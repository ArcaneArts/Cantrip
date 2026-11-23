// Actual endpoint codecs in both directions; all keys and content are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import * as crypto from "../../packages/crypto/dist/index.js";
import * as schemas from "../../packages/protocol/dist/communication-content.js";
import { reconcileNativeHistoryUsage } from "../../packages/protocol/dist/index.js";
import { nativeHistoryStateItemSchema } from "../../tests/reference-node-worker/src/native-history-state.ts";
import {
  protectNativeHistoryItemEvidence,
  openNativeHistoryItemEvidence,
} from "../../tests/reference-node-worker/src/native-history-item-content.ts";
import {
  protectNativeHistoryTurnMetadata,
  openNativeHistoryTurn,
  prepareNativeHistoryTurn,
} from "../../tests/reference-node-worker/src/native-history-turn-content.ts";
import {
  protectChatMessage,
  openMessage,
} from "../../tests/reference-node-worker/src/chat-message-encryption.ts";
import { prepareNativeHistoryRenderedItem } from "../../tests/reference-node-worker/src/native-history-prepare-item.ts";
import {
  openNativeHistoryArchivePage,
  openNativeHistoryTurnArchivePage,
} from "../../tests/reference-node-worker/src/native-history-archive.ts";
import {
  openNativeHistoryBatchArchivePage,
  nativeHistoryBatchPayloadDigest,
} from "../../tests/reference-node-worker/src/native-history-batch-archive.ts";
import { nativeHistoryUsageForTurn } from "../../tests/reference-node-worker/src/native-history-usage.ts";
import { nativeHistoryModelAttributionForTurn } from "../../tests/reference-node-worker/src/native-history-model-attribution.ts";
import { parseCodexNativeHistory } from "../../tests/reference-node-worker/src/codex/native-history.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
import { runHistoryUsageCases } from "../server-rust/native-history-usage-cases.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary history-source-fixture");
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
async function* lines(stream) {
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
  assert.equal(partial, "");
}
const output = lines(child.stdout);
let comparisons = 0;
async function native(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
async function result(input) {
  const r = await native(input);
  assert.equal(r.ok, true, r.error);
  return r.value;
}
async function observed(run) {
  try {
    return { ok: true, value: (await run()) ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
  return actual;
}
async function compare(input, run, label = input.op) {
  return same(await native(input), await observed(run), label).value;
}
let state = { owner: "owner", server: "server", revision: 1 };
const service = {
  ownerId: () => state.owner,
  serverIdentity: () => state.server,
  componentKey: (_scope, revision = state.revision) => {
    if (revision === 99)
      throw new Error("Missing historical chat-content key.");
    return { key: new Uint8Array(32).fill(revision), keyRevision: revision };
  },
};
async function change(patch) {
  Object.assign(state, patch);
  await result({ op: "identity", state });
}
const binding = {
  id: "binding",
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
};
const identity = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  component: "assistant",
  identityKind: "canonical",
};
const source = nativeHistoryStateItemSchema.parse({
  id: "item",
  identityKind: "canonical",
  revision: 3,
  ordinal: 0,
  body: {
    id: "item",
    type: "agentMessage",
    text: "synthetic private \ud800 \u2028 content",
    future: { retained: true },
  },
  lifecycle: "completed",
  completeBody: true,
  startedAtMs: 1,
  completedAtMs: 2,
  origin: { kind: "notification", generation: "runtime", sequence: 1 },
  conflicts: [],
});
const header = {
  threadId: "thread",
  turnId: "turn",
  revision: 4,
  ordinal: 0,
  status: "completed",
  startedAtMs: 1000,
  completedAtMs: 2500,
};
const capture = {
  threadId: "thread",
  turnId: "turn",
  isRoot: true,
  reasoningEffort: "high",
  selection: { status: "unavailable" },
};
const counts = {
  totalTokens: 8,
  inputTokens: 3,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  outputTokens: 5,
  reasoningOutputTokens: 2,
};
const usage = {
  version: 1,
  modelAttribution: capture,
  responses: [{ responseId: "response", usage: counts }],
  conflictingResponseIds: [],
  complete: true,
};
const richHeader = { ...header, usage, modelAttribution: capture };
const content = {
  version: 1,
  nativeTurn: { id: "turn", privateExtension: source.body.text },
  history: { retained: true },
};
const fixture = nativeHistoryWireFixtures("2026-11-17T00:00:00.000Z");
const base = fixture.nativeHistoryArchivePageSchema[0];
const fullBinding = { ...base.binding, ...binding };
try {
  const variants = [
    [
      "message",
      "encryptChatMessageProtectedContent",
      "decryptChatMessageProtectedContent",
      "chatMessageProtectedContentSchema",
      {
        version: 1,
        classification: {
          role: "assistant",
          mode: "default",
          attachmentIds: [],
        },
        content: [{ type: "text", text: source.body.text }],
      },
    ],
    [
      "prompt",
      "encryptQueuedPromptProtectedContent",
      "decryptQueuedPromptProtectedContent",
      "queuedPromptProtectedContentSchema",
      {
        version: 1,
        classification: { mode: "plan", attachmentIds: [] },
        text: "  synthetic prompt  ",
      },
    ],
    [
      "draft",
      "encryptChatComposerDraftProtectedContent",
      "decryptChatComposerDraftProtectedContent",
      "chatComposerDraftProtectedContentSchema",
      {
        version: 1,
        text: "synthetic draft",
        mode: "default",
        reasoningEffort: null,
      },
    ],
    [
      "plan",
      "encryptChatPlanProtectedContent",
      "decryptChatPlanProtectedContent",
      "chatPlanProtectedContentSchema",
      {
        version: 1,
        classification: { hasQuestion: false },
        explanation: null,
        steps: [{ step: "synthetic plan", status: "pending" }],
        question: null,
      },
    ],
    [
      "request",
      "encryptInteractionRequestContent",
      "decryptInteractionRequestContent",
      "interactionRequestProtectedContentSchema",
      {
        version: 1,
        classification: { kind: "userInput" },
        payload: { questions: ["synthetic question"] },
      },
    ],
    [
      "response",
      "encryptInteractionResponseContent",
      "decryptInteractionResponseContent",
      "interactionResponseProtectedContentSchema",
      {
        version: 1,
        classification: { kind: "userInput" },
        response: { answers: ["synthetic answer"] },
      },
    ],
  ];
  for (const [kind, encrypt, decrypt, schema, plain] of variants) {
    const context = {
      ownerId: "owner",
      keyRevision: 1,
      messageId: "message",
      promptId: "prompt",
      chatId: "chat",
      requestKey: "request",
    };
    const key = service.componentKey("chat-content").key;
    const protectedByNode = await crypto[encrypt]({
      ...context,
      componentKey: new Uint8Array(key),
      content: plain,
    });
    await compare(
      {
        op: "content.communication.open",
        kind,
        context,
        encrypted: protectedByNode,
        classification: plain.classification,
      },
      () =>
        crypto[decrypt]({
          ...context,
          componentKey: new Uint8Array(key),
          encrypted: protectedByNode,
          publicClassification: plain.classification,
        }),
      kind + " Node ciphertext opened natively",
    );
    const protectedByRust = await result({
      op: "content.communication.protect",
      kind,
      context,
      content: plain,
    });
    same(
      await crypto[decrypt]({
        ...context,
        componentKey: new Uint8Array(key),
        encrypted: protectedByRust,
        publicClassification: plain.classification,
      }),
      schemas[schema].parse(plain),
      kind + " native ciphertext opened in Node",
    );
    await compare(
      {
        op: "content.communication.open",
        kind,
        context: { ...context, ownerId: "other" },
        encrypted: protectedByNode,
        classification: plain.classification,
      },
      () =>
        crypto[decrypt]({
          ...context,
          ownerId: "other",
          componentKey: new Uint8Array(key),
          encrypted: protectedByNode,
          publicClassification: plain.classification,
        }),
    );
    if (plain.classification)
      await compare(
        {
          op: "content.communication.open",
          kind,
          context,
          encrypted: protectedByNode,
          classification: {},
        },
        () =>
          crypto[decrypt]({
            ...context,
            componentKey: new Uint8Array(key),
            encrypted: protectedByNode,
            publicClassification: {},
          }),
      );
  }
  for (const [kind, encrypt, plain] of [
    [
      "message",
      "encryptChatMessageProtectedContent",
      {
        version: 1,
        classification: {
          role: "assistant",
          mode: "default",
          attachmentIds: ["unrelated"],
        },
        content: [{ type: "text", text: "private" }],
      },
    ],
    [
      "prompt",
      "encryptQueuedPromptProtectedContent",
      {
        version: 1,
        classification: { mode: "default", attachmentIds: [] },
        text: "   ",
      },
    ],
    [
      "plan",
      "encryptChatPlanProtectedContent",
      {
        version: 1,
        classification: { hasQuestion: true },
        explanation: null,
        steps: [],
        question: null,
      },
    ],
  ]) {
    const context = {
      ownerId: "owner",
      keyRevision: 1,
      messageId: "message",
      promptId: "prompt",
      chatId: "chat",
    };
    await compare(
      { op: "content.communication.protect", kind, context, content: plain },
      () =>
        crypto[encrypt]({
          ...context,
          componentKey: service.componentKey("chat-content").key,
          content: plain,
        }),
      kind + " plaintext refinement",
    );
  }
  const tooLarge = {
    ...variants[0][4],
    content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
  };
  const context = { ownerId: "owner", keyRevision: 1, messageId: "message" };
  await compare(
    {
      op: "content.communication.protect",
      kind: "message",
      context,
      content: tooLarge,
    },
    () =>
      crypto.encryptChatMessageProtectedContent({
        ...context,
        componentKey: service.componentKey("chat-content").key,
        content: tooLarge,
      }),
    "encoded byte bound",
  );
  const itemInput = { service, binding, identity, revision: 4, source };
  const nodeEvidence = await protectNativeHistoryItemEvidence(itemInput);
  await compare(
    { op: "content.item.open", binding, identity, evidence: nodeEvidence },
    () =>
      openNativeHistoryItemEvidence({ ...itemInput, evidence: nodeEvidence }),
  );
  const evidence = await result({
    op: "content.item.protect",
    binding,
    identity,
    revision: 4,
    source,
  });
  same(
    await openNativeHistoryItemEvidence({ ...itemInput, evidence }),
    source,
    "native item evidence opens in Node",
  );
  for (const patch of [
    { evidence: { ...nodeEvidence, workerId: "other" } },
    { identity: { ...identity, itemId: "other" } },
    { binding: { ...binding, threadId: "other" } },
    { evidence: { ...nodeEvidence, revision: 5 } },
    {
      evidence: {
        ...nodeEvidence,
        content: { ...nodeEvidence.content, keyRevision: 99 },
      },
    },
  ]) {
    const input = { binding, identity, evidence: nodeEvidence, ...patch };
    await compare({ op: "content.item.open", ...input }, () =>
      openNativeHistoryItemEvidence({ service, ...input }),
    );
  }
  await compare(
    { op: "content.item.protect", binding, identity, revision: 0, source },
    () => protectNativeHistoryItemEvidence({ ...itemInput, revision: 0 }),
  );
  await compare(
    {
      op: "content.item.protect",
      binding,
      identity,
      revision: 4,
      source: { ...source, id: "other" },
    },
    () =>
      protectNativeHistoryItemEvidence({
        ...itemInput,
        source: { ...source, id: "other" },
      }),
  );
  await change({ revision: 2 });
  await compare(
    { op: "content.item.open", binding, identity, evidence },
    () => openNativeHistoryItemEvidence({ ...itemInput, evidence }),
    "historical grant is selected from envelope",
  );
  await change({ revision: 1 });
  const turns = [];
  for (const publicHeader of [header, richHeader]) {
    const nodeTurn = await protectNativeHistoryTurnMetadata({
      service,
      binding,
      header: publicHeader,
      content,
    });
    await compare({ op: "content.turn.open", binding, turn: nodeTurn }, () =>
      openNativeHistoryTurn({ service, binding, turn: nodeTurn }),
    );
    const turn = await result({
      op: "content.turn.protect",
      binding,
      header: publicHeader,
      content,
    });
    same(
      await openNativeHistoryTurn({ service, binding, turn }),
      content,
      "native turn opens in Node",
    );
    turns.push(turn);
    for (const patch of [
      { status: "interrupted" },
      { revision: 5 },
      { startedAtMs: 1001 },
    ])
      await compare(
        { op: "content.turn.open", binding, turn: { ...nodeTurn, ...patch } },
        () =>
          openNativeHistoryTurn({
            service,
            binding,
            turn: { ...nodeTurn, ...patch },
          }),
      );
  }
  const rich = turns[1],
    { usage: _usage, ...withoutUsage } = rich,
    { modelAttribution: _model, ...withoutModel } = rich;
  for (const turn of [
    withoutUsage,
    withoutModel,
    { ...rich, modelAttribution: { ...capture, reasoningEffort: "low" } },
  ])
    await compare(
      { op: "content.turn.open", binding, turn },
      () => openNativeHistoryTurn({ service, binding, turn }),
      "analytics relabeling invalidates AAD",
    );
  const snapshot = parseCodexNativeHistory(
    {
      thread: {
        id: "thread",
        parentThreadId: "parent",
        forkedFromId: null,
        status: { type: "idle" },
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [],
            itemsView: "full",
            startedAt: 1.25,
            completedAt: 2.5,
            futureTurn: { preserved: true },
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
            items: [],
            contexts: [],
            usage: {
              responses: [
                {
                  threadId: "thread",
                  responseId: "response",
                  sessionId: "session",
                  rootTurnId: "root-turn",
                  usage: counts,
                },
              ],
              total: counts,
              conflictingResponseIds: [],
            },
            cantripModelAttribution: capture,
            warnings: [],
            errors: [],
          },
        ],
      },
    },
    "thread",
  );
  const preparedTurn = await result({
    op: "content.turn.prepare",
    binding,
    snapshot,
    turnId: "turn",
    revision: 4,
  });
  const expectedTurn = await prepareNativeHistoryTurn({
    service,
    binding,
    snapshot,
    turnId: "turn",
    revision: 4,
  });
  const unsealed = (turn) => {
    const { metadata, ...header } = turn;
    return header;
  };
  same(
    unsealed(preparedTurn),
    unsealed(expectedTurn),
    "prepared turn public metadata",
  );
  same(
    await openNativeHistoryTurn({ service, binding, turn: preparedTurn }),
    await openNativeHistoryTurn({ service, binding, turn: expectedTurn }),
    "complete turn source and chronology",
  );
  await compare(
    {
      op: "content.turn.prepare",
      binding,
      snapshot,
      turnId: "absent",
      revision: 4,
    },
    () =>
      prepareNativeHistoryTurn({
        service,
        binding,
        snapshot,
        turnId: "absent",
        revision: 4,
      }),
  );
  const overflow = structuredClone(snapshot);
  overflow.thread.turns[0].startedAt = Number.MAX_VALUE;
  await compare(
    {
      op: "content.turn.prepare",
      binding,
      snapshot: overflow,
      turnId: "turn",
      revision: 4,
    },
    () =>
      prepareNativeHistoryTurn({
        service,
        binding,
        snapshot: overflow,
        turnId: "turn",
        revision: 4,
      }),
    "timestamp overflow is rejected before serialization",
  );
  for (const metadata of [
    null,
    { retention: "partial", usage: null },
    { retention: "complete", usage: null },
    { retention: "unavailable", usage: null },
    {
      retention: "complete",
      usage: {
        responses: [
          { threadId: "ancestor", responseId: "copied", usage: counts },
        ],
        conflictingResponseIds: [],
      },
    },
    {
      retention: "complete",
      cantripModelAttribution: capture,
      usage: {
        responses: [
          { threadId: "thread", responseId: "r2", usage: counts },
          { threadId: "thread", responseId: "r10", usage: counts },
          {
            threadId: "thread",
            responseId: "r2",
            usage: { ...counts, totalTokens: 99 },
          },
        ],
        conflictingResponseIds: ["unseen"],
      },
    },
  ]) {
    await compare(
      { op: "content.usage", threadId: "thread", turnId: "turn", metadata },
      () => nativeHistoryUsageForTurn("thread", "turn", metadata),
    );
    await compare(
      {
        op: "content.attribution",
        threadId: "thread",
        turnId: "turn",
        metadata,
      },
      () => nativeHistoryModelAttributionForTurn("thread", "turn", metadata),
    );
  }
  await runHistoryUsageCases({
    unchanged: async (_label, run) => run(),
    call: async (label, input, error) => {
      const output = await native({
        op: "content.usage.reconcile",
        previous: input.previous,
        incoming: input.input,
      });
      if (error) {
        same(output, { ok: false, error: error.message }, label);
        return [];
      }
      assert.equal(output.ok, true, output.error);
      same(
        output.value,
        reconcileNativeHistoryUsage(input.previous, input.input),
        label,
      );
      return [output.value];
    },
  });
  const id = "11111111-1111-4111-8111-111111111111",
    message = {
      role: "assistant",
      content: [{ type: "text", text: source.body.text }],
      idempotencyKey: "canonical",
    };
  const nodeMessage = await protectChatMessage({ id, message, service });
  await compare({ op: "content.message.open", message: nodeMessage }, () =>
    openMessage({
      ownerId: "owner",
      componentKey: service.componentKey("chat-content").key,
      message: nodeMessage,
    }),
  );
  const nativeMessage = await result({
    op: "content.message.protect",
    id,
    message,
  });
  same(
    await openMessage({
      ownerId: "owner",
      componentKey: service.componentKey("chat-content").key,
      message: nativeMessage,
    }),
    message.content,
    "native message opens in Node",
  );
  const rendered = { identity, source, message };
  const mapping = {
    identity,
    key: "a".repeat(64),
    messageId: id,
    idempotencyKey: "canonical",
    preservedInput: nodeMessage,
  };
  const prepare = {
    op: "content.prepare",
    binding,
    rendered,
    mapping,
    revision: 4,
    order: { turn: 0, item: 0, component: 0 },
    attachments: [],
  };
  const prepared = await result(prepare);
  same(prepared.message, nodeMessage, "preserved GUI ciphertext stays exact");
  same(
    await openNativeHistoryItemEvidence({
      service,
      binding,
      identity,
      evidence: prepared.evidence,
    }),
    source,
    "transformed native source remains independent",
  );
  const fresh = await result({
    ...prepare,
    mapping: { ...mapping, preservedInput: null },
  });
  same(
    await openMessage({
      ownerId: "owner",
      componentKey: service.componentKey("chat-content").key,
      message: fresh.message,
    }),
    message.content,
    "fresh native canonical message",
  );
  for (const badMapping of [
    { ...mapping, identity: { ...identity, itemId: "other" } },
    { ...mapping, messageId: "22222222-2222-4222-8222-222222222222" },
  ])
    await compare({ ...prepare, mapping: badMapping }, () =>
      prepareNativeHistoryRenderedItem({
        service,
        ...prepare,
        mapping: badMapping,
      }),
    );
  const itemsPage = {
    binding: fullBinding,
    snapshotId: "e".repeat(64),
    items: [
      {
        key: "a".repeat(64),
        identity,
        messageId: id,
        attachments: [],
        revision: 5,
        state: "completed",
        order: { turn: 0, item: 0, component: 0 },
        evidence: prepared.evidence,
      },
    ],
    nextCursor: null,
  };
  const turnsPage = {
    binding: fullBinding,
    snapshotId: "e".repeat(64),
    turns: [{ bindingId: "binding", workerId: "worker", turn: preparedTurn }],
    nextCursor: null,
  };
  const batch = { items: [prepared], turns: [preparedTurn] },
    batchPage = {
      binding: fullBinding,
      snapshotId: "e".repeat(64),
      batches: [
        {
          bindingId: "binding",
          workerId: "worker",
          receipt: fixture.nativeHistoryCommitReceiptSchema[0],
          previousDigest: null,
          payloadDigest: nativeHistoryBatchPayloadDigest(batch, null),
          batch,
        },
      ],
      nextCursor: null,
    };
  for (const [kind, page, open] of [
    ["items", itemsPage, openNativeHistoryArchivePage],
    ["turns", turnsPage, openNativeHistoryTurnArchivePage],
    ["batches", batchPage, openNativeHistoryBatchArchivePage],
  ]) {
    await compare({ op: "content.archive." + kind, page }, () =>
      open({ service, page }),
    );
    let n = 0;
    const signal = {
      throwIfAborted() {
        if (++n === 2) throw new Error("fixture stopped");
      },
    };
    await compare({ op: "content.archive." + kind, page, stopAt: 2 }, () =>
      open({ service, page, signal }),
    );
  }
  await compare(
    {
      op: "content.archive.items",
      page: {
        ...itemsPage,
        items: [{ ...itemsPage.items[0], evidence: null }],
      },
    },
    () =>
      openNativeHistoryArchivePage({
        service,
        page: {
          ...itemsPage,
          items: [{ ...itemsPage.items[0], evidence: null }],
        },
      }),
  );
  await compare(
    {
      op: "content.archive.batches",
      page: {
        ...batchPage,
        batches: [{ ...batchPage.batches[0], batch: null }],
      },
    },
    () =>
      openNativeHistoryBatchArchivePage({
        service,
        page: {
          ...batchPage,
          batches: [{ ...batchPage.batches[0], batch: null }],
        },
      }),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      communicationKinds: 6,
      nativePreparation: true,
      archiveOpening: true,
      sharedUsageKernel: true,
      runtime: "macOS ARM64",
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await completion, 0);
}
