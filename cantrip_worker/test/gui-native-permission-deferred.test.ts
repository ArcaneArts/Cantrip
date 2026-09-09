import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  CodexNativeRpcError,
  type RunAgentTurnOptions,
} from "../src/codex/app-server.js";
import { NativePermissionDeferredError } from "../src/codex/native-permission-deferred.js";

// Actual GUI attempt and cleanup with only native RPC transport substituted.
describe("GUI native no-consumption retention", () => {
  async function fixture(
    test: (f: {
      runtime: CodexAppServer;
      options: RunAgentTurnOptions;
      request: ReturnType<typeof vi.fn>;
    }) => Promise<void>,
  ) {
    const cwd = await mkdtemp(join(tmpdir(), "cantrip-gui-deferral-"));
    const runtime = new CodexAppServer(
      "/missing/native-fixture",
      cwd,
      join(cwd, "home"),
      unprobedCodexRuntimeReport,
    );
    const request = vi.fn(async () => {
      throw new CodexNativeRpcError(
        "pending",
        {
          code: -32001,
          message: "pending",
          data: { reason: "pendingSettings", inputConsumed: false },
        },
        "turn/start",
      );
    });
    Object.defineProperty(runtime, "ensureStarted", { value: async () => {} });
    Object.defineProperty(runtime, "loadThread", {
      value: async () => "thread",
    });
    Object.defineProperty(runtime, "methodAvailable", { value: () => false });
    Object.defineProperty(runtime, "request", { value: request });
    const options: RunAgentTurnOptions = {
      chatId: "chat",
      clientMessageId: "message",
      cwd,
      captureProtectedDiagnostics: false,
      executionProfile: "ide",
      isPrimary: true,
      automationPaused: false,
      planMode: "default",
      policyContext: null,
      model: {
        id: "model",
        routeId: "route",
        name: "fixture",
        reasoningEffort: null,
      },
      provider: {
        id: "provider",
        name: "fixture",
        kind: "chatgpt",
        baseUrl: "https://example.invalid",
        apiKey: null,
      },
      permissionProfileId: ":workspace",
      prompt: "original",
      rootKind: "git-worktree",
      skillNames: [],
      subagentDefaults: null,
      subagentProtocolVersion: undefined,
      threadId: "thread",
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
      inheritThreadSettings: true,
      nativeInput: [
        { type: "text", text: "exact input", text_elements: [] },
        { type: "image", url: "data:image/png;base64,YQ==" },
      ],
    };
    try {
      await test({ runtime, options, request });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
  it("waits for durable retention and preserves exact input before ending the GUI attempt", async () => {
    await fixture(async ({ runtime, options, request }) => {
      let finish!: () => void;
      const persisted = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const retain = vi.fn(async () => persisted);
      let settled = false;
      const result = runtime
        .runTurn({ ...options, onNativeDeferred: retain })
        .catch((error) => {
          settled = true;
          return error;
        });
      await expect.poll(() => retain.mock.calls.length).toBe(1);
      expect(settled).toBe(false);
      expect(retain).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread",
          nativeInput: options.nativeInput,
        }),
      );
      expect(runtime.hasActiveThread("thread")).toBe(false);
      finish();
      expect(await result).toBeInstanceOf(NativePermissionDeferredError);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });
  it("does not turn transport loss or dispatch-hook failure into permission to replay", async () => {
    await fixture(async ({ runtime, options, request }) => {
      const retain = vi.fn();
      request.mockRejectedValueOnce(new Error("connection lost"));
      await expect(
        runtime.runTurn({ ...options, onNativeDeferred: retain }),
      ).rejects.toThrow("connection lost");
      expect(retain).not.toHaveBeenCalled();
      const falseDeferral = new CodexNativeRpcError(
        "pending",
        {
          code: -32001,
          message: "pending",
          data: { reason: "pendingSettings", inputConsumed: false },
        },
        "turn/start",
      );
      await expect(
        runtime.runTurn({
          ...options,
          onNativeDeferred: retain,
          onBeforeNativeDispatch: async () => {
            throw falseDeferral;
          },
        }),
      ).rejects.toBe(falseDeferral);
      expect(retain).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    });
  });
  it("surfaces retention failure without silently retrying native input", async () => {
    await fixture(async ({ runtime, options, request }) => {
      const retain = vi.fn(async () => {
        throw new Error("persistence unavailable");
      });
      await expect(
        runtime.runTurn({ ...options, onNativeDeferred: retain }),
      ).rejects.toThrow("persistence unavailable");
      expect(request).toHaveBeenCalledTimes(1);
      expect(runtime.hasActiveThread("thread")).toBe(false);
    });
  });
});
