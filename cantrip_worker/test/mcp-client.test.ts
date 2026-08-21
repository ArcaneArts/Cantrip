import { afterEach, describe, expect, it, vi } from "vitest";

import type { CantripMcpBinding } from "@cantrip/protocol";

import { CantripServerRequestError } from "../src/cli-client.js";
import { invokeCantripMcpOperation } from "../src/mcp/client.js";

const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId: "project-one",
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  canonicalRoot: "/worktrees/one",
  rootKind: "git-worktree",
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
  issuedAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Cantrip MCP server client", () => {
  it("forwards the full binding for authoritative server revalidation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        summary: "Context is current.",
        worktreeId: "worktree-one",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokeCantripMcpOperation({
        binding,
        request: { operation: "context.get", arguments: {} },
        requestId: "request-one",
        serverUrl: "https://cantrip.example",
        token: "worker-secret",
      }),
    ).resolves.toMatchObject({
      summary: "Context is current.",
      worktreeId: "worktree-one",
      mutated: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cantrip.example/api/internal/agent-operations",
    );
    expect(init.headers).toMatchObject({
      authorization: "Bearer worker-secret",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      binding,
      request: { operation: "context.get", arguments: {} },
      requestId: "request-one",
    });
  });

  it("preserves server rejection codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "stale-binding", error: "The lane changed." },
          { status: 409 },
        ),
      ),
    );

    await expect(
      invokeCantripMcpOperation({
        binding,
        request: { operation: "context.get", arguments: {} },
        requestId: "request-two",
        serverUrl: "https://cantrip.example",
        token: "worker-secret",
      }),
    ).rejects.toMatchObject<Partial<CantripServerRequestError>>({
      status: 409,
      code: "stale-binding",
    });
  });

  it("rejects oversized server responses before reading their body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(9 * 1_024 * 1_024) },
          }),
      ),
    );

    await expect(
      invokeCantripMcpOperation({
        binding,
        request: { operation: "context.get", arguments: {} },
        requestId: "request-three",
        serverUrl: "https://cantrip.example",
        token: "worker-secret",
      }),
    ).rejects.toThrow("too large");
  });
});
