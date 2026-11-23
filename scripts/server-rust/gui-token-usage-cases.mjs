import assert from "node:assert/strict";
import { stamp } from "./project-target-state.mjs";
export async function runGuiTokenUsageCases(h) {
  const { observe, seed, clean, snapshot, capture, reopen } = h;
  const base = {
    sourceKey: "gui-usage",
    projectId: "github",
    chatId: "chat",
    modelRouteId: "gui-anchor",
    workerId: "alpha",
    providerAccountId: null,
    executionAttemptId: "gui-usage-attempt",
    attemptKind: "chat-turn",
    attemptStatus: "running",
    reasoningEffort: "high",
  };
  const canonical = (thread = capture.threadId, turn = capture.turnId) =>
    "native-turn:" + JSON.stringify(["chat", thread, turn]);
  const totals = (n) => ({
    totalTokens: n * 2,
    inputTokens: n,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: n,
    reasoningOutputTokens: 0,
  });
  const native = (...counts) => ({
    version: 1,
    modelAttribution: capture,
    responses: counts.map((n, i) => ({
      responseId: "response-" + i,
      usage: totals(n),
    })),
    complete: true,
    conflictingResponseIds: [],
  });
  const write = (name, record = {}, options = {}) =>
    observe(
      name,
      { action: "usage", record: { ...base, ...record } },
      { op: "native-command-gui-telemetry", shape: "raw", ...options },
    );
  const captured = (extra = {}) => ({
    turnId: capture.turnId,
    nativeModelAttribution: capture,
    ...extra,
  });
  const exact = (extra = {}) => ({
    sourceKey: canonical(),
    turnId: capture.turnId,
    nativeTurn: { threadId: capture.threadId, turnId: capture.turnId },
    ...extra,
  });
  async function refused(name, record, options = {}) {
    const before = await snapshot("before " + name);
    await write(name, record, { error: true, ...options });
    assert.deepEqual(await snapshot("after " + name), before);
  }
  await clean();
  await write("persist a zero-count GUI bootstrap", { startedAt: stamp });
  let states = await snapshot("actual GUI bootstrap usage");
  for (const s of states) {
    const r = s.usageRecords[0];
    assert.equal(r.attempt_status, "running");
    assert.equal(r.reported_total_tokens, null);
    assert.equal(r.completed_at, null);
    assert.equal(r.input_tokens, 0);
  }
  await write("native capture adopts its GUI bootstrap source", captured());
  states = await snapshot("one exact native turn and its GUI source alias");
  for (const s of states) {
    assert.equal(s.usageRecords.length, 1);
    const r = s.usageRecords[0];
    assert.equal(r.source_key, canonical());
    assert.deepEqual(r.source_aliases, [base.sourceKey]);
    assert.equal(r.model_route_id, "gui-chosen");
    assert.equal(r.reasoning_effort, "low");
  }
  await write(
    "native responses own the deduplicated turn subtotal",
    exact({
      nativeUsage: native(10, 20),
      attemptStatus: "completed",
      completedAt: stamp,
      finalizedAt: stamp,
    }),
  );
  const measured = await snapshot("complete native response subtotal");
  for (const s of measured) {
    const r = s.usageRecords[0];
    assert.equal(r.input_tokens, 30);
    assert.equal(r.output_tokens, 30);
    assert.equal(r.reported_total_tokens, 60);
    assert.equal(r.usage_semantics, "native-responses-complete-v1");
  }
  await write(
    "late GUI finalizer cannot replace native counters or model evidence",
    {
      turnId: capture.turnId,
      usage: totals(999),
      attemptStatus: "failed",
      reasoningEffort: "high",
      modelRouteId: "gui-anchor",
      startedAt: "2026-10-26T00:00:00.123Z",
    },
  );
  states = await snapshot(
    "native counts and terminal state survive late GUI finalization",
  );
  for (const s of states) {
    const r = s.usageRecords[0];
    assert.equal(r.input_tokens, 30);
    assert.equal(r.attempt_status, "completed");
    assert.equal(r.model_route_id, "gui-chosen");
    assert.equal(r.reasoning_effort, "low");
    assert.equal(Date.parse(r.started_at), Date.parse(stamp));
  }
  await reopen(
    "general native usage and source aliases survive database reopen",
  );
  assert.deepEqual(await snapshot("usage state after actual reopen"), states);
  await refused("captured turn identity cannot name another turn", {
    ...captured(),
    turnId: "wrong",
  });
  await refused(
    "native identity and model capture must name the same thread",
    captured({ nativeTurn: { threadId: "wrong", turnId: capture.turnId } }),
  );
  await refused(
    "canonical source cannot name a different native turn",
    captured({ sourceKey: "native-turn:wrong" }),
  );
  await refused(
    "native model capture must belong to input worker",
    captured({
      nativeModelAttribution: {
        ...capture,
        selection: { ...capture.selection, workerId: "beta" },
      },
    }),
  );
  await refused(
    "native model capture must belong to input account",
    captured({
      nativeModelAttribution: {
        ...capture,
        selection: { ...capture.selection, providerAccountId: "other" },
      },
    }),
  );
  await refused(
    "conflicting retained capture rolls back alias adoption",
    captured({
      sourceKey: "new-conflicting-alias",
      nativeModelAttribution: { ...capture, reasoningEffort: "high" },
    }),
  );
  await refused(
    "ordinary late telemetry cannot impersonate a different worker",
    { turnId: capture.turnId, workerId: "beta" },
  );
  await refused("token usage verifies actual owned chat", {
    chatId: "other-chat",
  });
  await refused("token usage refuses missing owned chat", {
    chatId: "missing",
  });
  await write("an attempt alias may name a later exact native turn", {
    ...captured(),
    turnId: "second-turn",
    nativeModelAttribution: { ...capture, turnId: "second-turn" },
  });
  states = await snapshot("two distinct native turns share an attempt alias");
  for (const s of states) assert.equal(s.usageRecords.length, 2);
  await refused("ambiguous attempt alias requires the exact turn", {});
  await refused("unknown retained turn cannot consume another turn alias", {
    turnId: "unknown-turn",
  });
  await write("exact second turn resolves its shared attempt alias", {
    turnId: "second-turn",
    attemptStatus: "completed",
    usage: totals(7),
  });
  await snapshot("exact alias resolution updates only its own native turn");
  await clean();
  await write(
    "persist pre-canonical captured usage",
    captured({ sourceKey: "pre-canonical" }),
  );
  await seed(
    "UPDATE token_usage_records SET source_key='legacy-captured-source',source_aliases='[]'::jsonb",
  );
  await write(
    "unknown observer source finds the independently retained exact turn",
    captured({ sourceKey: "new-observer" }),
  );
  states = await snapshot(
    "legacy source adoption retains the original exact turn",
  );
  for (const s of states) {
    assert.equal(s.usageRecords.length, 1);
    assert.deepEqual(s.usageRecords[0].source_aliases, [
      "legacy-captured-source",
      "new-observer",
    ]);
  }
  await clean();
  await write(
    "pending GUI bootstrap before independently arriving native history",
    {},
  );
  await write(
    "canonical history arrives without knowing the GUI attempt alias",
    {
      ...exact(),
      ...captured(),
      nativeUsage: native(11),
      attemptStatus: "completed",
    },
  );
  states = await snapshot(
    "independent native observation and zero-count bootstrap",
  );
  for (const s of states) assert.equal(s.usageRecords.length, 2);
  await write(
    "exact captured GUI update merges only the zero-count bootstrap",
    captured(),
  );
  states = await snapshot(
    "one retained native usage row after bootstrap merge",
  );
  for (const s of states) {
    assert.equal(s.usageRecords.length, 1);
    assert.equal(s.usageRecords[0].input_tokens, 11);
    assert.deepEqual(s.usageRecords[0].source_aliases, [base.sourceKey]);
  }
  await clean();
  await write("independently measured bootstrap counts are retained", {
    usage: totals(5),
  });
  await write("independent measured native history", {
    ...exact(),
    ...captured(),
    nativeUsage: native(11),
  });
  await refused(
    "measured uncorrelated usage cannot be discarded during native adoption",
    captured(),
  );
  await clean();
  await write("ordinary source is scoped to its original chat", {
    sourceKey: "cross-chat-source",
    usage: totals(5),
  });
  await refused("ordinary source key cannot cross chat ownership", {
    sourceKey: "cross-chat-source",
    chatId: "task",
  });
  await clean();
  await write("retain complete native usage before conflicting response", {
    ...captured(),
    nativeUsage: native(10, 20),
  });
  await write(
    "conflicting response evidence excludes its disputed subtotal",
    exact({ nativeUsage: native(999, 20) }),
  );
  await write(
    "replayed original response cannot erase the conflict",
    exact({ nativeUsage: native(10, 20) }),
  );
  states = await snapshot("partial native response evidence remains explicit");
  for (const s of states) {
    const r = s.usageRecords[0];
    assert.equal(r.native_usage.complete, false);
    assert.deepEqual(r.native_usage.conflictingResponseIds, ["response-0"]);
    assert.equal(r.input_tokens, 20);
    assert.equal(r.reported_total_tokens, null);
    assert.equal(r.usage_semantics, "native-responses-partial-v1");
  }
  const overflowing = native(10, 20);
  overflowing.responses.push({
    responseId: "overflow",
    usage: {
      totalTokens: 9007199254740991,
      inputTokens: 9007199254740991,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  await write(
    "unsafe aggregate retains evidence without inventing a subtotal",
    exact({ nativeUsage: overflowing }),
  );
  states = await snapshot("unsafe total preserves prior known counters");
  for (const s of states) {
    assert.equal(s.usageRecords[0].input_tokens, 20);
    assert.equal(s.usageRecords[0].native_usage.complete, false);
  }
  await clean();
  await write("retain bootstrap before real SQL capture failure", {});
  const beforeFailure = await snapshot(
    "bootstrap before SQL constraint failure",
  );
  await seed(
    "ALTER TABLE token_usage_records ADD CONSTRAINT reject_gui_capture CHECK(native_model_attribution IS NULL)",
  );
  await write(
    "actual usage SQL failure rolls back canonical rename and aliases",
    captured(),
    { error: true, sqlstate: "23514" },
  );
  assert.deepEqual(
    await snapshot("bootstrap survives failed canonical usage write"),
    beforeFailure,
  );
  await seed(
    "ALTER TABLE token_usage_records DROP CONSTRAINT reject_gui_capture",
  );
  await write("native usage retries after actual SQL rollback", captured());
  await write("native usage capture retry is idempotent", captured());
  states = await snapshot(
    "exactly one accepted native usage record after retry",
  );
  for (const s of states) assert.equal(s.usageRecords.length, 1);
  await clean();
  await write("non-chat telemetry retains its ordinary source identity", {
    chatId: null,
    sourceKey: "non-chat",
    turnId: capture.turnId,
    nativeTurn: { threadId: capture.threadId, turnId: capture.turnId },
    usage: totals(1.25),
    workerVersion: "worker",
    serverVersion: "server",
    codexVersion: "codex",
    attemptStatus: "completed",
  });
  await write("undefined versions retain earlier metadata", {
    chatId: null,
    sourceKey: "non-chat",
    turnId: capture.turnId,
    usage: totals(2),
    attemptStatus: "running",
  });
  states = await snapshot("non-chat terminal status and version fields");
  for (const s of states) {
    const r = s.usageRecords[0];
    assert.equal(r.source_key, "non-chat");
    assert.equal(r.worker_version, "worker");
    assert.equal(r.server_version, "server");
    assert.equal(r.attempt_status, "completed");
  }
  await write("explicit null clears optional usage metadata", {
    chatId: null,
    sourceKey: "non-chat",
    turnId: capture.turnId,
    workerVersion: null,
    serverVersion: null,
    codexVersion: null,
  });
  states = await snapshot("explicit null usage versions");
  for (const s of states) {
    assert.equal(s.usageRecords[0].worker_version, null);
    assert.equal(s.usageRecords[0].server_version, null);
  }
  await clean();
}
