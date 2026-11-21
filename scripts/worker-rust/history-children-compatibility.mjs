// Actual Node/native descendant discovery and real encrypted source scans.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { NativeHistoryDescendants } from "../../tests/reference-node-worker/src/native-history-descendants.ts";
import { NativeHistorySourceJournal } from "../../tests/reference-node-worker/src/native-history-source-journal.ts";
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
const snapshot = (id, parentThreadId) => ({
  thread: { id, parentThreadId, status: { type: "idle" }, turns: [] },
});
const headers = {
  root: null,
  child: "root",
  grandchild: "child",
  unrelated: null,
  loopA: "loopB",
  loopB: "loopA",
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-history-children-"));
let oracle,
  serial = 0;
class Oracle {
  constructor(config) {
    this.config = config;
    this.generation = "runtime-one";
    this.trace = [];
    this.errors = [];
    this.waiters = [];
    const self = this;
    this.runtime = {
      get transportGeneration() {
        return self.generation;
      },
      readNativeHistory: async (id) => {
        const reply = this.config.histories[id];
        await this.begin("read", id);
        return parseCodexNativeHistory(reply, id);
      },
    };
    this.owner = new NativeHistoryDescendants({
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
          return structuredClone(this.config.bindings[input.threadId]);
        },
      },
      bind: (input) => {
        const scope = {
          chatId: input.chatId,
          threadId: input.threadId,
          provenance: input.provenance,
        };
        this.trace.push({ kind: "bind", input: scope });
        return {
          reconcile: () => this.trace.push({ kind: "reconcile", input: scope }),
        };
      },
      retryDelayMs: 5,
      onError: (error) => this.errors.push(error.message),
    });
  }
  async begin(kind, input) {
    this.trace.push({ kind, input: structuredClone(input) });
    const failed = this.config[kind + "FailNext"] > 0;
    if (failed) this.config[kind + "FailNext"]--;
    while (this.config[kind + "Held"])
      await new Promise((resolve) => this.waiters.push(resolve));
    if (failed) throw new Error(`fixture ${kind} failed`);
  }
  configure(config) {
    Object.assign(this.config, config);
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  resolve(thread, provenance) {
    return this.owner.resolve(
      { runtime: this.runtime, chatId: "chat", threadId: "root", provenance },
      thread,
    );
  }
}
async function init(extra = {}) {
  if (oracle) {
    oracle.configure({ readHeld: false, openHeld: false });
    await oracle.owner.stop();
    await native({
      op: "configure",
      config: { readHeld: false, openHeld: false },
    });
    await native({ op: "children.stop.start" });
    await native({ op: "children.await" });
  }
  const config = {
    retryDelayMs: 5,
    histories: Object.fromEntries(
      Object.entries(headers).map(([id, parent]) => [id, snapshot(id, parent)]),
    ),
    bindings: Object.fromEntries(
      Object.keys(headers).map((id) => [
        id,
        { id: `binding-${id}`, chatId: "chat", threadId: id },
      ]),
    ),
    ...extra,
  };
  oracle = new Oracle(structuredClone(config));
  await native({ op: "init", generation: "runtime-one", config });
  oracle.directory = path.join(root, String(++serial));
  await native({
    op: "children.start",
    directory: path.join(oracle.directory, "native"),
  });
}
async function start(thread, name = "a", provenance) {
  const result = oracle.resolve(thread, provenance).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: error.message }),
  );
  await native({
    op: "children.resolve.start",
    chatId: "chat",
    rootThreadId: "root",
    threadId: thread,
    name,
    provenance,
  });
  return { promise: result };
}
async function compare(thread, name = "a", provenance) {
  const result = await start(thread, name, provenance);
  same(
    await call({ op: "children.await", name }),
    await result.promise,
    "verified output scope / failure",
  );
}
async function trace() {
  same(
    (await native({ op: "children.state" })).trace,
    oracle.trace,
    "actual native read/open/bind/reconcile order",
  );
}
async function configure(config) {
  oracle.configure(config);
  await native({ op: "configure", config });
}
try {
  await init({ readHeld: true });
  const a = await start("grandchild", "a"),
    b = await start("grandchild", "b");
  await until(
    async () =>
      oracle.trace.some((v) => v.kind === "read") &&
      (await native({ op: "children.state" })).trace.some(
        (v) => v.kind === "read",
      ),
    "shared pending read",
  );
  await configure({ readHeld: false });
  same(
    await call({ op: "children.await", name: "a" }),
    await a.promise,
    "first shared resolution",
  );
  same(
    await call({ op: "children.await", name: "b" }),
    await b.promise,
    "second shared resolution",
  );
  await compare("grandchild");
  await trace();
  same(
    oracle.trace.filter((v) => v.kind === "read").map((v) => v.input),
    ["grandchild", "child"],
    "rootward reads shared across callers",
  );
  same(
    oracle.trace.filter((v) => v.kind === "open").map((v) => v.input.threadId),
    ["root", "child", "grandchild"],
    "parent-first binding opens",
  );
  await compare("grandchild", "historical", {
    kind: "binding",
    bindingId: "binding-root",
  });
  await trace();
  await compare("root");
  await trace();

  for (const thread of ["unrelated", "loopA"]) {
    await init();
    await compare(thread);
    await trace();
    same(
      oracle.trace.some((v) => v.kind === "open"),
      false,
      "unverified chain never opens server binding",
    );
  }
  const long = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `depth-${i}`,
      snapshot(`depth-${i}`, i === 31 ? "root" : `depth-${i + 1}`),
    ]),
  );
  await init({ histories: long });
  await compare("depth-0");
  await trace();

  // Failed immutable lookups are evicted; verified successes stay cached.
  await init({ readFailNext: 1 });
  await compare("child");
  await compare("child");
  await trace();
  await init({ openFailNext: 1 });
  await compare("child");
  await compare("child");
  await trace();
  await init({
    bindings: { root: { id: "bad", chatId: "foreign", threadId: "root" } },
  });
  await compare("child");
  await trace();
  await init({
    bindings: {
      root: { id: "binding-root", chatId: "chat", threadId: "root" },
      child: { id: "wrong-child", chatId: "chat", threadId: "foreign" },
    },
  });
  await compare("child");
  await trace();

  await init({ readHeld: true });
  const replaced = await start("child");
  await until(
    async () =>
      oracle.trace.some((v) => v.kind === "read") &&
      (await native({ op: "children.state" })).trace.some(
        (v) => v.kind === "read",
      ),
    "held native read",
  );
  oracle.generation = "runtime-two";
  await native({ op: "replace", generation: "runtime-two" });
  await configure({ readHeld: false });
  same(
    await call({ op: "children.await" }),
    await replaced.promise,
    "replaced native evidence rejected",
  );
  await compare("child");
  await trace();
  for (const held of ["readHeld", "openHeld"]) {
    await init({ [held]: true });
    const pending = await start("child");
    const kind = held === "readHeld" ? "read" : "open";
    await until(
      async () =>
        oracle.trace.some((v) => v.kind === kind) &&
        (await native({ op: "children.state" })).trace.some(
          (v) => v.kind === kind,
        ),
      "held shutdown boundary",
    );
    await oracle.owner.stop();
    await native({ op: "children.stop.start", name: "stop" });
    await native({ op: "children.await", name: "stop" });
    same(
      await call({ op: "children.await" }),
      await pending.promise,
      "shutdown abandons native read / aborts metadata",
    );
    await configure({ readHeld: false, openHeld: false });
    same(
      oracle.trace.some((v) => v.kind === "bind"),
      false,
      "shutdown never accepts late child binding",
    );
  }

  // Scan actual encrypted records; repair an actual unreadable record before
  // consuming it. Unrelated candidates do not poison verified siblings.
  await init();
  const records = [
    { type: "subAgentActivity", agentThreadId: "unrelated" },
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      receiverThreadIds: ["root", "child", "child", "", 3],
    },
  ].map((item, i) => ({
    kind: "notification",
    generation: "runtime-one",
    threadId: "root",
    sequence: i + 1,
    receivedAtMs: 1,
    method: "item/completed",
    params: {
      threadId: "root",
      turnId: "turn",
      item: { id: `activity-${i}`, ...item },
    },
  }));
  const journal = await NativeHistorySourceJournal.open({
    directory: path.join(oracle.directory, "node"),
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding-root",
    threadId: "root",
    service,
  });
  for (const frame of records) await journal.append(frame);
  const nativeDirectory = await native({
    op: "children.source",
    chatId: "chat",
    bindingId: "binding-root",
    threadId: "root",
    frames: records,
  });
  const files = [journal.directory, nativeDirectory].map((directory) =>
    path.join(directory, "0000000000000001.source.json"),
  );
  const original = await Promise.all(files.map((file) => readFile(file)));
  for (const file of files) await writeFile(file, "{broken");
  oracle.owner.wake(
    journal,
    { chatId: "chat", threadId: "root", bindingId: "binding-root" },
    oracle.runtime,
  );
  await native({ op: "children.wake" });
  await until(
    async () =>
      oracle.errors.length &&
      (await native({ op: "children.state" })).errors.length,
    "actual encrypted source read failure",
  );
  for (let i = 0; i < files.length; i++) await writeFile(files[i], original[i]);
  await native({ op: "children.flush.start" });
  await oracle.owner.flush();
  await native({ op: "children.await" });
  await trace();
  same(
    oracle.trace.filter((v) => v.kind === "bind").map((v) => v.input.threadId),
    ["child", "child"],
    "disproven candidate skipped, verified child bound and reconciled",
  );
  same(
    (await native({ op: "children.state" })).errors.some((v) =>
      v.error.includes("verify its parent"),
    ),
    true,
    "unrelated candidate diagnosed without endless retry",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      actualNodeDescendants: true,
      actualNativeDescendants: true,
      realEncryptedJournalRepair: true,
      rootRemovedOnExit: true,
    }),
  );
} finally {
  if (oracle) {
    oracle.configure({ readHeld: false, openHeld: false });
    await oracle.owner.stop();
    await native({
      op: "configure",
      config: { readHeld: false, openHeld: false },
    });
    await native({ op: "children.stop.start" });
    await native({ op: "children.await" });
  }
  child.stdin.end();
  assert.equal(await finished, 0);
  await rm(root, { recursive: true, force: true });
}
