import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";

describe("native Task execution observation", () => {
  it.each([
    ["active", "running"],
    ["idle", "idle"],
    ["notLoaded", "idle"],
    ["systemError", "failed"],
  ])(
    "reads %s directly without resuming a thread or exporting its transcript",
    async (native, status) => {
      const runtime = Object.create(CodexAppServer.prototype) as CodexAppServer;
      const request = vi.fn(async () => ({
        thread: { id: "thread", status: { type: native } },
      }));
      Object.assign(runtime, { request });
      expect(await runtime.readThreadExecution("thread")).toEqual({
        threadId: "thread",
        status,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", {
        threadId: "thread",
        includeTurns: false,
      });
    },
  );
  it("rejects a mismatched thread instead of using it as evidence of execution", async () => {
    const runtime = Object.create(CodexAppServer.prototype) as CodexAppServer;
    Object.assign(runtime, {
      request: vi.fn(async () => ({
        thread: { id: "other", status: { type: "active" } },
      })),
    });
    await expect(runtime.readThreadExecution("thread")).rejects.toThrow(
      "another thread",
    );
  });
  it("does not mistake an unknown native status for an idle session", async () => {
    const runtime = Object.create(CodexAppServer.prototype) as CodexAppServer;
    Object.assign(runtime, {
      request: vi.fn(async () => ({
        thread: { id: "thread", status: { type: "unknown" } },
      })),
    });
    await expect(runtime.readThreadExecution("thread")).rejects.toThrow(
      "could not be observed",
    );
  });
});
