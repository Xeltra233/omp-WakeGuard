/** Real bundled OMP RPC regression: native A -> B fallback, then B outage. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const executable = process.env.OMP_EXECUTABLE;
const extension = process.env.WAKEGUARD_EXTENSION ?? join(root, "src", "index.ts");
const evidence = process.env.WAKEGUARD_EVIDENCE_DIR ?? join(root, "goal-1", "evidence");
const started = Date.now();
const records = [];
const frames = [];
const endpoints = [];
const labels = ["MAIN_FAIL_NATIVE_FALLBACK", "BACKUP_STILL_WORKS", "BACKUP_SITE_DOWN", "BACKUP_RECOVERED"];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const record = (kind, data = {}) => {
  const line = JSON.stringify({ at: Date.now() - started, kind, ...data });
  records.push(line);
  console.log(line);
};
let child, closed, spawnError, failure;
let stdout = "", stderr = "", partial = "", sequence = 0;
await mkdir(evidence, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "wakeguard-fallback-"));

async function endpoint(name, model) {
  const state = { healthy: true, quota: false, gets: [], posts: [] };
  const html = "<html><body>503 Service Unavailable</body></html>";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/v1/models" && req.method === "GET") {
      const status = state.healthy ? 200 : 503;
      state.gets.push({ at: Date.now() - started, status });
      res.writeHead(status, { "content-type": state.healthy ? "application/json" : "text/html" });
      res.end(state.healthy ? JSON.stringify({ object: "list", data: [{ id: model }] }) : html);
    } else if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse(raw);
      const users = (body.messages ?? []).filter((message) => message.role === "user").flatMap((message) =>
        typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text));
      const status = state.quota ? 429 : state.healthy ? 200 : 503;
      state.posts.push({ at: Date.now() - started, status, model: body.model, labels: users.filter((text) => labels.includes(text)) });
      if (status === 429) {
        // A long Retry-After selects OMP's real fallback instead of waiting.
        res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded for primary model", type: "rate_limit_error" } }));
      } else if (status === 503) {
        res.writeHead(503, { "content-type": "text/html", "retry-after": "0" });
        res.end(html);
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({
          id: "fixture", object: "chat.completion.chunk", created: 1, model,
          choices: [{ index: 0, delta: { role: "assistant", content: `FALLBACK_OK_${name}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`);
      }
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unexpected fixture route" } }));
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return { state, server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function wait(test, label, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = test();
    if (result) return result;
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI ended before ${label}: exit=${child.exitCode} signal=${child.signalCode}`);
    if (endpoints.some((item) => item.state.posts.length > 30)) throw new Error(`Unexpected retry flood before ${label}`);
    await pause(40);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function rpc(type, payload = {}) {
  const id = `fallback-${++sequence}`;
  const start = frames.length;
  child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n");
  const ack = await wait(() => frames.find((frame) => frame.type === "response" && frame.id === id && frame.command === type), `${type} acknowledgement`);
  assert.equal(ack.success, true, `${type} rejected: ${JSON.stringify(ack)}`);
  return { id, start, ack };
}
const prompt = (message) => rpc("prompt", { message });
async function settled(packet, success = true) {
  const result = await wait(() => frames.slice(packet.start).find((frame) => frame.type === "prompt_result" && frame.id === packet.id), "session completion", 60_000);
  assert.equal(result.agentInvoked, true);
  assert.equal(result.sessionSettled, true);
  if (success) {
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.ok(frames.slice(packet.start).some((frame) => frame.type === "message_end" && frame.message?.role === "assistant" && JSON.stringify(frame.message.content).includes("FALLBACK_OK_backup")), "Backup must return a real assistant result");
  }
  const state = (await rpc("get_state")).ack.data;
  assert.equal(state.isStreaming, false, "Completed prompt must leave OMP idle");
  assert.equal(state.model?.provider, "fallback-backup");
  assert.equal(state.model?.id, "backup");
  record("SETTLED", { id: packet.id, result, model: { provider: state.model.provider, id: state.model.id, baseUrl: state.model.baseUrl } });
}
async function notice(message) {
  const start = frames.length;
  await prompt(message);
  return wait(() => frames.slice(start).find((frame) => frame.type === "extension_ui_request" && frame.method === "notify"), `${message} notification`);
}
const status = () => notice("/wakeguard status");
// The footer slot is the extension's only passive surface: it must exist only
// while the watchdog is enabled. Frames are the RPC UI's own recording of
// `ui.setStatus`, so `statusText` absent means the host was told to clear it.
const footerFrames = () =>
  frames.filter((frame) => frame.type === "extension_ui_request" && frame.method === "setStatus" && frame.statusKey === "omp-wakeguard");
const footerTexts = () => footerFrames().filter((frame) => typeof frame.statusText === "string" && frame.statusText.length > 0);
const footerCleared = () => {
  const last = footerFrames().at(-1);
  return last !== undefined && (last.statusText === undefined || last.statusText === null);
};
const fixtureEvents = () => stderr.split("\n").filter((line) => line.startsWith("FALLBACK_FIXTURE ")).map((line) => JSON.parse(line.slice(17)));
const refused = (port) => new Promise((done) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(false); });
  socket.once("error", (error) => { socket.destroy(); done(error.code === "ECONNREFUSED"); });
});

try {
  endpoints.push(await endpoint("main", "main"));
  endpoints.push(await endpoint("backup", "backup"));
  const [primary, backup] = endpoints;
  const agent = join(work, "agent");
  await mkdir(agent);
  const settings = {
    modelRoles: { default: "fallback-primary/main" },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 100, maxDelayMs: 100, modelFallback: true,
      fallbackChains: { default: ["fallback-primary/main", "fallback-backup/backup"] } },
  };
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  await writeFile(join(agent, "config.yml"), JSON.stringify(settings));
  const command = executable ?? "bun";
  const args = executable ? [] : [join(root, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js")];
  args.push("--mode", "rpc", "--no-extensions", "--no-skills", "--no-tools", "--no-session", "--no-rules",
    "-e", extension, "-e", join(here, "fixtures", "fallback-host.ts"), "--thinking", "off", "--wakeguard-interval", "1000");
  record("LAUNCH", { command, args, agent, ports: endpoints.map((item) => item.port) });
  child = spawn(command, args, { cwd: work, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
    WAKEGUARD_FALLBACK_PROVIDERS: JSON.stringify([
      { name: "fallback-primary", model: "main", baseUrl: primary.url },
      { name: "fallback-backup", model: "backup", baseUrl: backup.url },
    ]),
  } });
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    partial += text;
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      try { frames.push(JSON.parse(line)); } catch { /* Non-RPC diagnostics remain in stdout evidence. */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  closed = new Promise((done) => {
    child.once("error", (error) => { spawnError = error; done(); });
    child.once("close", done);
  });
  await wait(() => fixtureEvents().some((event) => event.event === "ready"), "real OMP session ready");
  record("READY", { pid: child.pid });
  assert.match((await status()).message, /state:\s*off/i);
  assert.equal(primary.state.gets.length, 0);
  assert.equal(backup.state.gets.length, 0);
  // Loaded-but-unused: the footer slot must stay unclaimed while the watchdog is off.
  assert.equal(footerTexts().length, 0, "An unused wakeguard must not occupy the footer before /wakeguard on");
  await notice("/wakeguard on");
  await wait(() => primary.state.gets.at(-1)?.status === 200, "initial primary probe");
  await wait(() => footerTexts().length > 0, "footer entry after enabling");
  assert.match(footerTexts().at(-1).statusText, /^wakeguard (probing|sleeping)/);
  const initialGets = primary.state.gets.length;
  await pause(2200);
  assert.equal(primary.state.gets.length, initialGets, "Healthy primary must sleep across two intervals");

  primary.state.quota = true;
  await settled(await prompt(labels[0]));
  assert.ok(primary.state.posts.some((post) => post.status === 429), "Primary must actually fail");
  assert.ok(backup.state.posts.some((post) => post.status === 200 && post.model === "backup"));
  assert.ok(fixtureEvents().some((event) => event.event === "fallback_applied" && event.model?.provider === "fallback-backup"), "Require native fallback, never a manual set_model");
  record("NATIVE_FALLBACK", { primaryPosts: primary.state.posts, backupPosts: backup.state.posts });
  await settled(await prompt(labels[1]));

  const primaryGets = primary.state.gets.length;
  const backupGets = backup.state.gets.length;
  backup.state.healthy = false;
  const bad = await prompt(labels[2]);
  await wait(() => backup.state.gets.length >= backupGets + 2 && backup.state.gets.at(-1).status === 503, "automatic probes of failed backup", 45_000);
  await settled(bad, false);
  const probing = await status();
  assert.match(probing.message, /state:\s*probing/i);
  assert.ok(probing.message.includes(`${backup.url}/models`), "Status must target failed backup, not initial primary");
  await wait(() => /^wakeguard probing/.test(footerTexts().at(-1)?.statusText ?? ""), "probing footer entry");
  assert.equal(primary.state.gets.length, primaryGets, "Fallback outage must never probe the old primary");
  record("BACKUP_AUTO_WAKE", { status: probing.message, primaryGets: primary.state.gets, backupGets: backup.state.gets, backupPosts: backup.state.posts });

  backup.state.healthy = true;
  await wait(() => backup.state.gets.at(-1)?.status === 200, "backup recovery probe");
  const recoveredGets = backup.state.gets.length;
  const recoveredPosts = backup.state.posts.length;
  await pause(2200);
  assert.equal(backup.state.gets.length, recoveredGets, "Recovered backup must sleep across two intervals");
  assert.equal(backup.state.posts.length, recoveredPosts, "Without PVP, recovery must not replay the failed prompt");
  assert.match((await status()).message, /state:\s*sleeping/i);
  await wait(() => /^wakeguard sleeping$/.test(footerTexts().at(-1)?.statusText ?? ""), "sleeping footer entry");
  record("BACKUP_RECOVERY_SLEEP", { primaryGets: primary.state.gets, backupGets: backup.state.gets });

  await notice("/wakeguard check");
  assert.equal(backup.state.gets.length, recoveredGets + 1, "Manual check must also probe the actual backup");
  assert.equal(primary.state.gets.length, primaryGets);
  await settled(await prompt(labels[3]));
  assert.equal(backup.state.posts.length, recoveredPosts + 1);
  assert.equal(backup.state.posts.at(-1).labels.filter((label) => label === labels[3]).length, 1, "Recovered prompt must not be duplicated");

  await notice("/wakeguard off");
  await wait(footerCleared, "footer entry cleared by /wakeguard off");
  await notice(`/wakeguard url ${primary.url}/models`);
  const explicitBackupGets = backup.state.gets.length;
  await notice("/wakeguard on");
  await wait(() => primary.state.gets.length === primaryGets + 1, "explicit URL probe");
  const explicit = await status();
  assert.ok(explicit.message.includes(`${primary.url}/models [explicit]`), "Explicit URL must override fallback model binding");
  assert.equal(backup.state.gets.length, explicitBackupGets);
  await notice("/wakeguard off");
  await notice("/wakeguard url auto");
  await notice("/wakeguard on");
  await wait(() => backup.state.gets.length === explicitBackupGets + 1, "re-enabled watchdog uses current backup");
  const automatic = await status();
  assert.ok(automatic.message.includes(`${backup.url}/models [derived]`));
  const finalGets = endpoints.map((item) => item.state.gets.length);
  const finalPosts = endpoints.map((item) => item.state.posts.length);
  await pause(2200);
  assert.deepEqual(endpoints.map((item) => item.state.gets.length), finalGets);
  assert.deepEqual(endpoints.map((item) => item.state.posts.length), finalPosts);
  record("CURRENT_MODEL_COMMANDS", { autoStatus: automatic.message, explicitStatus: explicit.message, gets: finalGets, posts: finalPosts });
} catch (error) {
  failure = error;
  record("FAILURE", { message: error.message, stack: error.stack });
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await Promise.race([closed, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
  }
  let pidGone = true;
  if (child?.pid) {
    try { process.kill(child.pid, 0); pidGone = false; } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const ports = [];
  for (const item of endpoints) {
    item.server.closeAllConnections();
    await new Promise((done) => item.server.close(done));
    ports.push({ port: item.port, refused: await refused(item.port) });
  }
  record("CLEANUP", { pid: child?.pid, exitCode: child?.exitCode, signal: child?.signalCode, pidGone, ports });
  const prefix = join(evidence, `omp-fallback-${started}`);
  record("EVIDENCE", { records: `${prefix}.records.json`, stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log` });
  await writeFile(`${prefix}.records.json`, `[\n${records.join(",\n")}\n]\n`);
  await writeFile(`${prefix}.stdout.log`, stdout);
  await writeFile(`${prefix}.stderr.log`, stderr);
  await rm(work, { recursive: true, force: true });
  assert.equal(pidGone, true, "Fixture OMP must exit");
  assert.ok(ports.every((item) => item.refused), "Fixture ports must refuse connections after cleanup");
}
if (failure) throw failure;
console.log("PASS real OMP native fallback + backup outage + current-model commands");
