// Actual canonical preparation/bootstrap/replay, comparing plaintext and revision
// state rather than independently randomized ciphertext. All profiles are owned.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createNativeHistoryProjector,
  nativeHistorySourceFingerprint,
} from "../../tests/reference-node-worker/src/native-history-projector.ts";
import { restoreNativeHistoryProjectorState } from "../../tests/reference-node-worker/src/native-history-projector-bootstrap.ts";
import { rebaseNativeHistoryProjector } from "../../tests/reference-node-worker/src/native-history-projector-rebase.ts";
import { reduceNativeHistory } from "../../tests/reference-node-worker/src/native-history-reducer.ts";
import { renderNativeHistoryItem } from "../../tests/reference-node-worker/src/native-history-render.ts";
import { parseCodexNativeHistory } from "../../tests/reference-node-worker/src/codex/native-history.ts";
import {
  protectChatMessage,
  openMessage,
} from "../../tests/reference-node-worker/src/chat-message-encryption.ts";
import { openNativeHistoryItemEvidence } from "../../tests/reference-node-worker/src/native-history-item-content.ts";
import { openNativeHistoryTurn } from "../../tests/reference-node-worker/src/native-history-turn-content.ts";
import { NativeHistorySourceJournal } from "../../tests/reference-node-worker/src/native-history-source-journal.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary);
const wire = (value) => JSON.parse(JSON.stringify(value));
const encode = (value) =>
  JSON.stringify(value, (_key, value) =>
    Object.is(value, -0) ? JSON.rawJSON("-0") : value,
  );
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const finished = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
async function* lines(stream) {
  stream.setEncoding("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  assert.equal(pending, "");
}
const output = lines(child.stdout);
let comparisons = 0;
async function native(input) {
  child.stdin.write(encode(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
async function result(input) {
  const r = await native(input);
  assert.equal(r.ok, true, r.error);
  return r.value;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, wire(expected), label);
  comparisons++;
  return actual;
}
const fixtures = nativeHistoryWireFixtures("2026-11-17T00:00:00Z"),
  binding = fixtures.nativeHistoryBindingSchema[0];
const context = {
  cwd: process.platform === "win32" ? "C:\\project" : "/project",
  mode: "default",
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: (_scope, revision = 1) => ({
    key: new Uint8Array(32).fill(revision),
    keyRevision: revision,
  }),
};
const event = (
  item,
  sequence = 1,
  method = "item/completed",
  turnId = "turn",
) => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "notification",
    generation: "runtime",
    sequence,
    threadId: "thread",
    receivedAtMs: sequence,
    method,
    params: {
      turnId,
      item: {
        id: "item",
        type: "agentMessage",
        text: "exact retained output",
        ...item,
      },
    },
  },
});
function configuration(records, previous = null, extra = {}) {
  const source = reduceNativeHistory(
    previous?.source,
    records,
    binding.threadId,
  );
  const mappings = [];
  for (const turn of source.turns)
    for (const item of turn.items) {
      const chosen = extra.contexts?.[item.id] ?? extra.context ?? context;
      for (const draft of renderNativeHistoryItem(item, {
        ...chosen,
        threadId: binding.threadId,
        turnId: turn.id,
      })) {
        const h = createHash("sha256")
          .update(JSON.stringify(draft.identity))
          .digest("hex");
        mappings.push({
          key: h,
          identity: draft.identity,
          messageId: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
          idempotencyKey: `native:${h}`,
          preservedInput: null,
        });
      }
    }
  return { binding, context, mappings, ...extra };
}
function reference(config) {
  const trace = [],
    abort = new AbortController();
  if (config.aborted) abort.abort(new Error("fixture stopped"));
  const call = (kind, detail) => {
    trace.push({ kind, detail });
    if (config.stopAt === kind) abort.abort(new Error("fixture stopped"));
    if (config.throwAt === kind) throw new Error(`fixture ${kind} error`);
  };
  const project = createNativeHistoryProjector({
    binding,
    service,
    signal: abort.signal,
    maxItemsPerBatch: config.maxItemsPerBatch,
    ...(Object.hasOwn(config, "bootstrap")
      ? {
          bootstrap: async () => {
            call("bootstrap", null);
            return structuredClone(config.bootstrap);
          },
        }
      : {}),
    ...(config.prepare
      ? {
          prepare: async () => {
            call("prepare", null);
          },
        }
      : {}),
    context: async (item, turn) => {
      call("context", { itemId: item.id, turnId: turn.id });
      return structuredClone(config.contexts?.[item.id] ?? config.context);
    },
    materialize: async (item, turn, context, publishedAttachments) => {
      call("materialize", {
        itemId: item.id,
        turnId: turn.id,
        context,
        ...(publishedAttachments === undefined ? {} : { publishedAttachments }),
      });
      const material = structuredClone(
        config.materials?.[item.id] ?? config.material ?? {},
      );
      return {
        attachments: [],
        ...material,
        inputParts: material.inputParts
          ? new Map(
              Object.entries(material.inputParts).map(([k, v]) => [
                Number(k),
                v,
              ]),
            )
          : undefined,
      };
    },
    associate: async (draft, turn) => {
      call("associate", { identity: draft.identity, turnId: turn.id });
      return config.association ?? { kind: "native" };
    },
    client: {
      resolve: async (input) => {
        call("resolve", input);
        if (Object.hasOwn(config, "resolveResult")) return config.resolveResult;
        return input.items.map(({ identity }) => {
          const selected = config.mappings.find(
            (mapping) =>
              JSON.stringify(mapping.identity) === JSON.stringify(identity),
          );
          if (!selected) throw new Error("fixture mapping missing");
          return structuredClone(selected);
        });
      },
    },
  });
  return { project, trace };
}
async function plaintext(batches) {
  return Promise.all(
    batches.map(async (batch) => ({
      items: await Promise.all(
        batch.items.map(async (item) => {
          const content = await openMessage({
            message: item.message,
            componentKey: new Uint8Array(32).fill(1),
            ownerId: "owner",
          });
          const source = await openNativeHistoryItemEvidence({
            service,
            binding,
            identity: item.identity,
            evidence: item.evidence,
          });
          return {
            ...item,
            message: { ...item.message, protectedContent: content },
            evidence: { ...item.evidence, content: source },
          };
        }),
      ),
      turns: await Promise.all(
        batch.turns.map(async (turn) => ({
          ...turn,
          metadata: await openNativeHistoryTurn({ service, binding, turn }),
        })),
      ),
    })),
  );
}
async function compare(
  records,
  previous = null,
  extra = {},
  label = "projector",
) {
  const config = configuration(records, previous, extra),
    ref = reference(config);
  let expected;
  try {
    expected = await ref.project(records, previous);
  } catch (error) {
    expected = { error: error.message };
  }
  const actual = await result({
    op: "projector.run",
    config,
    records,
    previous,
  });
  same(actual.trace, ref.trace, label + " callback order");
  if (expected.error) {
    assert.equal(typeof actual.error, "string", label);
    if (!expected.error.startsWith("["))
      same(actual.error, expected.error, label + " error");
    else comparisons++;
    return actual;
  }
  assert.equal(actual.error, undefined, label + ": " + actual.error);
  same(actual.state, expected.state, label + " revision/fingerprint state");
  same(
    await plaintext(actual.batches),
    await plaintext(expected.batches),
    label + " authenticated plaintext batches",
  );
  return actual;
}
async function restored(recovery, label = "restore") {
  let expected;
  try {
    expected = {
      ok: true,
      value: restoreNativeHistoryProjectorState(recovery),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  const actual = await native({ op: "projector.restore", recovery });
  if (expected.ok || !expected.error.startsWith("["))
    same(actual, expected, label);
  else {
    assert.equal(actual.ok, false);
    comparisons++;
  }
  return actual.value;
}
const root = await mkdtemp(path.join(tmpdir(), "cantrip-canonical-projector-"));
try {
  await compare([], null, { prepare: true }, "empty");
  const first = event({});
  const initial = await compare(
    [first],
    null,
    { prepare: true },
    "first output",
  );
  for (const context of [false, "future", ["future"]])
    await compare([first], null, { context }, "callback object spread");
  await compare(
    [first],
    initial.state,
    {},
    "unchanged source skips reservation",
  );
  const changed = await compare(
    [event({ text: "changed" }, 2)],
    initial.state,
    {},
    "next revision",
  );
  await compare(
    [],
    changed.state,
    { context: { ...context, mode: "plan" } },
    "presentation-only revision",
  );
  const restoredState = structuredClone(initial.state);
  restoredState.items[0].fingerprint = null;
  restoredState.items[0].sourceFingerprint = nativeHistorySourceFingerprint(
    restoredState.source.turns[0].items[0],
    0,
    0,
  );
  await compare(
    [],
    restoredState,
    { context: { ...context, mode: "plan" } },
    "unchanged restored UI",
  );
  const stale = wire(restoredState);
  stale.source.turns[0].items[0].lifecycle = "started";
  delete stale.items[0].sourceFingerprint;
  await compare([], stale, {}, "canonical completion fences stale source");
  const revised = wire(initial.state);
  revised.items[0].canonicalRevision = 0;
  await compare(
    [event({ text: "concurrent observation" }, 2)],
    revised,
    {},
    "zero canonical basis retained",
  );
  const user = event({
    type: "userMessage",
    clientId: "gui-client",
    content: [{ type: "text", text: "transformed native prompt" }],
  });
  const gui = configuration([user]);
  gui.mappings[0].preservedInput = await protectChatMessage({
    service,
    id: gui.mappings[0].messageId,
    message: {
      role: "user",
      content: [{ type: "text", text: "original GUI prompt" }],
      idempotencyKey: gui.mappings[0].idempotencyKey,
    },
  });
  const preserved = await compare(
    [user],
    null,
    { mappings: gui.mappings, throwAt: "materialize" },
    "preserved GUI ciphertext",
  );
  same(
    preserved.batches[0].items[0].message,
    gui.mappings[0].preservedInput,
    "exact GUI ciphertext retained",
  );
  await compare(
    [user],
    null,
    {
      material: {
        inputParts: { 1: [{ type: "text", text: "authorized reference" }] },
        attachments: [],
      },
    },
    "observed input association",
  );
  for (const phase of [
    "prepare",
    "context",
    "associate",
    "resolve",
    "materialize",
  ]) {
    await compare(
      [first],
      null,
      { prepare: true, throwAt: phase },
      `failure at ${phase}`,
    );
  }
  for (const phase of ["prepare", "context", "resolve", "materialize"]) {
    await compare(
      [first],
      null,
      { prepare: true, stopAt: phase },
      `cancellation at ${phase}`,
    );
  }
  await compare([first], null, { aborted: true }, "already cancelled");
  await compare([first], null, { resolveResult: [] }, "missing reservation");
  const unrelated = configuration([first]).mappings;
  unrelated[0].identity.itemId = "other";
  await compare(
    [first],
    null,
    { resolveResult: unrelated },
    "foreign reservation",
  );
  const many = [
    event({ id: "one" }),
    event({ id: "two" }, 2),
    event({ id: "three" }, 3, "item/completed", "second"),
  ];
  await compare(many, null, { maxItemsPerBatch: 1 }, "item-count batching");
  await compare(
    Array.from({ length: 4 }, (_, i) =>
      event({ id: `large-${i}`, text: "x".repeat(1100 * 1024) }, i + 1),
    ),
    null,
    {},
    "four-MiB batch boundary",
  );
  await compare(
    [event({ text: "y".repeat(2 * 1024 * 1024) })],
    null,
    {},
    "indivisible evidence larger than batch budget",
  );
  const snapshot = parseCodexNativeHistory(
    {
      thread: {
        id: "thread",
        status: { type: "idle" },
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [
              { id: "item", type: "agentMessage", text: "retained answer" },
            ],
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
      history: {
        version: 1,
        currentTurnId: null,
        currentTurnState: "notLoaded",
        turns: [
          {
            turnId: "turn",
            source: "canonical",
            retention: "complete",
            contexts: [],
            items: [
              {
                itemId: "item",
                state: "completed",
                startedAtMs: 1000,
                completedAtMs: 2000,
              },
            ],
            usage: null,
            warnings: null,
            errors: null,
          },
        ],
      },
    },
    "thread",
  );
  const snap = {
    sequence: 1,
    recordId: randomUUID(),
    frame: {
      kind: "snapshot",
      id: randomUUID(),
      threadId: "thread",
      generation: "runtime",
      readBarrierSequence: 0,
      completedSequence: 0,
      receivedAtMs: 1,
      snapshot,
    },
  };
  const turn = await compare(
    [snap],
    null,
    { maxItemsPerBatch: 1 },
    "canonical turn",
  );
  await compare(
    [
      {
        ...snap,
        sequence: 2,
        recordId: randomUUID(),
        frame: { ...snap.frame, id: randomUUID() },
      },
    ],
    turn.state,
    {},
    "semantic evidence ignores repeat record IDs",
  );
  const overflowing = structuredClone(snap);
  overflowing.frame.snapshot.thread.turns[0].startedAt = Number.MAX_VALUE;
  await compare([overflowing], null, {}, "timestamp multiplication overflow");
  const empty = {
    binding,
    snapshotId: "f".repeat(64),
    items: [],
    turns: [],
    batches: [],
  };
  await restored(empty, "empty archive");
  const selected = wire(initial.state.source.turns[0].items[0]);
  const selectedIdentity = configuration([first]).mappings[0].identity;
  const itemEntry = {
    key: "a".repeat(64),
    identity: selectedIdentity,
    revision: 3,
    state: "completed",
    order: { turn: 0, item: 0, component: 0 },
    sourceRevision: 3,
    sourceCurrent: true,
    source: selected,
  };
  const recovery = {
    ...empty,
    items: [itemEntry],
    batches: [
      {
        bindingId: "foreign",
        batch: {
          items: [{ identity: selectedIdentity, revision: 9 }],
          turns: [{ turnId: "turn", revision: 100 }],
        },
      },
    ],
  };
  const recovered = await restored(
    recovery,
    "all accepted item floors, foreign turn floor excluded",
  );
  await compare(
    [],
    null,
    { bootstrap: recovered, prepare: true },
    "first-stage bootstrap",
  );
  await restored(
    {
      ...recovery,
      items: [
        {
          ...itemEntry,
          source: null,
          sourceRevision: null,
          sourceCurrent: false,
        },
      ],
    },
    "missing source evidence",
  );
  await restored(
    { ...recovery, items: [{ ...itemEntry, sourceCurrent: false }] },
    "stale source never replaces canonical body",
  );
  await restored(
    {
      ...recovery,
      items: [
        { ...itemEntry, identity: { ...selectedIdentity, threadId: "other" } },
      ],
    },
    "foreign item",
  );
  await restored(
    {
      ...recovery,
      items: [{ ...itemEntry, source: { ...selected, id: "other" } }],
    },
    "wrong source identity",
  );
  await restored(
    {
      ...recovery,
      items: [
        itemEntry,
        {
          ...itemEntry,
          identity: { ...selectedIdentity, component: "activity" },
          source: {
            ...selected,
            body: { ...selected.body, text: "contradictory" },
          },
        },
      ],
    },
    "contradictory component source",
  );
  const turnEntry = (
    status,
    terminal,
    bindingId = binding.id,
    metadata = null,
  ) => {
    const body = {
      id: "turn",
      status,
      completedAt: status === "completed" ? 2 : null,
      error: status === "interrupted" ? "snapshot interruption" : null,
    };
    const reduced = {
      id: "turn",
      ordinal: 99,
      revision: 1,
      body,
      metadata,
      origin: { kind: "snapshot", generation: bindingId, sequence: 0 },
      conflicts: [],
      ...(terminal ? { terminalNotification: terminal } : {}),
    };
    return {
      bindingId,
      workerId: "worker",
      turn: {
        ...fixtures.nativeHistoryPreparedBatchSchema[0].turns[0],
        threadId: "thread",
        turnId: "turn",
        status,
        ordinal: 99,
        revision: 4,
      },
      source: { version: 2, reducedTurn: reduced, evidence: [] },
    };
  };
  const completed = turnEntry("completed", "completed"),
    interrupted = turnEntry("interrupted", undefined, "foreign");
  await restored(
    { ...recovery, turns: [interrupted, completed] },
    "actual completion outranks inferred interruption and canonical item order wins",
  );
  await restored(
    { ...empty, turns: [completed, turnEntry("failed", "failed", "foreign")] },
    "ambiguous actual completions remain conflicts",
  );
  await restored(
    {
      ...empty,
      turns: [
        turnEntry("completed", undefined, binding.id, {
          turnId: "turn",
          contexts: [{ cwd: "/one" }],
          selected: "a",
        }),
        turnEntry("completed", undefined, "foreign", {
          turnId: "turn",
          contexts: [{ cwd: "/two" }, { cwd: "/one" }],
          selected: "b",
        }),
      ],
    },
    "context union and metadata disagreement",
  );
  await restored(
    {
      ...empty,
      turns: [
        {
          ...completed,
          source: {
            version: 1,
            nativeTurn: completed.source.reducedTurn.body,
            history: { turnId: "turn" },
          },
        },
      ],
    },
    "legacy turn source",
  );
  await restored(
    {
      ...empty,
      turns: [{ ...completed, source: { version: 0, extension: "retained" } }],
    },
    "legacy header-only source",
  );
  const conflictRecord = {
    recordId: randomUUID(),
    method: "notice",
    params: { safe: "first" },
  };
  const evidenceA = wire(completed),
    evidenceB = wire(completed);
  evidenceA.source.evidence = [conflictRecord];
  evidenceB.source.evidence = [
    { ...conflictRecord, params: { safe: "other" } },
  ];
  await restored(
    { ...empty, turns: [evidenceA, evidenceB] },
    "conflicting recovered evidence identity",
  );
  const signedA = turnEntry("completed", undefined, binding.id, {
      retained: -0,
    }),
    signedB = turnEntry("completed", undefined, "foreign", { retained: 0 });
  await restored(
    { ...empty, turns: [signedA, signedB] },
    "signed-zero metadata conflict",
  );
  // Real encrypted retained journals supply replay, including a page boundary.
  await result({
    op: "open",
    directory: path.join(root, "native-source"),
    workerId: "worker",
    chatId: binding.chatId,
    bindingId: binding.id,
    threadId: "thread",
  });
  const retained = [];
  for (const record of many) {
    await result({ op: "append", frame: record.frame });
  }
  retained.push(...(await result({ op: "read", after: 0, limit: 512 })));
  const nodeSource = await NativeHistorySourceJournal.open({
    directory: path.join(root, "native-source"),
    workerId: "worker",
    chatId: binding.chatId,
    bindingId: binding.id,
    threadId: "thread",
    service,
  });
  const through = await result({ op: "head" });
  const config = configuration(retained, null, { bootstrap: recovered });
  const pages = {
    archive: async () => ({
      binding,
      snapshotId: empty.snapshotId,
      items: [],
      nextCursor: null,
    }),
    archiveTurns: async () => ({
      binding,
      snapshotId: empty.snapshotId,
      turns: [],
      nextCursor: null,
    }),
    archiveBatches: async () => ({
      binding,
      snapshotId: empty.snapshotId,
      batches: [],
      nextCursor: null,
    }),
  };
  for (const endpoint of [
    through,
    { ...through, recordId: randomUUID() },
    { sequence: through.sequence + 1, recordId: through.recordId },
  ]) {
    const ref = reference(config);
    let expected;
    try {
      expected = await rebaseNativeHistoryProjector({
        binding,
        service,
        source: nodeSource,
        through: endpoint,
        client: pages,
        project: ref.project,
      });
    } catch (error) {
      expected = { error: error.message };
    }
    const actual = await result({
      op: "projector.rebase",
      config,
      through: endpoint,
      recovery: empty,
    });
    same(actual.trace, ref.trace, "rebase callback order");
    if (expected.error)
      same(actual.error, expected.error, "fixed replay endpoint error");
    else {
      same(actual.state, expected.state, "full retained replay state");
      same(
        await plaintext(actual.batches),
        await plaintext(expected.batches),
        "replay canonical preparation",
      );
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      nativeCanonicalProjector: true,
      nativeBootstrap: true,
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await finished, 0);
  await rm(root, { recursive: true, force: true });
}
