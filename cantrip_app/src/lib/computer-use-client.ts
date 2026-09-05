import {
  clearSensitiveBytes,
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  openComputerUseResult,
  protectComputerUseRequest,
  type ComputerUseContentContext,
  type ComputerUseOpen,
  type ComputerUseSeal,
} from "@cantrip/crypto";
import {
  cuaAgentSourcesSchema,
  cuaAgentObservationSchema,
  computerUseActionSchema,
  computerUseHttpResultSchema,
  cuaIdSchema,
  type ComputerUseAction,
  type ComputerUseResultContent,
} from "@cantrip/protocol/computer-use";
import {
  cuaPreviewLeaseSchema,
  type CuaPreviewLease,
} from "@cantrip/protocol/computer-use-preview";

import { request } from "./api-client";
import {
  clientEncryption,
  type ClientEncryptionService,
  type ClientEncryptionSnapshot,
} from "./client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "./client-session";
import { getActiveServerUrl } from "./server-connections";

export type ComputerUseClientErrorCode =
  | "authentication-required"
  | "identity-changed"
  | "encryption-unavailable"
  | "invalid-lease"
  | "invalid-action"
  | "invalid-response"
  | "decryption-failed"
  | "cancelled"
  | "timeout"
  | "disposed"
  | "preview-already-open"
  | "preview-stopping"
  | "preview-stopped";

export class ComputerUseClientError extends Error {
  constructor(
    readonly code: ComputerUseClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseClientError";
  }
}

export interface ComputerUseClient {
  open(signal?: AbortSignal): Promise<CuaPreviewLease>;
  /** Returned bytes are caller-owned and must be cleared after display/use. */
  operation(
    lease: CuaPreviewLease,
    action: ComputerUseAction,
    signal?: AbortSignal,
  ): Promise<{ content: ComputerUseResultContent; bytes: Uint8Array | null }>;
  stop(lease: CuaPreviewLease, signal?: AbortSignal): Promise<void>;
  /** Cancels local work only; explicit Stop owns remote lease termination. */
  dispose(): void;
}

export interface ComputerUseClientDependencies {
  request?: typeof request;
  sessionIdentity?: () => ClientSessionIdentitySnapshot | null;
  identityMatches?: (expected: ClientSessionIdentitySnapshot) => boolean;
  onIdentityChanged?: (listener: () => void) => () => void;
  serverUrl?: () => string;
  encryption?: Pick<
    ClientEncryptionService,
    "getSnapshot" | "componentKey" | "subscribe"
  >;
  randomUUID?: () => string;
  encrypt?: typeof encryptEndpointContentPayload;
  decrypt?: typeof decryptEndpointContentPayload;
}

function joinedSignal(signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  const bindings = active.map((signal) => {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, abort } of bindings)
        signal.removeEventListener("abort", abort);
    },
  };
}

/** One explicit preview lifetime pinned to its original account and key revision. */
export function createComputerUseClient(
  chatId: string,
  dependencies: ComputerUseClientDependencies = {},
): ComputerUseClient {
  cuaIdSchema.parse(chatId);
  const currentIdentity = (
    dependencies.sessionIdentity ?? getClientSessionIdentitySnapshot
  )();
  if (!currentIdentity)
    throw new ComputerUseClientError(
      "authentication-required",
      "Sign in before opening computer use.",
    );
  const identity = Object.freeze({ ...currentIdentity });
  const baseUrl = (dependencies.serverUrl ?? getActiveServerUrl)().replace(
    /\/$/u,
    "",
  );
  const path = `${baseUrl}/api/chats/${encodeURIComponent(chatId)}/computer-use`;
  const matchesIdentity =
    dependencies.identityMatches ?? clientSessionIdentityMatches;
  const service = dependencies.encryption ?? clientEncryption;
  const sourceSnapshot = service.getSnapshot();
  const snapshot = {
    ...sourceSnapshot,
    identity: sourceSnapshot.identity && { ...sourceSnapshot.identity },
  };
  const send = dependencies.request ?? request;
  const identityLifetime = new AbortController();
  const encryptionLifetime = new AbortController();
  let operationsLifetime = new AbortController();
  let disposed = false;
  let opening = false;
  let stopped = false;
  let stopping = false;
  let stopConfirmed = false;
  let retiredLeaseId: string | null = null;
  let ownedLease: CuaPreviewLease | null = null;

  function sameEncryption(current: ClientEncryptionSnapshot): boolean {
    return (
      current.status === "ready" &&
      snapshot.status === "ready" &&
      current.masterKeyRevision !== null &&
      current.masterKeyRevision === snapshot.masterKeyRevision &&
      current.clientId === snapshot.clientId &&
      current.identity?.serverId === identity.serverId &&
      current.identity.ownerId === identity.userId &&
      snapshot.identity?.serverId === identity.serverId &&
      snapshot.identity.ownerId === identity.userId
    );
  }
  function assertIdentity(signal?: AbortSignal): void {
    if (disposed)
      throw new ComputerUseClientError("disposed", "Computer use was closed.");
    if (identityLifetime.signal.aborted || !matchesIdentity(identity)) {
      identityLifetime.abort();
      throw new ComputerUseClientError(
        "identity-changed",
        "The account or server changed. Open a new computer-use preview.",
      );
    }
    if (signal?.aborted)
      if (
        signal.reason instanceof ComputerUseClientError &&
        signal.reason.code === "timeout"
      )
        throw signal.reason;
    if (signal?.aborted)
      throw new ComputerUseClientError(
        "cancelled",
        "Computer-use request was cancelled.",
      );
  }
  function assertEncryption(signal?: AbortSignal, allowStopped = false): void {
    assertIdentity(signal);
    if (
      encryptionLifetime.signal.aborted ||
      !sameEncryption(service.getSnapshot())
    ) {
      encryptionLifetime.abort();
      throw new ComputerUseClientError(
        "encryption-unavailable",
        "Unlock encryption and open a new computer-use preview. Stop remains available.",
      );
    }
    if (stopped && !allowStopped)
      throw new ComputerUseClientError(
        "preview-stopped",
        "Computer use was stopped. Open a new preview to continue.",
      );
  }
  function checkLease(candidate: CuaPreviewLease): CuaPreviewLease {
    const parsed = cuaPreviewLeaseSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !ownedLease ||
      parsed.data.chatId !== chatId ||
      parsed.data.leaseId !== ownedLease.leaseId ||
      parsed.data.workerId !== ownedLease.workerId ||
      parsed.data.generation !== ownedLease.generation
    ) {
      throw new ComputerUseClientError(
        "invalid-lease",
        "This preview lease does not belong to the open computer-use client.",
      );
    }
    return { ...ownedLease };
  }
  const unsubscribeIdentity = (
    dependencies.onIdentityChanged ?? onClientSessionIdentityChanged
  )(() => {
    if (!matchesIdentity(identity)) identityLifetime.abort();
  });
  const unsubscribeEncryption = service.subscribe(() => {
    if (!sameEncryption(service.getSnapshot())) encryptionLifetime.abort();
  });

  async function sendBound(
    suffix: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    assertIdentity(signal);
    const result = await waitForSignal(
      send(
        `${path}${suffix}`,
        { method: "POST", body: JSON.stringify(body), signal },
        {
          allowCsrfRecovery: false,
          expectedIdentity: identity,
        },
      ),
      signal,
    );
    assertIdentity(signal);
    return result;
  }

  function waitForSignal<T>(
    work: Promise<T>,
    signal: AbortSignal,
    encrypted = false,
    discard?: (result: T) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        try {
          assertIdentity();
          if (
            encrypted &&
            (encryptionLifetime.signal.aborted ||
              !sameEncryption(service.getSnapshot()))
          )
            assertEncryption();
          assertIdentity(signal);
        } catch (error) {
          reject(error);
        }
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      work
        .then((result) => {
          if (cancelled) discard?.(result);
          else resolve(result);
        }, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async function timed<T>(
    encrypted: boolean,
    timeoutMs: number,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    discard?: (result: T) => void,
  ): Promise<T> {
    const deadline = new AbortController();
    const pending = joinedSignal([
      signal,
      deadline.signal,
      identityLifetime.signal,
      ...(encrypted ? [encryptionLifetime.signal] : []),
    ]);
    const timeout = setTimeout(
      () =>
        deadline.abort(
          new ComputerUseClientError(
            "timeout",
            "Computer use did not respond before its deadline. The operation was not retried.",
          ),
        ),
      timeoutMs,
    );
    try {
      return await waitForSignal(
        task(pending.signal),
        pending.signal,
        encrypted,
        discard,
      );
    } finally {
      clearTimeout(timeout);
      pending.dispose();
    }
  }

  const client: ComputerUseClient = {
    async open(signal) {
      assertEncryption(signal, true);
      if (stopping)
        throw new ComputerUseClientError(
          "preview-stopping",
          "Wait for Stop to finish before opening a new preview.",
        );
      if (opening)
        throw new ComputerUseClientError(
          "preview-already-open",
          "This computer-use client is already opening a preview.",
        );
      if (ownedLease && !stopped) return { ...ownedLease };
      if (stopped && !stopConfirmed)
        throw new ComputerUseClientError(
          "preview-stopped",
          "Confirm Stop before opening a new preview.",
        );
      if (stopped) {
        ownedLease = null;
        stopped = false;
        stopConfirmed = false;
        operationsLifetime = new AbortController();
      }
      opening = true;
      const pending = joinedSignal([
        signal,
        identityLifetime.signal,
        encryptionLifetime.signal,
        operationsLifetime.signal,
      ]);
      try {
        const response = await sendBound("/preview", {}, pending.signal);
        assertEncryption(pending.signal);
        const parsed = cuaPreviewLeaseSchema.safeParse(response);
        if (
          !parsed.success ||
          parsed.data.chatId !== chatId ||
          parsed.data.leaseId === retiredLeaseId
        )
          throw new ComputerUseClientError(
            "invalid-response",
            "The server returned an invalid computer-use preview lease.",
          );
        ownedLease = Object.freeze({ ...parsed.data });
        return { ...ownedLease };
      } finally {
        opening = false;
        pending.dispose();
      }
    },
    async operation(lease, action, signal) {
      assertEncryption(signal);
      const owned = checkLease(lease);
      const parsed = computerUseActionSchema.safeParse(action);
      if (!parsed.success)
        throw new ComputerUseClientError(
          "invalid-action",
          "The computer-use action is invalid.",
        );
      const context: ComputerUseContentContext = {
        serverId: identity.serverId,
        workerId: owned.workerId,
        chatId,
        operationId: (dependencies.randomUUID ?? (() => crypto.randomUUID()))(),
        operation: parsed.data.operation,
        previewLeaseId: owned.leaseId,
      };
      const pending = joinedSignal([
        signal,
        identityLifetime.signal,
        encryptionLifetime.signal,
        operationsLifetime.signal,
      ]);
      const seal: ComputerUseSeal = async (endpointContext, plaintext) => {
        assertEncryption(pending.signal);
        const key = service.componentKey({
          component: "client-control-content",
          identity: snapshot.identity!,
          keyRevision: snapshot.masterKeyRevision!,
        });
        try {
          const result = await (
            dependencies.encrypt ?? encryptEndpointContentPayload
          )({
            ownerId: identity.userId,
            context: endpointContext,
            keyRevision: snapshot.masterKeyRevision!,
            componentKey: key,
            plaintext,
          });
          assertEncryption(pending.signal);
          return result;
        } finally {
          clearSensitiveBytes(key);
        }
      };
      const open: ComputerUseOpen = async (endpointContext, opaque) => {
        assertEncryption(pending.signal);
        if (opaque.keyRevision !== snapshot.masterKeyRevision)
          throw new ComputerUseClientError(
            "decryption-failed",
            "Computer-use content could not be authenticated.",
          );
        const key = service.componentKey({
          component: "client-control-content",
          identity: snapshot.identity!,
          keyRevision: snapshot.masterKeyRevision!,
        });
        let plaintext: Uint8Array | null = null;
        try {
          plaintext = await (
            dependencies.decrypt ?? decryptEndpointContentPayload
          )({
            ownerId: identity.userId,
            context: endpointContext,
            keyRevision: snapshot.masterKeyRevision!,
            componentKey: key,
            opaque,
          });
          assertEncryption(pending.signal);
          const result = plaintext;
          plaintext = null;
          return result;
        } finally {
          clearSensitiveBytes(key);
          if (plaintext) clearSensitiveBytes(plaintext);
        }
      };
      let bytes: Uint8Array | null = null;
      try {
        const protectedRequest = await protectComputerUseRequest({
          context,
          request: parsed.data,
          seal,
        });
        assertEncryption(pending.signal);
        const response = await sendBound(
          "/operation",
          protectedRequest,
          pending.signal,
        );
        assertEncryption(pending.signal);
        const envelope = computerUseHttpResultSchema.safeParse(response);
        if (!envelope.success)
          throw new ComputerUseClientError(
            "invalid-response",
            "The server returned invalid computer-use content.",
          );
        let opened: Awaited<ReturnType<typeof openComputerUseResult>>;
        try {
          opened = await openComputerUseResult({
            context,
            opaque: envelope.data.response,
            chunks: envelope.data.chunks,
            open,
          });
        } catch {
          assertEncryption(pending.signal);
          throw new ComputerUseClientError(
            "decryption-failed",
            "Computer-use content could not be authenticated.",
          );
        }
        bytes = opened.payload;
        assertEncryption(pending.signal);
        if (
          opened.result.status === "ok" &&
          parsed.data.operation === "agent.sources.list"
        ) {
          const { sources } = cuaAgentSourcesSchema.parse(opened.result.data);
          if (
            sources.some(
              ({ binding }) =>
                binding.chatId !== chatId ||
                binding.workerId !== owned.workerId ||
                binding.threadId === null ||
                binding.turnId === null,
            )
          ) {
            throw new ComputerUseClientError(
              "invalid-response",
              "The worker returned sources for a different agent execution.",
            );
          }
        } else if (
          opened.result.status === "ok" &&
          parsed.data.operation === "agent.observation.get"
        ) {
          const { source, session } = cuaAgentObservationSchema.parse(
            opened.result.data,
          );
          const binding = session.binding;
          if (
            source.sourceId !== parsed.data.sourceId ||
            binding.chatId !== chatId ||
            binding.workerId !== owned.workerId ||
            binding.threadId === null ||
            binding.turnId === null ||
            (Object.keys(binding) as (keyof typeof binding)[]).some(
              (key) => binding[key] !== source.binding[key],
            ) ||
            session.target?.id !== source.target.id ||
            session.target.generation !== source.target.generation ||
            session.observationRevision !== source.observationRevision ||
            session.cursor.revision !== source.cursorRevision
          ) {
            throw new ComputerUseClientError(
              "invalid-response",
              "The worker returned an observation for a different agent source or execution.",
            );
          }
        } else if (
          opened.result.status === "ok" &&
          "session" in opened.result.data
        ) {
          const { binding, target } = opened.result.data.session;
          if (
            binding.chatId !== chatId ||
            binding.workerId !== owned.workerId ||
            binding.taskId !== null ||
            binding.threadId !== null ||
            binding.turnId !== null ||
            ("sessionId" in parsed.data &&
              binding.sessionId !== parsed.data.sessionId) ||
            ("targetId" in parsed.data &&
              (target?.id !== parsed.data.targetId ||
                target.generation !== parsed.data.targetGeneration)) ||
            (parsed.data.operation === "target.detach" && target !== null)
          ) {
            throw new ComputerUseClientError(
              "invalid-response",
              "The worker returned content for a different computer-use session or target.",
            );
          }
        }
        const result = { content: opened.result, bytes };
        bytes = null;
        return result;
      } finally {
        if (bytes) clearSensitiveBytes(bytes);
        pending.dispose();
      }
    },
    async stop(lease, signal) {
      assertIdentity(signal);
      const owned = checkLease(lease);
      if (stopping)
        throw new ComputerUseClientError(
          "preview-stopping",
          "Computer use is already stopping.",
        );
      if (stopConfirmed) return;
      stopping = true;
      stopped = true;
      operationsLifetime.abort();
      const pending = joinedSignal([signal, identityLifetime.signal]);
      try {
        const result = await sendBound(
          "/preview/stop",
          { leaseId: owned.leaseId, workerId: owned.workerId },
          pending.signal,
        );
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result) ||
          Object.keys(result).length !== 1 ||
          !("closed" in result) ||
          result.closed !== true
        )
          throw new ComputerUseClientError(
            "invalid-response",
            "The worker did not confirm that computer use stopped.",
          );
        stopConfirmed = true;
        retiredLeaseId = owned.leaseId;
      } finally {
        stopping = false;
        pending.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      identityLifetime.abort();
      encryptionLifetime.abort();
      operationsLifetime.abort();
      unsubscribeIdentity();
      unsubscribeEncryption();
    },
  };
  return {
    open: (signal) =>
      timed(true, 35_000, (bounded) => client.open(bounded), signal),
    operation: (lease, action, signal) =>
      timed(
        true,
        35_000,
        (bounded) => client.operation(lease, action, bounded),
        signal,
        (result) => {
          if (result.bytes) clearSensitiveBytes(result.bytes);
        },
      ),
    stop: (lease, signal) =>
      timed(false, 30_000, (bounded) => client.stop(lease, bounded), signal),
    dispose: () => client.dispose(),
  };
}
