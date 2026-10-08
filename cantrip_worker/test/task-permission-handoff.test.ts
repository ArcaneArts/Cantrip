import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type GoalRuntimeOptions,
} from "../src/codex/app-server.js";
import { connectFixtureNativeObservation } from "./fixtures/connected-native-observation.js";

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
});
