import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  CodexTurnFailureError,
  type RunAgentTurnOptions,
} from "../src/codex/app-server.js";
import type { CodexNativeEnvironment } from "../src/codex/runtime-types.js";

describe("captured native Linux runtime", () => {
  it("does not replay a turn after its first attempt reports a retryable error", async () => {
    const environment: CodexNativeEnvironment = {
      selection: {
        environmentId: "os-fixture",
        cwd: "/source",
        runtimeWorkspaceRoots: ["/source"],
      },
      instructions: "Linux fixture",
      prepare: async () => {},
      hasGitMetadata: async () => false,
      snapshot: async () => new Map(),
    };
    const runtime = new CodexAppServer(
      "/unused",
      "/unused",
      "/unused",
      unprobedCodexRuntimeReport,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      null,
      environment,
    );
    let writes = 0;
    const attempt = vi.fn(async () => {
      writes++;
      throw new CodexTurnFailureError(
        "Response was lost after an OS write",
        "serverOverloaded",
        "thread",
        "turn",
      );
    });
    Object.defineProperty(runtime, "runTurnAttempt", { value: attempt });
    // Only the outer admission/retry loop is exercised; native tool execution is
    // covered separately by the real Docker and installed-VM fixtures.
    await expect(
      runtime.runTurn({
        chatId: "chat",
        threadId: null,
      } as RunAgentTurnOptions),
    ).rejects.toThrow("Response was lost");
    expect(attempt).toHaveBeenCalledOnce();
    expect(writes).toBe(1);
    expect(
      runtime.resolveComputerUseExecution({
        threadId: "thread",
        turnId: "turn",
      }),
    ).toBeNull();
  });
});
