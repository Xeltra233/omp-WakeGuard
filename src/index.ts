import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_INTERVAL_MS,
  formatStatus,
  parseInterval,
  type RetryRequest,
  WAKEGUARD_RETRY_CHANNEL,
  WakeGuardController,
} from "./wakeguard-controller.js";

export {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  formatStatus,
  parseInterval,
  statusLine,
  WAKEGUARD_RETRY_CHANNEL,
  WAKEGUARD_STATUS_KEY,
  WakeGuardController,
} from "./wakeguard-controller.js";
export type {
  RetryRequest,
  WakeGuardConfig,
  WakeGuardState,
  WakeGuardStatus,
  WakeGuardUi,
} from "./wakeguard-controller.js";
export {
  classifyFailure,
  classifyResponse,
  parseFailureEnvelope,
  deriveProbeUrl,
  displayUrl,
  looksLikeJson,
  probeApi,
  sanitizeProbeUrl,
} from "./probe.js";
export type {
  FailureEnvelope,
  FailureInput,
  FailureKind,
  ModelLike,
  ProbeKind,
  ProbeResult,
  SanitizedUrl,
} from "./probe.js";

const USAGE =
  "usage — /wakeguard [on|off|status|check|url <url|auto>|interval <10m>] (loaded off; /wakeguard on probes immediately)";

/**
 * OMP WakeGuard — the OMP build of pi-wakeguard.
 *
 * Shares the probe/classifier/controller modules with the Pi package; only the
 * host surface differs (OMP events and EventBus). Behaviour contract is the
 * same: loaded off and silent, `/wakeguard on` probes once immediately, then
 * every interval while down, and a reachable probe releases the parked request
 * exactly once.
 */
export default function wakeGuardExtension(pi: ExtensionAPI): void {
  pi.registerFlag("wakeguard-url", {
    description: "Probe URL for wakeguard (default: derived from the model baseUrl). Does not enable the watchdog.",
    type: "string",
  });
  pi.registerFlag("wakeguard-interval", {
    description: "Probe interval while the API is down (default 10m; accepts 30s/10m). Does not enable the watchdog.",
    type: "string",
  });

  // OMP parses CLI flags *after* loading extensions (applyExtensionFlags runs
  // once the extension set is known), so getFlag() is still empty inside this
  // factory. Defaults here; the real values are applied in session_start.
  const controller = new WakeGuardController({ intervalMs: DEFAULT_INTERVAL_MS });
  let appliedIntervalFlag: string | undefined;
  let appliedUrlFlag: string | undefined;

  /**
   * Apply `--wakeguard-interval` / `--wakeguard-url` once the host has parsed
   * them. Only a changed flag value is applied, so a runtime
   * `/wakeguard interval` survives later session switches.
   */
  const applyFlags = (ui?: { notify(message: string, level?: string): void }): void => {
    const rawInterval = pi.getFlag("wakeguard-interval") as string | undefined;
    if (rawInterval !== appliedIntervalFlag) {
      appliedIntervalFlag = rawInterval;
      if (rawInterval !== undefined) {
        const parsed = parseInterval(rawInterval);
        if (parsed === undefined) {
          ui?.notify(`wakeguard: ignoring invalid --wakeguard-interval ${JSON.stringify(rawInterval)}`, "warning");
        } else {
          controller.setInterval(String(parsed));
        }
      }
    }
    const rawUrl = pi.getFlag("wakeguard-url") as string | undefined;
    if (rawUrl !== appliedUrlFlag) {
      appliedUrlFlag = rawUrl;
      if (rawUrl !== undefined) {
        const outcome = controller.setUrl(rawUrl);
        if (!outcome.ok) ui?.notify(`wakeguard: ${outcome.message}`, "warning");
      }
    }
  };

  /** PVP handshake: the caller assigns `request.wait`, then awaits it. */
  const unsubscribeRetry = pi.events.on(WAKEGUARD_RETRY_CHANNEL, (payload) => {
    const request = payload as RetryRequest | undefined;
    if (!request || typeof request !== "object") return;
    if (!controller.isEnabled) return;
    request.wait = controller.waitForRetry(request);
  });

  pi.registerCommand("wakeguard", {
    description:
      "Sleep until the model API answers again: /wakeguard [on|off|status|check|url <url|auto>|interval <10m>]",
    handler: async (args, ctx) => {
      controller.bindUi(ctx.ui);
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const argument = rest.join(" ");
      switch ((verb ?? "status").toLowerCase()) {
        case "on": {
          if (!controller.enable()) {
            ctx.ui.notify(
              `wakeguard: already ${controller.currentState} — interval ${controller.status().intervalMs}ms`,
              "info",
            );
            return;
          }
          ctx.ui.notify("wakeguard: on — probing now, then every interval while down", "info");
          return;
        }
        case "off":
          controller.disable("command");
          return;
        case "status":
          ctx.ui.notify(formatStatus(controller.status()), "info");
          return;
        case "check": {
          const result = await controller.check();
          ctx.ui.notify(
            `wakeguard: ${result.kind} — ${result.reason}`,
            result.kind === "reachable" ? "info" : "warning",
          );
          return;
        }
        case "url": {
          const outcome = controller.setUrl(argument);
          ctx.ui.notify(`wakeguard: ${outcome.message}`, outcome.ok ? "info" : "error");
          return;
        }
        case "interval": {
          const outcome = controller.setInterval(argument);
          ctx.ui.notify(`wakeguard: ${outcome.message}`, outcome.ok ? "info" : "error");
          return;
        }
        default:
          ctx.ui.notify(USAGE, "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    applyFlags(ctx.ui);
    controller.bindUi(ctx.ui);
    controller.bindModel(modelFacts(ctx));
  });

  pi.on("before_provider_request", () => {
    controller.clearResponseMetadata();
  });

  pi.on("after_provider_response", (event) => {
    controller.noteProviderResponse(event.status, event.headers);
  });

  // OMP has no model_select event; a session switch is the model-epoch boundary.
  pi.on("session_switch", (_event, ctx) => {
    controller.bindUi(ctx.ui);
    controller.bindModel(modelFacts(ctx));
    controller.cancelGate("session switched");
  });

  pi.on("turn_end", (event, ctx) => {
    controller.bindUi(ctx.ui);
    if (event.message.role !== "assistant") return;
    const stopReason = event.message.stopReason;
    // A user abort is not evidence about the API: cancel the gate, probe nothing.
    if (stopReason === "aborted") {
      controller.cancelGate("request aborted");
      return;
    }
    if (stopReason === "error") {
      controller.observeFailure({
        errorMessage: event.message.errorMessage,
        status: controller.lastProviderStatus(),
        model: modelFacts(ctx),
      });
      return;
    }
    controller.handleTurnSuccess();
  });

  pi.on("session_shutdown", () => {
    unsubscribeRetry();
    controller.dispose();
  });
}

/** Narrow the host model into the four fields the probe needs. */
function modelFacts(ctx: { model?: { id?: string; api?: string; provider?: string; baseUrl?: string } }):
  | { id?: string; api?: string; provider?: string; baseUrl?: string }
  | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return { id: model.id, api: model.api, provider: model.provider, baseUrl: model.baseUrl };
}
