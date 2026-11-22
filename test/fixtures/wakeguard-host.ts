import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import pvpExtension from "../../../omp-unlimited-pvp/src/index.js";
import wakeGuardExtension from "../../src/index.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

/**
 * Real OMP host for the double-extension CLI check.
 *
 * Loads the production omp-unlimited-pvp and omp-wakeguard extensions
 * unmodified; only the provider (a local HTTP fixture) and the command input
 * are fixtures. Both extension factories are invoked exactly as OMP invokes
 * them — after `--wakeguard-interval` was registered but before OMP parses it.
 */
export default function wakeGuardHost(pi: ExtensionAPI): void {
  // Host contract under test: at factory time OMP has not applied CLI flags yet.
  process.stderr.write(`WAKE_TEST factory-interval ${JSON.stringify(pi.getFlag("wakeguard-interval"))}\n`);

  const commands = new Map<string, CommandHandler>();
  const capture = new Proxy(pi, {
    get(target, key) {
      if (key === "registerCommand") {
        return (name: string, definition: { handler: CommandHandler }) => {
          commands.set(name, definition.handler);
          return target.registerCommand(name, definition);
        };
      }
      return Reflect.get(target, key);
    },
  });

  wakeGuardExtension(capture);
  pvpExtension(capture);

  pi.registerProvider("wakeguard-fixture", {
    baseUrl: process.env.WAKEGUARD_TEST_URL ?? "",
    apiKey: "fixture-not-a-secret",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 100,
      },
      {
        id: "fixture-alt",
        name: "Fixture Alt",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 100,
      },
    ],
  });

  // Handshake observation: registered AFTER both extensions, so the wake guard's
  // listener has already run and any `wait` it assigned is visible here. This is
  // how the harness proves the PVP gate fired at all, rather than inferring it
  // from request counts.
  pi.events.on("omp-wakeguard:before-retry:v1", (payload) => {
    const request = payload as { errorMessage?: string; wait?: unknown; model?: { baseUrl?: string } };
    if (!request || typeof request !== "object") return;
    process.stderr.write(
      `WAKE_TEST gate-emit waited=${typeof request.wait} model=${request.model?.baseUrl ?? "-"} error=${JSON.stringify(
        (request.errorMessage ?? "").slice(0, 120),
      )}\n`,
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    // Host contract, second half: flags are readable once session_start runs.
    process.stderr.write(`WAKE_TEST session-start-interval ${JSON.stringify(pi.getFlag("wakeguard-interval"))}\n`);

    const notifies: string[] = [];
    // OMP hands command handlers a `ctx.ui` wrapper that is NOT the object
    // captured here, so patching `notify` on one object records nothing. The
    // extension is given a forwarding recorder instead: it records every call
    // and delegates to whatever `ctx.ui` is current, which keeps the recorder
    // valid across re-binds.
    let liveUi = ctx.ui as unknown as {
      notify(message: string, type?: string): void;
      setStatus(id: string, text: string | undefined): void;
    };
    const recordNotify = (text: string, type?: string) => {
      notifies.push(text);
      process.stderr.write(`WAKE_TEST notify ${type ?? "info"} ${text.replaceAll("\n", " | ")}\n`);
      try {
        liveUi.notify(text, type);
      } catch {
        // print mode has no interactive surface; the stderr record is enough
      }
    };
    const recordStatus = (id: string, text: string | undefined) => {
      process.stderr.write(`WAKE_TEST status ${id} ${text ?? "(cleared)"}\n`);
      try {
        liveUi.setStatus(id, text);
      } catch {
        // print mode has no footer; the stderr record is enough
      }
    };
    const ui = new Proxy({} as Record<string, unknown>, {
      get(_target, key) {
        if (key === "notify") return recordNotify;
        if (key === "setStatus") return recordStatus;
        const value = Reflect.get(liveUi as object, key);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(liveUi) : value;
      },
      set(_target, key, value) {
        try {
          Reflect.set(liveUi as object, key, value);
        } catch {
          // recording surface only
        }
        return true;
      },
      has(_target, key) {
        return key in (liveUi as object);
      },
    });

    (liveUi as unknown as { __wgMarker?: number }).__wgMarker = 7;
    for (const [name, handler] of [...commands]) {
      commands.set(name, (args2: string, ctx2: ExtensionCommandContext) => {
        // Delegate to the real UI the host hands over — but never to our own
        // recording proxy, which would recurse through recordNotify.
        if ((ctx2.ui as unknown) !== (ui as unknown)) liveUi = ctx2.ui as unknown as typeof liveUi;
        const c = ctx2.ui as unknown as { __wgMarker?: number; notify?: unknown };
        process.stderr.write(
          `WAKE_TEST diag invoke ${name} marker=${c?.__wgMarker ?? "none"} notifyType=${typeof c?.notify} same=${(ctx2.ui as unknown) === (ui as unknown)}\n`,
        );
        return handler(args2, ctx2);
      });
    }
    const scoped = { ...ctx, ui: ui as ExtensionCommandContext["ui"] } as ExtensionCommandContext;
    const run = async (name: string, args: string) => {
      const handler = commands.get(name);
      process.stderr.write(`WAKE_TEST diag run ${name} ${JSON.stringify(args)} handler=${typeof handler}\n`);
      try {
        await handler?.(args, scoped);
      } catch (failure) {
        process.stderr.write(`WAKE_TEST command-error ${name} ${String(failure)}\n`);
        throw failure;
      }
    };

    process.stderr.write(
      `WAKE_TEST diag notifyType=${typeof liveUi.notify} uiKeys=${Object.keys(liveUi).join(",")} proto=${Object.getPrototypeOf(liveUi)?.constructor?.name}\n`,
    );
    process.stderr.write(
      `WAKE_TEST diag handler=${typeof commands.get("wakeguard")} pvp=${typeof commands.get("pvp")} ctxKeys=${Object.keys(ctx).join(",")} uiSame=${(ctx.ui as unknown) === (ui as unknown)}\n`,
    );
    // Proof that the CLI flag reached the controller before /wakeguard on.
    await run("wakeguard", "status");
    process.stderr.write(`WAKE_TEST diag notify-count=${notifies.length} last=${JSON.stringify(notifies.at(-1) ?? "")}\n`);
    try {
      const r = await commands.get("wakeguard")?.("status", scoped);
      process.stderr.write(`WAKE_TEST diag manual-ok ${String(r)}\n`);
    } catch (e) {
      process.stderr.write(`WAKE_TEST diag manual-throw ${String(e)}\n`);
    }
    process.stderr.write(`WAKE_TEST diag notify-count2=${notifies.length}\n`);
    const statusText = notifies.at(-1) ?? "";
    process.stderr.write(`WAKE_TEST configured-interval ${/interval: (\d+)ms/.exec(statusText)?.[1] ?? "unknown"}\n`);
    process.stderr.write(`WAKE_TEST configured-url ${/url: (\S+)/.exec(statusText)?.[1] ?? "unknown"}\n`);

    const pvpMode = process.env.WAKEGUARD_TEST_PVP;
    if (pvpMode) await run("pvp", pvpMode);
    if (process.env.WAKEGUARD_TEST_AUTOSTART !== "0") await run("wakeguard", "on");
    process.stderr.write("WAKE_TEST ready\n");

    const offAfter = Number(process.env.WAKEGUARD_TEST_OFF_AFTER_MS ?? "");
    if (Number.isFinite(offAfter) && offAfter > 0) {
      // Fire without blocking session_start: the parked request keeps the run
      // alive, and off must arrive while the gate is waiting.
      setTimeout(() => {
        process.stderr.write("WAKE_TEST off-trigger\n");
        void run("wakeguard", "off");
      }, offAfter);
    }

    const statusAfter = Number(process.env.WAKEGUARD_TEST_STATUS_AFTER_MS ?? "");
    if (Number.isFinite(statusAfter) && statusAfter > 0) {
      setTimeout(() => {
        void run("wakeguard", "status");
        void run("pvp", "status");
      }, statusAfter);
    }
  });
}
