import { randomUUID } from "node:crypto";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
} from "@cantrip/crypto";
import {
  agentInteractionRequestPayloadSchema,
  type AgentInteractionResponse,
  type EncryptedAgentInteractionRequestCreate,
  type WorkerComputerUseApprovalResponseCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaApprovalManager, type CuaApprovalContext } from "./approvals.js";

const key = new Uint8Array(32).fill(31);
const managers: CuaApprovalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
});

function fixture() {
  let clock = Date.parse("2026-09-01T12:00:00Z");
  const controller = new AbortController();
  const issued: Uint8Array[] = [];
  const onTerminal = vi.fn();
  const encryption = {
    ownerId: vi.fn(() => "owner"),
    serverIdentity: vi.fn(() => "server"),
    componentKey: vi.fn(() => {
      const bytes = key.slice();
      issued.push(bytes);
      return { key: bytes, keyRevision: 1 };
    }),
  };
  const manager = new CuaApprovalManager({
    workerId: "worker",
    encryption,
    onTerminal,
    now: () => clock,
  });
  managers.push(manager);
  const context: CuaApprovalContext = {
    scope: {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: null,
      turnId: null,
    },
    projectId: null,
    executionLaneId: null,
    profile: {
      selectedId: ":default",
      effectiveId: ":default",
      forcedByWorktreePolicy: false,
    },
    signal: controller.signal,
  };
  const authorize = (
    operation: Parameters<
      CuaApprovalManager["authorize"]
    >[0]["operation"] = "observation.snapshot",
    target = { targetId: "window", targetGeneration: 1 },
  ) => manager.authorize({ context, operation, target });
  const request = async () => {
    const result = await authorize();
    if (result.status !== "approval-required")
      throw new Error("Expected approval");
    return result.request;
  };
  return {
    manager,
    context,
    controller,
    encryption,
    issued,
    onTerminal,
    authorize,
    request,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function permissions(request: EncryptedAgentInteractionRequestCreate) {
  const opened = await decryptInteractionRequestContent({
    ownerId: "owner",
    requestKey: request.requestKey,
    keyRevision: 1,
    componentKey: key,
    encrypted: request.protectedPayload,
    publicClassification: request.classification,
  });
  const payload = agentInteractionRequestPayloadSchema.parse(opened.payload);
  if (payload.kind !== "permissions") throw new Error("Expected permissions");
  return payload;
}

async function answer(
  request: EncryptedAgentInteractionRequestCreate,
  override: Partial<
    Extract<AgentInteractionResponse, { kind: "permissions" }>
  > = {},
): Promise<WorkerComputerUseApprovalResponseCommand> {
  const payload = await permissions(request);
  const response = {
    kind: "permissions" as const,
    permissions: payload.requestedPermissions,
    scope: "session" as const,
    strictAutoReview: false,
    ...override,
  };
  const classification = { kind: "permissions" as const };
  return {
    type: "computer-use.approval.respond",
    ownerId: "owner",
    chatId: request.provenance.chatId!,
    executionLaneId: request.provenance.executionLaneId,
    requestKey: request.requestKey,
    response: {
      classification,
      protectedResponse: await encryptInteractionResponseContent({
        ownerId: "owner",
        requestKey: request.requestKey,
        keyRevision: 1,
        componentKey: key,
        content: { version: 1, classification, response },
      }),
    },
  };
}

describe("computer-use durable permission owner", () => {
  it("constructs and closes without reading keys, identity, or starting native work", () => {
    const f = fixture();
    expect(f.manager.status()).toEqual({
      pending: 0,
      grants: 0,
      completed: 0,
      closed: false,
    });
    f.manager.close();
    f.manager.close();
    for (const method of Object.values(f.encryption))
      expect(method).not.toHaveBeenCalled();
  });

  it("protects a genuine idle request with no fabricated thread, turn, or cwd and clears borrowed keys", async () => {
    const f = fixture();
    const request = await f.request();
    expect(request.provenance).toEqual({
      owner: "computer-use",
      chatId: "chat",
      workerId: "worker",
      threadId: null,
      turnId: null,
      itemId: null,
      executionLaneId: null,
    });
    const payload = await permissions(request);
    expect(payload).toMatchObject({
      source: "native-computer-use",
      cwd: null,
      requestedPermissions: {
        computerUse: {
          version: 1,
          classes: ["capture"],
          target: { targetId: "window", targetGeneration: 1 },
        },
      },
    });
    expect(JSON.stringify(request)).not.toContain('"targetId"');
    expect(f.issued.every((bytes) => bytes.every((byte) => byte === 0))).toBe(
      true,
    );
  });

  it("coalesces identical requests and returns independently owned ciphertext records", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.request(), f.request()]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.provenance.chatId = "changed";
    expect((await f.request()).provenance.chatId).toBe("chat");
    expect(f.manager.status().pending).toBe(1);
    expect(f.encryption.componentKey).toHaveBeenCalledTimes(1);
  });

  it("selected YOLO permits observation without extra interaction or key access, including forced Primary read-only", async () => {
    const f = fixture();
    f.context.profile = {
      selectedId: ":yolo",
      effectiveId: ":read-only",
      forcedByWorktreePolicy: true,
    };
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
    expect(f.manager.status().pending).toBe(0);
  });

  it("grants only the approved class, target generation, lane, profile and authority lease", async () => {
    const f = fixture();
    await f.manager.answer(await answer(await f.request()));
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    for (const mutation of [
      { operation: "cursor.move" as const },
      { target: { targetId: "window", targetGeneration: 2 } },
      { context: { ...f.context, executionLaneId: "other" } },
      {
        context: {
          ...f.context,
          profile: { ...f.context.profile, effectiveId: ":read-only" },
        },
      },
      { context: { ...f.context, signal: new AbortController().signal } },
      {
        context: {
          ...f.context,
          scope: { ...f.context.scope, chatId: "other" },
        },
      },
    ]) {
      const result = await f.manager.authorize({
        context: f.context,
        operation: "observation.snapshot",
        target: { targetId: "window", targetGeneration: 1 },
        ...mutation,
      });
      expect(result.status).toBe("approval-required");
    }
  });

  it("uses one credit for Grant once in an idle preview and does not replenish on exact retry", async () => {
    const f = fixture();
    const response = await answer(await f.request(), { scope: "turn" });
    await f.manager.answer(response);
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    await expect(f.manager.answer(response)).resolves.toEqual({
      accepted: true,
    });
    expect((await f.authorize()).status).toBe("approval-required");
    const changed = structuredClone(response);
    changed.response.protectedResponse.envelope.ciphertext += "A";
    await expect(f.manager.answer(changed)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("keeps real-turn grants for that turn and revokes them when its owner aborts", async () => {
    const f = fixture();
    f.context.scope.threadId = "thread";
    f.context.scope.turnId = "turn";
    await f.manager.answer(await answer(await f.request(), { scope: "turn" }));
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    f.controller.abort();
    await expect(f.authorize()).rejects.toMatchObject({ code: "revoked" });
  });

  it("accepts denial without creating a grant or replaying an operation", async () => {
    const f = fixture();
    const response = await answer(await f.request(), { permissions: {} });
    await expect(f.manager.answer(response)).resolves.toEqual({
      accepted: true,
    });
    await expect(f.manager.answer(response)).resolves.toEqual({
      accepted: true,
    });
    expect(f.manager.status().grants).toBe(0);
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it.each(["ownerId", "chatId", "executionLaneId"] as const)(
    "rejects a response from another %s before decrypting it",
    async (field) => {
      const f = fixture();
      const response = await answer(await f.request());
      f.encryption.componentKey.mockClear();
      await expect(
        f.manager.answer({ ...response, [field]: "other" }),
      ).rejects.toMatchObject({ code: "ownership-mismatch" });
      expect(f.encryption.componentKey).not.toHaveBeenCalled();
    },
  );

  it.each(["workerId", "ownerId", "serverId"] as const)(
    "rejects a request bound to another %s",
    async (field) => {
      const f = fixture();
      f.context.scope[field] = "other";
      await expect(f.request()).rejects.toMatchObject({
        code: "ownership-mismatch",
      });
      expect(f.encryption.componentKey).not.toHaveBeenCalled();
    },
  );

  it("authenticates the actual request key and current component revision", async () => {
    const f = fixture();
    const first = await f.request();
    const response = await answer(first);
    const second = await f.manager.authorize({
      context: f.context,
      operation: "cursor.move",
    });
    if (second.status !== "approval-required")
      throw new Error("Expected request");
    await expect(
      f.manager.answer({ ...response, requestKey: second.request.requestKey }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    response.response.protectedResponse.keyRevision = 2;
    await expect(f.manager.answer(response)).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(f.issued.every((bytes) => bytes.every((byte) => byte === 0))).toBe(
      true,
    );
  });

  it.each<
    Extract<AgentInteractionResponse, { kind: "permissions" }>["permissions"]
  >([
    {
      computerUse: {
        version: 1,
        classes: ["capture", "cursor"],
        target: { targetId: "window", targetGeneration: 1 },
      },
    },
    { computerUse: { version: 1, classes: ["capture"], target: null } },
    {
      computerUse: {
        version: 1,
        classes: ["capture"],
        target: { targetId: "other", targetGeneration: 1 },
      },
    },
    {
      computerUse: {
        version: 1,
        classes: ["capture"],
        target: { targetId: "window", targetGeneration: 2 },
      },
    },
    { unrelated: true },
  ])(
    "rejects substituted or expanded permission content %#",
    async (permissions) => {
      const f = fixture();
      await expect(
        f.manager.answer(await answer(await f.request(), { permissions })),
      ).rejects.toMatchObject({ code: "invalid-response" });
      expect(f.manager.status().grants).toBe(0);
    },
  );

  it("rejects engine auto-review as a replacement for the user's CUA decision", async () => {
    const f = fixture();
    await expect(
      f.manager.answer(
        await answer(await f.request(), { strictAutoReview: true }),
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("does not treat object property ordering as a different permission grant", async () => {
    const f = fixture();
    await expect(
      f.manager.answer(
        await answer(await f.request(), {
          permissions: {
            computerUse: {
              target: { targetGeneration: 1, targetId: "window" },
              classes: ["capture"],
              version: 1,
            },
          },
        }),
      ),
    ).resolves.toEqual({ accepted: true });
  });

  it("expires pending approvals and notifies the durable owner exactly once", async () => {
    const f = fixture();
    const request = await f.request();
    const response = await answer(request);
    f.advance(5 * 60_000);
    await expect(f.manager.answer(response)).rejects.toMatchObject({
      code: "expired",
    });
    expect(f.onTerminal).toHaveBeenCalledExactlyOnceWith({
      requestKey: request.requestKey,
      chatId: "chat",
      status: "expired",
    });
    await expect(f.manager.answer(response)).rejects.toMatchObject({
      code: "revoked",
    });
  });

  it("revokes exactly one authority signal, including pending, granted and completed approvals", async () => {
    const f = fixture();
    const own = await f.request();
    await f.manager.answer(await answer(own));
    await f.authorize("cursor.move");
    const survivor = {
      ...f.context,
      signal: new AbortController().signal,
      scope: { ...f.context.scope, threadId: "agent", turnId: "turn" },
    };
    const other = await f.manager.authorize({
      context: survivor,
      operation: "observation.snapshot",
      target: { targetId: "window", targetGeneration: 1 },
    });
    if (other.status !== "approval-required")
      throw new Error("Expected approval");
    await f.manager.answer(await answer(other.request));
    f.manager.revokeContext(f.context.signal);
    expect(f.manager.status()).toMatchObject({
      pending: 0,
      grants: 1,
      completed: 1,
    });
    expect(f.manager.contextForResponse(own.requestKey)).toBeNull();
    await expect(f.authorize()).rejects.toMatchObject({ code: "revoked" });
    await expect(
      f.manager.authorize({
        context: survivor,
        operation: "observation.snapshot",
        target: { targetId: "window", targetGeneration: 1 },
      }),
    ).resolves.toEqual({ status: "allowed" });
    expect(f.onTerminal).toHaveBeenCalledTimes(1);
  });

  it("remembers explicit lifetime revocation before its first approval is published", async () => {
    const f = fixture();
    f.manager.revokeContext(f.context.signal);
    await expect(f.request()).rejects.toMatchObject({ code: "revoked" });
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
  });

  it.each([
    "abort",
    "context",
    "chat",
    "thread",
    "disconnect",
    "close",
  ] as const)(
    "revokes pending requests and grants on %s and never accepts late approval",
    async (kind) => {
      const f = fixture();
      f.context.scope.threadId = "thread";
      const request = await f.request();
      const response = await answer(request);
      const pendingCursor = await f.manager.authorize({
        context: f.context,
        operation: "cursor.move",
      });
      await f.manager.answer(response);
      if (kind === "abort") f.controller.abort();
      if (kind === "context") f.manager.revokeContext(f.context.signal);
      if (kind === "chat") f.manager.revokeChat("chat");
      if (kind === "thread") f.manager.revokeThread("thread");
      if (kind === "disconnect") f.manager.disconnect();
      if (kind === "close") f.manager.close();
      await expect(f.manager.answer(response)).rejects.toMatchObject({
        code: kind === "close" ? "closed" : "revoked",
      });
      await expect(f.authorize()).rejects.toMatchObject({
        code: kind === "close" ? "closed" : "revoked",
      });
      expect(f.manager.status().pending).toBe(0);
      expect(pendingCursor.status).toBe("approval-required");
      expect(f.onTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it("Stop remains allowed for a revoked scope but not a foreign owner", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.authorize("session.close")).resolves.toEqual({
      status: "allowed",
    });
    f.context.scope.ownerId = "other";
    await expect(f.authorize("session.close")).rejects.toMatchObject({
      code: "ownership-mismatch",
    });
  });

  it("does not publish a request after cancellation while encryption is completing", async () => {
    const f = fixture();
    const pending = f.request();
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "revoked" });
    expect(f.manager.status().pending).toBe(0);
  });

  it("does not publish a request whose deadline passed during encryption", async () => {
    const f = fixture();
    const pending = f.request();
    f.advance(5 * 60_000);
    await expect(pending).rejects.toMatchObject({ code: "expired" });
    expect(f.manager.status().pending).toBe(0);
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });

  it("accepts concurrent identical response retries without two grants", async () => {
    const f = fixture();
    const response = await answer(await f.request(), { scope: "turn" });
    await expect(
      Promise.all([f.manager.answer(response), f.manager.answer(response)]),
    ).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    await expect(f.authorize()).resolves.toEqual({ status: "allowed" });
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it("rejects an approval revoked while authenticated decryption is completing", async () => {
    const f = fixture();
    const response = await answer(await f.request());
    const pending = f.manager.answer(response);
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "revoked" });
    expect(f.manager.status().grants).toBe(0);
  });

  it("bounds outstanding durable requests without evicting existing approvals", async () => {
    const f = fixture();
    for (let index = 0; index < 32; index++)
      await f.authorize("observation.snapshot", {
        targetId: String(index),
        targetGeneration: 1,
      });
    await expect(f.authorize()).rejects.toMatchObject({ code: "capacity" });
    expect(f.manager.status().pending).toBe(32);
    f.advance(5 * 60_000);
    expect((await f.authorize()).status).toBe("approval-required");
    expect(f.manager.status().pending).toBe(1);
  });

  it("redacts encryption failures and never fabricates a replacement key or permission", async () => {
    const f = fixture();
    f.encryption.componentKey.mockImplementation(() => {
      throw new Error("private key diagnostic");
    });
    await expect(f.request()).rejects.toThrow(
      "Computer-use approval encryption is unavailable.",
    );
    expect(f.manager.status().pending).toBe(0);
    await expect(
      f.manager.answer({
        type: "computer-use.approval.respond",
        requestKey: randomUUID(),
        ownerId: "owner",
        chatId: "chat",
        executionLaneId: null,
        response: {} as never,
      }),
    ).rejects.toMatchObject({ code: "revoked" });
  });
});
