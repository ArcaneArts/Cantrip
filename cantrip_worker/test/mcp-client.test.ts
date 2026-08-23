import { afterEach, describe, expect, it, vi } from "vitest";

import type { CantripMcpBinding } from "@cantrip/protocol";

import { CantripServerRequestError } from "../src/cli-client.js";
import {
  fetchCantripMcpServerCompatibility,
  invokeCantripMcpOperation,
  legacyCantripMcpServerCompatibility,
} from "../src/mcp/client.js";

const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId: "project-one",
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  rootKind: "git-worktree",
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
  issuedAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Cantrip MCP server client", () => {
  it("negotiates the current relay protocol and ignores unknown future operations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          bindingProtocolVersions: [1, 2],
          operations: ["context.get", "future.operation"],
        }),
      ),
    );

    await expect(
      fetchCantripMcpServerCompatibility({
        serverUrl: "https://cantrip.example",
        token: "worker-secret",
        workerId: "worker-one",
      }),
    ).resolves.toEqual({
      bindingProtocolVersion: 2,
      operations: ["context.get"],
    });
  });

  it("falls back to the legacy relay protocol when the capability route is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
    );

    await expect(
      fetchCantripMcpServerCompatibility({
        serverUrl: "https://cantrip.example",
        token: "worker-secret",
        workerId: "worker-one",
      }),
    ).resolves.toMatchObject({
      bindingProtocolVersion: 1,
      operations: expect.arrayContaining(["context.get", "policy.read"]),
    });
  });

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

  it("sends a privacy-safe legacy binding to older servers", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ summary: "Context is current." }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const legacyBinding: CantripMcpBinding = {
      ...binding,
      allowedOperations: ["context.get", "tool.help"],
    };
    const legacyCanonicalRoot = `ctrr_${"A".repeat(43)}`;

    await invokeCantripMcpOperation({
      binding: legacyBinding,
      compatibility: legacyCantripMcpServerCompatibility(),
      legacyCanonicalRoot,
      request: { operation: "context.get", arguments: {} },
      requestId: "request-legacy",
      serverUrl: "https://cantrip.example",
      token: "worker-secret",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      binding: {
        canonicalRoot: legacyCanonicalRoot,
        allowedOperations: ["context.get"],
      },
      request: { operation: "context.get", arguments: {} },
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
