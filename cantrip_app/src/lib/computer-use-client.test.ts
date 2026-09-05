import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  openComputerUseRequest,
  protectComputerUseResult,
  type ComputerUseContentContext,
} from "@cantrip/crypto";
import {
  CUA_CHUNK_BYTES,
  type CuaSession,
  type CuaAgentSource,
  type ComputerUseAction,
  type ComputerUseChunkEvent,
  type ComputerUseHttpResult,
  type ComputerUseResultContent,
} from "@cantrip/protocol/computer-use";

vi.mock("./api-client", () => ({ request: vi.fn() }));
vi.mock("./client-encryption", () => ({ clientEncryption: undefined }));
vi.mock("./client-session", () => ({
  getClientSessionIdentitySnapshot: () => null,
  clientSessionIdentityMatches: () => false,
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("./server-connections", () => ({
  getActiveServerUrl: () => "http://unused.invalid",
}));

import type { ClientSessionIdentitySnapshot } from "./client-session";
import type { ClientEncryptionSnapshot } from "./client-encryption";
import {
  createComputerUseClient,
  type ComputerUseClient,
  type ComputerUseClientDependencies,
} from "./computer-use-client";

const chatId = "chat-a";
const firstLease = {
  leaseId: "11111111-1111-4111-8111-111111111111",
  chatId,
  workerId: "worker-a",
  generation: 7,
};
const secondLease = {
  ...firstLease,
  leaseId: "22222222-2222-4222-8222-222222222222",
};
const operationId = "33333333-3333-4333-8333-333333333333";
const componentKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const clients: ComputerUseClient[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function sessionResult(): { session: CuaSession } {
  return {
    session: {
      binding: {
        workerId: "worker-a",
        chatId,
        taskId: null,
        threadId: null,
        turnId: null,
        sessionId: "native-session-a",
      },
      target: {
        id: "monitor-a",
        generation: 3,
        kind: "monitor",
        title: "Private desktop",
        application: null,
        processId: null,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        pixelWidth: 1,
        pixelHeight: 1,
        scaleFactor: 1,
        focused: null,
        minimized: null,
      },
      cursor: {
        appearance: {
          version: 1,
          style: "arrow",
          color: "#ffffff",
          size: 16,
          label: null,
          trail: false,
          visible: true,
        },
        position: { x: 0, y: 0 },
        trailPoints: [],
        updatedAtMs: 1,
        revision: 1,
      },
      observationRevision: 1,
    },
  };
}
const agentSourceId = "55555555-5555-4555-8555-555555555555";
function agentSource(): CuaAgentSource {
  const { session } = sessionResult();
  return {
    sourceId: agentSourceId,
    rootThreadId: "root-thread",
    binding: {
      ...session.binding,
      threadId: "child-thread",
      turnId: "actual-turn",
    },
    target: session.target!,
    cursorRevision: session.cursor.revision,
    observationRevision: session.observationRevision,
    observedAtMs: 1000,
  };
}
const snapshotAction: ComputerUseAction = {
  operation: "observation.snapshot",
  sessionId: "native-session-a",
  targetId: "monitor-a",
  targetGeneration: 3,
};

function fixture() {
  const originalIdentity: ClientSessionIdentitySnapshot = {
    accountId: "owner-a",
    connectionId: "connection-a",
    generation: 1,
    incarnationId: "44444444-4444-4444-8444-444444444444",
    serverId: "server-a",
    serverUrl: "https://server-a.test",
    userId: "owner-a",
  };
  let identity: ClientSessionIdentitySnapshot | null = { ...originalIdentity };
  let snapshot: ClientEncryptionSnapshot = {
    status: "ready",
    clientId: "client-a",
    identity: { ownerId: "owner-a", serverId: "server-a" },
    masterKeyRevision: 2,
  };
  const identityListeners = new Set<() => void>();
  const encryptionListeners = new Set<() => void>();
  const issuedKeys: Uint8Array[] = [];
  const openedPlaintext: Uint8Array[] = [];
  const actions: ComputerUseAction[] = [];
  const bytes = new Uint8Array(CUA_CHUNK_BYTES + 128);
  bytes.set(
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    ),
  );
  let lease = firstLease;
  let resultTransform: (
    result: ComputerUseResultContent,
  ) => ComputerUseResultContent = (value) => value;
  let envelopeTransform: (
    value: ComputerUseHttpResult,
  ) => ComputerUseHttpResult = (value) => value;
  let contextTransform: (
    value: ComputerUseContentContext,
  ) => ComputerUseContentContext = (value) => value;
  let encrypt = encryptEndpointContentPayload;
  let decrypt = decryptEndpointContentPayload;

  const respond: NonNullable<ComputerUseClientDependencies["request"]> = async (
    url,
    init,
  ) => {
    if (url.endsWith("/preview/stop")) return { closed: true };
    if (url.endsWith("/preview")) return { ...lease };
    const request = JSON.parse(String(init?.body));
    const context: ComputerUseContentContext = {
      serverId: "server-a",
      workerId: "worker-a",
      chatId,
      operationId: request.operationId,
      operation: request.operation,
      previewLeaseId: request.previewLeaseId,
    };
    const action = await openComputerUseRequest({
      context,
      opaque: request,
      open: (endpoint, opaque) =>
        decryptEndpointContentPayload({
          ownerId: "owner-a",
          context: endpoint,
          keyRevision: 2,
          componentKey,
          opaque,
        }),
    });
    actions.push(action);
    let result: ComputerUseResultContent =
      action.operation === "observation.snapshot" ||
      action.operation === "agent.observation.get"
        ? {
            status: "ok",
            operation: action.operation,
            data: {
              ...sessionResult(),
              image: {
                mediaType: "image/png",
                width: 1,
                height: 1,
                byteCount: bytes.length,
                sha256: Array.from(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                  (byte) => byte.toString(16).padStart(2, "0"),
                ).join(""),
                cursorIncluded: true,
              },
            },
            chunkCount: 2,
          }
        : {
            status: "ok",
            operation: "targets.list",
            data: { targets: [] },
            chunkCount: 0,
          };
    if (action.operation === "agent.sources.list")
      result = {
        status: "ok",
        operation: action.operation,
        data: { sources: [agentSource()] },
        chunkCount: 0,
      };
    if (
      action.operation === "agent.observation.get" &&
      result.status === "ok" &&
      "image" in result.data
    ) {
      const source = agentSource();
      result = {
        ...result,
        operation: action.operation,
        data: {
          ...result.data,
          source,
          session: { ...sessionResult().session, binding: source.binding },
          nativeImage: { ...result.data.image, sha256: "b".repeat(64) },
        },
      };
    }
    result = resultTransform(result);
    const chunks: ComputerUseChunkEvent[] = [];
    const response = await protectComputerUseResult({
      context: contextTransform(context),
      result,
      payload:
        (action.operation === "observation.snapshot" ||
          action.operation === "agent.observation.get") &&
        result.status === "ok"
          ? bytes
          : null,
      seal: (endpoint, plaintext) =>
        encryptEndpointContentPayload({
          ownerId: "owner-a",
          context: endpoint,
          keyRevision: 2,
          componentKey,
          plaintext,
        }),
      emit: async (chunk) => {
        chunks.push(chunk);
      },
    });
    return envelopeTransform({ response, chunks });
  };
  let handler = respond;
  const send = vi.fn<NonNullable<ComputerUseClientDependencies["request"]>>(
    async (...args) => handler(...args),
  );
  const client = createComputerUseClient(chatId, {
    request: send,
    sessionIdentity: () => identity,
    identityMatches: (expected) =>
      JSON.stringify(expected) === JSON.stringify(identity),
    onIdentityChanged: (listener) => {
      identityListeners.add(listener);
      return () => {
        identityListeners.delete(listener);
      };
    },
    serverUrl: () => identity?.serverUrl ?? "https://signed-out.invalid",
    encryption: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        encryptionListeners.add(listener);
        return () => {
          encryptionListeners.delete(listener);
        };
      },
      componentKey: () => {
        const key = componentKey.slice();
        issuedKeys.push(key);
        return key;
      },
    },
    encrypt: (input) => encrypt(input),
    decrypt: async (input) => {
      const plaintext = await decrypt(input);
      openedPlaintext.push(plaintext);
      return plaintext;
    },
    randomUUID: () => operationId,
  });
  clients.push(client);
  return {
    client,
    send,
    respond,
    originalIdentity,
    issuedKeys,
    openedPlaintext,
    actions,
    bytes,
    identityListeners,
    encryptionListeners,
    setIdentity(next: ClientSessionIdentitySnapshot | null) {
      identity = next;
      for (const listener of identityListeners) listener();
    },
    setEncryption(update: Partial<ClientEncryptionSnapshot>) {
      snapshot = { ...snapshot, ...update };
      for (const listener of encryptionListeners) listener();
    },
    setLease(value: typeof firstLease) {
      lease = value;
    },
    setHandler(value: typeof handler) {
      handler = value;
    },
    setEncrypt(value: typeof encrypt) {
      encrypt = value;
    },
    setDecrypt(value: typeof decrypt) {
      decrypt = value;
    },
    setResultTransform(value: typeof resultTransform) {
      resultTransform = value;
    },
    setEnvelopeTransform(value: typeof envelopeTransform) {
      envelopeTransform = value;
    },
    setContextTransform(value: typeof contextTransform) {
      contextTransform = value;
    },
  };
}

describe("bound computer-use preview client", () => {
  it("uses the normal server route, authenticates PNG chunks and clears borrowed keys/plaintext", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const result = await f.client.operation(lease, snapshotAction);
    expect(result.content).toMatchObject({
      status: "ok",
      operation: "observation.snapshot",
    });
    expect(result.bytes).toEqual(f.bytes);
    expect(f.send.mock.calls[0]).toMatchObject([
      "https://server-a.test/api/chats/chat-a/computer-use/preview",
      { method: "POST", body: "{}" },
      { allowCsrfRecovery: false, expectedIdentity: f.originalIdentity },
    ]);
    expect(f.actions).toEqual([snapshotAction]);
    expect(f.issuedKeys.every((key) => key.every((byte) => byte === 0))).toBe(
      true,
    );
    expect(
      f.openedPlaintext.every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    result.bytes!.fill(0);
  });

  it.each(["chatId", "workerId", "leaseId", "generation"] as const)(
    "rejects a foreign lease %s before network or encryption",
    async (field) => {
      const f = fixture();
      const lease = await f.client.open();
      await expect(
        f.client.operation(
          { ...lease, [field]: field === "generation" ? 8 : "foreign" },
          { operation: "targets.list" },
        ),
      ).rejects.toMatchObject({ code: "invalid-lease" });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.issuedKeys).toEqual([]);
    },
  );

  it("rejects a lease for a different chat from open", async () => {
    const f = fixture();
    f.setLease({ ...firstLease, chatId: "foreign-chat" });
    await expect(f.client.open()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("does not send an action if identity changes during encryption, including A→B→A", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const encrypted =
      deferred<Awaited<ReturnType<typeof encryptEndpointContentPayload>>>();
    f.setEncrypt(async (input) => {
      const result = await encryptEndpointContentPayload(input);
      await encrypted.promise;
      return result;
    });
    const pending = f.client.operation(lease, { operation: "targets.list" });
    await vi.waitFor(() => expect(f.issuedKeys).toHaveLength(1));
    f.setIdentity({ ...f.originalIdentity, userId: "owner-b" });
    f.setIdentity({ ...f.originalIdentity, generation: 3 });
    encrypted.resolve(undefined as never);
    await expect(pending).rejects.toMatchObject({ code: "identity-changed" });
    expect(f.send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(f.issuedKeys[0]!.every((byte) => byte === 0)).toBe(true),
    );
  });

  it("aborts a sent request and rejects late plaintext after an account switch", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const gate = deferred<void>();
    f.setDecrypt(async (input) => {
      const plaintext = await decryptEndpointContentPayload(input);
      await gate.promise;
      return plaintext;
    });
    const pending = f.client.operation(lease, snapshotAction);
    await vi.waitFor(() => expect(f.issuedKeys.length).toBeGreaterThan(1));
    f.setIdentity({
      ...f.originalIdentity,
      serverId: "server-b",
      serverUrl: "https://server-b.test",
    });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "identity-changed" });
    await vi.waitFor(() => expect(f.openedPlaintext.length).toBeGreaterThan(0));
    expect(
      f.openedPlaintext.every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    expect(f.send.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  });

  it.each([
    { status: "locked" as const },
    { masterKeyRevision: 3 },
    { identity: { ownerId: "foreign-owner", serverId: "server-a" } },
  ])("keeps Stop available after encryption changes: %j", async (update) => {
    const f = fixture();
    const lease = await f.client.open();
    f.setEncryption(update);
    await expect(
      f.client.operation(lease, { operation: "targets.list" }),
    ).rejects.toMatchObject({ code: "encryption-unavailable" });
    await f.client.stop(lease);
    expect(f.send.mock.calls[1]).toMatchObject([
      "https://server-a.test/api/chats/chat-a/computer-use/preview/stop",
      {
        body: JSON.stringify({
          leaseId: lease.leaseId,
          workerId: lease.workerId,
        }),
      },
      { allowCsrfRecovery: false },
    ]);
    expect(f.issuedKeys).toEqual([]);
  });

  it("never sends Stop using a newly selected account", async () => {
    const f = fixture();
    const lease = await f.client.open();
    f.setIdentity({ ...f.originalIdentity, userId: "owner-b" });
    await expect(f.client.stop(lease)).rejects.toMatchObject({
      code: "identity-changed",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(["worker", "chat", "session", "target"])(
    "rejects authenticated but wrong %s result attribution",
    async (field) => {
      const f = fixture();
      const lease = await f.client.open();
      f.setResultTransform((result) => {
        if (result.status === "ok" && "session" in result.data) {
          if (field === "worker")
            result.data.session.binding.workerId = "other-worker";
          if (field === "chat")
            result.data.session.binding.chatId = "other-chat";
          if (field === "session")
            result.data.session.binding.sessionId = "other-session";
          if (field === "target") result.data.session.target!.generation += 1;
        }
        return result;
      });
      await expect(
        f.client.operation(lease, snapshotAction),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it.each([
    "ciphertext",
    "sequence",
    "missing",
    "duplicate",
    "operation",
    "lease-context",
  ])(
    "rejects %s tampering without exposing encrypted data in errors",
    async (kind) => {
      const f = fixture();
      const lease = await f.client.open();
      if (kind === "lease-context")
        f.setContextTransform((context) => ({
          ...context,
          previewLeaseId: secondLease.leaseId,
        }));
      f.setEnvelopeTransform((envelope) => {
        if (kind === "ciphertext") {
          const text = envelope.chunks[0]!.protectedContent.envelope.ciphertext;
          envelope.chunks[0]!.protectedContent.envelope.ciphertext =
            (text[0] === "A" ? "B" : "A") + text.slice(1);
        }
        if (kind === "sequence") envelope.chunks.reverse();
        if (kind === "missing") envelope.chunks.pop();
        if (kind === "duplicate") envelope.chunks[1] = envelope.chunks[0]!;
        if (kind === "operation")
          envelope.response.operationId = secondLease.leaseId;
        return envelope;
      });
      await expect(
        f.client.operation(lease, snapshotAction),
      ).rejects.toMatchObject({
        code: "decryption-failed",
        message: "Computer-use content could not be authenticated.",
      });
      expect(
        f.openedPlaintext.every((value) => value.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );

  it.each(["approval-required", "spawn-failed", "process-exited"])(
    "returns protected %s errors for the controller without retrying the action",
    async (code) => {
      const f = fixture();
      const lease = await f.client.open();
      f.setResultTransform(() => ({
        status: "error",
        operation: "targets.list",
        code,
        message: "Computer use could not proceed.",
        outcome: "not-sent",
      }));
      const result = await f.client.operation(lease, {
        operation: "targets.list",
      });
      expect(result).toMatchObject({
        content: { status: "error", code },
        bytes: null,
      });
      expect(f.actions).toHaveLength(1);
    },
  );

  it("stops independently of a stalled operation and explicitly reopens with a new lease", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const late = deferred<unknown>();
    f.setHandler((...args) =>
      args[0].endsWith("/operation") ? late.promise : f.respond(...args),
    );
    const pending = f.client.operation(lease, { operation: "targets.list" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    await f.client.stop(lease);
    expect(f.send.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    f.setLease(secondLease);
    expect(await f.client.open()).toEqual(secondLease);
    late.resolve({});
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      f.client.operation(lease, { operation: "targets.list" }),
    ).rejects.toMatchObject({ code: "invalid-lease" });
  });

  it("requires confirmed Stop before reopen and never silently accepts a retired lease", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const stopped = deferred<unknown>();
    f.setHandler((...args) =>
      args[0].endsWith("/preview/stop") ? stopped.promise : f.respond(...args),
    );
    const pending = f.client.stop(lease);
    await expect(f.client.open()).rejects.toMatchObject({
      code: "preview-stopping",
    });
    stopped.resolve({ closed: false });
    await expect(pending).rejects.toMatchObject({ code: "invalid-response" });
    await expect(f.client.open()).rejects.toMatchObject({
      code: "preview-stopped",
    });
    f.setHandler(f.respond);
    await f.client.stop(lease);
    await expect(f.client.open()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("dispose unsubscribes and cancels local work without sending Stop", async () => {
    const f = fixture();
    const lease = await f.client.open();
    f.client.dispose();
    f.client.dispose();
    expect(f.identityListeners.size).toBe(0);
    expect(f.encryptionListeners.size).toBe(0);
    await expect(
      f.client.operation(lease, { operation: "targets.list" }),
    ).rejects.toMatchObject({ code: "disposed" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("rejects a late open and cannot return to its old identity incarnation", async () => {
    const f = fixture();
    const response = deferred<unknown>();
    f.setHandler(() => response.promise);
    const pending = f.client.open();
    f.setIdentity({ ...f.originalIdentity, generation: 2 });
    response.resolve(firstLease);
    await expect(pending).rejects.toMatchObject({ code: "identity-changed" });
    f.setIdentity(f.originalIdentity);
    await expect(f.client.open()).rejects.toMatchObject({
      code: "identity-changed",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("rejects a different encrypted key revision and clears the authenticated manifest", async () => {
    const f = fixture();
    const lease = await f.client.open();
    f.setEnvelopeTransform((envelope) => {
      envelope.response.protectedContent.keyRevision = 3;
      envelope.response.protectedContent.envelope.keyRevision = 3;
      return envelope;
    });
    await expect(
      f.client.operation(lease, snapshotAction),
    ).rejects.toMatchObject({ code: "decryption-failed" });
    expect(f.openedPlaintext).toEqual([]);
  });

  it("cancels only the requested operation when its caller aborts", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const response = deferred<unknown>();
    f.setHandler((...args) =>
      args[0].endsWith("/operation") ? response.promise : f.respond(...args),
    );
    const abort = new AbortController();
    const pending = f.client.operation(
      lease,
      { operation: "targets.list" },
      abort.signal,
    );
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    abort.abort(new Error("private caller cancellation reason"));
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      message: "Computer-use request was cancelled.",
    });
    f.setHandler(f.respond);
    await expect(
      f.client.operation(lease, { operation: "targets.list" }),
    ).resolves.toMatchObject({ content: { status: "ok" } });
    response.resolve({});
  });

  it("bounds an unresponsive open to 35 seconds without replaying it", async () => {
    const f = fixture();
    f.setHandler(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = f.client.open();
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds crypto time too and clears borrowed key material once a late crypto call settles", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const gate = deferred<void>();
    const began = deferred<void>();
    f.setEncrypt(async (input) => {
      began.resolve();
      await gate.promise;
      return encryptEndpointContentPayload(input);
    });
    vi.useFakeTimers();
    const pending = f.client.operation(lease, { operation: "targets.list" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await began.promise;
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(f.send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    gate.resolve();
    await vi.waitFor(() =>
      expect(f.issuedKeys.every((key) => key.every((byte) => byte === 0))).toBe(
        true,
      ),
    );
  });

  it("gives Stop an independent 30-second deadline and permits an explicit retry afterward", async () => {
    const f = fixture();
    const lease = await f.client.open();
    f.setHandler(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = f.client.stop(lease);
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(f.send).toHaveBeenCalledTimes(2);
    f.setHandler(f.respond);
    await expect(f.client.stop(lease)).resolves.toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("encrypted agent observation attribution", () => {
  it("opens a real encrypted agent source and rendition while preserving native metadata and real thread/turn identities", async () => {
    const f = fixture();
    const lease = await f.client.open();
    const listed = await f.client.operation(lease, {
      operation: "agent.sources.list",
    });
    expect(listed.content).toMatchObject({
      status: "ok",
      data: { sources: [agentSource()] },
    });
    expect(listed.bytes).toBeNull();
    const result = await f.client.operation(lease, {
      operation: "agent.observation.get",
      sourceId: agentSourceId,
    });
    expect(result.content).toMatchObject({
      status: "ok",
      data: {
        source: agentSource(),
        session: { binding: agentSource().binding },
        nativeImage: { sha256: "b".repeat(64) },
      },
    });
    expect(result.bytes).toEqual(f.bytes);
    result.bytes?.fill(0);
    expect(f.send.mock.calls.at(-1)?.[1]?.body).not.toContain("child-thread");
    expect(f.send.mock.calls.at(-1)?.[1]?.body).not.toContain(agentSourceId);
  });
  it.each(["chatId", "workerId"] as const)(
    "rejects encrypted source-list results with a different %s",
    async (field) => {
      const f = fixture();
      const lease = await f.client.open();
      f.setResultTransform((result) =>
        result.status === "ok" && "sources" in result.data
          ? {
              ...result,
              data: {
                sources: result.data.sources.map((source) => ({
                  ...source,
                  binding: { ...source.binding, [field]: "other" },
                })),
              },
            }
          : result,
      );
      await expect(
        f.client.operation(lease, { operation: "agent.sources.list" }),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );
  it.each(["sourceId", "chatId", "workerId"] as const)(
    "rejects encrypted observations attributed to a different %s",
    async (field) => {
      const f = fixture();
      const lease = await f.client.open();
      f.setResultTransform((result) => {
        if (result.status !== "ok" || !("source" in result.data)) return result;
        const data = result.data;
        if (field === "sourceId")
          return {
            ...result,
            data: {
              ...data,
              source: {
                ...data.source,
                sourceId: "66666666-6666-4666-8666-666666666666",
              },
            },
          };
        const binding = { ...data.source.binding, [field]: "other" };
        return {
          ...result,
          data: {
            ...data,
            source: { ...data.source, binding },
            session: { ...data.session, binding },
          },
        };
      });
      await expect(
        f.client.operation(lease, {
          operation: "agent.observation.get",
          sourceId: agentSourceId,
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
      expect(
        f.openedPlaintext.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );
  it("keeps manual preview strict when an encrypted snapshot uses agent identities", async () => {
    const f = fixture();
    const lease = await f.client.open();
    f.setResultTransform((result) =>
      result.status === "ok" && "session" in result.data
        ? {
            ...result,
            data: {
              ...result.data,
              session: {
                ...result.data.session,
                binding: agentSource().binding,
              },
            },
          }
        : result,
    );
    await expect(
      f.client.operation(lease, snapshotAction),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
