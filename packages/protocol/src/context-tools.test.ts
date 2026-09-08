import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_MUTATION_OPERATIONS,
  CANTRIP_MCP_MUTATION_TOOL_NAMES,
  cantripMcpContextCompactResultSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpToolNamesForOperations,
} from "./index.js";

const contextWindow = {
  threadId: "thread-one",
  turnId: "turn-one",
  usedTokens: 75_000,
  contextWindowTokens: 100_000,
  remainingTokens: 25_000,
  usedPercent: 75,
  remainingPercent: 25,
  usageUpdatedAtMs: 1_786_212_000_000,
  compactionScheduled: false,
};

describe("managed context tools", () => {
  it("keeps operation and tool catalogs index-aligned", () => {
    expect(CANTRIP_MCP_MUTATION_OPERATIONS[0]).toBe("context.compact");
    expect(CANTRIP_MCP_MUTATION_TOOL_NAMES[0]).toBe("context_compact");
    expect(
      cantripMcpToolNamesForOperations(["context.get", "context.compact"]),
    ).toEqual(["context_get", "context_compact"]);
  });

  it("returns exact occupancy and a turn-ending native compaction request", () => {
    expect(
      cantripMcpContextGetResultSchema.parse({
        summary: "Context is current.",
        target: null,
        worktreeId: "worktree-one",
        data: {
          worker: { id: "worker-one", name: "Worker one", online: true },
          context: {
            chatId: "chat-one",
            executionLaneId: "lane-one",
            permissionProfileId: ":workspace",
            projectId: "project-one",
            rootKind: "git-worktree",
            terminalId: null,
            workerId: "worker-one",
            worktreeId: "worktree-one",
            worktreeMode: "agent-managed",
          },
          binding: {
            status: "ready",
            mutationReady: true,
            staleClaims: [],
            recoveryInstruction: null,
            expiresAt: "2026-09-08T20:00:00.000Z",
          },
          contextWindow,
        },
      }).data.contextWindow,
    ).toEqual(contextWindow);

    expect(
      cantripMcpContextCompactResultSchema.parse({
        summary: "Compaction scheduled.",
        target: null,
        worktreeId: "worktree-one",
        continuationScheduled: true,
        mutated: true,
        data: { ...contextWindow, compactionScheduled: true },
      }),
    ).toMatchObject({
      continuationScheduled: true,
      mutated: true,
      data: { compactionScheduled: true },
    });
  });
});
