// Actual Node/native settlement, owned WebSocket processes and installed Codex.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Reference, settle } from "./codex-session-reference.mjs";
import { pure } from "./codex-session-pure.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" }, codex: { type: "string" } } });
assert.ok(values.binary); assert.ok(values.codex);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-codex-session-"));
const child = spawn(values.binary, [], { env: { ...process.env, PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "inherit"] });
const finished = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
async function* lines(stream) { stream.setEncoding("utf8"); let partial = ""; for await (const chunk of stream) { partial += chunk; let at; while ((at = partial.indexOf("\n")) >= 0) { yield partial.slice(0, at); partial = partial.slice(at + 1); } } assert.equal(partial, ""); }
const output = lines(child.stdout), reference = new Reference();
let comparisons = 0, serial = 0, exitReleaseFile, homes;
function same(actual, expected, label) { assert.deepEqual(actual, expected, label); comparisons++; }
async function native(input, raw = false) { child.stdin.write(JSON.stringify(input) + "\n"); const line = await output.next(); assert.equal(line.done, false); const value = JSON.parse(line.value); if (raw) return value; assert.equal(value.ok, true, value.message); return value.value; }
async function pair(input) {
  const node = input.op === "await" ? await reference.call(input) : await settle(reference.call(input));
  const rust = await native(input, true);
  if (input.op === "session.initialize" && node.value?.codexHome) {
    assert.equal(node.value.codexHome, homes.node);
    assert.equal(rust.value?.codexHome, homes.rust);
    // Each real runtime must use its own profile. Compare the reported path
    // against its actual realpath before normalizing that injected difference.
    node.value.codexHome = homes.rust;
  }
  same(rust, node, input.op); return rust.value;
}
async function open(config = {}, binary = values.binary) {
  const home = path.join(root, String(++serial)); await mkdir(home);
  await mkdir(path.join(home, "node")); await mkdir(path.join(home, "rust"));
  homes = { node: await realpath(path.join(home, "node")), rust: await realpath(path.join(home, "rust")) };
  if (config.holdExit) { exitReleaseFile = path.join(home, "release-owned-peers"); config = { ...config, exitReleaseFile }; }
  const input = { op: "session.open", binary, cwd: root, config, secrets: ["secret-key"] };
  const node = await settle(reference.call({ ...input, home: path.join(home, "node") }));
  const rust = await native({ ...input, home: path.join(home, "rust") }, true);
  same(rust, node, "actual managed native process startup"); return rust;
}
try {
  await pure({ native, same });
  await pair({ op: "new" });
  await pair({ op: "request", method: "thread/read", params: { text: "😀\ud800" }, name: "normal", observe: true });
  await pair({ op: "snapshot" });
  await pair({ op: "response", message: { id: "01", result: { value: "😀\ud800" }, extra: true } });
  await pair({ op: "await", name: "normal" }); await pair({ op: "snapshot" });
  await pair({ op: "request", method: "cantrip/inference", params: {}, name: "private", observe: true, timeoutMs: 20 });
  await pair({ op: "await", name: "private" }); await pair({ op: "snapshot" });
  await pair({ op: "response", message: { id: "2", result: { label: "PRIVATE_LABEL" } } });
  const late = await pair({ op: "snapshot" }); assert.equal(JSON.stringify(late.diagnostics).includes("PRIVATE_LABEL"), false); assert.equal(late.tickets.at(-1).state, "replied");

  await pair({ op: "new", sendError: "send rejected before acceptance" });
  await pair({ op: "request", method: "cantrip/inference", params: {}, name: "not-sent", observe: true, failObserver: "notSent", timeoutMs: 10 });
  await pair({ op: "await", name: "not-sent" }); const unsent = await pair({ op: "snapshot" }); assert.deepEqual(unsent.tickets, [{ name: "not-sent", state: "notSent" }]);
  await pair({ op: "new" });
  await pair({ op: "request", method: "cantrip/inference", name: "lost", observe: true });
  await pair({ op: "reject", message: "socket lost" }); await pair({ op: "await", name: "lost" });
  assert.deepEqual((await pair({ op: "snapshot" })).tickets, []);
  await pair({ op: "new" });
  await pair({ op: "request", method: "thread/read", name: "observer", observe: true, failObserver: "replied" });
  await pair({ op: "response", message: { id: "0x1", method: "", result: 33 } });
  await pair({ op: "await", name: "observer" }); await pair({ op: "snapshot" });
  await pair({ op: "request", method: "thread/read", name: "abandoned", observe: true, abandon: true });
  await pair({ op: "response", message: { id: 2, result: true } }); await pair({ op: "snapshot" });
  await pair({ op: "request", method: "thread/read", name: "missing" });
  await pair({ op: "response", message: { id: 3 } }); await pair({ op: "await", name: "missing" });
  await pair({ op: "request", method: "thread/read", name: "native-error" });
  await pair({ op: "response", message: { id: 4, error: { code: -32602, message: "Bearer hidden", data: { scope: "retained native error" } } } });
  await pair({ op: "await", name: "native-error" }); await pair({ op: "snapshot" });
  await pair({ op: "new" });
  await pair({ op: "request", method: "future/\ud800", name: "utf16-deadline", timeoutMs: 1 });
  await pair({ op: "await", name: "utf16-deadline" });
  await pair({ op: "response", message: { id: "\ud800", result: true } }); await pair({ op: "snapshot" });

  await open({ colored: true, endpointOnStderr: true });
  await pair({ op: "session.initialize" });
  await pair({ op: "request", method: "fixture/echo", params: { value: { text: "😀\ud800" } }, name: "echo", observe: true });
  await pair({ op: "await", name: "echo" });
  await pair({ op: "request", method: "fixture/server", params: { scope: "owned" }, name: "server" }); await pair({ op: "await", name: "server" });
  await pair({ op: "session.event" }); await pair({ op: "session.send", message: { id: "server-one", result: { handled: true } } });
  await pair({ op: "session.send", message: { method: "fixture/clientNotice", params: { value: 1 } } });
  await pair({ op: "request", method: "fixture/received", params: {}, name: "received" }); await pair({ op: "await", name: "received" });
  await pair({ op: "request", method: "fixture/invalid", params: { frames: ["not json", "[]", '{"id":null}', '{"method":"future/notification","params":{"value":1}}'] }, name: "invalid" });
  await pair({ op: "await", name: "invalid" }); await pair({ op: "session.event" }); await pair({ op: "snapshot" });
  await pair({ op: "request", method: "fixture/notify", params: { notices: [{ method: "thread/nativeResources/requested", params: { data: "PRIVATE_CONTROL_CONTEXT" } }, { method: "thread/managedExecution/requested", params: { trigger: "inference", data: "PRIVATE_CONTROL_CONTEXT" } }] }, name: "private-control" });
  await pair({ op: "await", name: "private-control" }); await pair({ op: "session.event" }); await pair({ op: "session.event" });
  assert.equal(JSON.stringify((await pair({ op: "snapshot" })).diagnostics).includes("PRIVATE_CONTROL_CONTEXT"), false);
  await pair({ op: "request", method: "cantrip/inference", params: { hold: true, value: { label: "PRIVATE_NATIVE_LABEL" } }, name: "late-native", observe: true, timeoutMs: 20 });
  await pair({ op: "await", name: "late-native" });
  await pair({ op: "request", method: "fixture/release", params: {}, name: "released" }); await pair({ op: "await", name: "released" });
  const networkLate = await pair({ op: "snapshot" }); assert.equal(JSON.stringify(networkLate.diagnostics).includes("PRIVATE_NATIVE_LABEL"), false); assert.equal(networkLate.tickets.at(-1).state, "replied");
  await pair({ op: "session.close" }); await pair({ op: "session.close" });
  await pair({ op: "session.status" });
  await pair({ op: "request", method: "thread/read", name: "closed", observe: true }); await pair({ op: "await", name: "closed" }); await pair({ op: "snapshot" });

  if (process.platform !== "win32") {
    await open({ ignoreInterrupt: true, holdExit: true });
    await pair({ op: "request", method: "cantrip/inference", params: { hold: true, value: "never a reply" }, name: "held", observe: true });
    await pair({ op: "request", method: "fixture/close", params: {}, name: "closing", observe: true });
    await pair({ op: "await", name: "held" }); await pair({ op: "await", name: "closing" });
    await pair({ op: "session.event" });
    const lost = await pair({ op: "session.status" }); assert.equal(lost.processExited, false); assert.equal(lost.generation, false);
    await writeFile(exitReleaseFile, "release owned fixture peers");
    await pair({ op: "session.event" }); assert.equal((await pair({ op: "session.status" })).processExited, true);
    assert.deepEqual((await pair({ op: "snapshot" })).tickets, []);
    await pair({ op: "session.close" });
  }
  await open({ stderr: ["warning", "\u001b[31mfatal secret-key Bearer hidden\u001b[0m"], exitBeforeListening: 130 });
  await reference.close();
  const noEndpoint = await native({ op: "session.open", binary: values.binary, cwd: root, home: path.join(root, "no-endpoint"), config: { noEndpoint: true }, timeoutMs: 30 }, true);
  assert.equal(noEndpoint.ok, false); assert.equal(noEndpoint.message, "Codex app-server did not announce an endpoint within 120 seconds.");
  await open({}, values.codex); await pair({ op: "session.initialize" });
  await pair({ op: "request", method: "thread/list", params: { cursor: null, limit: 10, archived: false }, name: "actual-local-threads" });
  const actual = await pair({ op: "await", name: "actual-local-threads" }); assert.deepEqual(actual.data, []);
  const missingGate = "df6d13fd-84f7-4c81-bef6-26d171c0bb8f";
  await pair({
    op: "request",
    method: "thread/managedExecution/inferenceClaim",
    params: {
      threadId: missingGate,
      turnId: missingGate,
      scopeId: missingGate,
      attemptId: missingGate,
      runnerGeneration: missingGate,
    },
    name: "actual-missing-inference-claim",
  });
  const claim = await pair({ op: "await", name: "actual-missing-inference-claim" });
  assert.equal(claim.claimed, false);
  await pair({ op: "session.close" }); assert.equal((await pair({ op: "session.status" })).processExited, true);
  console.log(JSON.stringify({ status: "passed", comparisons, actualNodeAlgorithms: true, actualNativeWebSocketProcesses: true, lateReplySettlesAfterObservationTimeout: true, socketLossDoesNotSettle: true, actualExitFence: true, existingCodexManagedSession: true, noInference: true, rootRemovedOnExit: true }));
} finally {
  try { await reference.close(); if (child.exitCode === null && child.signalCode === null) child.stdin.end(); assert.equal(await finished, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
}
