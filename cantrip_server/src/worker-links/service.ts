import { randomUUID } from "node:crypto";

import {
  workerLinkLeaseSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionOpenRequestSchema,
  workerLinkPeerSessionSchema,
  workerLinkPeerSignalEnvelopeSchema,
  workerLinkResourceKindSchema,
  workerLinkResourceGrantSchema,
  workerLinkSessionSchema,
  type WorkerLinkLease,
  type WorkerLinkOperationalRoute,
  type WorkerLinkPeerMailbox,
  type WorkerLinkPeerMailboxReadRequest,
  type WorkerLinkPeerSession,
  type WorkerLinkPeerSessionOpenRequest,
  type WorkerLinkPeerSignalEnvelope,
  type WorkerLinkResourceGrant,
  type WorkerLinkResourceKind,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";

import type {
  RelayCoordinationMessage,
  RelayCoordinator,
  WorkerLinkSessionClaim,
} from "../coordination/relay-coordinator.js";
import {
  WorkerLinkCoordinator,
  WorkerLinkUnavailableError,
  type WorkerLinkCoordinatorStats,
  type WorkerLinkGrantIssueInput,
  type WorkerLinkSessionOpenInput,
} from "./coordinator.js";

// A replicated operation may spend one full worker-command timeout at the
// authority before its response crosses the coordination bus again.
const OPERATION_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 500;

type WorkerLinkOperation =
  | { kind: "renew-session"; sessionId: string }
  | {
      kind: "replace-route";
      sessionId: string;
      preferredRoute: WorkerLinkOperationalRoute;
    }
  | {
      kind: "open-peer";
      sessionId: string;
      input: WorkerLinkPeerSessionOpenRequest;
    }
  | {
      kind: "signal-peer";
      sessionId: string;
      envelope: WorkerLinkPeerSignalEnvelope;
    }
  | {
      kind: "read-peer-mailbox";
      sessionId: string;
      peerSessionId: string;
      input: WorkerLinkPeerMailboxReadRequest;
    }
  | {
      kind: "revoke-peer";
      sessionId: string;
      peerSessionId: string;
    }
  | { kind: "issue-grant"; input: WorkerLinkGrantIssueInput }
  | {
      kind: "renew-grant";
      sessionId: string;
      grantId: string;
    }
  | {
      kind: "revoke-grant";
      sessionId: string;
      grantId: string;
      reason:
        "released" | "resource-stopped" | "resource-deleted" | "lease-expired";
    }
  | {
      kind: "revoke-session";
      sessionId: string;
      reason:
        | "released"
        | "account-session-ended"
        | "worker-disconnected"
        | "worker-generation-changed"
        | "lease-expired"
        | "server-shutdown";
    };

type WorkerLinkRevokeScope =
  | { kind: "account-session"; accountSessionId: string }
  | { kind: "owner"; ownerId: string }
  | {
      kind: "attachment";
      ownerId: string;
      resourceKind: WorkerLinkResourceKind;
      resourceId: string;
      attachmentId: string;
      reason: "resource-stopped" | "resource-deleted";
    }
  | {
      kind: "resource";
      ownerId: string;
      resourceKind: WorkerLinkResourceKind;
      resourceId: string;
      reason: "resource-stopped" | "resource-deleted";
    };

export type WorkerLinkRelayRevokeScope =
  | { kind: "session"; sessionId: string }
  | { kind: "account-session"; accountSessionId: string }
  | { kind: "owner"; ownerId: string };

export type WorkerLinkRelayRevokeListener = (
  scope: WorkerLinkRelayRevokeScope,
) => void;

interface PendingOperation {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WorkerLinkService {
  #closed = false;
  readonly #localSessionIds = new Set<string>();
  readonly #pending = new Map<string, PendingOperation>();
  readonly #relayRevokeListeners = new Set<WorkerLinkRelayRevokeListener>();
  readonly #unsubscribe: (() => void) | null;

  constructor(
    private readonly local: WorkerLinkCoordinator,
    private readonly coordination: RelayCoordinator | undefined,
  ) {
    this.#unsubscribe =
      coordination?.subscribe((message) => this.#receive(message)) ?? null;
  }

  async openSession(
    input: WorkerLinkSessionOpenInput,
  ): Promise<WorkerLinkSession> {
    this.#assertOpen();
    const session = await this.local.openSession(input);
    this.#localSessionIds.add(session.sessionId);
    if (this.coordination) {
      const claim = claimFor(this.coordination.instanceId, session);
      const previous = await this.coordination.claimWorkerLinkSession(claim);
      if (
        previous &&
        previous.authorityInstanceId !== this.coordination.instanceId
      ) {
        await this.local.revokeSession(session.sessionId, "released");
        this.#localSessionIds.delete(session.sessionId);
        throw new WorkerLinkUnavailableError(
          "WorkerLink session authority is already owned by another server.",
        );
      }
    }
    return session;
  }

  async sessionForAuthorization(
    sessionId: string,
    authorization: { accountSessionId: string; ownerId: string },
  ): Promise<WorkerLinkSession | null> {
    const local = this.local.sessionForAuthorization(sessionId, authorization);
    if (local) return local;
    const claim = await this.coordination?.findWorkerLinkSession(sessionId);
    if (
      !claim ||
      claim.session.identity.ownerId !== authorization.ownerId ||
      claim.session.identity.accountSessionId !==
        authorization.accountSessionId ||
      claim.expiresAt <= Date.now()
    ) {
      return null;
    }
    return claim.session;
  }

  renewSession(sessionId: string): Promise<WorkerLinkSession> {
    return this.#runSessionOperation(sessionId, {
      kind: "renew-session",
      sessionId,
    }).then((value) => workerLinkSessionSchema.parse(value));
  }

  async replaceRoute(
    sessionId: string,
    preferredRoute: WorkerLinkOperationalRoute,
  ): Promise<WorkerLinkSession> {
    const session = workerLinkSessionSchema.parse(
      await this.#runSessionOperation(sessionId, {
        kind: "replace-route",
        sessionId,
        preferredRoute,
      }),
    );
    await this.#revokeRelayEverywhere({ kind: "session", sessionId });
    return session;
  }

  openPeerSession(
    sessionId: string,
    input: WorkerLinkPeerSessionOpenRequest,
  ): Promise<WorkerLinkPeerSession> {
    return this.#runSessionOperation(sessionId, {
      kind: "open-peer",
      sessionId,
      input: workerLinkPeerSessionOpenRequestSchema.parse(input),
    }).then((value) => workerLinkPeerSessionSchema.parse(value));
  }

  signalPeer(
    sessionId: string,
    envelope: WorkerLinkPeerSignalEnvelope,
  ): Promise<void> {
    const parsed = workerLinkPeerSignalEnvelopeSchema.parse(envelope);
    if (parsed.sessionId !== sessionId) {
      throw new WorkerLinkUnavailableError(
        "WorkerLink peer signal authority does not match the session.",
      );
    }
    return this.#runSessionOperation(sessionId, {
      kind: "signal-peer",
      sessionId,
      envelope: parsed,
    }).then(() => undefined);
  }

  readPeerMailbox(
    sessionId: string,
    peerSessionId: string,
    input: WorkerLinkPeerMailboxReadRequest,
  ): Promise<WorkerLinkPeerMailbox> {
    const parsedPeerSessionId =
      workerLinkPeerSessionSchema.shape.peerSessionId.parse(peerSessionId);
    return this.#runSessionOperation(sessionId, {
      kind: "read-peer-mailbox",
      sessionId,
      peerSessionId: parsedPeerSessionId,
      input: workerLinkPeerMailboxReadRequestSchema.parse(input),
    }).then((value) => workerLinkPeerMailboxSchema.parse(value));
  }

  revokePeerSession(
    sessionId: string,
    peerSessionId: string,
  ): Promise<boolean> {
    const parsedPeerSessionId =
      workerLinkPeerSessionSchema.shape.peerSessionId.parse(peerSessionId);
    return this.#runSessionOperation(sessionId, {
      kind: "revoke-peer",
      sessionId,
      peerSessionId: parsedPeerSessionId,
    }).then(Boolean);
  }

  issueGrant(
    input: WorkerLinkGrantIssueInput,
  ): Promise<WorkerLinkResourceGrant> {
    return this.#runSessionOperation(input.sessionId, {
      kind: "issue-grant",
      input,
    }).then((value) => workerLinkResourceGrantSchema.parse(value));
  }

  renewGrant(sessionId: string, grantId: string): Promise<WorkerLinkLease> {
    return this.#runSessionOperation(sessionId, {
      kind: "renew-grant",
      sessionId,
      grantId,
    }).then((value) => workerLinkLeaseSchema.parse(value));
  }

  revokeGrant(
    sessionId: string,
    grantId: string,
    reason:
      | "released"
      | "resource-stopped"
      | "resource-deleted"
      | "lease-expired" = "released",
  ): Promise<boolean> {
    return this.#runSessionOperation(sessionId, {
      kind: "revoke-grant",
      sessionId,
      grantId,
      reason,
    }).then(Boolean);
  }

  async revokeSession(
    sessionId: string,
    reason:
      | "released"
      | "account-session-ended"
      | "worker-disconnected"
      | "worker-generation-changed"
      | "lease-expired"
      | "server-shutdown" = "released",
  ): Promise<boolean> {
    const revoked = Boolean(
      await this.#runSessionOperation(sessionId, {
        kind: "revoke-session",
        sessionId,
        reason,
      }),
    );
    if (revoked) {
      await this.#revokeRelayEverywhere({ kind: "session", sessionId });
    }
    return revoked;
  }

  async revokeAccountSession(accountSessionId: string): Promise<number> {
    const revoked = await this.#revokeEverywhere({
      kind: "account-session",
      accountSessionId,
    });
    await this.#revokeRelayEverywhere({
      kind: "account-session",
      accountSessionId,
    });
    return revoked;
  }

  async revokeOwner(ownerId: string): Promise<number> {
    const revoked = await this.#revokeEverywhere({ kind: "owner", ownerId });
    await this.#revokeRelayEverywhere({ kind: "owner", ownerId });
    return revoked;
  }

  async revokeResource(
    ownerId: string,
    resourceKind: WorkerLinkResourceKind,
    resourceId: string,
    reason: "resource-stopped" | "resource-deleted" = "resource-stopped",
  ): Promise<number> {
    return this.#revokeEverywhere({
      kind: "resource",
      ownerId,
      resourceKind,
      resourceId,
      reason,
    });
  }

  async revokeAttachment(
    ownerId: string,
    resourceKind: WorkerLinkResourceKind,
    resourceId: string,
    attachmentId: string,
    reason: "resource-stopped" | "resource-deleted" = "resource-stopped",
  ): Promise<number> {
    return this.#revokeEverywhere({
      kind: "attachment",
      ownerId,
      resourceKind,
      resourceId,
      attachmentId,
      reason,
    });
  }

  stats(): WorkerLinkCoordinatorStats {
    return this.local.stats();
  }

  subscribeRelayRevocations(
    listener: WorkerLinkRelayRevokeListener,
  ): () => void {
    this.#relayRevokeListeners.add(listener);
    return () => this.#relayRevokeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new WorkerLinkUnavailableError("WorkerLink service closed."),
      );
    }
    this.#pending.clear();
    this.#relayRevokeListeners.clear();
    const sessionIds = [...this.#localSessionIds];
    this.#localSessionIds.clear();
    await this.local.close();
    if (this.coordination) {
      await Promise.all(
        sessionIds.map((sessionId) =>
          this.coordination!.releaseWorkerLinkSession(
            sessionId,
            this.coordination!.instanceId,
          ),
        ),
      );
    }
  }

  async #runSessionOperation(
    sessionId: string,
    operation: WorkerLinkOperation,
  ): Promise<unknown> {
    this.#assertOpen();
    if (!this.coordination) return this.#runLocal(operation);
    const claim = await this.coordination.findWorkerLinkSession(sessionId);
    if (!claim) {
      throw new WorkerLinkUnavailableError(
        "WorkerLink session is unavailable.",
      );
    }
    if (claim.authorityInstanceId === this.coordination.instanceId) {
      return this.#runLocal(operation);
    }
    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new WorkerLinkUnavailableError(
            "WorkerLink authority did not answer in time.",
          ),
        );
      }, OPERATION_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(requestId, { reject, resolve, timeout });
    });
    try {
      await this.coordination.publish({
        kind: "worker-link-operation-request",
        targetInstanceId: claim.authorityInstanceId,
        requestId,
        operation,
      });
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(requestId);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return response;
  }

  async #runLocal(operation: WorkerLinkOperation): Promise<unknown> {
    switch (operation.kind) {
      case "renew-session": {
        const session = await this.local.renewSession(operation.sessionId);
        await this.#refreshClaim(session);
        return session;
      }
      case "replace-route": {
        const session = await this.local.replaceRoute(
          operation.sessionId,
          operation.preferredRoute,
        );
        await this.#refreshClaim(session);
        return session;
      }
      case "open-peer":
        return this.local.openPeerSession({
          sessionId: operation.sessionId,
          ...operation.input,
        });
      case "signal-peer":
        return this.local.signalPeer(operation.envelope);
      case "read-peer-mailbox":
        return this.local.readPeerMailbox(
          operation.sessionId,
          operation.peerSessionId,
          operation.input,
        );
      case "revoke-peer":
        return this.local.revokePeerSession(
          operation.sessionId,
          operation.peerSessionId,
        );
      case "issue-grant":
        return this.local.issueGrant(operation.input);
      case "renew-grant":
        return this.local.renewGrant(operation.sessionId, operation.grantId);
      case "revoke-grant":
        return this.local.revokeGrant(
          operation.sessionId,
          operation.grantId,
          operation.reason,
        );
      case "revoke-session": {
        const revoked = await this.local.revokeSession(
          operation.sessionId,
          operation.reason,
        );
        if (revoked) {
          this.#localSessionIds.delete(operation.sessionId);
          await this.coordination?.releaseWorkerLinkSession(
            operation.sessionId,
            this.coordination.instanceId,
          );
        }
        return revoked;
      }
    }
  }

  async #refreshClaim(session: WorkerLinkSession): Promise<void> {
    if (!this.coordination) return;
    const claim = claimFor(this.coordination.instanceId, session);
    const refreshed = await this.coordination.refreshWorkerLinkSession(claim);
    const replacement = refreshed
      ? null
      : await this.coordination.claimWorkerLinkSession(claim);
    if (
      !refreshed &&
      replacement?.authorityInstanceId !== undefined &&
      replacement.authorityInstanceId !== this.coordination.instanceId
    ) {
      throw new WorkerLinkUnavailableError(
        "WorkerLink session authority was lost during the operation.",
      );
    }
  }

  async #revokeEverywhere(scope: WorkerLinkRevokeScope): Promise<number> {
    this.#assertOpen();
    const revoked = await this.#applyRevokeScope(scope);
    if (this.coordination) {
      await this.coordination.publish({ kind: "worker-link-revoke", scope });
    }
    return revoked;
  }

  async #revokeRelayEverywhere(
    scope: WorkerLinkRelayRevokeScope,
  ): Promise<void> {
    this.#notifyRelayRevocation(scope);
    if (this.coordination) {
      await this.coordination.publish({
        kind: "worker-link-relay-revoke",
        scope,
      });
    }
  }

  #notifyRelayRevocation(scope: WorkerLinkRelayRevokeScope): void {
    for (const listener of this.#relayRevokeListeners) listener(scope);
  }

  #applyRevokeScope(scope: WorkerLinkRevokeScope): Promise<number> {
    switch (scope.kind) {
      case "account-session":
        return this.local.revokeAccountSession(scope.accountSessionId);
      case "owner":
        return this.local.revokeOwner(scope.ownerId);
      case "resource":
        return this.local.revokeResource(
          scope.ownerId,
          scope.resourceKind,
          scope.resourceId,
          scope.reason,
        );
      case "attachment":
        return this.local.revokeAttachment(
          scope.ownerId,
          scope.resourceKind,
          scope.resourceId,
          scope.attachmentId,
          scope.reason,
        );
    }
  }

  async #receive(message: RelayCoordinationMessage): Promise<void> {
    if (this.#closed) return;
    if (message.kind === "worker-link-operation-response") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else {
        pending.reject(
          new WorkerLinkUnavailableError(
            boundedError(
              message.error ?? "WorkerLink authority rejected the operation.",
            ),
          ),
        );
      }
      return;
    }
    if (message.kind === "worker-link-revoke") {
      const scope = parseRevokeScope(message.scope);
      if (scope) await this.#applyRevokeScope(scope);
      return;
    }
    if (message.kind === "worker-link-relay-revoke") {
      const scope = parseRelayRevokeScope(message.scope);
      if (scope) this.#notifyRelayRevocation(scope);
      return;
    }
    if (message.kind !== "worker-link-operation-request") return;
    const operation = parseOperation(message.operation);
    if (!operation || !this.coordination) return;
    let result: unknown;
    let error: string | undefined;
    try {
      const claim = await this.coordination.findWorkerLinkSession(
        sessionIdOf(operation),
      );
      if (claim?.authorityInstanceId !== this.coordination.instanceId) {
        throw new WorkerLinkUnavailableError(
          "This server no longer owns WorkerLink authority.",
        );
      }
      result = await this.#runLocal(operation);
    } catch (caught) {
      error = boundedError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
    await this.coordination.publish({
      kind: "worker-link-operation-response",
      targetInstanceId: message.sourceInstanceId,
      requestId: message.requestId,
      ok: error === undefined,
      ...(error === undefined ? { result } : { error }),
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkerLinkUnavailableError("WorkerLink service is closed.");
    }
  }
}

function claimFor(
  authorityInstanceId: string,
  session: WorkerLinkSession,
): WorkerLinkSessionClaim {
  return {
    authorityInstanceId,
    expiresAt: Date.parse(session.lease.expiresAt),
    session,
  };
}

function sessionIdOf(operation: WorkerLinkOperation): string {
  return operation.kind === "issue-grant"
    ? operation.input.sessionId
    : operation.sessionId;
}

function parseOperation(value: unknown): WorkerLinkOperation | null {
  if (!record(value) || !text(value.kind, 64)) return null;
  switch (value.kind) {
    case "renew-session":
      return text(value.sessionId) ? (value as WorkerLinkOperation) : null;
    case "replace-route":
      return text(value.sessionId) &&
        (value.preferredRoute === "local" || value.preferredRoute === "relay")
        ? (value as WorkerLinkOperation)
        : null;
    case "open-peer": {
      const input = workerLinkPeerSessionOpenRequestSchema.safeParse(
        value.input,
      );
      return text(value.sessionId) && input.success
        ? { kind: "open-peer", sessionId: value.sessionId, input: input.data }
        : null;
    }
    case "signal-peer": {
      const envelope = workerLinkPeerSignalEnvelopeSchema.safeParse(
        value.envelope,
      );
      return text(value.sessionId) &&
        envelope.success &&
        envelope.data.sessionId === value.sessionId
        ? {
            kind: "signal-peer",
            sessionId: value.sessionId,
            envelope: envelope.data,
          }
        : null;
    }
    case "read-peer-mailbox": {
      const input = workerLinkPeerMailboxReadRequestSchema.safeParse(
        value.input,
      );
      return text(value.sessionId) && text(value.peerSessionId) && input.success
        ? {
            kind: "read-peer-mailbox",
            sessionId: value.sessionId,
            peerSessionId: value.peerSessionId,
            input: input.data,
          }
        : null;
    }
    case "revoke-peer":
      return text(value.sessionId) && text(value.peerSessionId)
        ? {
            kind: "revoke-peer",
            sessionId: value.sessionId,
            peerSessionId: value.peerSessionId,
          }
        : null;
    case "issue-grant":
      return record(value.input) && text(value.input.sessionId)
        ? (value as WorkerLinkOperation)
        : null;
    case "renew-grant":
      return text(value.sessionId) && text(value.grantId)
        ? (value as WorkerLinkOperation)
        : null;
    case "revoke-grant":
      return text(value.sessionId) &&
        text(value.grantId) &&
        [
          "released",
          "resource-stopped",
          "resource-deleted",
          "lease-expired",
        ].includes(String(value.reason))
        ? (value as WorkerLinkOperation)
        : null;
    case "revoke-session":
      return text(value.sessionId) &&
        [
          "released",
          "account-session-ended",
          "worker-disconnected",
          "worker-generation-changed",
          "lease-expired",
          "server-shutdown",
        ].includes(String(value.reason))
        ? (value as WorkerLinkOperation)
        : null;
    default:
      return null;
  }
}

function parseRevokeScope(value: unknown): WorkerLinkRevokeScope | null {
  if (!record(value) || !text(value.kind, 64)) return null;
  if (value.kind === "account-session" && text(value.accountSessionId)) {
    return value as WorkerLinkRevokeScope;
  }
  if (value.kind === "owner" && text(value.ownerId)) {
    return value as WorkerLinkRevokeScope;
  }
  if (
    value.kind === "attachment" &&
    text(value.ownerId) &&
    workerLinkResourceKindSchema.safeParse(value.resourceKind).success &&
    text(value.resourceId) &&
    text(value.attachmentId) &&
    (value.reason === "resource-stopped" || value.reason === "resource-deleted")
  ) {
    return value as WorkerLinkRevokeScope;
  }
  if (
    value.kind === "resource" &&
    text(value.ownerId) &&
    workerLinkResourceKindSchema.safeParse(value.resourceKind).success &&
    text(value.resourceId) &&
    (value.reason === "resource-stopped" || value.reason === "resource-deleted")
  ) {
    return value as WorkerLinkRevokeScope;
  }
  return null;
}

function parseRelayRevokeScope(
  value: unknown,
): WorkerLinkRelayRevokeScope | null {
  if (!record(value) || !text(value.kind, 64)) return null;
  if (value.kind === "session" && text(value.sessionId)) {
    return value as WorkerLinkRelayRevokeScope;
  }
  if (value.kind === "account-session" && text(value.accountSessionId)) {
    return value as WorkerLinkRelayRevokeScope;
  }
  if (value.kind === "owner" && text(value.ownerId)) {
    return value as WorkerLinkRelayRevokeScope;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 200): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function boundedError(value: string): string {
  return value.slice(0, MAX_ERROR_LENGTH);
}
