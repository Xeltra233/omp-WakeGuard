/**
 * Probe primitives for omp-wakeguard.
 *
 * The watchdog answers one question: "can the model API serve us right now?" —
 * not "is the vendor's homepage up?". Only a structured JSON answer proves the
 * API is alive; an HTML 200 is a captive portal, and an HTML 403 is a WAF page.
 *
 * Probes are credential-free: no auth headers are ever sent, so an
 * operator-supplied URL cannot leak a token.
 */

export interface ModelLike {
  id?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
}

export type ProbeKind = "reachable" | "untrusted" | "unreachable";

export interface ProbeResult {
  kind: ProbeKind;
  url: string;
  /** Origin + path only: query strings and userinfo are never printed. */
  displayUrl: string;
  status?: number;
  contentType?: string;
  reason: string;
  at: number;
}

export type FailureKind = "api" | "outage" | "unknown";

export interface FailureInput {
  errorMessage?: string;
  status?: number;
  contentType?: string;
  /** Model that produced the failure; picks the probe target when present. */
  model?: ModelLike;
}

/** Trailing endpoint paths stripped from `baseUrl`; the version segment is kept. */
const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/responses",
  "/messages",
  "/completions",
  "/embeddings",
  "/images/generations",
];

const BODY_LIMIT = 8 * 1024;

/** Mask query strings and userinfo; keep origin + path for status output. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const query = parsed.search ? "?…" : "";
    return `${parsed.origin}${parsed.pathname}${query}`;
  } catch {
    return "(invalid url)";
  }
}

export interface SanitizedUrl {
  url: string;
  display: string;
}

/**
 * Validate an operator-supplied probe URL.
 *
 * Rejects non-HTTP schemes and embedded credentials (which would otherwise be
 * shown in status output and sent to the endpoint).
 */
export function sanitizeProbeUrl(raw: string): SanitizedUrl | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    // Never echo the raw input: a mistyped token in the path would land in
    // status output, transcripts and logs.
    return { error: "invalid URL (expected http(s)://host/path)" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported protocol: ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { error: "credentials in the probe URL are not allowed" };
  }
  parsed.hash = "";
  return { url: parsed.toString(), display: displayUrl(parsed.toString()) };
}

/**
 * Derive a model-list probe URL from a model descriptor.
 *
 * A `baseUrl` may be a provider root (`https://api.openai.com/v1`) or a full
 * endpoint (`https://api.openai.com/v1/chat/completions`). Only the endpoint
 * segment is stripped, so `/v1` survives; `/models` is appended when absent.
 */
export function deriveProbeUrl(model?: ModelLike): { url?: string; display?: string; reason: string } {
  const raw = (model?.baseUrl ?? "").trim();
  if (!raw) return { reason: "model has no baseUrl" };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { reason: "model baseUrl is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { reason: `unsupported baseUrl protocol: ${parsed.protocol}` };
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }

  const api = (model?.api ?? "").toLowerCase();
  const needsVersion = api.includes("anthropic") || api.includes("claude");
  if (needsVersion && !/\/v\d+$/.test(path)) path += "/v1";
  if (!/\/models$/.test(path)) path += "/models";

  parsed.pathname = path || "/models";
  parsed.search = "";
  parsed.hash = "";
  const url = parsed.toString();
  return { url, display: displayUrl(url), reason: "derived from model baseUrl" };
}

/** True when the preview parses as JSON (or is a truncated JSON prefix). */
export function looksLikeJson(text: string, truncated = false): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  if (truncated) return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn an HTTP response into a verdict.
 *
 * - structured JSON, any status -> reachable (401/429/503 JSON still proves the API answered)
 * - HTML/empty 5xx -> unreachable (gateway)
 * - HTML/empty 2xx/3xx/4xx -> untrusted (portal, redirect, WAF page)
 */
export function classifyResponse(status: number, bodyPreview: string, truncated = false): ProbeKind {
  if (status <= 0) return "unreachable";
  if (looksLikeJson(bodyPreview, truncated)) return "reachable";
  if (status >= 500) return "unreachable";
  return "untrusted";
}

/** Transport failures: the request never produced a usable HTTP answer. */
const OUTAGE_PATTERNS: RegExp[] = [
  /stream\s+disconnected/i,
  /socket\s+hang\s?up/i,
  /fetch\s+failed/i,
  /\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bEPIPE\b|\bECONNABORTED\b|\bUND_ERR_\w+/i,
  /connection\s+(?:refused|reset|closed)/i,
  /network\s+(?:error|unreachable|down)/i,
  /getaddrinfo/i,
  /dns\s+(?:error|lookup|resolution)/i,
  /timed\s*out\s+(?:connecting|waiting\s+for\s+headers)/i,
];

/** Provider-side failures: the API is alive; keep retrying natively. */
const API_PATTERNS: RegExp[] = [
  /invalid[_\s-]?api[_\s-]?key/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /authenticat/i,
  /rate[_\s-]?limit/i,
  /too\s+many\s+requests/i,
  /quota/i,
  /insufficient[_\s-]?(?:quota|balance|funds)/i,
  /model[_\s-]?not[_\s-]?found/i,
  /invalid[_\s-]?model/i,
  /not\s+a\s+valid\s+model/i,
  /context[_\s-]?(?:length|window)/i,
  /too\s+many\s+tokens/i,
  /maximum\s+context/i,
  /invalid[_\s-]?request/i,
  /bad\s+request/i,
  /overloaded/i,
];

/** A provider error message of the shape `${status}: ${body}` (Pi's own form). */
const STATUS_LEADING = /^\s*([45]\d{2})\s*:\s*/;
/** The other Pi form: `${label} (${status}): ${body}`. */
const STATUS_PARENTHESIZED = /^\s*[^()\n]{0,64}?\(([45]\d{2})\)\s*:\s*/;
/** Pi truncates long provider bodies with this suffix before they reach us. */
const TRUNCATION_SUFFIX = /\s*\.\.\.\s*\[truncated \d+ chars\]\s*$/;

export interface FailureEnvelope {
  /** HTTP status carried inside the error text, when the message names one. */
  status?: number;
  /** True when the text after that status parses as a JSON error envelope. */
  structured: boolean;
}

/**
 * Read HTTP evidence out of a provider error message.
 *
 * Built-in providers do not report a failed response through
 * `after_provider_response`; the only trace left is the message Pi formats as
 * `<status>: <body>` (or `<label> (<status>): <body>`). When the body is a JSON
 * envelope the API itself answered — auth, quota or an upstream 503 — which is
 * a provider-level failure, not an unreachable endpoint. An HTML body on the
 * same status is a gateway page and stays an outage signal.
 */
export function parseFailureEnvelope(message: string): FailureEnvelope {
  const match = STATUS_LEADING.exec(message) ?? STATUS_PARENTHESIZED.exec(message);
  if (!match) return { structured: false };
  const status = Number(match[1]);
  const truncated = TRUNCATION_SUFFIX.test(message);
  const body = message.slice(match[0].length).replace(TRUNCATION_SUFFIX, "");
  return { status, structured: looksLikeJson(body, truncated) };
}

/**
 * Classify a model failure.
 *
 * Structured evidence wins outright: a recorded HTTP answer with a JSON body —
 * whether it arrives as real response metadata or as a `<status>: <json>` error
 * message — is proof the provider talked to us, so it is an API-level failure
 * (400/401/403/429/503 included) no matter what words the body carries: a proxy
 * error page copied into a JSON error body must not be read as "the site is
 * down". Only without that evidence does transport wording decide, and a
 * dropped connection must not be mistaken for the previous request's 200. A
 * non-JSON 5xx (HTML gateway page) is an outage; a non-JSON 4xx is `unknown`
 * and the caller runs one classification probe.
 *
 * A bare "timeout" word is deliberately not an outage signal — providers emit
 * it for their own upstream stalls.
 */
export function classifyFailure(input: FailureInput): FailureKind {
  const message = input.errorMessage ?? "";
  const contentType = (input.contentType ?? "").toLowerCase();
  const recorded = typeof input.status === "number" && input.status > 0;
  const envelope = recorded ? { structured: false } : parseFailureEnvelope(message);

  const status = recorded ? input.status : envelope.status;
  const hasResponse = typeof status === "number" && status > 0;
  const structured = (recorded && contentType.includes("json")) || envelope.structured;

  // Structured answer wins outright: the API is reachable and the request
  // itself was rejected. Retrying natively is PVP's job, never the watchdog's.
  if (hasResponse && structured) return "api";

  for (const pattern of OUTAGE_PATTERNS) {
    if (pattern.test(message)) return "outage";
  }

  if (hasResponse) {
    if (status! >= 500) return "outage";
    return "unknown";
  }

  for (const pattern of API_PATTERNS) {
    if (pattern.test(message)) return "api";
  }
  return "unknown";
}

export interface ProbeOptions {
  url: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Single credential-free GET with a hard timeout that also covers the body.
 *
 * Never throws: cancellation, timeout and transport errors all come back as
 * `unreachable` with a reason, and the abort listener + timer are released.
 */
export async function probeApi(options: ProbeOptions): Promise<ProbeResult> {
  const at = Date.now();
  const display = displayUrl(options.url);
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      return { kind: "unreachable", url: options.url, displayUrl: display, reason: "probe cancelled before start", at };
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(250, options.timeoutMs));
  timer.unref();

  try {
    const response = await fetch(options.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json", "cache-control": "no-store", "user-agent": "omp-wakeguard/0.1" },
    });
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const { text, truncated } = await readBodyPreview(response, BODY_LIMIT);
    const kind = classifyResponse(response.status, text, truncated);
    return {
      kind,
      url: options.url,
      displayUrl: display,
      status: response.status,
      contentType,
      reason: `HTTP ${response.status}${contentType ? ` ${contentType}` : ""}`,
      at,
    };
  } catch (error) {
    const { name, message } = errorText(error);
    let reason: string;
    if (cancelled && !timedOut) reason = "probe cancelled";
    else if (timedOut) reason = `probe timeout after ${options.timeoutMs}ms`;
    else reason = `${name}: ${message}`;
    return { kind: "unreachable", url: options.url, displayUrl: display, reason, at };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Read at most `limit` characters of the body, then cancel the stream. */
async function readBodyPreview(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= limit) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }
  return { text: text.slice(0, limit), truncated };
}

/** Read name/message off an unknown thrown value without asserting a shape. */
function errorText(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
