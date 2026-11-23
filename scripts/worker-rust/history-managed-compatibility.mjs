// Actual Node/native managed captures over independent encrypted profiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ManagedNativeHistorySources } from "../../tests/reference-node-worker/src/managed-native-history-sources.ts";
import { NativeHistorySourceJournal } from "../../tests/reference-node-worker/src/native-history-source-journal.ts";
import { NativeHistoryObservations } from "../../tests/reference-node-worker/src/codex/native-history-observation.ts";
import { parseCodexNativeHistory } from "../../tests/reference-node-worker/src/codex/native-history.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary);
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const finished = new Promise((resolve, reject) => {
  child.once("close", resolve);
  child.once("error", reject);
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
const output = lines(child.stdout);
async function call(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
async function native(input) {
  const result = await call(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
let comparisons = 0;
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
async function until(test, label) {
  for (let i = 0; i < 400; i++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out: " + label);
}
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(31), keyRevision: 1 }),
};
const scope = {
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
  bindingId: "binding",
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-history-managed-"));
const originalNow = Date.now;
Date.now = () => 1000;
let oracle,
  serial = 0;
class Oracle {
  constructor(directory, config) {
    this.directory = directory;
    this.config = config;
    this.generation = "runtime-1";
    this.hub = new NativeHistoryObservations();
    this.hub.replace(this.generation);
    this.trace = [];
    this.errors = [];
    this.waiters = [];
    this.captures = new Map();
    const self = this;
    this.runtime = {
      get transportGeneration() {
        return self.generation;
      },
      observeNativeHistory: (thread, observer) =>
        this.hub.subscribe(thread, observer, async () => {
          await this.begin("read", thread);
          return parseCodexNativeHistory(
            { thread: { id: thread, status: { type: "idle" }, turns: [] } },
            thread,
          );
        }),
    };
    this.sources = new ManagedNativeHistorySources({
      directory: path.join(directory, "node", "sources"),
      workerId: "worker",
      service,
      client: {
        open: async (input, signal) => {
          const pending = this.begin("open", input);
          await new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) return abort();
            signal.addEventListener("abort", abort, { once: true });
            pending
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", abort));
          });
          return { id: "binding" };
        },
      },
      retryDelayMs: config.retryDelayMs,
      maxRetryDelayMs: config.maxRetryDelayMs,
      snapshotDelayMs: config.snapshotDelayMs,
      bindingTimeoutMs: config.bindingTimeoutMs,
      onPersisted: (_journal, value) => this.begin("persisted", value),
      onError: (error, value) =>
        this.errors.push({ phase: value.phase, error: error.message }),
    });
  }
  async begin(kind, input) {
    this.trace.push({ kind, input: structuredClone(input) });
    const fail = this.config[kind + "FailNext"] > 0;
    if (fail) this.config[kind + "FailNext"]--;
    while (this.config[kind + "Held"])
      await new Promise((resolve) => this.waiters.push(resolve));
    if (fail) throw new Error(`fixture ${kind} failed`);
  }
  configure(config) {
    Object.assign(this.config, config);
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  bind(name = "a", provenance) {
    const capture = this.sources.bind({
      runtime: this.runtime,
      chatId: "chat",
      threadId: "thread",
      provenance,
    });
    this.captures.set(name, capture);
    return { generation: capture.generation, aborted: capture.signal.aborted };
  }
  count(kind) {
    return this.trace.filter((v) => v.kind === kind).length;
  }
}
async function init(config = {}) {
  if (oracle) {
    oracle.configure({
      openHeld: false,
      persistedHeld: false,
      readHeld: false,
    });
    await oracle.sources.stopAndWait();
    await native({
      op: "configure",
      config: { openHeld: false, persistedHeld: false, readHeld: false },
    });
    await native({ op: "manager.stop" });
  }
  const directory = path.join(root, String(++serial));
  config = {
    retryDelayMs: 5,
    maxRetryDelayMs: 10,
    snapshotDelayMs: 0,
    binding: { id: "binding" },
    ...config,
  };
  oracle = new Oracle(directory, structuredClone(config));
  await native({ op: "init", generation: "runtime-1", config });
  await native({
    op: "manager.start",
    directory: path.join(directory, "native"),
  });
  return oracle;
}
async function configure(config) {
  oracle.configure(config);
  await native({ op: "configure", config });
}
async function bind(name, provenance) {
  same(
    await native({ op: "manager.bind", name, provenance }),
    oracle.bind(name, provenance),
    "binding lifetime",
  );
}
async function emit(id) {
  const params = {
    threadId: "thread",
    turnId: "turn",
    item: { id, type: "agentMessage", text: "PRIVATE_MANAGED_CAPTURE" },
  };
  oracle.hub.notification("item/completed", params);
  await native({ op: "notification", method: "item/completed", params });
}
async function reads(count = 1) {
  await until(
    async () =>
      oracle.count("read") === count &&
      (await native({ op: "manager.state" })).trace.filter(
        (v) => v.kind === "read",
      ).length === count,
    "matching snapshot read boundary",
  );
}
async function flush(close = false) {
  const pending = close ? oracle.sources.close() : oracle.sources.flush();
  await native({ op: close ? "manager.close.start" : "manager.flush.start" });
  await pending;
  await native({ op: "manager.await" });
}
async function frames(sort = false) {
  const journal = await NativeHistorySourceJournal.open({
    ...scope,
    directory: path.join(oracle.directory, "node", "sources"),
    service,
  });
  const normal = (frames) => {
    frames = structuredClone(frames);
    for (const frame of frames) if (frame.kind === "snapshot") delete frame.id;
    if (sort)
      frames.sort((a, b) =>
        JSON.stringify([a.generation, a.kind, a.sequence ?? 0]).localeCompare(
          JSON.stringify([b.generation, b.kind, b.sequence ?? 0]),
        ),
      );
    return frames;
  };
  same(
    normal(await native({ op: "manager.records" })),
    normal((await journal.read()).map((v) => v.frame)),
    "encrypted journal contents",
  );
  return journal;
}
try {
  // Subscription precedes binding I/O; failed attempts use updated provenance.
  await init({ openHeld: true, openFailNext: 1 });
  await bind("a");
  await reads();
  await emit("before-binding");
  await bind("b", { kind: "binding", bindingId: "historical-binding" });
  same(
    oracle.captures.get("a"),
    oracle.captures.get("b"),
    "same runtime views share a capture",
  );
  await until(
    async () =>
      oracle.count("open") &&
      (await native({ op: "manager.state" })).trace.some(
        (v) => v.kind === "open",
      ),
    "held binding attempts",
  );
  await configure({ openHeld: false });
  await flush();
  await frames();
  const state = await native({ op: "manager.state" });
  same(
    state.trace.filter((v) => v.kind === "read").length,
    1,
    "native shared observation reads once",
  );
  same(oracle.count("read"), 1, "reference shared observation reads once");
  same(
    state.trace.filter((v) => v.kind === "open").at(-1).input.provenance,
    { kind: "binding", bindingId: "historical-binding" },
    "retry keeps admitted provenance",
  );
  same(
    state.errors.some((v) => v.error === "fixture open failed"),
    true,
    "binding failure reported",
  );

  // Real filesystem obstruction; retiring transport must retain its exact tail.
  await init();
  await bind("old");
  await flush();
  const journal = await frames();
  const [key] = await readdir(path.join(oracle.directory, "native", "sources"));
  const blocked = [
    path.join(journal.directory, "0000000000000002.source.json"),
    path.join(
      oracle.directory,
      "native",
      "sources",
      key,
      "0000000000000002.source.json",
    ),
  ];
  for (const file of blocked) await mkdir(file);
  await emit("old-tail");
  await until(
    async () =>
      oracle.errors.length &&
      (await native({ op: "manager.state" })).errors.length,
    "actual disk failure",
  );
  oracle.generation = "runtime-2";
  oracle.hub.replace(oracle.generation);
  await native({ op: "replace", generation: "runtime-2" });
  await bind("replacement");
  await reads(2);
  await emit("new-tail");
  for (const file of blocked) await rm(file, { recursive: true });
  await flush(true);
  await frames(true);
  same(
    (await native({ op: "manager.state" })).captures.every(
      (v) => v.aborted && !v.pendingRecords,
    ),
    true,
    "both native generations drained after repair",
  );
  same(
    (await call({ op: "manager.bind" })).error,
    "Managed history capture has been stopped.",
    "closed manager rejects binding",
  );

  // One binding timeout never retires observation or starts model input again.
  await init({ bindingTimeoutMs: 30, openHeld: true });
  await bind("timeout");
  await reads();
  await emit("during-timeout");
  await until(
    async () =>
      oracle.errors.some((v) => v.error.includes("timeout")) &&
      (await native({ op: "manager.state" })).errors.some((v) =>
        v.error.includes("timeout"),
      ),
    "per-attempt timeout",
  );
  await configure({ openHeld: false });
  await flush();
  await frames();
  same(
    (await native({ op: "manager.state" })).captures[0].aborted,
    false,
    "binding timeout keeps subscription active",
  );
  same(
    oracle.captures.get("timeout").signal.aborted,
    false,
    "reference timeout keeps subscription active",
  );
  same(oracle.count("read"), 1, "no repeated snapshot after binding timeout");

  // Final teardown aborts held metadata I/O; unsaved frames remain unsaved.
  await init({ openHeld: true });
  await bind("held");
  await reads();
  await emit("unsaved-tail");
  await until(
    async () =>
      oracle.count("open") &&
      (await native({ op: "manager.state" })).trace.some(
        (v) => v.kind === "open",
      ),
    "held final request",
  );
  same(
    await native({ op: "manager.stop" }),
    await oracle.sources.stopAndWait(),
    "stop reports actual unsaved frames",
  );
  same(
    (await native({ op: "manager.state" })).captures[0].aborted,
    true,
    "final stop retires observation",
  );

  // Stop waits for accepted persistence callbacks before releasing key owners.
  await init({ persistedHeld: true });
  await bind("persisted");
  await until(
    async () =>
      oracle.count("persisted") &&
      (await native({ op: "manager.state" })).trace.some(
        (v) => v.kind === "persisted",
      ),
    "held persisted callbacks",
  );
  let stopped = false;
  const stopping = oracle.sources.stopAndWait().then((v) => {
    stopped = true;
    return v;
  });
  await native({ op: "manager.stop.start" });
  await native({ op: "tick", ms: 15 });
  same(stopped, false, "reference stop waits for accepted callback");
  same(
    await native({ op: "manager.poll" }),
    { ready: false },
    "native stop waits for accepted callback",
  );
  await configure({ persistedHeld: false });
  same(
    await native({ op: "manager.await" }),
    await stopping,
    "stop settles actual callback before reporting counts",
  );
  await frames();
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      actualNodeSources: true,
      actualNativeSources: true,
      realEncryptedJournals: true,
      realDiskRepair: true,
      rootRemovedOnExit: true,
    }),
  );
} finally {
  if (oracle) {
    oracle.configure({
      openHeld: false,
      persistedHeld: false,
      readHeld: false,
    });
    await oracle.sources.stopAndWait();
    await native({
      op: "configure",
      config: { openHeld: false, persistedHeld: false, readHeld: false },
    });
    await native({ op: "manager.stop" });
  }
  Date.now = originalNow;
  child.stdin.end();
  assert.equal(await finished, 0);
  await rm(root, { recursive: true, force: true });
}
