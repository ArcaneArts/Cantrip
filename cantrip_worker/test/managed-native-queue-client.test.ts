import { describe, expect, it, vi } from "vitest";
import { ManagedNativeQueueClient } from "../src/managed-native-queue-client.js";
import { protectNativeCommandContent } from "../src/native-command-content.js";

const session = {
  chatId: "chat",
  threadId: "thread",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: null,
  runtimeGeneration: "runtime",
  connectionId: "view",
};
async function fixture() {
  const sealed = await protectNativeCommandContent({
    service: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({ key: new Uint8Array(32), keyRevision: 1 }),
    },
    context: { chatId: "chat", operationId: "operation", direction: "request" },
    content: { method: "thread/queue/start" },
  });
  const admission = {
    operationId: "operation",
    origin: "terminal" as const,
    session,
    method: "thread/queue/start",
    payloadDigest: sealed.digest,
    protectedPayload: sealed.envelope,
    expectedActivationGeneration: null,
    intent: {
      scope: "thread" as const,
      settingKeys: [],
      expectedTurnId: null,
      resumeAutonomy: true,
    },
  };
  const receipt = {
    operationId: "operation",
    operationGeneration: "generation",
    activationGeneration: null,
    chatId: "chat",
    threadId: "thread",
    startsExecution: false,
    executionLaneId: null,
    status: "applied",
    method: admission.method,
    payloadDigest: admission.payloadDigest,
    rejectionCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const response = {
    receipt,
    revision: 2,
    paused: false,
    items: [],
    claims: [],
  };
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(response), { status: 200 }),
  );
  const client = new ManagedNativeQueueClient({
    serverUrl: "https://fixture.invalid",
    workerId: "worker",
    token: () => "token",
    fetch: fetch as typeof globalThis.fetch,
  });
  return { client, fetch, admission, receipt, response };
}

describe("canonical queue HTTP client", () => {
  it("sends authenticated atomic mutation with its exact identity and cancellation signal", async () => {
    const f = await fixture();
    const controller = new AbortController();
    await f.client.mutate(
      {
        admission: f.admission,
        expectedRevision: 1,
        mutation: { kind: "start" },
      },
      controller.signal,
    );
    const [url, options] = f.fetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe("/api/internal/native-queue/mutate");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBe(controller.signal);
    expect(options.headers).toMatchObject({ authorization: "Bearer token" });
    expect(JSON.parse(String(options.body))).toMatchObject({
      admission: { workerId: "worker", operationId: "operation", session },
      expectedRevision: 1,
    });
  });

  it("looks up the original protected operation without mutating and fences a foreign receipt", async () => {
    const f = await fixture();
    f.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ found: true, ...f.response }), {
          status: 200,
        }),
    );
    expect(await f.client.lookup({ admission: f.admission })).toMatchObject({
      found: true,
      receipt: f.receipt,
    });
    const [url, options] = f.fetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe("/api/internal/native-queue/lookup");
    expect(JSON.parse(String(options.body))).toEqual({
      admission: { ...f.admission, workerId: "worker" },
    });
    f.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            found: true,
            ...f.response,
            receipt: { ...f.receipt, threadId: "foreign" },
          }),
          { status: 200 },
        ),
    );
    await expect(f.client.lookup({ admission: f.admission })).rejects.toThrow(
      "another operation",
    );
  });

  it("accepts a snapshot-only import acknowledgment", async () => {
    const f = await fixture();
    const { receipt: _, ...snapshot } = f.response;
    f.fetch.mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );
    expect(
      await f.client.acknowledgeImport({
        session,
        runnerGeneration: "runner",
        importId: "import",
        sourceDigest: f.admission.payloadDigest,
        receipt: { deleted: true, conflict: false },
      }),
    ).toEqual({ ...snapshot, pendingImports: [] });
  });

  it("leaves a lost mutation response uncertain and never retries or mints another identity", async () => {
    const f = await fixture();
    f.fetch.mockRejectedValue(
      new TypeError("connection lost after server commit"),
    );
    await expect(
      f.client.mutate({
        admission: f.admission,
        expectedRevision: 1,
        mutation: { kind: "start" },
      }),
    ).rejects.toMatchObject({ code: "queue-operation-uncertain" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([502, 200])(
    "retains the original operation when the HTTP %s acknowledgment cannot prove a result",
    async (status) => {
      const f = await fixture();
      f.fetch.mockResolvedValue(
        new Response("invalid acknowledgment", { status }),
      );
      await expect(
        f.client.mutate({
          admission: f.admission,
          expectedRevision: 1,
          mutation: { kind: "start" },
        }),
      ).rejects.toMatchObject({ code: "queue-operation-uncertain" });
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a successful response for a different queue operation", async () => {
    const f = await fixture();
    f.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...f.response,
          receipt: { ...f.receipt, operationId: "foreign" },
        }),
        { status: 200 },
      ),
    );
    await expect(
      f.client.mutate({
        admission: f.admission,
        expectedRevision: 1,
        mutation: { kind: "start" },
      }),
    ).rejects.toThrow("another operation");
  });

  it("preserves server conflicts instead of turning a failed claim into acceptance", async () => {
    const f = await fixture();
    f.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Queue revision changed",
          code: "queue-revision-conflict",
        }),
        { status: 409 },
      ),
    );
    await expect(
      f.client.mutate({
        admission: f.admission,
        expectedRevision: 1,
        mutation: { kind: "start" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "queue-revision-conflict" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
