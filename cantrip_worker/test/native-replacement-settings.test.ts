import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type PrepareManagedThreadOptions,
} from "../src/codex/app-server.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const observations = new NativeHistoryObservations();
  observations.replace("transport");
  const native = runtime as unknown as {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    handleMessage(data: Buffer): void;
    ensureStarted(): Promise<void>;
    loadThread(options: PrepareManagedThreadOptions): Promise<string>;
  };
  vi.spyOn(runtime, "transportGeneration", "get").mockReturnValue("transport");
  vi.spyOn(runtime, "observeNativeHistory").mockImplementation(
    (thread, observer) =>
      observations.subscribe(thread, observer, async () => {
        throw new Error("No history read expected");
      }),
  );
  native.ensureStarted = vi.fn(async () => {});
  const source = nativeThreadSettings({
    settingsVersion: { epoch: "source-core", revision: "8" },
    model: "chosen-root",
    effort: null,
    serviceTier: "fast",
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "chosen-root",
        reasoning_effort: null,
        developer_instructions: "retained instructions",
      },
    },
    multiAgentEnabled: true,
    subagentModel: "chosen-child",
    subagentReasoningEffort: null,
  });
  let actualSource = structuredClone(source);
  let dispatched: Record<string, unknown> | null = null;
  const request = vi.fn<typeof native.request>(async (method, params) => {
    if (method === "collaborationMode/list")
      return {
        data: [{ mode: "plan", model: null, reasoning_effort: "medium" }],
      };
    if (method === "thread/settings/read")
      return { threadId: "old", threadSettings: actualSource };
    if (method === "thread/settings/update") {
      dispatched = params;
      return {
        operationId: params.operationId,
        submissionId: "native-submission",
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  native.request = request;
  const notify = (method: string, params: Record<string, unknown>) => {
    observations.notification(method, params);
    native.handleMessage(Buffer.from(JSON.stringify({ method, params })));
  };
  native.loadThread = vi.fn(async (options) => {
    await options.onThreadIdentified?.("new");
    notify("thread/settings/updated", {
      threadId: "new",
      threadSettings: nativeThreadSettings(),
    });
    return "new";
  });
  const options: PrepareManagedThreadOptions = {
    cwd: "/workspace",
    threadId: null,
    model: {
      id: "bootstrap",
      routeId: "bootstrap",
      name: "bootstrap",
      reasoningEffort: "high",
    },
    provider: { id: "provider", name: "Provider", kind: "openai" },
    permissionProfileId: ":workspace",
    mcpServers: [],
    executionProfile: "ide",
    subagentDefaults: null,
    planMode: "default",
    intent: "configure",
  };
  const applied = (overrides = {}) =>
    notify("thread/settings/updated", {
      threadId: "new",
      operationId: dispatched!.operationId,
      submissionId: "native-submission",
      threadSettings: {
        ...source,
        settingsVersion: { epoch: "new-core", revision: "1" },
        ...overrides,
      },
    });
  return {
    runtime,
    native,
    request,
    source,
    options,
    notify,
    observations,
    applied,
    changeSource: () => {
      actualSource = {
        ...source,
        model: "new-console-choice",
        settingsVersion: { epoch: "source-core", revision: "9" },
      };
    },
    dispatched: () => dispatched,
  };
}

describe("new managed session settings preparation", () => {
  it("waits for its applied plan selection, accepting native default instructions", async () => {
    const f = fixture();
    let complete = false;
    const result = f.runtime
      .prepareManagedThread({ ...f.options, planMode: "plan" })
      .then((value) => {
        complete = true;
        return value;
      });
    await vi.waitFor(() => expect(f.dispatched()).not.toBeNull());
    expect(complete).toBe(false);
    f.notify("thread/settings/updated", {
      threadId: "new",
      operationId: "another-operation",
      submissionId: "other-submission",
      threadSettings: nativeThreadSettings({
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "bootstrap",
            reasoning_effort: "medium",
            developer_instructions: "Native plan instructions",
          },
        },
      }),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(complete).toBe(false);
    f.applied({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "bootstrap",
          reasoning_effort: "medium",
          developer_instructions: "Native plan instructions",
        },
      },
    });
    await expect(result).resolves.toEqual({ threadId: "new" });
    expect(complete).toBe(true);
  });
  it("keeps existing-thread plan changes pending without blocking their acknowledgment", async () => {
    const f = fixture();
    await expect(
      f.runtime.prepareManagedThread({
        ...f.options,
        threadId: "new",
        planMode: "plan",
      }),
    ).resolves.toEqual({ threadId: "new" });
    expect(f.dispatched()).not.toBeNull();
  });
});

describe("native settings on invalid-compaction replacement", () => {
  it("captures the actual Core and waits for correlated application before completing preparation", async () => {
    const f = fixture();
    const captured = await f.runtime.captureNativeReplacementSettings("old");
    expect(captured.settings).toEqual(f.source);
    let finished = false;
    const result = f.runtime
      .prepareManagedThread({ ...f.options, replacementSettings: captured })
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.waitFor(() => expect(f.dispatched()).not.toBeNull());
    expect(finished).toBe(false);
    expect(f.dispatched()).toEqual({
      threadId: "new",
      operationId: expect.any(String),
      model: "chosen-root",
      effort: null,
      serviceTier: "fast",
      collaborationMode: f.source.collaborationMode,
      multiAgentEnabled: true,
      subagentModel: "chosen-child",
      subagentReasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
    });
    expect(f.dispatched()).not.toHaveProperty("approvalPolicy");
    expect(f.dispatched()).not.toHaveProperty("sandboxPolicy");
    f.applied();
    await expect(result).resolves.toEqual({ threadId: "new" });
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "thread/settings/read",
      ),
    ).toHaveLength(3);
  });

  it.each([null, "priority", "default"])(
    "restores raw tier absence over target %s without a read gate",
    async (targetTier) => {
      const f = fixture();
      f.native.loadThread = vi.fn(async (options) => {
        await options.onThreadIdentified?.("new");
        f.notify("thread/settings/updated", {
          threadId: "new",
          threadSettings: nativeThreadSettings({ serviceTier: targetTier }),
        });
        return "new";
      });
      f.request.mockImplementation(async (method, params) => {
        if (method === "thread/settings/read") {
          expect(params.threadId).toBe("old");
          return {
            threadId: "old",
            threadSettings: { ...f.source, serviceTier: null },
          };
        }
        return {
          operationId: params.operationId,
          submissionId: "native-submission",
        };
      });
      const replacementSettings =
        await f.runtime.captureNativeReplacementSettings("old");
      const result = f.runtime.prepareManagedThread({
        ...f.options,
        replacementSettings,
      });
      await vi.waitFor(() =>
        expect(
          f.request.mock.calls.some(
            ([method]) => method === "thread/settings/update",
          ),
        ).toBe(true),
      );
      const patch = f.request.mock.calls.find(
        ([method]) => method === "thread/settings/update",
      )![1];
      expect(patch).not.toHaveProperty("serviceTier");
      expect(patch.unsetServiceTier).toBe(true);
      f.notify("thread/settings/updated", {
        threadId: "new",
        operationId: patch.operationId,
        submissionId: "native-submission",
        threadSettings: {
          ...f.source,
          serviceTier: null,
          settingsVersion: { epoch: "new-core", revision: "1" },
        },
      });
      await expect(result).resolves.toEqual({ threadId: "new" });
      expect(
        f.runtime.getNativeThreadSettings("new").confirmed?.settings
          .serviceTier,
      ).toBeNull();
    },
  );

  it("surfaces the actual source read error instead of falling back to bootstrap", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("native Core unavailable"));
    await expect(
      f.runtime.captureNativeReplacementSettings("old"),
    ).rejects.toThrow("native Core unavailable");
    expect(f.native.loadThread).not.toHaveBeenCalled();
  });

  it("rejects a console change during replacement instead of overwriting it from the earlier capture", async () => {
    const f = fixture();
    const replacementSettings =
      await f.runtime.captureNativeReplacementSettings("old");
    f.changeSource();
    await expect(
      f.runtime.prepareManagedThread({ ...f.options, replacementSettings }),
    ).rejects.toThrow("source settings changed");
    expect(f.dispatched()).toBeNull();
  });

  it("does not hand off if the source changes while settings application is pending", async () => {
    const f = fixture();
    const replacementSettings =
      await f.runtime.captureNativeReplacementSettings("old");
    const result = f.runtime.prepareManagedThread({
      ...f.options,
      replacementSettings,
    });
    const rejected = expect(result).rejects.toThrow("source settings changed");
    await vi.waitFor(() => expect(f.dispatched()).not.toBeNull());
    f.changeSource();
    f.applied();
    await rejected;
  });

  it("stops preparation even when the native enqueue acknowledgment has not arrived", async () => {
    const f = fixture();
    const replacementSettings =
      await f.runtime.captureNativeReplacementSettings("old");
    const implementation = f.request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    let operationId: unknown;
    f.request.mockImplementation((method, params) => {
      if (method !== "thread/settings/update")
        return implementation(method, params);
      operationId = params.operationId;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const result = f.runtime.prepareManagedThread({
      ...f.options,
      replacementSettings,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("user stopped");
    await vi.waitFor(() => expect(operationId).toBeTruthy());
    controller.abort(new Error("user stopped"));
    await rejected;
    release({ operationId, submissionId: "native-submission" });
  });

  it.each(["rejected", "abort", "exit", "closed", "different-applied"])(
    "does not complete a replacement after %s",
    async (kind) => {
      const f = fixture();
      const replacementSettings =
        await f.runtime.captureNativeReplacementSettings("old");
      const controller = new AbortController();
      const result = f.runtime.prepareManagedThread({
        ...f.options,
        replacementSettings,
        signal: controller.signal,
      });
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(f.dispatched()).not.toBeNull());
      if (kind === "rejected")
        f.notify("error", {
          threadId: "new",
          turnId: "native-submission",
          willRetry: false,
          error: { message: "unsupported child model" },
        });
      if (kind === "abort") controller.abort(new Error("user stopped"));
      if (kind === "exit") f.observations.replace(null);
      if (kind === "closed") f.notify("thread/closed", { threadId: "new" });
      if (kind === "different-applied") f.applied({ model: "bootstrap" });
      await rejected;
    },
  );
});
