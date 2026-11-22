/**
 * omp-wakeguard controller.
 *
 * Three states only — `off`, `sleeping`, `probing` — and one job: while the
 * provider endpoint cannot serve requests, park the retry and probe until it
 * answers, then release the request exactly once.
 *
 * The extension never wraps OMP internals or PVP's retry hook. It publishes one
 * synchronous EventBus contract:
 *
 *   request = { signal, errorMessage, status, contentType, model }
 *   pi.events.emit("omp-wakeguard:before-retry:v1", request)
 *   const recovered = request.wait ? await request.wait : false
 *
 * `true` means "the API is back, retry natively once"; `false` means "do not
 * retry" (cancelled, aborted, or shut down). While the extension is off no
 * `wait` is published at all, so PVP keeps its own behaviour untouched.
 *
 * Loading the extension is inert: it starts `off`, sends no traffic, and only
 * `/wakeguard on` enables it (which probes once immediately).
 */

import {
  classifyFailure,
  deriveProbeUrl,
  displayUrl,
  type FailureKind,
  type FailureInput,
  type ModelLike,
  probeApi,
  type ProbeResult,
  sanitizeProbeUrl,
} from "./probe.js";

export const WAKEGUARD_STATUS_KEY = "omp-wakeguard";
export const WAKEGUARD_RETRY_CHANNEL = "omp-wakeguard:before-retry:v1";

export const DEFAULT_INTERVAL_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
/** Node's setTimeout ceiling; anything longer fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export type WakeGuardState = "off" | "sleeping" | "probing";

/** The one mutable object shared over the EventBus. */
export interface RetryRequest extends FailureInput {
  signal?: AbortSignal;
  /** Model that produced this failure; wins over the session model. */
  model?: ModelLike;
  /** Filled synchronously by the watchdog when it decides to park. */
  wait?: Promise<boolean>;
}

export interface WakeGuardUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface WakeGuardConfig {
  /** Explicit probe URL, or undefined to derive one from the active model. */
  url?: string;
  intervalMs: number;
  timeoutMs: number;
}

export interface WakeGuardStatus {
  state: WakeGuardState;
  /** Origin + path only; never carries query strings or credentials. */
  url?: string;
  urlSource: "explicit" | "derived" | "none";
  intervalMs: number;
  timeoutMs: number;
  waiting: number;
  lastProbe?: ProbeResult;
  lastFailure?: FailureKind;
}

interface Deferred {
  promise: Promise<boolean>;
  resolve(value: boolean): void;
  detach?: () => void;
  settled: boolean;
}

/**
 * One outage epoch. Waiters parked here are released together, and the probe
 * controller dies with it so a cancelled gate can never be revived by a late
 * response.
 */
interface Gate {
  generation: number;
  controller: AbortController;
  waiters: Set<Deferred>;
  url: string;
  display: string;
}

function createDeferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  return { promise, resolve, settled: false };
}

/** Parse `30000`, `30s`, `2m` into milliseconds. */
export function parseInterval(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const text = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2] ?? "ms";
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : 1;
  const scaled = Math.round(value * factor);
  // A value past the timer limit silently becomes 1ms and would hammer the
  // provider: reject it instead of clamping.
  if (!Number.isFinite(scaled) || scaled > MAX_TIMER_MS) return undefined;
  return Math.max(1000, scaled);
}

export class WakeGuardController {
  private config: WakeGuardConfig;
  private state: WakeGuardState = "off";
  private gate: Gate | undefined;
  private flight: { generation: number; controller: AbortController } | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** `/wakeguard check` flights, aborted by off/disable/shutdown. */
  private readonly manualProbes = new Set<AbortController>();
  private nextGeneration = 1;
  private ui: WakeGuardUi | undefined;
  private model: ModelLike | undefined;
  private lastProbe: ProbeResult | undefined;
  private lastFailure: FailureKind | undefined;
  private lastStatus: number | undefined;
  private lastContentType: string | undefined;
  private disposed = false;

  constructor(config?: Partial<WakeGuardConfig>) {
    this.config = {
      url: config?.url,
      intervalMs: config?.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  get currentState(): WakeGuardState {
    return this.state;
  }

  get isEnabled(): boolean {
    return this.state !== "off";
  }

  get configSnapshot(): Readonly<WakeGuardConfig> {
    return { ...this.config };
  }

  bindUi(ui: WakeGuardUi): void {
    this.ui = ui;
    this.refreshStatus();
  }

  /**
   * Session/model binding. Response metadata belonged to the old model, so a
   * real switch drops it; re-binding the same model (session_start after a
   * reload, repeated binds) must keep the failed response's evidence so the
   * following classification still sees its status. It is cleared anyway at
   * the next `before_provider_request`.
   */
  bindModel(model: ModelLike | undefined): void {
    const changed =
      this.model?.id !== model?.id ||
      this.model?.provider !== model?.provider ||
      this.model?.baseUrl !== model?.baseUrl;
    this.model = model;
    if (changed) this.clearResponseMetadata();
  }

  /**
   * Response metadata is per request: a previous 200 must never classify the
   * next dropped connection.
   */
  clearResponseMetadata(): void {
    this.lastStatus = undefined;
    this.lastContentType = undefined;
  }

  status(): WakeGuardStatus {
    const target = this.describeTarget();
    return {
      state: this.state,
      url: target.display,
      urlSource: target.source,
      intervalMs: this.config.intervalMs,
      timeoutMs: this.config.timeoutMs,
      waiting: this.gate?.waiters.size ?? 0,
      lastProbe: this.lastProbe,
      lastFailure: this.lastFailure,
    };
  }

  /** Record the HTTP status of the last provider response for failure classification. */
  noteProviderResponse(status: number, headers?: Record<string, string>): void {
    this.lastStatus = status;
    const contentType = headers?.["content-type"] ?? headers?.["Content-Type"];
    this.lastContentType = contentType?.toLowerCase();
  }

  /** HTTP status recorded for the most recent provider response, if any. */
  lastProviderStatus(): number | undefined {
    return this.lastStatus;
  }

  /**
   * EventBus adapter. Parking only happens when the failure is transport-side
   * or unknown with a probe target available.
   */
  waitForRetry(request: RetryRequest): Promise<boolean> {
    if (this.disposed || this.state === "off") return Promise.resolve(true);

    const failure = this.classify(request);
    this.lastFailure = failure;
    if (failure === "api") {
      this.refreshStatus();
      return Promise.resolve(true);
    }

    const target = this.resolveTarget(request.model);
    if (!target) {
      this.report("no probe URL available; not parking the request", "warning");
      return Promise.resolve(true);
    }

    const waiter = createDeferred();
    const signal = request.signal;
    if (signal) {
      if (signal.aborted) {
        waiter.settled = true;
        return Promise.resolve(false);
      }
      const onAbort = () => {
        this.settle(waiter, false);
        this.maybeDisarm("request aborted");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiter.detach = () => signal.removeEventListener("abort", onAbort);
    }

    this.openGate(target.url, target.display).waiters.add(waiter);
    // A parked request must hold the event loop open for the next probe.
    if (this.gate?.waiters.size === 1) this.timer?.ref();
    this.report(
      failure === "outage"
        ? "provider unreachable; parking request and probing"
        : "unknown provider failure; classifying with one probe",
      "warning",
    );
    this.refreshStatus();
    return waiter.promise;
  }

  /**
   * Standalone mode: a failed turn with no PVP gate started the outage
   * ourselves. Never blocks the turn — it only arms the probe loop.
   */
  observeFailure(input: FailureInput): void {
    if (this.disposed || this.state === "off") return;
    const failure = this.classify(input);
    this.lastFailure = failure;
    if (failure === "api") {
      this.refreshStatus();
      return;
    }
    const target = this.resolveTarget(input.model);
    if (!target) {
      this.refreshStatus();
      return;
    }
    const gate = this.openGate(target.url, target.display);
    if (gate.waiters.size === 0) this.report(`provider unreachable (${target.display}); probing`, "warning");
    this.refreshStatus();
  }

  /**
   * `/wakeguard on` — enable and run one immediate probe. Idempotent: calling
   * it while already enabled reports the current state and never parks,
   * restarts, or duplicates a running cycle.
   *
   * Returns `true` when this call changed the state.
   */
  enable(): boolean {
    if (this.disposed || this.state !== "off") return false;
    this.clearResponseMetadata();
    const target = this.resolveTarget();
    if (!target) {
      this.state = "sleeping";
      this.report("enabled, but no probe URL is available (set /wakeguard url or pick a model)", "warning");
      this.refreshStatus();
      return true;
    }
    this.openGate(target.url, target.display);
    this.report(`enabled; probing ${target.display} now`, "info");
    this.refreshStatus();
    return true;
  }

  /** `/wakeguard off` — cancel every wait and go fully idle; never self-wakes. */
  disable(reason = "disabled"): void {
    this.teardownGate(reason, false);
    this.abortManualProbes();
    this.state = "off";
    this.report(`wakeguard off (${reason})`, "info");
    this.refreshStatus();
  }

  setUrl(raw: string | undefined): { ok: boolean; message: string } {
    const value = raw?.trim();
    const before = this.describeTarget().url;
    if (!value || value === "auto") {
      this.config.url = undefined;
    } else {
      const sanitized = sanitizeProbeUrl(value);
      if ("error" in sanitized) return { ok: false, message: sanitized.error };
      this.config.url = sanitized.url;
    }
    // A gate belongs to the target it was opened against. Retargeting must not
    // leave its timer running or release a parked request on the old endpoint's
    // verdict: drop it, stay enabled, and let the next failure re-open.
    if (this.gate && this.gate.url !== this.describeTarget().url) {
      this.cancelGate("probe target changed");
    }
    this.refreshStatus();
    if (!value || value === "auto") {
      return { ok: true, message: "probe URL reset to auto (derived from model baseUrl)" };
    }
    const target = this.describeTarget();
    const changed = target.url !== before;
    return {
      ok: true,
      message: changed ? `probe URL set to ${target.display}` : `probe URL unchanged (${target.display})`,
    };
  }

  setInterval(raw: string): { ok: boolean; message: string } {
    const intervalMs = parseInterval(raw);
    if (!intervalMs) return { ok: false, message: `invalid interval: ${raw} (use 30000 or 30s)` };
    this.config.intervalMs = intervalMs;
    // Honor the new cadence in the current outage instead of after one stale
    // cycle: only the wait is rescheduled, no extra probe is issued now.
    const gate = this.gate;
    if (gate && this.timer) this.scheduleNext(gate);
    this.refreshStatus();
    return { ok: true, message: `probe interval set to ${intervalMs}ms` };
  }

  /** `/wakeguard check` — one probe now, never changes the enabled state. */
  async check(): Promise<ProbeResult> {
    const target = this.resolveTarget();
    if (!target) {
      const result: ProbeResult = {
        kind: "unreachable",
        url: "",
        displayUrl: "(none)",
        reason: "no probe URL available",
        at: Date.now(),
      };
      this.lastProbe = result;
      return result;
    }
    // A manual probe is cancellable like everything else: `/wakeguard off` or a
    // shutdown must not leave an HTTP request running behind a dead session.
    const controller = new AbortController();
    this.manualProbes.add(controller);
    try {
      const result = await probeApi({
        url: target.url,
        timeoutMs: this.config.timeoutMs,
        signal: controller.signal,
      });
      if (this.disposed) return result;
      this.lastProbe = result;
      this.refreshStatus();
      this.report(`probe ${result.kind}: ${result.reason}`, result.kind === "reachable" ? "info" : "warning");
      return result;
    } finally {
      this.manualProbes.delete(controller);
    }
  }

  /** Any successful turn means the API is working again: stop probing. */
  handleTurnSuccess(): void {
    if (this.state === "off") return;
    this.teardownGate("turn succeeded", true);
    this.state = "sleeping";
    this.refreshStatus();
  }

  /** Abort / model switch / session switch: cancel this gate, stay enabled. */
  cancelGate(reason: string): void {
    if (this.state === "off") return;
    const wasProbing = this.state === "probing";
    this.teardownGate(reason, false);
    this.state = "sleeping";
    if (wasProbing) this.report(`wakeguard cancelled (${reason})`, "info");
    this.refreshStatus();
  }

  /** Session teardown: nothing may survive. */
  dispose(): void {
    this.disposed = true;
    this.teardownGate("session shutdown", false);
    this.abortManualProbes();
    this.state = "off";
    this.clearTimer();
    this.ui?.setStatus(WAKEGUARD_STATUS_KEY, undefined);
    this.ui = undefined;
  }

  /** Cancel in-flight `/wakeguard check` requests; they never outlive the state. */
  private abortManualProbes(): void {
    for (const probe of this.manualProbes) probe.abort();
    this.manualProbes.clear();
  }

  private classify(input: FailureInput): FailureKind {
    return classifyFailure({
      errorMessage: input.errorMessage,
      status: input.status ?? this.lastStatus,
      contentType: input.contentType ?? this.lastContentType,
    });
  }

  /** Open the gate, or reuse it when the probe target is unchanged. */
  private openGate(url: string, display: string): Gate {
    if (this.gate) {
      if (this.gate.url !== url) this.teardownGate("probe target changed", false);
      else {
        this.state = "probing";
        this.startProbe(this.gate);
        return this.gate;
      }
    }
    const gate: Gate = {
      generation: this.nextGeneration++,
      controller: new AbortController(),
      waiters: new Set(),
      url,
      display,
    };
    this.gate = gate;
    this.state = "probing";
    this.refreshStatus();
    this.startProbe(gate);
    return gate;
  }

  /**
   * Kick a probe only when no flight belongs to this generation. A pending
   * scheduleNext timer already owns the next probe: a waiter joining mid-cycle
   * must ride that cadence instead of resetting it with an extra request.
   */
  private startProbe(gate: Gate): void {
    if (this.flight && this.flight.generation === gate.generation) return;
    if (this.timer) return;
    void this.runProbe(gate);
  }

  private async runProbe(gate: Gate): Promise<void> {
    if (this.gate !== gate || this.state !== "probing") return;
    if (this.flight?.generation === gate.generation) return;

    const flight = { generation: gate.generation, controller: new AbortController() };
    this.flight = flight;
    try {
      const result = await probeApi({
        url: gate.url,
        timeoutMs: this.config.timeoutMs,
        signal: flight.controller.signal,
      });
      // Stale cycle: the gate was cancelled, replaced, or disabled mid-probe.
      if (this.flight !== flight || this.gate !== gate || gate.generation !== flight.generation) return;
      if (this.state !== "probing") return;

      this.lastProbe = result;
      if (result.kind === "reachable") {
        this.recover(gate, result.reason);
        return;
      }
      this.report(`waiting: ${result.reason}`, "warning");
      this.scheduleNext(gate);
    } finally {
      if (this.flight === flight) this.flight = undefined;
    }
  }

  private scheduleNext(gate: Gate): void {
    if (this.gate !== gate || this.state !== "probing") return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.gate === gate && this.state === "probing") void this.runProbe(gate);
    }, this.config.intervalMs);
    // A parked request must keep the process alive; only an idle watchdog timer
    // may be unref'd so it never blocks host shutdown.
    if (gate.waiters.size === 0) this.timer.unref();
  }

  private recover(gate: Gate, reason: string): void {
    if (this.gate !== gate) return;
    const waiting = gate.waiters.size;
    this.gate = undefined;
    gate.generation = this.nextGeneration++;
    this.clearTimer();
    flightAbort(this.flight);
    this.flight = undefined;
    this.state = "sleeping";
    for (const waiter of [...gate.waiters]) this.settle(waiter, true);
    gate.waiters.clear();
    this.report(
      waiting > 0
        ? `api reachable (${reason}); releasing ${waiting} parked request(s) once`
        : `api reachable (${reason}); watchdog back to sleep`,
      "info",
    );
    this.refreshStatus();
  }

  private maybeDisarm(reason: string): void {
    if (this.state !== "probing" || (this.gate?.waiters.size ?? 0) > 0) return;
    this.teardownGate(reason, false);
    this.state = "sleeping";
    this.report(`no parked request left (${reason})`, "info");
    this.refreshStatus();
  }

  /** Kill the gate: abort the probe flight, clear the timer, settle waiters. */
  private teardownGate(reason: string, recovered: boolean): void {
    const gate = this.gate;
    this.gate = undefined;
    this.clearTimer();
    flightAbort(this.flight);
    this.flight = undefined;
    if (!gate) return;
    gate.generation = this.nextGeneration++;
    for (const waiter of [...gate.waiters]) this.settle(waiter, recovered);
    gate.waiters.clear();
    void reason;
  }

  private settle(waiter: Deferred, value: boolean): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.detach?.();
    this.gate?.waiters.delete(waiter);
    waiter.resolve(value);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Explicit URL wins; otherwise derive from this request's model, then the session model. */
  private resolveTarget(model?: ModelLike): { url: string; display: string } | undefined {
    const described = this.describeTarget(model);
    if (!described.url) return undefined;
    return { url: described.url, display: described.display ?? displayUrl(described.url) };
  }

  private describeTarget(model?: ModelLike): {
    url?: string;
    display?: string;
    source: "explicit" | "derived" | "none";
  } {
    if (this.config.url) {
      return { url: this.config.url, display: displayUrl(this.config.url), source: "explicit" };
    }
    const derived = deriveProbeUrl(model ?? this.model);
    if (!derived.url) return { source: "none" };
    return { url: derived.url, display: derived.display ?? displayUrl(derived.url), source: "derived" };
  }

  private report(message: string, type: "info" | "warning" | "error"): void {
    this.ui?.notify(`wakeguard: ${message}`, type);
  }

  private refreshStatus(): void {
    this.ui?.setStatus(WAKEGUARD_STATUS_KEY, statusLine(this.status()));
  }
}

function flightAbort(flight: { controller: AbortController } | undefined): void {
  flight?.controller.abort();
}

/** Compact native-looking footer status, e.g. `wakeguard probing`. */
export function statusLine(status: WakeGuardStatus): string {
  if (status.state === "off") return "wakeguard off";
  if (status.state === "sleeping") return "wakeguard sleeping";
  return `wakeguard probing (${status.waiting} parked)`;
}

/** Plain-text block for `/wakeguard status`. */
export function formatStatus(status: WakeGuardStatus): string {
  const lines = [
    `state: ${status.state}`,
    `url: ${status.url ?? "(none)"} [${status.urlSource}]`,
    `interval: ${status.intervalMs}ms (${Math.round(status.intervalMs / 600) / 100} min)`,
    `timeout: ${status.timeoutMs}ms`,
    `parked requests: ${status.waiting}`,
  ];
  if (status.lastFailure) lines.push(`last failure: ${status.lastFailure}`);
  if (status.lastProbe) lines.push(`last probe: ${status.lastProbe.kind} — ${status.lastProbe.reason}`);
  return lines.join("\n");
}
