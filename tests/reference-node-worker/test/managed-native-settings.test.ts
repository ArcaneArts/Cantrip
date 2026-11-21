import { describe, expect, it, vi } from "vitest";
import { ManagedNativeSettings } from "../src/codex/managed-native-settings.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";

const scope = {
  chatId: "chat",
  operationId: "operation",
  operationGeneration: "grant",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeOperationId: "native-operation",
};
const settings = {
  cwd: "/private/workspace",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "readOnly" },
  activePermissionProfile: null,
  model: "fixture",
  modelProvider: "provider",
  effort: "high",
  serviceTier: null,
  summary: null,
  collaborationMode: {
    mode: "default",
    settings: { developer_instructions: "private" },
  },
  personality: null,
};
function fixture() {
  const observations = new NativeHistoryObservations();
  observations.replace("runtime");
  const read = vi.fn(async (): Promise<never> => {
    throw new Error("No snapshot required");
  });
  const delivery = {
    track: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
  };
  const onError = vi.fn();
  const runtime = {
    observeNativeHistory: (
      threadId: string,
      observer: Parameters<NativeHistoryObservations["subscribe"]>[1],
    ) => observations.subscribe(threadId, observer, read),
  };
  const tracker = new ManagedNativeSettings({ runtime, delivery, onError });
  return { observations, delivery, tracker, read, onError };
}
const applied = {
  threadId: "thread",
  operationId: "native-operation",
  submissionId: "submission",
  threadSettings: settings,
};

describe("managed settings native evidence", () => {
  it("captures early application and late queue acknowledgment without reading history", async () => {
    const f = fixture();
    await f.tracker.track(scope);
    f.observations.notification("thread/settings/updated", applied);
    await f.tracker.acknowledge(scope.nativeOperationId, {
      result: {
        operationId: scope.nativeOperationId,
        submissionId: "submission",
      },
    });
    expect(f.delivery.record.mock.calls).toEqual([
      [scope, "applied", "submission", applied],
      [
        scope,
        "queued",
        "submission",
        {
          result: {
            operationId: scope.nativeOperationId,
            submissionId: "submission",
          },
        },
      ],
    ]);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("captures asynchronous rejection before queue acknowledgment without borrowing an active turn", async () => {
    const f = fixture();
    await f.tracker.track(scope);
    const error = {
      threadId: "thread",
      turnId: "submission",
      willRetry: false,
      error: {
        message: "Settings rejected",
        codexErrorInfo: {
          threadSettingsUpdateFailed: { operationId: scope.nativeOperationId },
        },
      },
    };
    f.observations.notification("error", error);
    await f.tracker.acknowledge(scope.nativeOperationId, null);
    expect(f.delivery.record).toHaveBeenNthCalledWith(
      1,
      scope,
      "rejected",
      "submission",
      error,
    );
    expect(f.delivery.record).toHaveBeenNthCalledWith(
      2,
      scope,
      "transport-lost",
      "submission",
      { reason: "native-response-unavailable" },
    );
  });

  it("ignores unrelated thread/operation errors and retains mismatched queue identities as conflicting evidence", async () => {
    const f = fixture();
    await f.tracker.track(scope);
    f.observations.notification("thread/settings/updated", {
      ...applied,
      threadId: "child",
    });
    f.observations.notification("thread/settings/updated", {
      ...applied,
      operationId: "other",
    });
    f.observations.notification("error", {
      threadId: "thread",
      turnId: "real-turn",
      willRetry: false,
      error: { message: "model failed", codexErrorInfo: "badRequest" },
    });
    expect(f.delivery.record).not.toHaveBeenCalled();
    const wrong = {
      result: { operationId: "other", submissionId: "submission" },
    };
    await f.tracker.acknowledge(scope.nativeOperationId, wrong);
    expect(f.delivery.record).toHaveBeenCalledWith(
      scope,
      "correlation-conflict",
      null,
      wrong,
    );
  });

  it("reports transport replacement and refuses registration on the retired transport", async () => {
    const f = fixture();
    await f.tracker.track(scope);
    f.observations.replace("new-runtime");
    expect(f.delivery.record).toHaveBeenCalledWith(
      scope,
      "transport-lost",
      null,
      { reason: "native-transport-closed" },
    );
    await expect(
      f.tracker.track({
        ...scope,
        nativeOperationId: "other",
        operationId: "other",
      }),
    ).rejects.toThrow("replaced or closed");
    f.observations.notification("thread/settings/updated", applied);
    expect(f.delivery.record).toHaveBeenCalledTimes(1);
  });
});
