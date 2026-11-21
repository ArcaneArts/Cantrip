import { describe, expect, it, vi } from "vitest";
import {
  captureWorkerTurn,
  restoreWorkerTurn,
  workerTurnContinuationSchema,
} from "../src/codex/worker-turn-continuation.js";
import { workerTurnState } from "../src/codex/worker-turn-continuation.test-fixture.js";

describe("worker continuation bookkeeping", () => {
  it("restores baseline, context and deduplication with new authority and excludes offline time", () => {
    vi.useFakeTimers();
    try {
      const original = workerTurnState();
      original.admission.operationGeneration = "old-operation";
      original.admission.resolvedRequestIds = new Set(["number:1"]);
      Object.assign(original, {
        executionGrant: "must-not-save",
        apiKey: "must-not-save",
      });
      const saved = captureWorkerTurn(original, "turn");
      expect(JSON.stringify(saved)).not.toContain("must-not-save");
      expect(JSON.stringify(saved)).not.toContain("old-lane");
      vi.advanceTimersByTime(60_000);
      const fresh = workerTurnState();
      fresh.admission.resolvedRequestIds = new Set(["number:2"]);
      const replyIds = fresh.admission.resolvedRequestIds;
      const authority = fresh.admission;
      const resolve = fresh.resolve;
      fresh.baseline.clear();
      fresh.completedCommandIds.clear();
      restoreWorkerTurn(fresh, JSON.parse(JSON.stringify(saved)));
      expect(fresh.baseline).toEqual(original.baseline);
      expect(fresh.completedCommandIds).toEqual(original.completedCommandIds);
      expect(fresh.latestUsage).toEqual(original.latestUsage);
      expect(fresh.liveAgentMessageFingerprints).toEqual(
        original.liveAgentMessageFingerprints,
      );
      expect(fresh.admission).toBe(authority);
      expect(fresh.admission.operationGeneration).toBe("fresh-operation");
      expect(fresh.resolve).toBe(resolve);
      expect(fresh.startedAtMs).toBe(original.startedAtMs + 60_000);
      expect(fresh.fileStartedAtMs.get("before.txt")).toBe(
        original.fileStartedAtMs.get("before.txt")! + 60_000,
      );
      expect(saved).not.toHaveProperty("resolvedRequestIds");
      expect(fresh.admission.resolvedRequestIds).toBe(replyIds);
      expect(fresh.admission.resolvedRequestIds.has("number:1")).toBe(false);
      expect(
        workerTurnContinuationSchema.safeParse({
          ...saved,
          executionGrant: "forbidden",
        }).success,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains a caller's fresh source when stored identity is wrong", () => {
    const original = workerTurnState();
    const saved = captureWorkerTurn(original, "turn");
    for (const patch of [
      { threadId: "foreign" },
      { chatId: "foreign" },
      { cwd: "/foreign" },
      { providerId: "foreign" },
    ]) {
      const fresh = workerTurnState();
      expect(() => restoreWorkerTurn(fresh, { ...saved, ...patch })).toThrow(
        /another native execution source/,
      );
      expect(fresh.admission.controller.signal.aborted).toBe(false);
    }
  });
});
