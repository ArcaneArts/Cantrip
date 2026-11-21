// Actual Node/native stdio clients, capability discovery and installed CLI.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { CodexRpcClient } from "../../tests/reference-node-worker/src/codex/rpc-client.ts";
import { spawnGuardedProcess } from "../../tests/reference-node-worker/src/process-guard.ts";
import {
  discoverCodexRuntime,
  discoverCodexVersion,
} from "../../tests/reference-node-worker/src/codex/discovery.ts";
import { verifyCodexInstallation } from "../../tests/reference-node-worker/src/codex/bundled-runtime.ts";
import { verifyPure } from "./codex-runtime-pure.mjs";
const { values } = parseArgs({
  options: { binary: { type: "string" }, codex: { type: "string" } },
});
assert.ok(values.binary);
assert.ok(values.codex);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-codex-runtime-"));
const originalSpawn = childProcess.spawn,
  previousConfig = process.env.CANTRIP_CODEX_FIXTURE;
const children = new Set();
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (args[2]?.env?.CANTRIP_GUARD_COMMAND) {
    const done = new Promise((resolve) => child.once("close", resolve));
    children.add(done);
    done.finally(() => children.delete(done));
  }
  return child;
};
syncBuiltinESMExports();
const processDriver = originalSpawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const finished = new Promise((resolve, reject) => {
  processDriver.once("close", resolve);
  processDriver.once("error", reject);
});
async function* lines(stream) {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    let end;
    while ((end = text.indexOf("\n")) >= 0) {
      yield text.slice(0, end);
      text = text.slice(end + 1);
    }
  }
  assert.equal(text, "");
}
const output = lines(processDriver.stdout);
async function native(input, raw = false) {
  processDriver.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  const result = JSON.parse(line.value);
  if (raw) return result;
  assert.equal(result.ok, true, result.error);
  return result.value;
}
const wire = (value) => JSON.parse(JSON.stringify(value));
const settle = (pending) =>
  pending.then(
    (value) => ({ ok: true, value: wire(value) }),
    (error) => ({ ok: false, error: error.message }),
  );
let comparisons = 0;
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
let client,
  serial = 0;
const pending = new Map();
async function spawn(config = {}, timeoutMs = 1000) {
  if (client) client.close();
  await Promise.all([...children]);
  process.env.CANTRIP_CODEX_FIXTURE = JSON.stringify(config);
  const home = path.join(root, String(++serial));
  await mkdir(home);
  const child = spawnGuardedProcess(
    values.binary,
    ["app-server", "--listen", "stdio://"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        CODEX_HOME: path.join(home, "node"),
      },
      stdin: "pipe",
    },
  );
  client = new CodexRpcClient(child, timeoutMs);
  await native({
    op: "rpc.spawn",
    binary: values.binary,
    cwd: root,
    home: path.join(home, "rust"),
    config,
    timeoutMs,
  });
}
async function request(method, params, name = "a") {
  pending.set(name, settle(client.request(method, params)));
  await native({ op: "rpc.request", method, params, name });
}
async function wait(method, pattern, name = "a", timeoutMs) {
  pending.set(
    name,
    settle(
      client.waitForNotification(
        method,
        (params) =>
          !pattern ||
          Object.entries(pattern).every(
            ([key, value]) => params?.[key] === value,
          ),
        timeoutMs,
      ),
    ),
  );
  await native({ op: "rpc.wait", method, pattern, name, timeoutMs });
}
async function compare(name = "a") {
  same(
    await native({ op: "await", name }, true),
    await pending.get(name),
    "actual RPC result / failure",
  );
  pending.delete(name);
}
try {
  await verifyPure({ native, same, root });
  await spawn();
  await request("fixture/echo", {
    value: { text: "Unicode 😀\ud800", missing: null },
    notifications: [
      { method: "complete", params: { id: "one" } },
      { method: "complete", params: { id: "two" } },
    ],
  });
  await compare();
  await wait("complete", { id: "two" });
  await compare();
  await wait("complete", { id: "one" });
  await compare();
  await wait("later", { wanted: true }, "wanted");
  await wait("later", null, "other");
  await request("fixture/echo", {
    value: true,
    notifications: [
      { method: "later", params: { wanted: false } },
      { method: "later", params: { wanted: true } },
    ],
  });
  await compare();
  await compare("wanted");
  await compare("other");
  await request("fixture/echo", {
    error: {
      code: -32602,
      message: "native rejection",
      data: { private: true },
    },
  });
  await compare();
  await request("fixture/echo", {
    lines: [
      "not json\r\nnull\n[]\r",
      '{"id":1.5,"result":"wrong"}\n',
      '{"method":7}\n',
    ],
    value: "after malformed lines",
  });
  await compare();
  client.notify("fixture/notice", { value: "accepted" });
  await native({
    op: "rpc.notify",
    method: "fixture/notice",
    params: { value: "accepted" },
  });
  await request("fixture/notified", {});
  await compare();

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, value) =>
      client.request("fixture/echo", { value }),
    ),
  );
  concurrent.sort((a, b) => a.result - b.result);
  same(
    await native({ op: "rpc.concurrent" }),
    {
      ids: concurrent.map((v) => v.id).sort((a, b) => a - b),
      results: concurrent.map((v) => v.result),
    },
    "concurrent native requests preserve unique IDs and replies",
  );
  const abandoned = {
    value: "abandoned",
    notifications: [{ method: "accepted", params: { committed: true } }],
  };
  client.request("fixture/echo", abandoned).catch(() => {});
  await native({
    op: "rpc.abandon",
    method: "fixture/echo",
    params: abandoned,
  });
  await wait("accepted", { committed: true });
  await compare();
  await request("fixture/echo", { value: "after abandoned response" });
  await compare();

  await spawn({}, 30);
  await request("fixture/hold", {}, "timeout");
  await compare("timeout");
  await request("fixture/release", {});
  await compare();
  await wait("absent", null, "notification", 30);
  await compare("notification");
  await spawn();
  const notifications = Array.from({ length: 101 }, (_, id) => ({
    method: "bounded",
    params: { id },
  }));
  await request("fixture/echo", { notifications, value: true });
  await compare();
  await wait("bounded", { id: 1 });
  await compare();
  await wait("bounded", { id: 0 }, "evicted", 30);
  await compare("evicted");
  await request("fixture/hold", {}, "held");
  client.close();
  await native({ op: "rpc.close" });
  await compare("held");
  await Promise.all([...children]);
  client = undefined;
  for (const code of [1, 130]) {
    await spawn();
    await request("fixture/exit", {
      code,
      stderr: [
        "discarded\r\n",
        '\u001b[31mfatal\u001b[0m API_KEY="private" Bearer hidden https://user:pass@example.invalid\r\n',
      ],
    });
    await compare();
  }
  if (process.platform !== "win32") {
    await spawn();
    await request("fixture/exit", {
      signal: true,
      stderr: ["actual owned peer signal\n"],
    });
    await compare();
  }

  if (client) {
    client.close();
    client = undefined;
  }
  await native({ op: "rpc.close" });
  await Promise.all([...children]);
  for (const config of [
    {},
    { rejectExperimental: true },
    { rejectInitialize: true },
    { initialize: { userAgent: "bad" } },
    { unavailable: ["turn/start", "plugin/list"] },
    { featureError: { code: -32601, message: "no feature method" } },
    {
      pages: [
        {
          data: [
            { name: "z", stage: "beta", enabled: true, defaultEnabled: false },
          ],
          nextCursor: "1",
        },
        { data: [], nextCursor: null },
      ],
    },
    { pages: [{ data: null, nextCursor: null }] },
    { versionRaw: "codex-cli 0.167.0", versionWarning: "warning on stderr" },
    { versionRaw: null },
  ]) {
    process.env.CANTRIP_CODEX_FIXTURE = JSON.stringify(config);
    const home = path.join(root, "discovery-" + ++serial);
    same(
      await native({
        op: "discover",
        binary: values.binary,
        cwd: root,
        home: path.join(home, "rust"),
        config,
      }),
      await discoverCodexRuntime(values.binary, path.join(home, "node")),
      "actual native process capability probe",
    );
    await Promise.all([...children]);
  }
  for (const config of [
    { versionWarning: "warning" },
    { versionStderr: true },
    { versionExit: 1 },
    { versionDelayMs: 100 },
  ]) {
    process.env.CANTRIP_CODEX_FIXTURE = JSON.stringify(config);
    same(
      await native({
        op: "version",
        binary: values.binary,
        cwd: root,
        config,
        timeoutMs: 30,
      }),
      await discoverCodexVersion(values.binary, 30),
      "actual version process / deadline",
    );
  }
  process.env.CANTRIP_CODEX_FIXTURE = JSON.stringify({ versionDelayMs: 30 });
  same(
    await native({
      op: "version",
      binary: values.binary,
      cwd: root,
      config: { versionDelayMs: 30 },
      timeoutMs: 0,
    }),
    await discoverCodexVersion(values.binary, 0),
    "zero version deadline is disabled",
  );
  process.env.CANTRIP_CODEX_FIXTURE = "{}";
  const blockedHome = path.join(root, "home-is-file");
  await writeFile(blockedHome, "owned blocker");
  for (const home of [blockedHome, path.join(blockedHome, "child")]) {
    same(
      await native(
        { op: "discover", binary: values.binary, cwd: root, home, config: {} },
        true,
      ),
      await settle(discoverCodexRuntime(values.binary, home)),
      "actual probe-home filesystem failure",
    );
  }
  delete process.env.CANTRIP_CODEX_FIXTURE;
  const installation = {
    binary: values.codex,
    manifestPath: path.join(path.dirname(values.codex), "codex-runtime.json"),
    source: "bundle",
  };
  same(
    await native({
      op: "verify",
      ...installation,
      cwd: root,
      platform: process.platform,
      architecture: process.arch,
    }),
    await verifyCodexInstallation(installation),
    "actual existing bundle manifest and artifact files",
  );
  const actual = await native({
    op: "discover",
    binary: values.codex,
    cwd: root,
    home: path.join(root, "actual-rust"),
    config: {},
  });
  const expected = await discoverCodexRuntime(
    values.codex,
    path.join(root, "actual-node"),
  );
  same(actual, expected, "existing real bundled native Codex probe");
  await Promise.all([...children]);
  assert.equal(actual.version.semantic, "0.166.0");
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      actualNodeAlgorithms: true,
      actualNativeStdioProcesses: true,
      existingBundledCodexProbe: true,
      realCodexCompatibility: actual.compatibility,
      noInference: true,
      rootRemovedOnExit: true,
    }),
  );
} finally {
  try {
    client?.close();
    if (processDriver.exitCode === null && processDriver.signalCode === null)
      await native({ op: "rpc.close" });
    await Promise.all([...children]);
    processDriver.stdin.end();
    assert.equal(await finished, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (previousConfig === undefined) delete process.env.CANTRIP_CODEX_FIXTURE;
    else process.env.CANTRIP_CODEX_FIXTURE = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
}
