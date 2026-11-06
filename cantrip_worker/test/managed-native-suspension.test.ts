import { describe, expect, it, vi } from "vitest";
import {
  createManagedSuspensionCapture,
  isDurablePauseRewrite,
} from "../src/codex/managed-native-suspension.js";
import type { NativeSuspensionStore } from "../src/native-suspension-store.js";
import type { CodexAppServer } from "../src/codex/app-server.js";
import { workerContinuation } from "../src/codex/worker-turn-continuation.test-fixture.js";

const frame = {
  method: "turn/pause",
  params: { threadId: "thread", turnId: "turn", paused: true },
};
const forward = {
  method: "turn/suspension",
  params: { threadId: "thread", operation: { type: "pause", turnId: "turn" } },
};
const suspension = {
  threadId: "thread",
  turnId: "turn",
  checkpointId: "committed",
  revision: 1,
};

describe("admitted durable Pause", () => {
  it("allows only the exact stronger form of the admitted Pause", () => {
    expect(isDurablePauseRewrite(frame, forward)).toBe(true);
    for (const candidate of [
      { ...forward, method: "turn/interrupt" },
      { ...forward, params: { ...forward.params, threadId: "foreign" } },
      {
        ...forward,
        params: {
          ...forward.params,
          operation: { type: "discard", turnId: "turn" },
        },
      },
      {
        ...forward,
        params: {
          ...forward.params,
          operation: { type: "resume", turnId: "turn" },
        },
      },
      {
        ...forward,
        params: {
          ...forward.params,
          operation: { type: "pause", turnId: "foreign" },
        },
      },
      { ...forward, params: { ...forward.params, path: "/other-home" } },
      {
        ...forward,
        params: {
          ...forward.params,
          operation: { type: "pause", turnId: "turn", grant: "extra" },
        },
      },
    ])
      expect(isDurablePauseRewrite(frame, candidate)).toBe(false);
    expect(
      isDurablePauseRewrite(
        { ...frame, params: { ...frame.params, paused: false } },
        forward,
      ),
    ).toBe(false);
    expect(
      isDurablePauseRewrite({ ...frame, method: "turn/start" }, forward),
    ).toBe(false);
  });

  it("persists the original home after the native boundary without issuing a second Pause", async () => {
    const runtime = {
      captureTurnSuspension: vi.fn(),
      inspectTurnSuspension: vi.fn(async () => ({ paused: true, suspension })),
      managedHistoryHome: "/original-home",
      compatibility: { version: { raw: "0.166.0" } },
      captureWorkerTurnContinuation: workerContinuation,
    };
    const evidence = { suspension, storageId: "id" };
    const store = {
      commit: vi.fn(async (_input: Record<string, unknown>) => evidence),
    };
    const capture = createManagedSuspensionCapture(
      runtime as unknown as CodexAppServer,
      store as unknown as NativeSuspensionStore,
    );
    const session = {
      chatId: "chat",
      threadId: "thread",
      contextKind: "project" as const,
      projectId: "project",
      placementId: "placement",
      modelRouteId: "route",
      providerAccountId: "account",
      runtimeGeneration: "current-runtime",
      connectionId: "current-view",
    };
    expect(await capture({ session, turnId: "turn", suspension })).toBe(
      evidence,
    );
    expect(runtime.captureTurnSuspension).not.toHaveBeenCalled();
    const saved = store.commit.mock.calls[0]![0] as Record<string, any>;
    expect(saved.home).toBe("/original-home");
    expect(saved.source).not.toHaveProperty("runtimeGeneration");
    expect(saved.source).not.toHaveProperty("connectionId");
    runtime.inspectTurnSuspension.mockResolvedValueOnce({
      paused: false,
      suspension,
    });
    await expect(
      capture({ session, turnId: "turn", suspension }),
    ).rejects.toThrow(/changed/);
    await expect(
      capture({ session, turnId: "foreign", suspension }),
    ).rejects.toThrow(/different native turn/);
  });
});
