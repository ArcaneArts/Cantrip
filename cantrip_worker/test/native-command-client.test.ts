import { describe, expect, it, vi } from "vitest";
import { NativeCommandClient } from "../src/native-command-client.js";

const session = {
  chatId: "chat-1",
  threadId: "thread-1",
  contextKind: "project" as const,
  projectId: "project-1",
  placementId: "worktree-1",
  modelRouteId: "route",
  providerAccountId: null,
  runtimeGeneration: "runtime-1",
  connectionId: "connection-1",
};
const receipt = {
  chatId: "chat-1",
  startsExecution: true,
  operationId: "operation-1",
  operationGeneration: "generation-1",
  activationGeneration: "generation-1",
  executionLaneId: "lane-1",
  status: "dispatched",
  method: "turn/start",
  payloadDigest: "a".repeat(64),
  rejectionCode: null,
  threadId: "thread-1",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
const request = {
  operationId: receipt.operationId,
  operationGeneration: receipt.operationGeneration,
  payloadDigest: receipt.payloadDigest,
  session,
};

describe("native command admission transport", () => {
  it("uses current worker credentials and preserves exact dispatch identity", async () => {
    const bodies: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push({ url: String(url), init: init! });
        return Response.json({
          receipt,
          execution: null,
          computerUseAuthority: null,
        });
      },
    );
    let token = "first-token";
    const client = new NativeCommandClient({
      serverUrl: "https://cantrip.example",
      workerId: "worker-1",
      token: () => token,
      fetch: fetcher,
    });
    await client.dispatch(request);
    token = "rotated-token";
    await client.dispatch(request);
    expect(bodies[0]!.url).toBe(
      "https://cantrip.example/api/internal/native-commands/dispatch",
    );
    expect(JSON.parse(String(bodies[0]!.init.body))).toEqual({
      ...request,
      workerId: "worker-1",
    });
    expect(bodies[1]!.init.headers).toMatchObject({
      authorization: "Bearer rotated-token",
    });
    expect(bodies[0]!.init.redirect).toBe("error");
  });

  it("does not retry uncertain dispatch after a transport failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("connection reset after commit"));
    const client = new NativeCommandClient({
      serverUrl: "https://cantrip.example",
      workerId: "worker-1",
      token: () => "token",
      fetch: fetcher,
    });
    await expect(client.dispatch(request)).rejects.toThrow("connection reset");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves actionable rejection codes and rejects invalid success receipts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Turn was replaced.", code: "stale-native-generation" },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ accepted: true }));
    const client = new NativeCommandClient({
      serverUrl: "https://cantrip.example",
      workerId: "worker-1",
      token: () => "token",
      fetch: fetcher,
    });
    await expect(client.dispatch(request)).rejects.toMatchObject({
      status: 409,
      code: "stale-native-generation",
    });
    await expect(client.dispatch(request)).rejects.toThrow();
  });

  it("separates native acceptance from execution completion", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ receipt: { ...receipt, status: "applied" } }),
      );
    const client = new NativeCommandClient({
      serverUrl: "https://cantrip.example",
      workerId: "worker-1",
      token: () => "token",
      fetch: fetcher,
    });
    await client.settle({
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      executionComplete: false,
      status: "applied",
    });
  });

  it("rejects a structurally valid receipt for another operation or incarnation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          receipt: { ...receipt, operationId: "other" },
          execution: null,
          computerUseAuthority: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          receipt: { ...receipt, operationGeneration: "old" },
          execution: null,
          computerUseAuthority: null,
        }),
      );
    const client = new NativeCommandClient({
      serverUrl: "https://cantrip.example",
      workerId: "worker-1",
      token: () => "token",
      fetch: fetcher,
    });
    await expect(client.dispatch(request)).rejects.toThrow("uncorrelated");
    await expect(client.dispatch(request)).rejects.toThrow("uncorrelated");
  });
});
