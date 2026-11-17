// Real Node/native history encryption and durable-file interoperability.
// All profiles and keys are synthetic; both implementations run sequentially.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  mkdir,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.ts";
import { NativeHistoryCursorTracker } from "../../cantrip_worker/src/native-history-cursor-tracker.ts";
import { parseCodexNativeHistory } from "../../cantrip_worker/src/codex/native-history.ts";
import * as content from "../../cantrip_worker/src/native-history-content.ts";
import { schemas } from "./history-source-contracts.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass the built --binary history-source-fixture");
const directory = await mkdtemp(path.join(tmpdir(), "cantrip-history-native-"));
let child, completion, lines;
function start() {
  child = spawn(path.resolve(values.binary), [], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const owned = child;
  completion = new Promise((resolve, reject) => {
    owned.once("error", reject);
    owned.once("close", resolve);
  });
  lines = jsonLines(child.stdout);
}
async function* jsonLines(stream) {
  stream.setEncoding("utf8");
  let partial = "";
  for await (const chunk of stream) {
    partial += chunk;
    let end;
    while ((end = partial.indexOf("\n")) >= 0) {
      yield partial.slice(0, end);
      partial = partial.slice(end + 1);
    }
  }
  assert.equal(partial, "", "unterminated native JSON frame");
}
start();
let comparisons = 0,
  state = { owner: "owner", server: "server", revision: 1 };
const service = {
  ownerId: () => state.owner,
  serverIdentity: () => state.server,
  componentKey: (_scope, at = state.revision) => {
    if (at === 99) throw new Error("Missing historical chat-content key.");
    return { key: new Uint8Array(32).fill(at), keyRevision: at };
  },
};
const input = {
  directory,
  workerId: "worker",
  chatId: "chat",
  bindingId: "binding",
  threadId: "thread",
  service,
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const file = (journal, n = 1) =>
  path.join(journal.directory, String(n).padStart(16, "0") + ".source.json");
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
  return actual;
}
async function rust(request) {
  child.stdin.write(JSON.stringify(request) + "\n");
  const result = await lines.next();
  assert.equal(result.done, false, "native fixture exited");
  return JSON.parse(result.value);
}
async function native(request) {
  const result = await rust(request);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function compare(request, run, label = request.op) {
  return same(await rust(request), await observe(run), label);
}
async function identity(next) {
  state = { ...state, ...next };
  await native({ op: "identity", state });
}
const notification = (sequence, extra = {}) => ({
  kind: "notification",
  generation: "runtime-1",
  sequence,
  threadId: "thread",
  receivedAtMs: sequence,
  method: "item/completed",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: `native-${sequence}`,
      type: "agentMessage",
      text: "private \ud800 source evidence",
    },
  },
  ...extra,
});
const snapshot = (extra = {}) => ({
  kind: "snapshot",
  generation: "runtime-1",
  id: randomUUID(),
  threadId: "thread",
  receivedAtMs: 4,
  readBarrierSequence: 1,
  completedSequence: 3,
  snapshot: {
    thread: {
      id: "thread",
      status: { type: "idle", future: 1 },
      turns: [
        {
          id: "turn",
          status: "completed",
          items: [notification(1).params.item],
          future: true,
        },
      ],
    },
    future: { 10: "index", 2: 2, "\ud800": "lone key" },
  },
  ...extra,
});
const open = (handle, extra = {}) =>
  native({ op: "open", handle, directory, ...extra });
async function collect(extra = {}) {
  const entries = [];
  for await (const entry of NativeHistorySourceJournal.recover({
    ...input,
    ...extra,
  }))
    entries.push(
      entry.error
        ? { key: entry.key, error: true }
        : {
            key: entry.key,
            journalId: entry.journal.journalId,
            scope: entry.journal.scope,
          },
    );
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}
try {
  // Parsed values and Zod issues, including passthrough metadata and u64 cursors.
  const snap = snapshot().snapshot;
  const live = {
    ...snap,
    history: {
      version: 1,
      currentTurnId: "turn",
      currentTurnState: "live",
      turns: [],
      live: {
        epoch: "epoch",
        throughSequence: "18446744073709551615",
        items: [
          {
            turnId: "turn",
            item: notification(1).params.item,
            state: "started",
            startedAtMs: null,
            completedAtMs: null,
            cursor: {
              epoch: "epoch",
              sequence: "18446744073709551615",
              previousSequence: null,
            },
          },
        ],
      },
    },
  };
  const schemaCases = [
    ["codexNativeHistorySnapshotSchema", snap],
    ["codexNativeHistorySnapshotSchema", live],
    ["codexNativeHistorySnapshotSchema", { ...snap, history: null }],
    [
      "codexNativeHistorySnapshotSchema",
      {
        thread: {
          ...snap.thread,
          turns: [
            { id: "t", status: "completed", items: [], startedAt: "bad" },
          ],
        },
      },
    ],
    ["nativeHistorySourceFrameSchema", notification(1)],
    ["nativeHistorySourceFrameSchema", snapshot()],
    ["nativeHistorySourceFrameSchema", { ...notification(1), extra: 1 }],
    ["nativeHistorySourceFrameSchema", { ...notification(1), sequence: 0 }],
    [
      "nativeHistorySourceFrameSchema",
      { ...notification(1), receivedAtMs: "bad" },
    ],
    [
      "nativeHistorySourceScopeSchema",
      {
        ownerId: "a",
        serverId: "s",
        workerId: "w",
        chatId: "c",
        bindingId: "b",
        threadId: "t",
      },
    ],
    ["historySourceOrdinalSchema", 9007199254740992],
    ["historySourcePageLimitSchema", 0],
    ["historySourcePageLimitSchema", 513],
  ];
  for (const sequence of [
    "0",
    "18446744073709551615",
    "18446744073709551616",
    "01",
    "-1",
    "",
    "1".repeat(21),
  ])
    schemaCases.push([
      "codexNativeHistoryCursorSchema",
      { epoch: "e", sequence, previousSequence: null },
    ]);
  for (const change of [
    { epoch: "wrong" },
    { sequence: "18446744073709551615" },
  ]) {
    const bad = structuredClone(live);
    bad.history.live.throughSequence = "1";
    Object.assign(bad.history.live.items[0].cursor, change);
    schemaCases.push(["codexNativeHistorySnapshotSchema", bad]);
  }
  for (const [schema, value] of schemaCases) {
    const source = schemas[schema].safeParse(value);
    same(
      await native({ op: "schema", schema, value }),
      source.success
        ? { success: true, data: source.data }
        : { success: false, issues: source.error.issues },
      schema,
    );
  }
  await compare({ op: "snapshot", value: snap }, () =>
    parseCodexNativeHistory(snap, "thread"),
  );
  await compare(
    {
      op: "snapshot",
      value: { ...snap, thread: { ...snap.thread, id: "foreign" } },
    },
    () =>
      parseCodexNativeHistory(
        { ...snap, thread: { ...snap.thread, id: "foreign" } },
        "thread",
      ),
  );

  // Six separate history domains, both directions, historical key selection.
  const context = {
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    streamId: randomUUID(),
    sequence: 1,
    recordId: randomUUID(),
    previousDigest: null,
  };
  const domains = [
    ["prepared-batch", "Batch"],
    ["source-record", "Source"],
    ["projection-state", "Projection"],
    ["projection-rebase", "ProjectionRebase"],
    ["outbox-baseline", "OutboxBaseline"],
    ["outbox-mutation", "OutboxMutation"],
  ];
  for (const [field, suffix] of domains) {
    const body = "\ufeffprivate \ud800 content \u2028";
    const envelope = await content["protectNativeHistory" + suffix]({
      service,
      context,
      body,
    });
    same(
      await native({ op: "decrypt", context, field, envelope }),
      body.slice(1).replaceAll("\ud800", "\ufffd"),
      field,
    );
    const protectedByRust = await native({
      op: "protect",
      context,
      field,
      body,
    });
    same(
      await content["openNativeHistory" + suffix]({
        service,
        context,
        envelope: protectedByRust,
      }),
      body.slice(1).replaceAll("\ud800", "\ufffd"),
      field + " reverse",
    );
    await compare(
      {
        op: "decrypt",
        context: { ...context, bindingId: "wrong" },
        field,
        envelope,
      },
      () =>
        content["openNativeHistory" + suffix]({
          service,
          context: { ...context, bindingId: "wrong" },
          envelope,
        }),
    );
    const other = field === "source-record" ? domains[0] : domains[1];
    await compare({ op: "decrypt", context, field: other[0], envelope }, () =>
      content["openNativeHistory" + other[1]]({ service, context, envelope }),
    );
  }

  // Node creates the durable identity and first record; native reopens unchanged.
  const journal = await NativeHistorySourceJournal.open(input);
  const first = await journal.append(notification(1));
  same(await open("a"), {
    directory: journal.directory,
    journalId: journal.journalId,
    scope: journal.scope,
  });
  await compare(
    { op: "append", frame: notification(1) },
    () => journal.append(notification(1)),
    "deduplicate Node record",
  );
  await identity({ revision: 2 });
  const second = await native({ op: "append", frame: notification(2) });
  same(
    await journal.append(notification(2)),
    second,
    "Node opens native ciphertext and deduplicates",
  );
  const snapFrame = snapshot();
  await native({ op: "append", frame: snapFrame });
  const nextGeneration = notification(1, { generation: "runtime-2" });
  await journal.append(nextGeneration);
  await compare({ op: "read", limit: 2 }, () => journal.read(0, 2));
  await compare({ op: "read", after: 2 }, () => journal.read(2));
  await compare({ op: "read", after: 4 }, () => journal.read(4));
  await compare({ op: "read", after: 5 }, () => journal.read(5));
  await compare({ op: "head" }, () => journal.head());
  await compare(
    { op: "append", frame: { ...notification(1), method: "item/started" } },
    () => journal.append({ ...notification(1), method: "item/started" }),
  );
  await compare(
    { op: "append", frame: notification(3, { threadId: "foreign" }) },
    () => journal.append(notification(3, { threadId: "foreign" })),
  );
  const badBarrier = snapshot({ readBarrierSequence: 10 });
  await compare({ op: "append", frame: badBarrier }, () =>
    journal.append(badBarrier),
  );
  // Reopen separate handles and enqueue together. Duplicate and successors must
  // serialize in invocation order; failure cannot poison the next operation.
  await open("b");
  const batch = await native({
    op: "batch",
    entries: [
      { handle: "a", frame: notification(5) },
      { handle: "b", frame: notification(5) },
      { handle: "b", frame: notification(6) },
      { handle: "a", frame: notification(7) },
    ],
  });
  same(
    batch.map((v) => v.sequence),
    [5, 5, 6, 7],
    "separate-handle FIFO",
  );
  same(batch[0], batch[1], "same frame id");
  const abandoned = await native({ op: "abandon", frame: notification(8) });
  same(abandoned.sequence, 8, "accepted append survives abandoned result");
  await compare({ op: "read", after: 4 }, () => journal.read(4));
  same(
    (await journal.read())[0].recordId,
    first.recordId,
    "original durable record identity retained",
  );
  child.stdin.end();
  same(await completion, 0, "owned native process stops");
  start();
  await identity({});
  same(
    await open("a"),
    {
      directory: journal.directory,
      journalId: journal.journalId,
      scope: journal.scope,
    },
    "identity survives actual native process restart",
  );
  await compare(
    { op: "read" },
    () => journal.read(),
    "replay after actual native process restart",
  );
  await identity({ owner: "foreign" });
  await compare({ op: "read" }, () => journal.read());
  await compare({ op: "append", frame: notification(9) }, () =>
    journal.append(notification(9)),
  );
  await identity({ owner: "owner" });
  // Native creates an identity; Node reopens the same identity and ciphertext.
  const nativeCreated = await open("created", { chatId: "native-created" });
  await native({ op: "append", handle: "created", frame: notification(1) });
  const reopened = await NativeHistorySourceJournal.open({
    ...input,
    chatId: "native-created",
  });
  same(
    reopened.journalId,
    nativeCreated.journalId,
    "native identity reopened by Node",
  );
  same(
    (await reopened.read())[0].frame,
    notification(1),
    "native-created journal opens in Node",
  );

  // Recovery isolates corrupt siblings, skips foreign owners/workers and known
  // journals, and does not create a missing profile or replace missing identity.
  const broken = await NativeHistorySourceJournal.open({
    ...input,
    chatId: "broken",
  });
  await broken.append(notification(1));
  const manifestBytes = await readFile(
    path.join(broken.directory, "source.json"),
  );
  await rm(path.join(broken.directory, "source.json"));
  await NativeHistorySourceJournal.open({
    ...input,
    workerId: "foreign-worker",
  });
  await NativeHistorySourceJournal.open({
    ...input,
    service: { ...service, ownerId: () => "foreign-owner" },
  });
  await symlink(journal.directory, path.join(directory, "a".repeat(64)), "dir");
  const recover = async (extra = {}) =>
    (await native({ op: "recover", directory, ...extra })).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
  same(
    await recover(),
    await collect(),
    "recovery and independent sibling errors",
  );
  same(
    await recover({ known: true }),
    await collect({ known: () => true }),
    "known journal suppression",
  );
  assert.equal(
    (await rust({ op: "recover", directory, cancelled: true })).ok,
    false,
  );
  comparisons++;
  const missing = path.join(directory, "not-created");
  same(
    await native({ op: "recover", directory: missing }),
    await collect({ directory: missing }),
    "missing recovery profile",
  );
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await assert.rejects(stat(path.join(broken.directory, "source.json")), {
    code: "ENOENT",
  });
  await writeFile(path.join(broken.directory, "source.json"), manifestBytes);
  same(await recover(), await collect(), "repaired identity");

  // Actual committed-record faults and repair; no resets or replacement IDs.
  const bytes = await readFile(file(journal));
  await rm(file(journal));
  await compare({ op: "read" }, () => journal.read());
  await writeFile(file(journal), bytes, { mode: 0o600 });
  const original = JSON.parse(bytes);
  await writeFile(
    file(journal),
    JSON.stringify({ ...original, digest: "0".repeat(64) }),
  );
  await compare({ op: "read" }, () => journal.read());
  const changed = { ...original, recordId: randomUUID() };
  delete changed.digest;
  changed.digest = hash(changed);
  await writeFile(file(journal), JSON.stringify(changed));
  await compare({ op: "read" }, () => journal.read());
  await writeFile(file(journal), bytes, { mode: 0o600 });
  await compare({ op: "read", limit: 1 }, () => journal.read(0, 1));
  // A new empty journal sees a real publication obstruction, then succeeds once
  // removed using the original captured frame and original manifest.
  const obstructed = await NativeHistorySourceJournal.open({
    ...input,
    chatId: "obstructed",
  });
  await open("obstructed", { chatId: "obstructed" });
  await mkdir(file(obstructed));
  same(
    (await rust({ op: "append", handle: "obstructed", frame: notification(1) }))
      .ok,
    false,
    "native actual IO error",
  );
  await assert.rejects(obstructed.append(notification(1)));
  await rm(file(obstructed), { recursive: true });
  const repaired = await native({
    op: "append",
    handle: "obstructed",
    frame: notification(1),
  });
  same(
    await obstructed.append(notification(1)),
    repaired,
    "retry after actual IO repair",
  );
  await rm(path.join(obstructed.directory, "source.json"));
  await compare(
    { op: "open", handle: "obstructed", directory, chatId: "obstructed" },
    () => NativeHistorySourceJournal.open({ ...input, chatId: "obstructed" }),
  );

  for (const name of await readdir(journal.directory)) {
    const full = path.join(journal.directory, name),
      body = await readFile(full, "utf8");
    assert.ok(!body.includes("private") && !body.includes("agentMessage"));
    if (process.platform !== "win32")
      same((await stat(full)).mode & 0o777, 0o600, "private file mode");
  }
  // Cursor gaps are item-specific and work above JS's exact numeric range.
  function event(
    sequence,
    nativeSequence,
    previousSequence,
    method = "item/agentMessage/delta",
    epoch = "epoch",
  ) {
    return notification(sequence, {
      method,
      params: { turnId: "turn", itemId: "answer" },
      nativeCursor: { epoch, sequence: nativeSequence, previousSequence },
    });
  }
  function observation(barrier, epoch = "epoch", itemSequence) {
    return snapshot({
      readBarrierSequence: barrier,
      completedSequence: 100,
      snapshot: {
        thread: { id: "thread", status: { type: "active" }, turns: [] },
        history: {
          version: 1,
          currentTurnId: "turn",
          currentTurnState: "live",
          turns: [],
          live: {
            epoch,
            throughSequence: "18446744073709551615",
            items: itemSequence
              ? [
                  {
                    turnId: "turn",
                    item: { id: "answer", type: "agentMessage" },
                    state: "started",
                    cursor: {
                      epoch,
                      sequence: itemSequence,
                      previousSequence: null,
                    },
                    startedAtMs: null,
                    completedAtMs: null,
                  },
                ]
              : [],
          },
        },
      },
    });
  }
  const sequences = [
    [
      event(1, "1", null, "item/started"),
      event(2, "3", "2"),
      event(3, "5", "4"),
      event(4, "3", "2"),
      observation(4),
      observation(4, "epoch", "3"),
      observation(4, "epoch", "5"),
      observation(4, "epoch", "1"),
      event(5, "6", "5"),
    ],
    [
      event(1, "3", "2"),
      event(2, "4", "3", "item/completed"),
      observation(2),
      event(3, "3", "2"),
    ],
    [
      event(2, "3", "2", undefined, "new"),
      observation(1, "old"),
      observation(2, "new", "3"),
      event(3, "5", "4", undefined, "new"),
      observation(3, "replacement"),
    ],
    [
      event(1, "18446744073709551613", null, "item/started"),
      event(2, "18446744073709551615", "18446744073709551614"),
      observation(2, "epoch", "18446744073709551615"),
    ],
    [notification(1), event(1, "0", null), observation(2, "new")],
  ];
  for (const frames of sequences) {
    const tracker = new NativeHistoryCursorTracker();
    same(
      await native({ op: "tracker", frames }),
      frames.map((frame) =>
        frame.kind === "notification"
          ? tracker.notification(frame)
          : tracker.snapshot(frame),
      ),
      "cursor recovery sequence",
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      schemas: schemaCases.length,
      runtime: "macOS ARM64",
      nodeFreeFixture: true,
      rootRemovedOnExit: true,
    }),
  );
} finally {
  child.stdin.end();
  const code = await completion;
  await rm(directory, { recursive: true, force: true });
  assert.equal(code, 0, "native fixture exit");
}
