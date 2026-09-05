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
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("exact-request computer-use approval waiting", () => {
  function agentFixture() {
    const f = fixture();
    f.context.scope.threadId = "native-thread";
    f.context.scope.turnId = "native-turn";
    f.context.executionLaneId = "lane";
    const published = deferred<EncryptedAgentInteractionRequestCreate>();
    const publish = vi.fn(
      async (request: EncryptedAgentInteractionRequestCreate) => {
        published.resolve(request);
      },
    );
    const wait = (
      overrides: Partial<
        Parameters<CuaApprovalManager["authorizeAndWait"]>[0]
      > = {},
    ) =>
      f.manager.authorizeAndWait({
        context: f.context,
        operation: "observation.snapshot",
        target: { targetId: "window", targetGeneration: 1 },
        publish,
        ...overrides,
      });
    return { ...f, published, publish, wait };
  }

  it("resumes the same suspended action once and preserves the exact grant on response replay", async () => {
    const f = agentFixture();
    const action = vi.fn();
    const waiting = f.wait().then(action);
    const request = await f.published.promise;
    expect(action).not.toHaveBeenCalled();
    const response = await answer(request, { scope: "turn" });
    await expect(f.manager.answer(response)).resolves.toEqual({
      accepted: true,
    });
    await waiting;
    await f.manager.answer(response);
    expect(action).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    await expect(f.wait()).resolves.toBeUndefined();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("does not expose a grant or resume before publication acknowledges an early answer", async () => {
    const f = agentFixture();
    const publication = deferred<void>();
    f.publish.mockImplementation(async (request) => {
      f.published.resolve(request);
      await publication.promise;
    });
    const action = vi.fn();
    const waiting = f.wait().then(action);
    const request = await f.published.promise;
    await f.manager.answer(await answer(request));
    expect(action).not.toHaveBeenCalled();
    expect(f.manager.status().grants).toBe(0);
    await expect(f.wait()).rejects.toMatchObject({ code: "capacity" });
    publication.resolve();
    await waiting;
    expect(action).toHaveBeenCalledTimes(1);
    expect(f.manager.status().grants).toBe(1);
  });

  it("publication failure after an early answer never grants or replays the action", async () => {
    const f = agentFixture();
    const publication = deferred<void>();
    f.publish.mockImplementation(async (request) => {
      f.published.resolve(request);
      await publication.promise;
    });
    const action = vi.fn();
    const waiting = f.wait().then(action);
    const failure = expect(waiting).rejects.toMatchObject({
      code: "publication-failed",
    });
    const request = await f.published.promise;
    await f.manager.answer(await answer(request));
    publication.reject(new Error("private publication diagnostic"));
    await failure;
    expect(action).not.toHaveBeenCalled();
    expect(f.manager.status()).toMatchObject({ pending: 0, grants: 0 });
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it("rejects denial precisely without automatic reauthorization", async () => {
    const f = agentFixture();
    const waiting = f.wait();
    const denied = expect(waiting).rejects.toMatchObject({ code: "denied" });
    const request = await f.published.promise;
    const response = await answer(request, { permissions: {} });
    await f.manager.answer(response);
    await denied;
    await f.manager.answer(response);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.manager.status()).toMatchObject({ pending: 0, grants: 0 });
  });

  it.each(["call", "context", "revoke"])(
    "cancels a waiting %s even while publication is unresolved",
    async (kind) => {
      const f = agentFixture();
      const call = new AbortController();
      const publication = deferred<void>();
      f.publish.mockImplementation(async (request) => {
        f.published.resolve(request);
        await publication.promise;
      });
      const waiting = f.wait({ signal: call.signal });
      const cancelled = expect(waiting).rejects.toMatchObject({
        code: kind === "call" ? "cancelled" : "revoked",
      });
      const request = await f.published.promise;
      if (kind === "call") call.abort();
      else if (kind === "context") f.controller.abort();
      else f.manager.revokeContext(f.context.signal);
      await cancelled;
      expect(f.onTerminal).toHaveBeenCalledWith({
        requestKey: request.requestKey,
        chatId: "chat",
        status: "interrupted",
      });
      const terminals = f.onTerminal.mock.calls.length;
      const terminalAfterPublication = deferred<void>();
      f.onTerminal.mockImplementation(() => terminalAfterPublication.resolve());
      publication.resolve();
      await terminalAfterPublication.promise;
      expect(f.onTerminal.mock.calls.length).toBeGreaterThan(terminals);
      await expect(
        f.manager.answer(await answer(request)),
      ).rejects.toMatchObject({ code: "revoked" });
      if (kind === "call") {
        expect(f.context.signal.aborted).toBe(false);
        expect((await f.authorize()).status).toBe("approval-required");
      } else {
        await expect(f.authorize()).rejects.toMatchObject({ code: "revoked" });
      }
    },
  );

  it("call cancellation after answer but before publication does not leak its staged grant", async () => {
    const f = agentFixture();
    const call = new AbortController();
    const publication = deferred<void>();
    f.publish.mockImplementation(async (request) => {
      f.published.resolve(request);
      await publication.promise;
    });
    const waiting = f.wait({ signal: call.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "cancelled",
    });
    await f.manager.answer(await answer(await f.published.promise));
    call.abort();
    await cancelled;
    publication.resolve();
    expect(f.manager.status().grants).toBe(0);
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it("expires the suspended call even when its publisher does not complete", async () => {
    vi.useFakeTimers();
    const f = agentFixture();
    const publication = deferred<void>();
    f.publish.mockImplementation(async (request) => {
      f.published.resolve(request);
      await publication.promise;
    });
    const waiting = f.wait();
    const expired = expect(waiting).rejects.toMatchObject({ code: "expired" });
    const request = await f.published.promise;
    f.advance(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expired;
    expect(f.manager.status().pending).toBe(0);
    expect(f.onTerminal).toHaveBeenCalledWith({
      requestKey: request.requestKey,
      chatId: "chat",
      status: "expired",
    });
    publication.resolve();
  });

  it("does no publication for YOLO, existing grants, or an already-cancelled call", async () => {
    const f = agentFixture();
    const call = new AbortController();
    call.abort();
    await expect(f.wait({ signal: call.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(
      f.wait({ operation: "session.close", signal: call.signal }),
    ).resolves.toBeUndefined();
    f.context.profile.selectedId = ":yolo";
    await expect(f.wait()).resolves.toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
  });

  it("cancels during encrypted request preparation without publishing or revoking the execution", async () => {
    const f = agentFixture();
    const call = new AbortController();
    const waiting = f.wait({ signal: call.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "cancelled",
    });
    call.abort();
    await cancelled;
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.manager.status().pending).toBe(0);
    expect(f.context.signal.aborted).toBe(false);
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it("keeps an existing pending preview request usable after a duplicate waiter is rejected", async () => {
    const f = agentFixture();
    const original = await f.request();
    const waiting = f.wait();
    const request = await f.published.promise;
    expect(request.requestKey).toBe(original.requestKey);
    await expect(f.wait()).rejects.toMatchObject({ code: "capacity" });
    expect(f.manager.status().pending).toBe(1);
    await f.manager.answer(await answer(request));
    await waiting;
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("consumes a one-use grant for the suspended call without changing preview retry semantics", async () => {
    const f = agentFixture();
    f.context.scope.threadId = null;
    f.context.scope.turnId = null;
    f.context.executionLaneId = null;
    const waiting = f.wait();
    await f.manager.answer(
      await answer(await f.published.promise, { scope: "turn" }),
    );
    await waiting;
    expect(f.manager.status().grants).toBe(0);
    expect((await f.authorize()).status).toBe("approval-required");
  });

  it("keeps cancelled but unresolved publishers bounded until their actual completion", async () => {
    const f = agentFixture();
    const publication = deferred<void>();
    const published = deferred<void>();
    let count = 0;
    const waits: Promise<void>[] = [];
    const call = new AbortController();
    for (let index = 0; index < 32; index++) {
      const waiting = f.wait({
        signal: call.signal,
        target: { targetId: `window-${index}`, targetGeneration: 1 },
        publish: async () => {
          if (++count === 32) published.resolve();
          await publication.promise;
        },
      });
      void waiting.catch(() => {});
      waits.push(waiting);
    }
    await published.promise;
    call.abort();
    await Promise.allSettled(waits);
    await expect(f.wait()).rejects.toMatchObject({ code: "capacity" });
    await expect(
      f.wait({ operation: "session.close", signal: call.signal }),
    ).resolves.toBeUndefined();
    const terminals = deferred<void>();
    let afterPublication = 0;
    f.onTerminal.mockImplementation(() => {
      if (++afterPublication === 32) terminals.resolve();
    });
    publication.resolve();
    await terminals.promise;
    // Authorize encryption yields while the resolved publisher slots retire.
    expect((await f.authorize()).status).toBe("approval-required");
    const nextCall = new AbortController();
    const waiting = f.wait({ signal: nextCall.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "cancelled",
    });
    await f.published.promise;
    nextCall.abort();
    await cancelled;
  });

  it("bounds waiting publications and preserves the first request when a duplicate waits", async () => {
    const f = agentFixture();
    const waits: Promise<void>[] = [];
    const publications = new Map<
      string,
      EncryptedAgentInteractionRequestCreate
    >();
    const abort = new AbortController();
    const ready = deferred<void>();
    for (let index = 0; index < 32; index++) {
      const waiting = f.wait({
        signal: abort.signal,
        target: { targetId: `window-${index}`, targetGeneration: 1 },
        publish: async (request) => {
          publications.set(request.requestKey, request);
          if (publications.size === 32) ready.resolve();
        },
      });
      void waiting.catch(() => {});
      waits.push(waiting);
    }
    await ready.promise;
    await expect(f.wait()).rejects.toMatchObject({ code: "capacity" });
    expect(f.manager.status().pending).toBe(32);
    abort.abort();
    expect(
      (await Promise.allSettled(waits)).every(
        (result) => result.status === "rejected",
      ),
    ).toBe(true);
    expect(f.manager.status().pending).toBe(0);
    expect(f.context.signal.aborted).toBe(false);
  });
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
