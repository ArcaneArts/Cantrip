import { describe, expect, it, vi } from "vitest";
import {
  taskInferenceInputReceiptSchema,
  type TaskInferenceInputReceipt,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import {
  CodexAppServer,
  type GoalRuntimeOptions,
} from "../src/codex/app-server.js";
import { WorkerInferenceAdmission } from "../src/inference-admission.js";
import { connectFixtureNativeObservation } from "./fixtures/connected-native-observation.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

const options: GoalRuntimeOptions = {
  cwd: "/unused/task-permission-handoff",
  threadId: "planning-thread",
  permissionProfileId: ":yolo",
  model: {
    id: "model",
    routeId: "route",
    name: "gpt-5.6-sol",
    reasoningEffort: null,
  },
  provider: {
    id: "provider",
    name: "ChatGPT",
    kind: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
    apiKey: null,
  },
};

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    null,
    null,
    new WorkerInferenceAdmission(
      {
        serverId: "server",
        ownerId: "owner",
        workerId: "worker",
        workerGeneration: "b64163b5-e606-417b-b202-3d3c4773f352",
      },
      (error) => {
        throw error;
      },
    ),
  );
  connectFixtureNativeObservation(runtime);
  const native = runtime as unknown as {
    ensureStarted(): Promise<void>;
    permissionProfilesSupported(): boolean;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    loadThread(
      input: GoalRuntimeOptions & {
        resultMode?: { kind: "structured"; outputSchema: object };
      },
    ): Promise<string | null>;
    handleMessage(data: Buffer): void;
    startTaskGoalFirstInput(
      threadId: string,
      receipt: TaskInferenceInputReceipt,
      start: () => Promise<unknown>,
    ): Promise<unknown>;
  };
  native.ensureStarted = vi.fn().mockResolvedValue(undefined);
  native.permissionProfilesSupported = () => true;
  let loaded = false;
  let security: Record<string, unknown> = { sandbox: "read-only" };
  const goal = {
    threadId: options.threadId,
    objective: "Implement plan",
    status: "blocked",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  native.request = vi.fn(async (method, params) => {
    if (method === "thread/resume") {
      // Match native rejoin behavior: overrides on a loaded Core are ignored.
      if (!loaded) security = { ...params };
      loaded = true;
      return { thread: { id: options.threadId } };
    }
    if (method === "thread/unsubscribe") {
      loaded = false;
      native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method: "thread/closed",
            params: { threadId: options.threadId },
          }),
        ),
      );
      return {};
    }
    if (method === "thread/managedConfig/update")
      return { threadId: options.threadId, applied: true };
    if (method === "collaborationMode/list") {
      return {
        data: [{ mode: "default", model: null, reasoning_effort: null }],
      };
    }
    if (method === "thread/settings/update") {
      const input = params as {
        operationId: string;
        collaborationMode: ReturnType<
          typeof nativeThreadSettings
        >["collaborationMode"];
      };
      const submissionId = `submission:${input.operationId}`;
      native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method: "thread/settings/updated",
            params: {
              threadId: options.threadId,
              operationId: input.operationId,
              submissionId,
              threadSettings: nativeThreadSettings({
                collaborationMode: input.collaborationMode,
              }),
            },
          }),
        ),
      );
      return { operationId: input.operationId, submissionId };
    }
    if (method === "thread/goal/get") return { goal };
    if (method === "thread/goal/set")
      return { goal: { ...goal, status: params.status } };
    throw new Error(`Unexpected ${method}`);
  });
  return { runtime, native, security: () => security };
}

describe("Task planning permission handoff", () => {
  it.each(["create", "resume", "conversation"])(
    "restores the selected permissions before %s on the same loaded planning thread",
    async (action) => {
      const f = fixture();
      await f.native.loadThread({
        ...options,
        resultMode: { kind: "structured", outputSchema: {} },
      });
      expect(f.security()).toMatchObject({
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      if (action === "create") {
        await f.runtime.createGoal({
          ...options,
          objective: "Implement plan",
          configureTaskPermissions: true,
        });
      } else if (action === "resume") {
        await f.runtime.updateGoal({
          ...options,
          threadId: options.threadId!,
          status: "active",
          configureTaskPermissions: true,
        });
      } else {
        await f.native.loadThread(options);
      }
      expect(f.security()).toMatchObject({
        permissions: ":danger-full-access",
        approvalPolicy: "never",
      });
      expect(f.security()).not.toHaveProperty("sandbox");
      const methods = vi
        .mocked(f.native.request)
        .mock.calls.map(([method]) => method);
      expect(methods.indexOf("thread/unsubscribe")).toBeGreaterThan(-1);
      if (action !== "conversation")
        expect(methods.indexOf("thread/unsubscribe")).toBeLessThan(
          methods.indexOf("thread/goal/set"),
        );
    },
  );

  it("restores an already blocked Task after worker restart before resuming its Goal", async () => {
    const f = fixture();
    await f.runtime.updateGoal({
      ...options,
      threadId: options.threadId!,
      status: "active",
      configureTaskPermissions: true,
    });
    expect(f.security()).toMatchObject({
      permissions: ":danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("honors a selected read-only implementation profile", async () => {
    const f = fixture();
    await f.native.loadThread({
      ...options,
      resultMode: { kind: "structured", outputSchema: {} },
    });
    await f.runtime.createGoal({
      ...options,
      permissionProfileId: ":read-only",
      objective: "Inspect plan",
      configureTaskPermissions: true,
    });
    expect(f.security()).toMatchObject({
      permissions: ":read-only",
      approvalPolicy: "on-request",
    });
  });

  it("leaves an existing provider hold with its transfer owner", async () => {
    const { runtime, native } = fixture();
    const threadId = options.threadId!;
    const receipt = taskInferenceInputReceiptSchema.parse({
      kind: "goal",
      operationId: "a3ba60ba-8974-4e4c-878c-511ae1c56388",
      chatId: "chat",
      clientMessageId: "a1efcccb-4b35-4c41-93d9-ae330bb993a2",
      workerId: "worker",
      worktreeId: "worktree",
      executionLaneId: "lane",
      executionLaneActivatedAt: "2026-01-01T00:00:00Z",
      providerId: options.provider.id,
      modelRouteId: options.model.routeId,
      providerAccountId: null,
      dispatch: {
        cycleId: "053d313b-3b10-4672-a941-198827f6a2c0",
        operationId: "finalize",
        leaseOwner: "worker",
        fencingToken: 1,
      },
    });
    const scope = {
      threadId,
      chatId: receipt.chatId,
      cycleId: receipt.dispatch.cycleId,
      orderEpoch: 0,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: null,
    };
    const transport = runtime.transportGeneration!;
    const transferId = "b452ed5f-4f5a-4c22-8ced-b86c36c4b21e";
    const producer = vi
      .spyOn(runtime, "controlManagedRootProducer")
      .mockResolvedValueOnce({ revision: "0", heldBy: null })
      .mockResolvedValueOnce({ revision: "1", heldBy: transferId });
    await runtime.createGoal({
      ...options,
      chatId: receipt.chatId,
      taskGoalCycleId: receipt.dispatch.cycleId,
      firstTaskInputMessageId: receipt.clientMessageId,
      objective: "Implement plan",
      configureTaskPermissions: true,
    });
    await runtime.holdTaskGoalForProviderTransfer(transferId, scope, transport);
    const start = vi.fn();
    await expect(
      native.startTaskGoalFirstInput(threadId, receipt, start),
    ).rejects.toThrow("Another provider transfer owns this native root.");
    expect(start).not.toHaveBeenCalled();
    expect(producer.mock.calls.map(([control]) => control.action)).toEqual([
      "read",
      "hold",
    ]);
    producer
      .mockResolvedValueOnce({ revision: "1", heldBy: transferId })
      .mockResolvedValueOnce({ revision: "2", heldBy: null });
    await runtime.releaseTaskGoalProviderTransfer(transferId, scope, transport);
    expect(producer.mock.lastCall?.[0]).toMatchObject({
      action: "release",
      operationId: transferId,
      expectedRevision: "1",
    });
  });
});
