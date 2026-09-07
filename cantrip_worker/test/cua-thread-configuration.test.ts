import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
import { managedCuaMcpServer } from "../src/mcp/managed.js";

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    loadThread(options: unknown, create?: boolean): Promise<string | null>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    ensureManagedMcpReady(): Promise<void>;
  };
  const request = vi
    .spyOn(native, "request")
    .mockResolvedValue({ thread: { id: "thread" } });
  const ready = vi
    .spyOn(native, "ensureManagedMcpReady")
    .mockResolvedValue(undefined);
  const metadata = {
    cwd: "/unused",
    threadId: "thread",
    permissionProfileId: ":yolo",
    model: { name: "model", reasoningEffort: "medium" },
    provider: { id: "provider", kind: "chatgpt" },
  };
  const configured = {
    ...metadata,
    mcpServers: [
      managedCuaMcpServer(
        { command: "node", arguments: ["cua.js"] },
        "/connection.json",
      ),
    ],
  };
  return { native, request, ready, metadata, configured };
}

// Real thread-loading code with a controlled app-server RPC boundary. These
// tests reproduce dashboard reads interleaving with tool initialization.
describe("CUA configuration survives plan and goal reads", () => {
  it("does not replace a loaded thread's tools or instructions when MCP is omitted", async () => {
    const f = fixture();
    await f.native.loadThread(f.configured);
    const resume = f.request.mock.calls.find(
      ([method]) => method === "thread/resume",
    )![1];
    expect(resume.developerInstructions).toContain("cantrip_cua");
    expect(resume.developerInstructions).not.toContain(
      "Computer use is not enabled.",
    );
    f.request.mockClear();
    await f.native.loadThread(f.metadata, false);
    await f.native.loadThread(f.metadata, false);
    await f.native.loadThread(f.configured);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("resumes an unloaded metadata-only thread without replacing persisted configuration", async () => {
    const f = fixture();
    expect(await f.native.loadThread(f.metadata, false)).toBe("thread");
    expect(f.request).toHaveBeenCalledExactlyOnceWith("thread/resume", {
      threadId: "thread",
    });
    expect(f.ready).not.toHaveBeenCalled();
  });

  it("serializes metadata reads behind in-flight tool setup", async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.ready.mockImplementationOnce(() => barrier);
    const setup = f.native.loadThread(f.configured);
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    const read = f.native.loadThread(f.metadata, false);
    let readFinished = false;
    void read.then(() => {
      readFinished = true;
    });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
    ]);
    release();
    await Promise.all([setup, read]);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("applies the enabled configuration after an earlier metadata resume completes", async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async () => {
      await barrier;
      return { thread: { id: "thread" } };
    });
    const read = f.native.loadThread(f.metadata, false);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    const setup = f.native.loadThread(f.configured);
    release();
    await Promise.all([read, setup]);
    const resumes = f.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    );
    expect(resumes).toHaveLength(2);
    expect(resumes[0]![1]).toEqual({ threadId: "thread" });
    expect(resumes[1]![1].developerInstructions).toContain("cantrip_cua");
    expect(resumes[1]![1].developerInstructions).not.toContain(
      "Computer use is not enabled.",
    );
  });

  it("still removes CUA when an explicit empty configuration is supplied", async () => {
    const f = fixture();
    await f.native.loadThread(f.configured);
    await f.native.loadThread({ ...f.metadata, mcpServers: [] });
    const last = f.request.mock.calls
      .filter(([method]) => method === "thread/resume")
      .at(-1)![1];
    expect(last.developerInstructions).toContain(
      "Computer use is not enabled.",
    );
  });

  it("does not poison later loads after a metadata resume fails", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("resume failed"));
    await expect(f.native.loadThread(f.metadata, false)).rejects.toThrow(
      "resume failed",
    );
    await expect(f.native.loadThread(f.configured)).resolves.toBe("thread");
    expect(f.ready).toHaveBeenCalledTimes(1);
  });
});
