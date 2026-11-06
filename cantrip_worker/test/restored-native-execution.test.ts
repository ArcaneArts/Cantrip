import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type PrepareAdmittedNativeExecutionOptions,
} from "../src/codex/app-server.js";
import { workerContinuation } from "../src/codex/worker-turn-continuation.test-fixture.js";

const suspension = {
  threadId: "thread",
  turnId: "turn",
  checkpointId: "checkpoint",
  revision: 1,
};
const options: PrepareAdmittedNativeExecutionOptions = {
  operationGeneration: "fresh-operation",
  threadId: "thread",
  chatId: "chat",
  cwd: "/original-workspace",
  captureProtectedDiagnostics: false,
  model: {
    id: "changed",
    routeId: "route",
    name: "changed-default",
    reasoningEffort: null,
  },
  provider: {
    id: "provider",
    kind: "openai-compatible",
    name: "Fixture",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fresh-key",
  },
};
function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/original-home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    ensureStarted(...args: unknown[]): Promise<void>;
    request(method: string, params: unknown): Promise<unknown>;
  };
  const start = vi.spyOn(native, "ensureStarted").mockResolvedValue();
  const request = vi
    .spyOn(native, "request")
    .mockImplementation(async (method) =>
      method === "turn/suspension"
        ? { paused: true, suspension }
        : { thread: { id: "thread" } },
    );
  return { runtime, start, request };
}
describe("restored native observer preparation", () => {
  it("attaches with expected intent and never forwards native input or Resume", async () => {
    const f = fixture();
    expect(await f.runtime.restoreHeldTurn(suspension, options)).toEqual({
      paused: true,
      suspension,
    });
    expect(f.request.mock.calls).toEqual([
      ["turn/suspension", { threadId: "thread", operation: { type: "read" } }],
      ["thread/resume", { threadId: "thread", expectedSuspension: suspension }],
      ["turn/suspension", { threadId: "thread", operation: { type: "read" } }],
    ]);
  });
  it("joins duplicates, binds the original identity without a start event, and preserves bookkeeping", async () => {
    const f = fixture();
    const saved = workerContinuation();
    const activity = vi.fn();
    const input = { ...options, onActivity: activity };
    const [first, second] = await Promise.all([
      f.runtime.prepareRestoredNativeExecution(input, suspension, saved),
      f.runtime.prepareRestoredNativeExecution(input, suspension, saved),
    ]);
    expect(second).toBe(first);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledWith(saved.model, options.provider);
    const observed = f.runtime.captureWorkerTurnContinuation("thread", "turn");
    expect(observed.baseline).toEqual(saved.baseline);
    expect(observed.latestUsage).toEqual(saved.latestUsage);
    expect(observed.completedCommandIds).toEqual(saved.completedCommandIds);
    expect(activity).not.toHaveBeenCalled();
    expect(f.runtime.isChatPaused("chat")).toBe(true);
    await expect(
      f.runtime.prepareRestoredNativeExecution(
        { ...input, operationGeneration: "other-owner" },
        suspension,
        saved,
      ),
    ).rejects.toThrow(/Another admitted observer/);
    first.fail(new Error("fixture cleanup"));
    await expect(first.completion).rejects.toThrow("fixture cleanup");
  });
  it("retains the hold and retries actual attachment after a failed restore", async () => {
    const f = fixture();
    const saved = workerContinuation();
    f.request.mockRejectedValueOnce(
      new Error("actual checkpoint decode failure"),
    );
    await expect(
      f.runtime.prepareRestoredNativeExecution(options, suspension, saved),
    ).rejects.toThrow("actual checkpoint decode failure");
    const handle = await f.runtime.prepareRestoredNativeExecution(
      options,
      suspension,
      saved,
    );
    expect(f.start).toHaveBeenCalledTimes(2);
    handle.fail(new Error("fixture cleanup"));
    await expect(handle.completion).rejects.toThrow("fixture cleanup");
  });
});
