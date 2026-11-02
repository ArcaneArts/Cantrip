import assert from "node:assert/strict";
import { literal, otherOwner, stamp } from "./project-target-state.mjs";
import { runGuiTokenUsageCases } from "./gui-token-usage-cases.mjs";
import { runGuiTelemetryRaces } from "./gui-telemetry-races.mjs";
import { runGuiRuntimeTelemetryCases } from "./gui-runtime-telemetry-cases.mjs";
import { runGuiRuntimeQuotaCases } from "./gui-runtime-quota-cases.mjs";
const empty = () => ({
  version: 1,
  turnIds: [],
  captures: [],
  conflictingTurnKeys: [],
});
export async function runGuiTelemetryCases(h) {
  const { observe, seed, reset, owner, reopen } = h;
  await reset();
  for (const [id, user] of [
    ["gui-provider", owner],
    ["gui-provider-other", owner],
    ["gui-provider-foreign", otherOwner],
  ])
    await seed(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(user)},${literal(id)},'ollama','http://localhost:11434') ON CONFLICT DO NOTHING`,
    );
  for (const [id, user] of [
    ["gui-model", owner],
    ["gui-model-other", owner],
    ["gui-model-foreign", otherOwner],
  ])
    await seed(
      `INSERT INTO model_profiles(id,owner_id,name) VALUES(${literal(id)},${literal(user)},${literal(id)}) ON CONFLICT DO NOTHING`,
    );
  for (const [i, [id, model, provider]] of [
    ["gui-anchor", "gui-model", "gui-provider"],
    ["gui-chosen", "gui-model", "gui-provider"],
    ["gui-other-model", "gui-model-other", "gui-provider"],
    ["gui-other-provider", "gui-model", "gui-provider-other"],
    ["gui-foreign", "gui-model-foreign", "gui-provider-foreign"],
  ].entries())
    await seed(
      `INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES(${literal(id)},${literal(model)},${literal(provider)},${literal(id)},${i},true) ON CONFLICT DO NOTHING`,
    );
  const capture = {
    threadId: "gui-native-thread",
    turnId: "gui-native-turn",
    isRoot: true,
    reasoningEffort: "low",
    selection: {
      status: "resolved",
      workerId: "alpha",
      providerId: "gui-provider",
      providerAccountId: null,
      modelId: "gui-model",
      routeId: "gui-chosen",
    },
  };
  const evidence = (...captures) => ({
    ...empty(),
    captures,
    turnIds: captures.map((c) => c.turnId),
  });
  const base = {
    sourceKey: "gui-behavior",
    projectId: "github",
    chatId: "chat",
    modelRouteId: "gui-anchor",
    executionAttemptId: "gui-attempt",
    attemptStatus: "running",
    workerId: "alpha",
    providerAccountId: null,
    reasoningEffort: "high",
  };
  const write = (name, record = {}, options = {}) =>
    observe(
      name,
      { action: "behavior", record: { ...base, ...record } },
      { op: "native-command-gui-telemetry", shape: "raw", ...options },
    );
  const snapshot = (name) =>
    observe(
      name,
      {
        telemetrySnapshot: true,
        sql: "SELECT jsonb_build_object('behaviorRecords',(SELECT jsonb_agg(to_jsonb(b) ORDER BY owner_id,source_key) FROM model_behavior_observations b),'usageRecords',(SELECT jsonb_agg(to_jsonb(u) ORDER BY owner_id,source_key) FROM token_usage_records u)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  const clean = () =>
    seed([
      "DELETE FROM model_behavior_observations",
      "DELETE FROM token_usage_records",
    ]);
  await clean();
  await write("legacy behavior input retains its selected route", {
    toolCallCount: 2.49,
    invalidToolCallCount: -1,
    durationMs: 10.5,
    contextUsedPercent: 12.345,
    startedAt: stamp,
  });
  let states = await snapshot("actual legacy behavior metrics");
  for (const s of states) {
    const r = s.behaviorRecords[0];
    assert.equal(r.model_route_id, "gui-anchor");
    assert.equal(r.reasoning_effort, "high");
    assert.equal(r.tool_call_count, 2);
    assert.equal(r.invalid_tool_call_count, 0);
    assert.equal(r.duration_ms, 11);
    assert.equal(r.context_used_percent_basis_points, 1235);
  }
  await write("empty observed evidence stays explicitly unattributed", {
    nativeAttribution: empty(),
  });
  states = await snapshot("empty evidence does not inherit launch defaults");
  for (const s of states) {
    const r = s.behaviorRecords[0];
    assert.equal(r.model_id, null);
    assert.equal(r.reasoning_effort, null);
    assert.equal(r.signal_availability.nativeModelKnown, false);
    assert.equal(r.signal_availability.nativeReasoningKnown, false);
  }
  await write("captured native route replaces the bootstrap route", {
    nativeAttribution: evidence(capture),
    toolCallCount: 8,
    firstActivityAt: stamp,
    finalAnswerAppeared: true,
    signalAvailability: { fork: true, copy: false },
  });
  await write("completion retains actual attribution", {
    attemptStatus: "completed",
    turnId: capture.turnId,
    toolCallCount: 8,
    finalAnswerAppeared: true,
    completedAt: stamp,
    finalizedAt: stamp,
  });
  const finalized = await snapshot(
    "accepted native route and completion metrics",
  );
  for (const s of finalized) {
    const r = s.behaviorRecords[0];
    assert.equal(r.model_route_id, "gui-chosen");
    assert.equal(r.reasoning_effort, "low");
    assert.equal(r.tool_call_count, 8);
  }
  await write("late running snapshot cannot reopen a finalized attempt", {
    toolCallCount: 0,
    finalAnswerAppeared: false,
    workerVersion: "late",
    completedAt: null,
    finalizedAt: null,
  });
  const late = await snapshot(
    "late running telemetry preserves terminal counters",
  );
  for (const s of late) {
    const r = s.behaviorRecords[0];
    assert.equal(r.attempt_status, "completed");
    assert.equal(r.tool_call_count, 8);
    assert.equal(r.final_answer_appeared, true);
    assert.equal(r.worker_version, null);
  }
  await reopen("native behavior evidence survives actual database reopen");
  assert.deepEqual(await snapshot("native behavior after reopen"), late);
  for (const [name, fields] of [
    ["another attempt", { executionAttemptId: "other" }],
    ["another chat", { chatId: "task" }],
    ["another project", { projectId: "folder" }],
    ["another worker", { workerId: "beta" }],
    ["another account", { providerAccountId: "foreign-account" }],
    ["another session provider", { modelRouteId: "gui-other-provider" }],
  ]) {
    const before = await snapshot("before rejected behavior " + name);
    await write("behavior source rejects " + name, fields, { error: true });
    assert.deepEqual(await snapshot("after rejected behavior " + name), before);
  }
  await clean();
  await write(
    "behavior verifies actual chat ownership",
    { chatId: "other-chat" },
    { error: true },
  );
  await write(
    "behavior rejects missing owned chat",
    { chatId: "missing" },
    { error: true },
  );
  await write(
    "native capture must belong to the input worker",
    {
      nativeAttribution: evidence({
        ...capture,
        selection: { ...capture.selection, workerId: "beta" },
      }),
    },
    { error: true },
  );
  await write(
    "native capture must belong to the input account",
    {
      nativeAttribution: evidence({
        ...capture,
        selection: {
          ...capture.selection,
          providerAccountId: "foreign-account",
        },
      }),
    },
    { error: true },
  );
  await clean();
  await write("partial model coverage remains unattributed", {
    nativeAttribution: {
      ...evidence(capture),
      turnIds: [capture.turnId, "missing-capture"],
    },
  });
  states = await snapshot("partial native behavior coverage");
  for (const s of states) {
    assert.equal(s.behaviorRecords[0].model_route_id, null);
    assert.equal(s.behaviorRecords[0].reasoning_effort, null);
  }
  await write("late capture fills the actual coverage gap", {
    nativeAttribution: evidence({ ...capture, turnId: "missing-capture" }),
  });
  states = await snapshot("complete observed coverage");
  for (const s of states) {
    assert.equal(s.behaviorRecords[0].model_route_id, "gui-chosen");
    assert.equal(s.behaviorRecords[0].turn_id, null);
  }
  await write("conflicting model observations remain explicit", {
    nativeAttribution: evidence({ ...capture, reasoningEffort: "high" }),
  });
  await write("replayed original capture cannot erase a conflict", {
    nativeAttribution: evidence(capture),
  });
  states = await snapshot("native conflict is durable");
  for (const s of states) {
    assert.equal(
      s.behaviorRecords[0].native_attribution.conflictingTurnKeys.length,
      1,
    );
    assert.equal(s.behaviorRecords[0].model_route_id, null);
    assert.equal(
      s.behaviorRecords[0].signal_availability.nativeReasoningKnown,
      false,
    );
  }
  await clean();
  await write("root and child use their observed model routes", {
    nativeAttribution: evidence(capture, {
      ...capture,
      threadId: "child",
      turnId: "child-turn",
      isRoot: false,
      selection: {
        ...capture.selection,
        routeId: "gui-other-model",
        modelId: "gui-model-other",
      },
    }),
  });
  states = await snapshot("mixed observed models remain unattributed");
  for (const s of states) assert.equal(s.behaviorRecords[0].model_id, null);
  await clean();
  await write("foreign catalog selection cannot attribute owned statistics", {
    nativeAttribution: evidence({
      ...capture,
      selection: {
        ...capture.selection,
        providerId: "gui-provider-foreign",
        modelId: "gui-model-foreign",
        routeId: "gui-foreign",
      },
    }),
  });
  states = await snapshot("foreign capture retained as unknown evidence");
  for (const s of states) {
    assert.equal(s.behaviorRecords[0].model_id, null);
    assert.equal(s.behaviorRecords[0].provider_id, "gui-provider");
  }
  await clean();
  await write("retain chosen model evidence before catalog deletion", {
    nativeAttribution: evidence(capture),
  });
  await seed("DELETE FROM model_routes WHERE id='gui-chosen'");
  await write(
    "catalog deletion never reassigns captured behavior to bootstrap",
    { attemptStatus: "completed" },
  );
  states = await snapshot("captured behavior after route removal");
  for (const s of states) {
    assert.equal(s.behaviorRecords[0].model_route_id, null);
    assert.equal(s.behaviorRecords[0].reasoning_effort, "low");
  }
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('gui-chosen','gui-model','gui-provider','gui-chosen',1,true)",
  );
  await clean();
  await seed(
    "ALTER TABLE model_behavior_observations ADD CONSTRAINT reject_gui_native_behavior CHECK(native_attribution IS NULL)",
  );
  await write(
    "actual behavior SQL failure rolls back the attempt",
    { nativeAttribution: evidence(capture) },
    { error: true, sqlstate: "23514" },
  );
  states = await snapshot("failed native behavior writer retained no row");
  for (const s of states) assert.equal(s.behaviorRecords, null);
  await seed(
    "ALTER TABLE model_behavior_observations DROP CONSTRAINT reject_gui_native_behavior",
  );
  await write("retry after real behavior SQL rollback", {
    nativeAttribution: evidence(capture),
  });
  await write("idempotent behavior retry retains one capture", {
    nativeAttribution: evidence(capture),
  });
  states = await snapshot("one durable model behavior observation");
  for (const s of states) {
    assert.equal(s.behaviorRecords.length, 1);
    assert.equal(s.behaviorRecords[0].native_attribution.captures.length, 1);
  }
  await clean();
  await runGuiTokenUsageCases({ ...h, clean, snapshot, capture });
  if (h.databaseMode === "postgres")
    await runGuiTelemetryRaces({ ...h, clean, snapshot, capture, base });
  await runGuiRuntimeTelemetryCases({ ...h, clean, snapshot, capture });
  await runGuiRuntimeQuotaCases(h);
}
