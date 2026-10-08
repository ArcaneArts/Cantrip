import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import { CodexAppServer } from "../src/codex/app-server.js";

const model = {
  id: "fixture-model",
  routeId: "fixture-route",
  name: "fixture-model",
  reasoningEffort: null,
};
const provider = {
  id: "fixture-provider",
  name: "Fixture",
  kind: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: null,
};

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    ensureStarted(): Promise<void>;
    methodAvailable(): boolean;
    request(method: string, params: unknown): Promise<unknown>;
  };
  native.ensureStarted = vi.fn().mockResolvedValue(undefined);
  native.methodAvailable = () => true;
  const request = vi.fn<typeof native.request>();
  native.request = request;
  const read = (threadId: string | null, cwd = "/project-a") =>
    runtime.readMcpResource({
      cwd,
      threadId,
      model,
      provider,
      server: "shared-name",
      uri: "wqa://marker",
    });
  return { runtime, request, read };
}

describe("conversation MCP resource context", () => {
  it("uses each conversation's native server despite a shared server name", async () => {
    const { request, read } = fixture();
    request.mockImplementation(async (_method, params) => {
      const { threadId } = params as { threadId: string | null };
      return {
        contents: [{ uri: "wqa://marker", text: threadId ?? "global" }],
      };
    });
    expect((await read("thread-a")).contents[0]?.text).toBe("thread-a");
    expect((await read("thread-b", "/project-b")).contents[0]?.text).toBe(
      "thread-b",
    );
    expect(request.mock.calls).toEqual([
      [
        "mcpServer/resource/read",
        { threadId: "thread-a", server: "shared-name", uri: "wqa://marker" },
      ],
      [
        "mcpServer/resource/read",
        { threadId: "thread-b", server: "shared-name", uri: "wqa://marker" },
      ],
    ]);
  });

  it("retains the same conversation context after explicit runtime reload", async () => {
    const { runtime, request, read } = fixture();
    request.mockResolvedValue({
      contents: [{ uri: "wqa://marker", text: "A" }],
    });
    await read("thread-a");
    await runtime.reloadMcpServers({ cwd: "/project-a", model, provider });
    await read("thread-a");
    expect(
      request.mock.calls
        .filter(([method]) => method === "mcpServer/resource/read")
        .map(([, params]) => params),
    ).toEqual([
      { threadId: "thread-a", server: "shared-name", uri: "wqa://marker" },
      { threadId: "thread-a", server: "shared-name", uri: "wqa://marker" },
    ]);
  });

  it("propagates an actual missing-resource error without retrying a global or other context", async () => {
    const { request, read } = fixture();
    request.mockRejectedValue(new Error("Unknown resource wqa://marker"));
    await expect(read("thread-a")).rejects.toThrow(
      "Unknown resource wqa://marker",
    );
    expect(request.mock.calls).toEqual([
      [
        "mcpServer/resource/read",
        { threadId: "thread-a", server: "shared-name", uri: "wqa://marker" },
      ],
    ]);
  });

  it("preserves an explicitly threadless request", async () => {
    const { request, read } = fixture();
    request.mockResolvedValue({ contents: [] });
    await read(null);
    expect(request).toHaveBeenCalledWith("mcpServer/resource/read", {
      threadId: null,
      server: "shared-name",
      uri: "wqa://marker",
    });
  });
});
