import { connectFixtureNativeObservation } from "./fixtures/connected-native-observation.js";
import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type GoalRuntimeOptions,
  type PrepareManagedThreadOptions,
} from "../src/codex/app-server.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

const base = {
  cwd: "/unused/cantrip-permission-inheritance",
  threadId: "thread-permissions",
  permissionProfileId: ":workspace",
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
} satisfies GoalRuntimeOptions;
const firstMcp = [
  {
    name: "example",
    enabled: true,
    transport: "stdio" as const,
    command: "example-mcp",
    args: [],
    environment: {},
  },
];
const secondMcp = [{ ...firstMcp[0]!, args: ["changed"] }];
const managed = {
  ...base,
  mcpServers: firstMcp,
  intent: "configure",
  planMode: "default",
  executionProfile: "ide",
  subagentDefaults: null,
} satisfies PrepareManagedThreadOptions;

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  connectFixtureNativeObservation(runtime, "native-generation");
  const native = runtime as unknown as {
    ensureStarted(): Promise<void>;
    methodAvailable(method: string): boolean;
    request(method: string, params: unknown): Promise<unknown>;
    handleMessage(data: Buffer): void;
    loadThread(input: GoalRuntimeOptions): Promise<string | null>;
  };
  native.ensureStarted = vi.fn().mockResolvedValue(undefined);
  native.methodAvailable = () => true;
  const request = vi.fn(
    async (method: string, params: unknown): Promise<unknown> => {
      if (method === "thread/resume" || method === "thread/start")
        return { thread: { id: base.threadId } };
      if (method === "thread/managedConfig/update")
        return { threadId: base.threadId, applied: true };
      if (method === "thread/unsubscribe") {
        native.handleMessage(
          Buffer.from(
            JSON.stringify({
              method: "thread/closed",
              params: { threadId: base.threadId },
            }),
          ),
        );
        return {};
      }
      if (method === "collaborationMode/list")
        return { data: [{ mode: "default" }, { mode: "plan" }] };
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
                threadId: base.threadId,
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
      throw new Error(`Unexpected RPC ${method}`);
    },
  );
  native.request = request;
  return { runtime, native, request };
}

function expectInheritedSecurity(params: unknown) {
  for (const key of [
    "permissions",
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "sandboxPolicy",
    "permissionProfileId",
  ]) {
    expect(params).not.toHaveProperty(key);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("managed permission inheritance during thread preparation", () => {
  it("does not overwrite a later confirmed profile while identification is awaiting", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread(managed);
    f.runtime.confirmManagedPermissionProfile(
      base.threadId!,
      "native-generation",
      ":workspace",
    );
    f.request.mockClear();
    const entered = deferred();
    const release = deferred();
    const input = {
      ...managed,
      mcpServers: secondMcp,
      permissionProfileId: ":danger-full-access",
    };
    const preparing = f.runtime.prepareManagedThread({
      ...input,
      onThreadIdentified: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    f.runtime.confirmManagedPermissionProfile(
      base.threadId!,
      "native-generation",
      ":read-only",
    );
    release.resolve();
    await preparing;
    const resumes = f.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    );
    expect(resumes).toHaveLength(1);
    expectInheritedSecurity(resumes[0]![1]);
    expect(f.runtime.confirmedManagedPermissionProfile(base.threadId!)).toBe(
      ":read-only",
    );
    f.request.mockClear();
    await f.runtime.prepareManagedThread(input);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toEqual([]);
  });

  it("does not resume a loaded managed thread solely for a stale bootstrap profile", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread(managed);
    f.request.mockClear();
    await f.runtime.prepareManagedThread({
      ...managed,
      permissionProfileId: ":danger-full-access",
    });
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toEqual([]);
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "thread/settings/update",
      ),
    ).toEqual([]);
  });

  it("inherits native security through an owned unsubscribe instead of replaying captured bootstrap security", async () => {
    const f = fixture();
    await f.native.loadThread({ ...base, mcpServers: firstMcp });
    f.runtime.confirmManagedPermissionProfile(
      base.threadId!,
      "native-generation",
      ":read-only",
    );
    f.request.mockClear();
    await f.native.loadThread({ ...base, mcpServers: secondMcp });
    const requests = f.request.mock.calls;
    expect(
      requests.filter(([method]) => method === "thread/unsubscribe"),
    ).toHaveLength(1);
    const resumes = requests.filter(([method]) => method === "thread/resume");
    expect(resumes).toHaveLength(1);
    expectInheritedSecurity(resumes[0]![1]);
    f.request.mockClear();
    await f.native.loadThread({
      ...base,
      mcpServers: secondMcp,
      permissionProfileId: ":danger-full-access",
    });
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toEqual([]);
  });

  it("still supplies bootstrap security for a genuinely new thread", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread({ ...managed, threadId: null });
    const starts = f.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    );
    expect(starts).toHaveLength(1);
    // Unprobed transports use the explicit legacy tuple until profile discovery.
    expect(starts[0]![1]).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });
});
