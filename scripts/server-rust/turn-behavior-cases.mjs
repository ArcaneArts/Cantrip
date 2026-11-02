import assert from "node:assert/strict";
export async function runTurnBehaviorCases({ observe }) {
  const capture = {
    threadId: "native-thread",
    turnId: "native-turn",
    isRoot: true,
    reasoningEffort: "low",
    selection: {
      status: "resolved",
      workerId: "alpha",
      providerId: "provider",
      providerAccountId: null,
      modelId: "model",
      routeId: "route",
    },
  };
  const run = (name, fields) =>
    observe(name, fields, { op: "native-command-gui-behavior", shape: "raw" });
  await run("empty content-free behavior tracker", {});
  const marker = "private-turn-behavior-content-must-not-be-retained";
  const result = await run(
    "streamed tools, tests, approvals and paths deduplicate",
    {
      actions: [
        {
          kind: "activity",
          value: {
            id: "test",
            type: "command",
            status: "running",
            command: "pnpm test",
            exitCode: null,
            output: marker,
          },
        },
        {
          kind: "activity",
          value: {
            id: "test",
            type: "command",
            status: "completed",
            command: "pnpm test",
            exitCode: 0,
            output: marker,
          },
        },
        {
          kind: "activity",
          value: {
            id: "tool",
            type: "mcpToolCall",
            status: "completed",
            error: marker,
          },
        },
        {
          kind: "activity",
          value: {
            id: "files",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "a" }, { path: "b" }, { path: "a" }],
          },
        },
        {
          kind: "activity",
          value: {
            id: "compact",
            type: "contextCompaction",
            status: "completed",
          },
        },
        {
          kind: "activity",
          value: {
            id: "compact",
            type: "contextCompaction",
            status: "completed",
          },
        },
        { kind: "approval", key: "approval" },
        { kind: "approval", key: "approval" },
        { kind: "visible", final: false },
        { kind: "visible", final: true },
      ],
    },
  );
  for (const value of result) {
    assert.equal(JSON.stringify(value).includes(marker), false);
    assert.equal(value.snapshot.toolCallCount, 2);
    assert.equal(value.snapshot.invalidToolCallCount, 1);
    assert.equal(value.snapshot.testPassCount, 1);
    assert.equal(value.snapshot.filesChangedCount, 2);
    assert.equal(value.snapshot.compactionCount, 1);
    assert.equal(value.snapshot.approvalRequestCount, 1);
  }
  await run("tool outcome updates retain latest source status", {
    actions: [
      ...[null, 1, 0].map((exitCode) => ({
        kind: "activity",
        value: {
          id: "test",
          type: "command",
          status: exitCode === null ? "running" : "completed",
          command: "cargo test",
          exitCode,
        },
      })),
      ...[true, false].map((success) => ({
        kind: "activity",
        value: {
          id: "dynamic",
          type: "dynamicToolCall",
          status: "completed",
          success,
        },
      })),
      ...["webSearch", "imageView", "collabToolCall"].map((type) => ({
        kind: "activity",
        value: { id: type, type, status: "declined" },
      })),
    ],
  });
  const usage = {
    inputTokens: 70,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 2,
    outputTokens: 30,
    reasoningOutputTokens: 12,
    modelContextWindow: 128000,
    contextUsedPercent: 12.5,
  };
  await run("usage replaces counters and preserves first observation times", {
    actions: [
      { kind: "mark", at: "2026-10-25T00:00:00.123Z" },
      {
        kind: "activity",
        at: "2026-10-25T00:00:01.123Z",
        value: {
          type: "usage",
          last: usage,
          modelContextWindow: usage.modelContextWindow,
          contextUsedPercent: usage.contextUsedPercent,
        },
      },
      { kind: "visible", final: false, at: "2026-10-25T00:00:02.123Z" },
      {
        kind: "usage",
        at: "2026-10-25T00:00:03.123Z",
        value: {
          ...usage,
          inputTokens: 80,
          modelContextWindow: null,
          contextUsedPercent: null,
        },
      },
      { kind: "visible", final: true, at: "2026-10-25T00:00:04.123Z" },
    ],
  });
  await run("actual native model captures retain gaps and conflicts", {
    actions: [
      { kind: "native-turn", turn: "native-turn" },
      {
        kind: "native-event",
        value: {
          type: "agent.protected-message",
          telemetry: {
            kind: "usage",
            turnId: "native-turn",
            nativeModelAttribution: capture,
          },
        },
      },
      { kind: "mutate-snapshot" },
      {
        kind: "native-event",
        value: {
          type: "agent.activity",
          activity: {
            correlation: { turnId: "native-turn" },
            nativeModelAttribution: capture,
          },
        },
      },
      {
        kind: "native-turn",
        turn: "native-turn",
        capture: { ...capture, reasoningEffort: "high" },
      },
      {
        kind: "native-turn",
        turn: "native-turn",
        capture: { ...capture, threadId: "child", isRoot: false },
      },
      { kind: "native-turn", turn: "uncaptured" },
    ],
  });
  for (const type of [
    "agent.protected-message",
    "agent.protected-task-message",
    "agent.activity",
    "agent.message",
    "agent.checkpoint",
    "agent.interaction.requested",
    "agent.interaction.requested.protected",
    "agent.inference-progress",
  ]) {
    await run("native behavior turn observation " + type, {
      actions: [
        {
          kind: "native-event",
          value: {
            type,
            telemetry: {
              turnId: "turn",
              nativeModelAttribution: { ...capture, turnId: "turn" },
            },
            activity: { correlation: { turnId: "turn" } },
            message: { correlation: { turnId: "turn" } },
            turnId: "turn",
            request: { turnId: "turn" },
          },
        },
      ],
    });
  }
  await run("native behavior preserves UTF16 and locale capture order", {
    actions: ["z", "A", "a", "é", "e\u0301", "😀", "\ud800"].map(
      (threadId) => ({
        kind: "native-turn",
        turn: threadId,
        capture: { ...capture, threadId, turnId: threadId },
      }),
    ),
  });
  await run("test runner recognition retains JavaScript whitespace semantics", {
    commands: [
      "pnpm --filter @cantrip/server test",
      "cargo test --workspace",
      "./gradlew test",
      "gradle test",
      "go test ./...",
      "mvn -q test",
      "dotnet test",
      "pytest -q",
      "vitest run",
      "jest",
      "pnpm build",
      "echo test",
      "contest",
      "npm run check",
      "cd app && npm test",
      "x;vitest",
      "x|jest",
      "x&cargo test",
      "cargo\ufefftest",
      "cargo\u0085test",
      "pnpm\u00a0test",
      "CARGO TEST",
      " cargo test",
      "cargo\ntest",
      "pnpm testx",
      "npx vitest",
      "echo cargo test",
      "bun run test",
      "yarn test",
      "mvn test;echo done",
    ],
  });
}
