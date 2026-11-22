/**
 * Real OMP CLI acceptance for omp-wakeguard with the REAL omp-unlimited-pvp
 * extension loaded unmodified.
 *
 * Only the provider (a local HTTP endpoint) and the command input are fixtures.
 * Every assertion below is made against a real `omp` CLI process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

// The loaded extensions patch prototypes on the SDK module instance they
// resolve from their own package location. Running a CLI from a *different*
// copy of the SDK means the patches land on a class object the running CLI
// never uses, so the retry gate silently never fires. The CLI must therefore
// come from the copy omp-unlimited-pvp resolves, and that the wake guard is
// expected to interoperate with.
const pvpDir = resolve(root, "..", "omp-unlimited-pvp");
/**
 * Resolve the SDK exactly the way the loaded extension does: by walking up
 * from omp-unlimited-pvp looking for node_modules/@oh-my-pi/pi-coding-agent.
 * A bare require.resolve cannot be used - the package's exports map defines no
 * CJS main, so only the physical directory layout is reliable here.
 */
const sdkRoot = (() => {
  let dir = pvpDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
    if (existsSync(join(candidate, "dist", "cli.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the SDK copy omp-unlimited-pvp resolves from ${pvpDir}`);
})();
/**
 * The REAL bundled CLI. dist/cli.js is what `omp` ships and runs; it carries
 * its own copy of AgentSession, so an extension must patch the class through
 * the live `pi.pi` namespace, never the module copy it imports. Running the
 * source entry would share one module graph and silently hide that bug, so
 * the bundle is the only valid target here.
 */
const cli = join(sdkRoot, "dist", "cli.js");
if (!existsSync(cli)) throw new Error(`bundled CLI not found at ${cli}`);
const hostExtension = join(here, "fixtures", "wakeguard-host.ts");
const evidence = join(root, "goal-2", "evidence", "omp-cli-wakeguard.log");
await mkdir(dirname(evidence), { recursive: true });

const interval = argValue("--interval", "1000");
const startedAt = Date.now();
const stamp = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

async function record(line) {
  console.log(`${stamp()} ${line}`);
  await appendFile(evidence, `${new Date().toISOString()} ${stamp()} ${line}\n`);
}

/**
 * Local provider endpoint. `/models` is the probe surface; `/chat/completions`
 * is the model call. `healthy` is flipped by the scenario itself.
 */
async function startEndpoint(options = {}) {
  const state = {
    healthy: false,
    probes: 0,
    probesAfterFirstChat: 0,
    chats: 0,
    chatFailuresLeft: options.chatFailuresLeft ?? 0,
    failStatus: options.failStatus ?? 401,
    failMessage: options.failMessage ?? "Incorrect API key provided",
    probeTimes: [],
  };
  const outageBody = "<html><body><h1>503 Service Unavailable</h1></body></html>";
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (path.endsWith("/chat/completions")) {
      state.chats += 1;
      if (state.chatFailuresLeft > 0) {
        state.chatFailuresLeft -= 1;
        res.writeHead(state.failStatus, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: state.failMessage, type: "invalid_request_error", code: "fixture_structured_error" },
          }),
        );
        return;
      }
      if (!state.healthy) {
        res.writeHead(503, { "content-type": "text/html" });
        res.end(outageBody);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { role: "assistant", content: "FIXTURE_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (path.endsWith("/models")) {
      state.probes += 1;
      if (state.chats > 0) state.probesAfterFirstChat += 1;
      state.probeTimes.push(Date.now());
      if (!state.healthy) {
        res.writeHead(503, { "content-type": "text/html" });
        res.end(outageBody);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unexpected path", path } }));
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return { server, state, port: server.address().port };
}

async function runScenario(
  name,
  { healthy, pvpMode = "", autostart = true, offAfterMs, restoreAfterChat, killAfterMs, endpointOptions = {} },
) {
  const work = await mkdtemp(join(tmpdir(), `wakeguard-omp-${name}-`));
  const endpoint = await startEndpoint(endpointOptions);
  const url = `http://127.0.0.1:${endpoint.port}/v1`;
  endpoint.state.healthy = healthy;
  await mkdir(join(work, "agent"), { recursive: true });
  // A real isolated agent dir: no credentials, no user settings, a fixture
  // provider selected as the chat model by role.
  await writeFile(
    join(work, "agent", "settings.json"),
    JSON.stringify({
      modelRoles: { default: "wakeguard-fixture/fixture" },
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await record(
    `[${name}] port=${endpoint.port} healthy=${healthy} structuredFailures=${endpoint.state.chatFailuresLeft} work=${work}`,
  );

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(work, "agent"),
    WAKEGUARD_TEST_URL: url,
    WAKEGUARD_TEST_PVP: pvpMode,
    WAKEGUARD_TEST_AUTOSTART: autostart ? "1" : "0",
    WAKEGUARD_TEST_OFF_AFTER_MS: offAfterMs ? String(offAfterMs) : "",
    WAKEGUARD_TEST_STATUS_AFTER_MS: "",
  };
  const child = spawn(
    "bun",
    [
      cli,
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-tools",
      "--no-session",
      "-e",
      hostExtension,
      "--wakeguard-interval",
      interval,
      "-p",
      "Reply FIXTURE_OK",
    ],
    { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  if (restoreAfterChat) {
    void (async () => {
      for (;;) {
        if (endpoint.state.chats > 0) {
          await new Promise((done) => setTimeout(done, 250));
          endpoint.state.healthy = true;
          await record(`[${name}] endpoint restored after first chat failure`);
          return;
        }
        if (child.exitCode !== null) return;
        await new Promise((done) => setTimeout(done, 50));
      }
    })();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, killAfterMs ?? 45_000);
  let code;
  try {
    code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    });
  } finally {
    clearTimeout(timer);
    if (!child.killed) child.kill();
    endpoint.server.closeAllConnections();
    await new Promise((done) => endpoint.server.close(done));
    // The child must be gone and the fixture port must refuse connections.
    assert.equal(child.exitCode === null && child.signalCode === null, false, name + ": child still running after close");
    await assert.rejects(
      () => new Promise((ok, no) => {
        const sock = connect(endpoint.port, "127.0.0.1");
        sock.once("connect", () => { sock.destroy(); ok(true); });
        sock.once("error", (e) => { sock.destroy(); no(e); });
      }),
      name + ": fixture port still accepting connections",
    );
    await rm(work, { recursive: true, force: true });
  }

  const gaps = endpoint.state.probeTimes.slice(1).map((t, i) => t - endpoint.state.probeTimes[i]);
  const summary = {
    scenario: name,
    pid: child.pid,
    port: endpoint.port,
    code,
    timedOut,
    probes: endpoint.state.probes,
    probesAfterFirstChat: endpoint.state.probesAfterFirstChat,
    chats: endpoint.state.chats,
    gaps,
    stdout,
    stderr,
  };
  await record(
    `[${name}] exit=${code} timedOut=${timedOut} probes=${summary.probes} chats=${summary.chats} gaps=${JSON.stringify(gaps)}`,
  );
  await record(`[${name}] stderr:\n${stderr.trim()}`);
  await record(`[${name}] stdout:\n${stdout.trim()}`);

  return summary;
}

const only = argValue("--only", "");
const enabled = (name) => !only || only.split(",").includes(name);
const results = [];

// 1. Bounded 20s observation of the real probe cadence: parked request, the
//    endpoint stays down, the watchdog must probe about once per second.
if (enabled("cadence-20s")) results.push(
  await runScenario("cadence-20s", { healthy: false, pvpMode: "on", autostart: true, killAfterMs: 20_000 }),
);

// 2. Outage then recovery: exactly one native retry, then success, then timer=0.
if (enabled("recover")) results.push(
  await runScenario("recover", {
    healthy: false,
    pvpMode: "on",
    autostart: true,
    restoreAfterChat: true,
    killAfterMs: 45_000,
  }),
);

// 3. A structured JSON auth error is a provider failure, not an outage.
if (enabled("structured-401")) results.push(
  await runScenario("structured-401", {
    healthy: true,
    pvpMode: "on",
    autostart: true,
    endpointOptions: { chatFailuresLeft: 1, failStatus: 401 },
    killAfterMs: 45_000,
  }),
);

// 3b. A structured JSON error whose body carries no recognisable wording and a
//     503 status: built-in providers never emit `after_provider_response` for a
//     failed status, so the only evidence left is the `503: {...}` message. The
//     envelope alone must keep this a provider failure - zero probes, no park.
if (enabled("structured-503-json")) results.push(
  await runScenario("structured-503-json", {
    healthy: true,
    pvpMode: "on",
    autostart: true,
    endpointOptions: { chatFailuresLeft: 1, failStatus: 503, failMessage: "upstream unavailable" },
    killAfterMs: 45_000,
  }),
);

// 4. `/wakeguard off` while the request is parked cancels the gate and must not
//    issue a retry.
if (enabled("off-while-parked")) results.push(
  await runScenario("off-while-parked", { healthy: false, pvpMode: "on", autostart: true, offAfterMs: 1200 }),
);

// 5. Loaded-off silence: no probe traffic at all.
if (enabled("loaded-off")) results.push(await runScenario("loaded-off", { healthy: true, pvpMode: "", autostart: false }));

if (only) {
  for (const r of results) {
    console.log(JSON.stringify({ scenario: r.scenario, code: r.code, probes: r.probes, chats: r.chats, gaps: r.gaps }));
    assert.ok(r.stderr.includes("WAKE_TEST ready"), r.scenario + ": host never reached ready");
    assert.ok(r.chats >= 1, r.scenario + ": no provider request reached the endpoint");
    const gateLines = r.stderr.split(String.fromCharCode(10)).filter(l => l.startsWith("WAKE_TEST gate-emit")).slice(0, 8);
    for (const line of gateLines) console.log("  " + line);
  }
  console.log("--only diagnostics passed; scenario assertions follow");
}

const byName = new Map(results.map(r => [r.scenario, r]));
const knownScenarios = ["cadence-20s", "recover", "structured-401", "structured-503-json", "off-while-parked", "loaded-off"];
if (only) {
  const requested = only.split(",").filter(Boolean);
  const bad = requested.filter(n => !knownScenarios.includes(n));
  assert.equal(bad.length, 0, "unknown --only scenario(s): " + bad.join(","));
  assert.ok(requested.length > 0, "--only requires at least one known scenario");
}
const cadence = byName.get("cadence-20s");
const recovered = byName.get("recover");
const structured = byName.get("structured-401");
const structuredJson = byName.get("structured-503-json");
const cancelled = byName.get("off-while-parked");
const loadedOff = byName.get("loaded-off");

// CLI flag must reach the controller before `/wakeguard on` runs, and the
// factory must NOT be the place it is read (OMP parses flags after loading).
for (const scenario of results) {
  assert.match(
    scenario.stderr,
    /WAKE_TEST factory-interval undefined/,
    "OMP has not parsed extension flags at factory time",
  );
  assert.match(
    scenario.stderr,
    new RegExp(`WAKE_TEST session-start-interval "${interval}"`),
    `--wakeguard-interval ${interval} must be readable at session_start`,
  );
}

// The controller must already hold the CLI interval when `/wakeguard on` runs.
// `loaded-off` never turns the watchdog on, so it legitimately reports unknown.
for (const scenario of results.filter((r) => r.scenario !== "loaded-off")) {
  assert.match(
    scenario.stderr,
    new RegExp(`WAKE_TEST configured-interval ${interval}\\b`),
    "the controller must hold the CLI interval before /wakeguard on",
  );
}

if (enabled("cadence-20s")) assert.equal(cadence.timedOut, true, "cadence run is deliberately killed after 20s");
if (enabled("cadence-20s")) assert.ok(cadence.probes >= 2, `must probe at least twice in 20s (probes=${cadence.probes})`);
if (enabled("cadence-20s")) for (const gap of cadence.gaps) {
  assert.ok(
    gap >= 800 && gap <= 2200,
    `probe gap must follow the 1000ms CLI interval, got ${cadence.gaps.join(",")}`,
  );
}
if (enabled("cadence-20s")) assert.equal(cadence.chats, 1, "the parked request must not be re-sent while down");
if (enabled("cadence-20s")) assert.match(cadence.stderr, /provider unreachable; parking/);

if (enabled("recover")) assert.equal(recovered.timedOut, false, "recovery must finish within the harness timeout");
if (enabled("recover")) assert.equal(recovered.code, 0, "recovered run must succeed");
if (enabled("recover")) assert.equal(recovered.chats, 2, "one failed attempt + exactly one native retry");
if (enabled("recover")) assert.match(recovered.stdout, /FIXTURE_OK/, "the native retry produced the assistant reply");
if (enabled("recover")) assert.ok(recovered.probes >= 2, `watchdog probed while down then while up (probes=${recovered.probes})`);
if (enabled("recover")) assert.match(recovered.stderr, /wakeguard: api reachable/);

if (enabled("structured-401")) assert.equal(structured.timedOut, false, "structured-failure run must finish, never park");
if (enabled("structured-401")) assert.equal(structured.code, 0, "PVP's own retry must carry a structured error to success");
if (enabled("structured-401")) assert.equal(structured.chats, 2, "one structured failure + exactly one native retry");
if (enabled("structured-401")) assert.match(structured.stdout, /FIXTURE_OK/);
if (enabled("structured-401")) assert.ok(structured.probes <= 1, `a JSON provider error must not start an outage loop (probes=${structured.probes})`);
if (enabled("structured-401")) assert.doesNotMatch(structured.stderr, /provider unreachable; parking/);

if (enabled("structured-503-json")) assert.equal(structuredJson.timedOut, false, "structured JSON 503 run must finish, never park");
if (enabled("structured-503-json")) assert.equal(structuredJson.code, 0, "the native retry must carry a JSON 503 to success");
if (enabled("structured-503-json")) assert.equal(structuredJson.chats, 2, "one JSON 503 + exactly one native retry");
if (enabled("structured-503-json")) assert.match(structuredJson.stdout, /FIXTURE_OK/);
if (enabled("structured-503-json")) assert.equal(structuredJson.probesAfterFirstChat, 0, "a JSON 503 body is provider evidence: no probe after the failing request");
if (enabled("structured-503-json")) assert.doesNotMatch(structuredJson.stderr, /provider unreachable; parking/);

if (enabled("off-while-parked")) assert.equal(cancelled.chats, 1, "a cancelled gate must not issue a retry");
if (enabled("off-while-parked")) assert.notEqual(cancelled.code, 0, "a cancelled run exits with the provider failure");
if (enabled("off-while-parked")) assert.match(cancelled.stderr, /WAKE_TEST off-trigger/);

if (enabled("loaded-off")) assert.equal(loadedOff.probes, 0, "loading the extension must not send probe traffic");
if (enabled("loaded-off")) assert.equal(loadedOff.chats, 1, "exactly the prompt's own request");
if (enabled("loaded-off")) assert.match(loadedOff.stderr, /WAKE_TEST ready/);

await record(
  `PASS real OMP CLI + real PVP: ${JSON.stringify(
    results.map((r) => ({ scenario: r.scenario, code: r.code, probes: r.probes, chats: r.chats, gaps: r.gaps })),
  )}`,
);
console.log("PASS real OMP CLI + real PVP");
