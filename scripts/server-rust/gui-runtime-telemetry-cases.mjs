import assert from "node:assert/strict";
import { stamp } from "./project-target-state.mjs";
export async function runGuiRuntimeTelemetryCases(h) {
  const { observe, seed, clean, snapshot, capture, standalone } = h;
  const execution = {
    projectId: "github",
    chatId: "chat",
    workerId: "alpha",
    modelRouteId: "gui-anchor",
    providerAccountId: null,
  };
  const runtime = {
    routeId: "gui-anchor",
    provider: { id: "gui-provider", accountId: null },
    model: { reasoningEffort: "high" },
  };
  const attribution = {
    workerId: "alpha",
    executionAttemptId: "runtime-attempt",
    attemptKind: "chat-turn",
    attemptStatus: "running",
    startedAt: stamp,
    codexVersion: "controlled-runtime",
  };
  const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        action: "runtime-usage",
        sourceKey: "runtime-usage-source",
        execution,
        runtime,
        usage,
        attribution,
        ...fields,
      },
      { op: "native-command-gui-telemetry", shape: "raw" },
    );
  await clean();
  let outputs = await run(
    "runtime token usage persists and publishes project metrics",
  );
  for (const output of outputs) {
    assert.equal(output.publications.length, 1);
    assert.equal(output.publications[0].completed, false);
    assert.deepEqual(output.warnings, []);
  }
  let states = await snapshot("live runtime usage metadata");
  for (const state of states) {
    const row = state.usageRecords[0];
    assert.equal(row.input_tokens, 5);
    assert.equal(row.worker_version, null);
    assert.equal(row.codex_version, "controlled-runtime");
    assert.equal(typeof row.server_version, "string");
  }
  outputs = await run(
    "completed runtime usage publishes a finalized metric update",
    {
      attribution: {
        ...attribution,
        attemptStatus: "completed",
        completedAt: stamp,
        finalizedAt: stamp,
      },
    },
  );
  for (const output of outputs)
    assert.equal(output.publications[0].completed, true);
  await snapshot("runtime usage finalization uses the actual writer");
  await clean();
  outputs = await run(
    "standalone runtime usage does not publish project metrics",
    { execution: { ...execution, projectId: null, chatId: standalone } },
  );
  for (const output of outputs) assert.deepEqual(output.publications, []);
  await snapshot("standalone runtime usage remains owner scoped");
  for (const mode of ["derived-attempt", "already-child", "no-attempt"]) {
    await clean();
    const child = {
      ...capture,
      threadId: "runtime-child",
      turnId: "runtime-child-turn",
      isRoot: false,
      selection: {
        ...capture.selection,
        modelId: "gui-model-other",
        routeId: "gui-other-model",
      },
    };
    const fields = {
      ...attribution,
      turnId: child.turnId,
      nativeModelAttribution: child,
    };
    if (mode === "already-child") {
      fields.attemptKind = "subagent-turn";
      fields.executionAttemptId = "already-child";
    }
    if (mode === "no-attempt") delete fields.executionAttemptId;
    await run("runtime observed child identity " + mode, {
      attribution: fields,
    });
    states = await snapshot("actual runtime child analytics " + mode);
    for (const state of states) {
      const row = state.usageRecords[0];
      assert.equal(row.attempt_kind, "subagent-turn");
      assert.equal(row.model_route_id, "gui-other-model");
      assert.equal(row.reasoning_effort, "low");
      assert.equal(row.turn_id, child.turnId);
      assert.equal(
        row.execution_attempt_id,
        mode === "no-attempt"
          ? null
          : mode === "already-child"
            ? "already-child"
            : "runtime-attempt:subagent:runtime-child:runtime-child-turn",
      );
      assert.deepEqual(row.source_aliases, [
        mode === "no-attempt"
          ? 'runtime-usage-source:native-child:["runtime-child","runtime-child-turn"]'
          : mode === "already-child"
            ? "chat-subagent:already-child"
            : "chat-subagent:runtime-attempt:subagent:runtime-child:runtime-child-turn",
      ]);
    }
  }
  await clean();
  await seed(
    "ALTER TABLE token_usage_records ADD CONSTRAINT reject_runtime_usage CHECK(false)",
  );
  outputs = await run(
    "runtime analytics SQL failure is degraded telemetry, not turn failure",
    {
      attribution: {
        ...attribution,
        turnId: capture.turnId,
        nativeModelAttribution: { ...capture, isRoot: false },
      },
    },
  );
  for (const output of outputs) {
    assert.deepEqual(output.publications, []);
    assert.deepEqual(output.warnings, [
      {
        message: "Unable to persist token usage analytics",
        sourceKey: "runtime-usage-source",
        error: true,
      },
    ]);
  }
  states = await snapshot(
    "failed runtime usage emits no invented durable result",
  );
  for (const s of states) assert.equal(s.usageRecords, null);
  await seed(
    "ALTER TABLE token_usage_records DROP CONSTRAINT reject_runtime_usage",
  );
  await clean();
  const behavior = {
    action: "runtime-behavior",
    sourceKey: "runtime-behavior-source",
    attribution: {
      ...attribution,
      routeAttemptIndex: 0,
      retryFailoverCount: 0,
    },
  };
  await run(
    "runtime behavior initially preserves unknown native evidence",
    behavior,
  );
  states = await snapshot(
    "empty live behavior evidence never inherits bootstrap model",
  );
  for (const state of states) {
    const row = state.behaviorRecords[0];
    assert.equal(row.model_id, null);
    assert.deepEqual(row.signal_availability, {
      fork: true,
      copy: false,
      rating: false,
      userRetryRegeneration: true,
      immediateCorrectiveFollowup: true,
      nativeModelKnown: false,
      nativeReasoningKnown: false,
    });
  }
  const marker = "private-runtime-command-content";
  outputs = await run(
    "runtime tracker feeds actual captured behavior to persistence",
    {
      ...behavior,
      attribution: {
        ...behavior.attribution,
        attemptStatus: "completed",
        completedAt: stamp,
        finalizedAt: stamp,
      },
      actions: [
        { kind: "native-turn", turn: capture.turnId, capture },
        {
          kind: "activity",
          value: {
            id: "runtime-command",
            type: "command",
            status: "completed",
            command: "cargo test " + marker,
            exitCode: 0,
            output: marker,
          },
        },
        { kind: "visible", final: true },
      ],
    },
  );
  for (const output of outputs) assert.deepEqual(output.warnings, []);
  states = await snapshot(
    "captured runtime behavior contains counters without command content",
  );
  for (const state of states) {
    const row = state.behaviorRecords[0];
    assert.equal(row.model_route_id, "gui-chosen");
    assert.equal(row.reasoning_effort, "low");
    assert.equal(row.tool_call_count, 1);
    assert.equal(row.test_pass_count, 1);
    assert.equal(row.final_answer_appeared, true);
    assert.equal(JSON.stringify(row).includes(marker), false);
  }
  await clean();
  await seed(
    "ALTER TABLE model_behavior_observations ADD CONSTRAINT reject_runtime_behavior CHECK(false)",
  );
  outputs = await run(
    "runtime behavior SQL failure remains a warning",
    behavior,
  );
  for (const output of outputs)
    assert.deepEqual(output.warnings, [
      {
        message: "Unable to persist model behavior analytics",
        sourceKey: "runtime-behavior-source",
        error: true,
      },
    ]);
  await seed(
    "ALTER TABLE model_behavior_observations DROP CONSTRAINT reject_runtime_behavior",
  );
  for (const [name, context, route, expected] of [
    ["same route and account", execution, runtime, true],
    ["changed route", { ...execution, modelRouteId: "other" }, runtime, false],
    [
      "changed account",
      { ...execution, providerAccountId: "other" },
      runtime,
      false,
    ],
    [
      "missing account differs from null",
      { modelRouteId: "gui-anchor" },
      runtime,
      false,
    ],
    [
      "both missing account fields",
      { modelRouteId: "gui-anchor" },
      { routeId: "gui-anchor", provider: {} },
      true,
    ],
  ]) {
    const results = await run("runtime resume identity " + name, {
      action: "runtime-resume",
      execution: context,
      runtime: route,
    });
    for (const result of results) assert.equal(result, expected);
  }
  await clean();
}
