import { randomBytes } from "node:crypto";

import {
  type CodeAppearance,
  type CodeRuntimeStatus,
  type CodeSharedAttachmentWire,
  type CodeTransportCandidate,
  codeTransportRevokeResultSchema,
  codeTransportRouteAuthorizeResultSchema,
  codeTransportRouteRevokeResultSchema,
  type CodeTransportWire,
} from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";
import { serverLogger } from "../logger.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

export interface SharedCodeTransportIdentity {
  readonly authSessionId: string;
  readonly ownerId: string;
  readonly protectedKeyRevision: number;
  readonly serverId: string;
  readonly serverControlPlaneGeneration: string;
  readonly workerId: string;
  readonly workerProcessGeneration: string;
}

export interface SharedCodeTransportRootIdentity extends Omit<
  SharedCodeTransportIdentity,
  "serverControlPlaneGeneration" | "workerProcessGeneration"
> {
  readonly rootAttachmentId: string;
  readonly tunnelId: string;
  readonly serverControlPlaneGeneration?: string;
  readonly workerProcessGeneration?: string;
}

export interface SharedCodeTransportRootLeaseState {
  readonly expiresAt: string;
  readonly generation: symbol;
  readonly hardExpiresAt: string;
}

export interface SharedCodeTransportRootLease extends SharedCodeTransportRootLeaseState {
  readonly recordActivity: () => SharedCodeTransportRootLeaseState | null;
  readonly validate: () => SharedCodeTransportRootLeaseState | null;
}

export interface SharedCodeTransportRootLeaseResult {
  readonly lease: SharedCodeTransportRootLease | null;
  readonly managed: boolean;
}

export interface CreateSharedCodeSessionAttachmentInput extends SharedCodeTransportIdentity {
  readonly appearance: CodeAppearance;
  readonly attachmentId: string;
  readonly codeTabId: string;
  readonly explorerId: string | null;
  readonly projectId: string | null;
  readonly runtime: CodeRuntimeStatus;
  readonly sessionId: string;
  readonly stopSessionOnRelease?: boolean;
  readonly transport: CodeTransportCandidate;
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}

export interface SharedCodeSessionAttachmentAuthorization {
  readonly attachmentId: string;
  readonly authSessionId: string;
  readonly ownerId: string;
}

export interface SharedCodeSessionRevocationIdentity {
  readonly authSessionId: string;
  readonly expectedSessionIncarnationId: string | null;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly workerId: string;
}

export interface SharedCodeSessionOwnershipIdentity {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sessionIncarnationId: string;
  readonly workerId: string;
}

export interface SharedCodeSessionOwnershipController {
  runAcquisition<T>(
    identity: SharedCodeSessionOwnershipIdentity,
    operation: () => Promise<T>,
  ): Promise<T>;
  release(identity: SharedCodeSessionOwnershipIdentity): Promise<void>;
}

export interface SharedCodeTransportRegistryOptions {
  readonly idleTtlMs?: number;
  readonly maxLifetimeMs?: number;
  readonly maxSessionAttachments?: number;
  readonly maxTombstones?: number;
  readonly maxTransports?: number;
  readonly now?: () => number;
  readonly sessionOwnership: SharedCodeSessionOwnershipController;
}

export class SharedCodeTransportCapacityError extends Error {}

type CleanupTunnelResources = (
  ownerId: string,
  tunnelId: string,
  reason: string,
  code?: number,
) => Promise<void> | void;

type SharedCodeTransportChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: null;
  tunnelId: string;
}) => void;

interface SharedCodeTransportRoot {
  readonly authSessionId: string;
  readonly createdAt: number;
  expiresAt: number;
  readonly generation: symbol;
  readonly hardExpiresAt: number;
  readonly identityKey: string;
  readonly ownerId: string;
  readonly protectedKeyRevision: number;
  readonly serverId: string;
  readonly sessionAttachmentIds: Set<string>;
  state: "active" | "retiring";
  readonly transportId: string;
  readonly workerId: string;
  readonly serverControlPlaneGeneration: string;
  readonly workerProcessGeneration: string;
}

interface SharedCodeSessionAttachment {
  readonly attachmentId: string;
  readonly authSessionId: string;
  expiresAt: number;
  readonly explorerId: string | null;
  readonly hardExpiresAt: number;
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly routeGrant: string;
  readonly runtime: CodeRuntimeStatus;
  readonly sessionId: string;
  readonly sessionIncarnationId: string;
  readonly stopSessionOnRelease: boolean;
  readonly transport: SharedCodeTransportRoot;
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
  readonly codeTabId: string;
}

interface SharedCodeLifecycleTombstone {
  readonly authSessionId: string;
  readonly authoritative: boolean;
  readonly ownerId: string;
  readonly expiresAt: number;
}

type SharedCodeLifecycleTombstones = Map<string, SharedCodeLifecycleTombstone>;

interface SharedCodePendingRetirement {
  readonly reason: string;
  readonly root: SharedCodeTransportRoot;
  readonly routeAttachmentIds: Set<string>;
  readonly sessionStops: Map<string, SharedCodeSessionOwnershipIdentity>;
  cleanupResourcesPending: boolean;
  managedTunnelPending: boolean;
  operation: Promise<unknown> | null;
  workerTransportPending: boolean;
}

interface SharedCodePendingSessionStop {
  readonly authSessionId: string;
  readonly identity: SharedCodeSessionOwnershipIdentity;
  operation: Promise<void> | null;
}

function keyPart(value: string): string {
  return `${value.length}:${value}`;
}

export function sharedCodeTransportBaseIdentityKey(
  identity: Pick<
    SharedCodeTransportIdentity,
    | "authSessionId"
    | "ownerId"
    | "serverId"
    | "serverControlPlaneGeneration"
    | "workerId"
    | "workerProcessGeneration"
  >,
): string {
  return `${sharedCodeTransportContinuityIdentityKey(identity)}${keyPart(identity.serverControlPlaneGeneration)}${keyPart(identity.workerProcessGeneration)}`;
}

export function sharedCodeTransportContinuityIdentityKey(
  identity: Pick<
    SharedCodeTransportIdentity,
    "authSessionId" | "ownerId" | "serverId" | "workerId"
  >,
): string {
  return [
    identity.ownerId,
    identity.authSessionId,
    identity.serverId,
    identity.workerId,
  ]
    .map(keyPart)
    .join("");
}

export function sharedCodeTransportIdentityKey(
  identity: SharedCodeTransportIdentity,
): string {
  return `${sharedCodeTransportBaseIdentityKey(identity)}${identity.protectedKeyRevision}`;
}

export function canonicalCodeAuthSessionId(
  ownerId: string,
  authSessionId: string | null,
): string {
  return authSessionId ?? `local:${ownerId}`;
}

export class SharedCodeTransportRegistry {
  readonly #activeRevocations = new Map<string, number>();
  readonly #bridge: WorkerCommandBus;
  readonly #idleTtlMs: number;
  readonly #maxLifetimeMs: number;
  readonly #maxSessionAttachments: number;
  readonly #maxAuthoritativeTombstones: number;
  readonly #maxAuthoritativeTombstonesPerIdentity: number;
  readonly #maxSpeculativeTombstones: number;
  readonly #maxSpeculativeTombstonesPerIdentity: number;
  readonly #maxTransports: number;
  readonly #now: () => number;
  readonly #identityQueues = new Map<string, Promise<void>>();
  readonly #pendingAcquisitionsByRevocationKey = new Map<string, number>();
  // Transport UUIDs are one-shot for at least the maximum resource lifetime.
  // Keeping cancelled candidates fenced for that retry horizon prevents a
  // delayed request from resurrecting a transport after DELETE completed.
  readonly #cancelledTransportCandidates: SharedCodeLifecycleTombstones =
    new Map();
  readonly #pendingTransportCandidates = new Map<string, number>();
  readonly #pendingRetirements = new Map<string, SharedCodePendingRetirement>();
  readonly #pendingSessionStops = new Map<
    string,
    SharedCodePendingSessionStop
  >();
  readonly #authoritativeReservationsByIdentity = new Map<string, number>();
  readonly #tombstoneCountsByIdentity = new Map<
    string,
    { authoritative: number; speculative: number }
  >();
  readonly #relayRoots = new Map<string, SharedCodeTransportRoot>();
  readonly #failedTransportRetirements: SharedCodeLifecycleTombstones =
    new Map();
  // A retired transport UUID remains fenced for the maximum resource
  // lifetime. Cycle 3 pairs this with worker control-plane incarnation cleanup
  // to avoid ABA across a server restart.
  readonly #retiringTransportIds: SharedCodeLifecycleTombstones = new Map();
  readonly #revocationGenerations = new Map<string, number>();
  readonly #rootsByIdentity = new Map<string, SharedCodeTransportRoot>();
  readonly #rootsByTransportId = new Map<string, SharedCodeTransportRoot>();
  readonly #retiredSessionAttachmentIds: SharedCodeLifecycleTombstones =
    new Map();
  readonly #sessions = new Map<string, SharedCodeSessionAttachment>();
  readonly #sessionOwnership: SharedCodeSessionOwnershipController;
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  readonly #workerDisconnectSubscriptions = new Map<string, () => void>();
  #changed: SharedCodeTransportChange | null = null;
  #cleanupTunnelResources: CleanupTunnelResources | null = null;
  #closed = false;
  #authoritativeReservations = 0;
  #authoritativeTombstones = 0;
  #sessionReservations = 0;
  #speculativeTombstones = 0;
  #transportReservations = 0;
  #repository: ServerRepository | null = null;

  constructor(
    bridge: WorkerCommandBus,
    options: SharedCodeTransportRegistryOptions,
  ) {
    this.#bridge = bridge;
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxSessionAttachments = options.maxSessionAttachments ?? 512;
    this.#maxTransports = options.maxTransports ?? 128;
    this.#maxSpeculativeTombstonesPerIdentity =
      options.maxTombstones ??
      Math.max(1_024, (this.#maxSessionAttachments + this.#maxTransports) * 8);
    if (
      !Number.isSafeInteger(this.#maxSpeculativeTombstonesPerIdentity) ||
      this.#maxSpeculativeTombstonesPerIdentity < 1
    ) {
      throw new Error("Shared Code tombstone capacity must be positive.");
    }
    // One identity cannot consume another identity's normal lifecycle reserve.
    // The global ceiling remains an emergency bound for a distributed flood,
    // while authoritative retirements have a separate allowance and are never
    // rejected after resource removal has begun.
    this.#maxSpeculativeTombstones = Math.max(
      1_024,
      this.#maxSpeculativeTombstonesPerIdentity * 8,
    );
    this.#maxAuthoritativeTombstonesPerIdentity = Math.max(
      8,
      this.#maxSpeculativeTombstonesPerIdentity,
    );
    this.#maxAuthoritativeTombstones = Math.max(
      2_048,
      this.#maxAuthoritativeTombstonesPerIdentity * 8,
      (this.#maxSessionAttachments + this.#maxTransports * 2) * 8,
    );
    this.#now = options.now ?? Date.now;
    this.#sessionOwnership = options.sessionOwnership;
    this.#sweepTimer = setInterval(
      () => this.#pruneExpired(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  configureControlPlane(
    repository: ServerRepository,
    changed: SharedCodeTransportChange,
    cleanupTunnelResources?: CleanupTunnelResources,
  ): void {
    if (this.#rootsByTransportId.size > 0) {
      throw new Error(
        "Shared Code control plane must be configured before use.",
      );
    }
    this.#repository = repository;
    this.#changed = changed;
    this.#cleanupTunnelResources = cleanupTunnelResources ?? null;
  }

  async createSessionAttachment(
    input: CreateSharedCodeSessionAttachmentInput,
  ): Promise<CodeSharedAttachmentWire> {
    this.#assertCreateInput(input);
    const sessionCandidateKey = this.#sessionAttachmentKey(input);
    this.#assertSessionCandidateCurrent(sessionCandidateKey);
    const releaseLifecycleReservation = this.#reserveLifecycleCapacity(input);
    const transportCandidateKey = this.#transportCandidateKey(input);
    this.#beginPendingTransportCandidate(transportCandidateKey);
    const releaseRevocationObservation =
      this.#beginAcquisitionRevocationObservation(input);
    const revocationGeneration = this.#revocationGeneration(input);
    const continuityKey = sharedCodeTransportContinuityIdentityKey(input);
    return this.#serialize(this.#attachmentQueueKey(input.attachmentId), () =>
      this.#serialize(this.#identityQueueKey(continuityKey), async () => {
        this.#assertTransportCandidateCurrent(transportCandidateKey);
        this.#assertAcquisitionCurrent(input, revocationGeneration);
        await this.#assertActiveTransportGrant(input);
        this.#assertTransportCandidateCurrent(transportCandidateKey);
        this.#assertAcquisitionCurrent(input, revocationGeneration);
        const identityKey = sharedCodeTransportIdentityKey(input);
        await this.#reconcilePendingContinuityRetirements(input, identityKey);
        const existingSession = this.#sessions.get(input.attachmentId);
        if (existingSession) {
          if (!this.#sessionMatchesCreate(existingSession, input)) {
            throw new Error(
              "This shared Code session attachment identity is already in use.",
            );
          }
          const now = this.#now();
          if (
            existingSession.expiresAt > now &&
            existingSession.hardExpiresAt > now &&
            this.#recordRootActivity(existingSession.transport)
          ) {
            return this.#sessionWire(existingSession);
          }
          await this.#removeSession(
            existingSession,
            "Code session lease expired",
          );
          throw new Error("This shared Code session attachment has expired.");
        }
        const releaseSessionReservation = this.#reserveSessionCapacity();
        try {
          let root = this.#rootsByIdentity.get(identityKey);
          if (root && !this.#validateRoot(root)) {
            await this.#retireRoot(root, "Code transport lease expired");
            root = undefined;
          }
          if (!root) {
            const obsolete = [...this.#rootsByTransportId.values()].filter(
              (candidate) =>
                candidate.state === "active" &&
                sharedCodeTransportContinuityIdentityKey(candidate) ===
                  continuityKey &&
                candidate.identityKey !== identityKey,
            );
            try {
              for (const candidate of obsolete) {
                await this.#retireRoot(
                  candidate,
                  "Code security identity changed",
                  { workerTransportAlreadyGone: true },
                );
              }
              root = await this.#createRoot(input, identityKey);
            } catch (error) {
              if (root) {
                await this.#retireRoot(
                  root,
                  "Code security identity replacement failed",
                ).catch(() => undefined);
              }
              throw error;
            }
          }
          try {
            this.#assertAcquisitionCurrent(input, revocationGeneration);
          } catch (error) {
            await this.#retireRoot(
              root,
              "Code transport identity changed during creation",
            ).catch(() => undefined);
            throw error;
          }

          const now = this.#now();
          const session: SharedCodeSessionAttachment = {
            attachmentId: input.attachmentId,
            authSessionId: input.authSessionId,
            codeTabId: input.codeTabId,
            expiresAt: Math.min(root.hardExpiresAt, now + this.#idleTtlMs),
            explorerId: input.explorerId,
            hardExpiresAt: Math.min(
              root.hardExpiresAt,
              now + this.#maxLifetimeMs,
            ),
            ownerId: input.ownerId,
            projectId: input.projectId,
            routeGrant: randomBytes(32).toString("base64url"),
            runtime: input.runtime,
            sessionId: input.sessionId,
            sessionIncarnationId: input.runtime.sessionIncarnationId!,
            stopSessionOnRelease: input.stopSessionOnRelease ?? false,
            transport: root,
            worktreeId: input.worktreeId,
            worktreePath: input.worktreePath,
          };

          try {
            return await this.#sessionOwnership.runAcquisition(
              this.#sessionOwnershipIdentity(session),
              async () => {
                await this.#authorizeRoute(root, session);
                this.#assertTransportCandidateCurrent(transportCandidateKey);
                this.#assertSessionCandidateCurrent(sessionCandidateKey);
                this.#assertAcquisitionCurrent(input, revocationGeneration);
                const completedAt = this.#now();
                if (
                  session.expiresAt <= completedAt ||
                  session.hardExpiresAt <= completedAt ||
                  !this.#recordRootActivity(root)
                ) {
                  throw new Error(
                    "The shared Code route expired while it was being authorized.",
                  );
                }
                this.#sessions.set(session.attachmentId, session);
                root.sessionAttachmentIds.add(session.attachmentId);
                serverLogger.info("Shared Cantrip Code session attached", {
                  attachmentId: session.attachmentId,
                  event: "code.session-attachment.created",
                  operation: "create-session-attachment",
                  sessionId: session.sessionId,
                  status: "completed",
                  subsystem: "code",
                  transportId: root.transportId,
                  workerId: root.workerId,
                });
                return this.#sessionWire(session);
              },
            );
          } catch (error) {
            const routeRevoked = await this.#revokeRoute(
              root,
              session.attachmentId,
            ).then(
              () => true,
              () => false,
            );
            if (!routeRevoked || root.sessionAttachmentIds.size === 0) {
              await this.#retireRoot(
                root,
                routeRevoked
                  ? "Code route authorization failed"
                  : "Code route authorization rollback failed",
              ).catch(() => undefined);
            }
            throw error;
          }
        } finally {
          releaseSessionReservation();
        }
      }),
    ).finally(() => {
      this.#endPendingTransportCandidate(transportCandidateKey);
      releaseRevocationObservation();
      releaseLifecycleReservation();
    });
  }

  async renewSessionAttachment(
    authorization: SharedCodeSessionAttachmentAuthorization,
  ): Promise<CodeSharedAttachmentWire | null> {
    const current = this.#sessions.get(authorization.attachmentId);
    if (!current) return null;
    const continuityKey = sharedCodeTransportContinuityIdentityKey(
      current.transport,
    );
    return this.#serialize(
      this.#attachmentQueueKey(authorization.attachmentId),
      () =>
        this.#serialize(this.#identityQueueKey(continuityKey), async () => {
          const session = this.#sessions.get(authorization.attachmentId);
          if (!session || !this.#authorizedSession(session, authorization)) {
            return null;
          }
          const now = this.#now();
          if (
            session.expiresAt <= now ||
            session.hardExpiresAt <= now ||
            !this.#recordRootActivity(session.transport)
          ) {
            await this.#removeSession(session, "Code session lease expired");
            return null;
          }
          session.expiresAt = Math.min(
            session.hardExpiresAt,
            session.transport.hardExpiresAt,
            now + this.#idleTtlMs,
          );
          try {
            await this.#authorizeRoute(session.transport, session);
            const completedAt = this.#now();
            if (
              session.expiresAt <= completedAt ||
              session.hardExpiresAt <= completedAt ||
              !this.#recordRootActivity(session.transport)
            ) {
              throw new Error(
                "The shared Code route expired while its lease was renewing.",
              );
            }
          } catch (error) {
            await this.#retireRoot(
              session.transport,
              "Code route lease renewal failed",
            ).catch(() => undefined);
            throw error;
          }
          return this.#sessionWire(session);
        }),
    );
  }

  async revokeSessionAttachment(
    authorization: SharedCodeSessionAttachmentAuthorization,
  ): Promise<boolean> {
    const current = this.#sessions.get(authorization.attachmentId);
    this.#recordTombstone(
      this.#retiredSessionAttachmentIds,
      this.#sessionAttachmentKey(authorization),
      authorization,
      Boolean(current && this.#authorizedSession(current, authorization)),
    );
    return this.#serialize(
      this.#attachmentQueueKey(authorization.attachmentId),
      async () => {
        const current = this.#sessions.get(authorization.attachmentId);
        if (!current) return false;
        const continuityKey = sharedCodeTransportContinuityIdentityKey(
          current.transport,
        );
        return this.#serialize(
          this.#identityQueueKey(continuityKey),
          async () => {
            const session = this.#sessions.get(authorization.attachmentId);
            if (!session || !this.#authorizedSession(session, authorization)) {
              return false;
            }
            await this.#removeSession(
              session,
              "Code session attachment released",
            );
            return true;
          },
        );
      },
    );
  }

  async revokeSession(
    identity: SharedCodeSessionRevocationIdentity,
  ): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(
      (session) =>
        session.ownerId === identity.ownerId &&
        session.authSessionId === identity.authSessionId &&
        session.transport.workerId === identity.workerId &&
        session.sessionId === identity.sessionId &&
        session.sessionIncarnationId === identity.expectedSessionIncarnationId,
    );
    await Promise.all(
      sessions.map((session) =>
        this.revokeSessionAttachment({
          attachmentId: session.attachmentId,
          authSessionId: session.authSessionId,
          ownerId: session.ownerId,
        }),
      ),
    );
  }

  async revokeExplorer(ownerId: string, explorerId: string): Promise<void> {
    await this.#revokeSessionsWhere(
      (session) =>
        session.ownerId === ownerId && session.explorerId === explorerId,
      "Explorer changed",
    );
  }

  async revokeAuthSession(authSessionId: string): Promise<void> {
    const key = `auth:${keyPart(authSessionId)}`;
    this.#beginRevocation(key);
    try {
      await this.#retireRootsWhere(
        (root) => root.authSessionId === authSessionId,
        "Code authentication session revoked",
      );
    } finally {
      this.#clearSpeculativeTombstones(
        (tombstone) => tombstone.authSessionId === authSessionId,
      );
      this.#endRevocation(key);
    }
  }

  async revokeOwner(ownerId: string): Promise<void> {
    const key = `owner:${keyPart(ownerId)}`;
    this.#beginRevocation(key);
    try {
      await this.#retireRootsWhere(
        (root) => root.ownerId === ownerId,
        "Code owner revoked",
      );
    } finally {
      this.#clearSpeculativeTombstones(
        (tombstone) => tombstone.ownerId === ownerId,
      );
      this.#endRevocation(key);
    }
  }

  async revokeWorker(workerId: string): Promise<void> {
    const key = `worker:${keyPart(workerId)}`;
    this.#beginRevocation(key);
    try {
      const failures: unknown[] = [];
      for (const retirement of this.#pendingRetirements.values()) {
        if (retirement.root.workerId !== workerId) continue;
        if (retirement.operation) {
          await retirement.operation.catch(() => undefined);
        }
        retirement.routeAttachmentIds.clear();
        retirement.workerTransportPending = false;
        await this.#runRetirementCleanup(retirement).catch((error) =>
          failures.push(error),
        );
      }
      await this.#retireRootsWhere(
        (root) => root.workerId === workerId,
        "Code worker disconnected",
        { workerTransportAlreadyGone: true },
      ).catch((error) => failures.push(error));
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Could not clean up every disconnected worker Code transport.",
        );
      }
    } finally {
      this.#endRevocation(key);
    }
  }

  async revokeWorkerSecurity(
    ownerId: string,
    workerId: string,
    protectedKeyRevision?: number,
  ): Promise<void> {
    const key = `security:${keyPart(ownerId)}${keyPart(workerId)}:${protectedKeyRevision ?? "all"}`;
    this.#beginRevocation(key);
    try {
      await this.#retireRootsWhere(
        (root) =>
          root.ownerId === ownerId &&
          root.workerId === workerId &&
          (protectedKeyRevision === undefined ||
            root.protectedKeyRevision === protectedKeyRevision),
        "Code worker security identity revoked",
      );
    } finally {
      this.#endRevocation(key);
    }
  }

  async revokeTransport(
    ownerId: string,
    authSessionId: string,
    transportId: string,
  ): Promise<boolean> {
    const candidateKey = this.#transportCandidateKey({
      authSessionId,
      ownerId,
      transport: { transportId },
    });
    const pending =
      (this.#pendingTransportCandidates.get(candidateKey) ?? 0) > 0;
    const root = this.#rootsByTransportId.get(transportId);
    const authorizedRoot = Boolean(
      root && root.ownerId === ownerId && root.authSessionId === authSessionId,
    );
    this.#recordTombstone(
      this.#cancelledTransportCandidates,
      candidateKey,
      { authSessionId, ownerId },
      pending || authorizedRoot,
    );
    if (
      !root ||
      root.ownerId !== ownerId ||
      root.authSessionId !== authSessionId
    ) {
      return pending;
    }
    const continuityKey = sharedCodeTransportContinuityIdentityKey(root);
    return this.#serialize(this.#identityQueueKey(continuityKey), async () => {
      if (this.#rootsByTransportId.get(transportId) !== root) return false;
      await this.#retireRoot(root, "Shared Code transport released");
      return true;
    });
  }

  acquireRootLease(
    identity: SharedCodeTransportRootIdentity,
  ): SharedCodeTransportRootLeaseResult {
    const root = this.#rootsByTransportId.get(identity.tunnelId);
    if (!root) return { lease: null, managed: false };
    if (
      root.transportId !== identity.rootAttachmentId ||
      root.authSessionId !== identity.authSessionId ||
      root.ownerId !== identity.ownerId ||
      root.protectedKeyRevision !== identity.protectedKeyRevision ||
      root.serverId !== identity.serverId ||
      root.workerId !== identity.workerId ||
      (identity.serverControlPlaneGeneration !== undefined &&
        root.serverControlPlaneGeneration !==
          identity.serverControlPlaneGeneration) ||
      (identity.workerProcessGeneration !== undefined &&
        root.workerProcessGeneration !== identity.workerProcessGeneration)
    ) {
      return { lease: null, managed: true };
    }
    const initial = this.#recordRootActivity(root);
    if (!initial) return { lease: null, managed: true };
    return {
      lease: {
        ...initial,
        recordActivity: () => this.#recordRootActivity(root),
        validate: () => this.#validateRoot(root),
      },
      managed: true,
    };
  }

  bindRelayAttachment(
    relayAttachmentId: string,
    identity: SharedCodeTransportRootIdentity,
  ): boolean {
    const acquired = this.acquireRootLease(identity);
    const root = this.#rootsByTransportId.get(identity.tunnelId);
    if (!acquired.managed || !acquired.lease || !root) return false;
    this.#relayRoots.set(relayAttachmentId, root);
    return true;
  }

  allowRelayAttachmentActivity(
    relayAttachmentId: string,
    tunnelId: string,
  ): boolean | null {
    const root = this.#relayRoots.get(relayAttachmentId);
    if (!root) return null;
    if (root.transportId !== tunnelId || !this.#recordRootActivity(root)) {
      this.#relayRoots.delete(relayAttachmentId);
      return false;
    }
    return true;
  }

  releaseRelayAttachment(relayAttachmentId: string): void {
    this.#relayRoots.delete(relayAttachmentId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    const retirements = await Promise.allSettled([
      this.#retireRootsWhere(() => true, "Code server shutting down"),
    ]);
    await Promise.all([
      this.#retryPendingRetirements(),
      this.#retryPendingSessionStops(),
    ]);
    for (const unsubscribe of this.#workerDisconnectSubscriptions.values()) {
      unsubscribe();
    }
    this.#workerDisconnectSubscriptions.clear();
    const failures = retirements
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (
      this.#pendingRetirements.size > 0 ||
      this.#pendingSessionStops.size > 0
    ) {
      throw new AggregateError(
        failures.length > 0
          ? failures
          : [
              new Error(
                `${this.#pendingRetirements.size} shared Code transport retirement(s) and ${this.#pendingSessionStops.size} session stop(s) remain incomplete.`,
              ),
            ],
        "Shared Code transports remained partially retired at shutdown.",
      );
    }
  }

  stats(): { sessionAttachments: number; transports: number } {
    return {
      sessionAttachments: this.#sessions.size,
      transports: this.#rootsByTransportId.size,
    };
  }

  hasSessionOwnership(identity: SharedCodeSessionOwnershipIdentity): boolean {
    return [...this.#sessions.values()].some(
      (session) =>
        session.ownerId === identity.ownerId &&
        session.transport.workerId === identity.workerId &&
        session.sessionId === identity.sessionId &&
        session.sessionIncarnationId === identity.sessionIncarnationId,
    );
  }

  #revocationKeys(input: SharedCodeTransportIdentity): readonly string[] {
    return [
      `owner:${keyPart(input.ownerId)}`,
      `auth:${keyPart(input.authSessionId)}`,
      `worker:${keyPart(input.workerId)}`,
      `security:${keyPart(input.ownerId)}${keyPart(input.workerId)}:all`,
      `security:${keyPart(input.ownerId)}${keyPart(input.workerId)}:${input.protectedKeyRevision}`,
    ];
  }

  #transportCandidateKey(input: {
    authSessionId: string;
    ownerId: string;
    transport: { transportId: string };
  }): string {
    return `${keyPart(input.ownerId)}${keyPart(input.authSessionId)}${input.transport.transportId}`;
  }

  #sessionAttachmentKey(input: {
    attachmentId: string;
    authSessionId: string;
    ownerId: string;
  }): string {
    return `${keyPart(input.ownerId)}${keyPart(input.authSessionId)}${input.attachmentId}`;
  }

  #assertSessionCandidateCurrent(key: string): void {
    if (this.#hasTombstone(this.#retiredSessionAttachmentIds, key)) {
      throw new Error(
        "This shared Code session attachment identity was already retired.",
      );
    }
  }

  #recordTombstone(
    tombstones: SharedCodeLifecycleTombstones,
    key: string,
    identity: Pick<SharedCodeTransportIdentity, "authSessionId" | "ownerId">,
    authoritative = false,
  ): void {
    this.#pruneTombstones(this.#now());
    const existing = tombstones.get(key);
    if (!existing && !authoritative) {
      this.#assertSpeculativeTombstoneCapacity(identity);
    }
    if (
      existing &&
      (existing.ownerId !== identity.ownerId ||
        existing.authSessionId !== identity.authSessionId)
    ) {
      throw new Error(
        "A shared Code lifecycle fence cannot change security identity.",
      );
    }
    const next = {
      authSessionId: identity.authSessionId,
      authoritative: authoritative || existing?.authoritative === true,
      expiresAt: this.#now() + this.#maxLifetimeMs,
      ownerId: identity.ownerId,
    };
    if (!existing) {
      this.#adjustTombstoneCount(next, 1);
    } else if (!existing.authoritative && next.authoritative) {
      this.#adjustTombstoneCount(existing, -1);
      this.#adjustTombstoneCount(next, 1);
    }
    tombstones.set(key, next);
  }

  #reserveLifecycleCapacity(
    identity: Pick<SharedCodeTransportIdentity, "authSessionId" | "ownerId">,
  ): () => void {
    this.#pruneTombstones(this.#now());
    this.#assertSpeculativeTombstoneCapacity(identity);
    const identityKey = this.#tombstoneIdentityKey(identity);
    const scopedCounts = this.#tombstoneCountsByIdentity.get(identityKey);
    const reservation = 3;
    const scopedExposure =
      (scopedCounts?.authoritative ?? 0) +
      (this.#authoritativeReservationsByIdentity.get(identityKey) ?? 0) +
      [...this.#sessions.values()].filter(
        (session) =>
          session.ownerId === identity.ownerId &&
          session.authSessionId === identity.authSessionId,
      ).length +
      [...this.#rootsByTransportId.values()].filter(
        (root) =>
          root.ownerId === identity.ownerId &&
          root.authSessionId === identity.authSessionId,
      ).length *
        2 +
      [...this.#pendingRetirements.values()].filter(
        (retirement) =>
          retirement.root.ownerId === identity.ownerId &&
          retirement.root.authSessionId === identity.authSessionId,
      ).length +
      [...this.#pendingSessionStops.values()].filter(
        (pending) =>
          pending.identity.ownerId === identity.ownerId &&
          pending.authSessionId === identity.authSessionId,
      ).length;
    if (
      scopedExposure + reservation >
      this.#maxAuthoritativeTombstonesPerIdentity
    ) {
      throw new SharedCodeTransportCapacityError(
        "This identity has reached its shared Code authoritative lifecycle fence limit.",
      );
    }
    const globalExposure =
      this.#authoritativeTombstones +
      this.#authoritativeReservations +
      this.#sessions.size +
      this.#rootsByTransportId.size * 2 +
      this.#pendingRetirements.size +
      this.#pendingSessionStops.size;
    if (globalExposure + reservation > this.#maxAuthoritativeTombstones) {
      throw new SharedCodeTransportCapacityError(
        "This server has reached its shared Code authoritative lifecycle fence limit.",
      );
    }
    this.#authoritativeReservations += reservation;
    this.#authoritativeReservationsByIdentity.set(
      identityKey,
      (this.#authoritativeReservationsByIdentity.get(identityKey) ?? 0) +
        reservation,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#authoritativeReservations -= reservation;
      const remaining =
        (this.#authoritativeReservationsByIdentity.get(identityKey) ?? 0) -
        reservation;
      if (remaining <= 0) {
        this.#authoritativeReservationsByIdentity.delete(identityKey);
      } else {
        this.#authoritativeReservationsByIdentity.set(identityKey, remaining);
      }
    };
  }

  #assertSpeculativeTombstoneCapacity(
    identity: Pick<SharedCodeTransportIdentity, "authSessionId" | "ownerId">,
  ): void {
    const scopedCount =
      this.#tombstoneCountsByIdentity.get(this.#tombstoneIdentityKey(identity))
        ?.speculative ?? 0;
    if (scopedCount >= this.#maxSpeculativeTombstonesPerIdentity) {
      throw new SharedCodeTransportCapacityError(
        "This identity has reached its shared Code lifecycle fence limit.",
      );
    }
    if (this.#speculativeTombstones >= this.#maxSpeculativeTombstones) {
      throw new SharedCodeTransportCapacityError(
        "This server has reached its shared Code speculative lifecycle fence limit.",
      );
    }
  }

  #tombstoneIdentityKey(
    identity: Pick<SharedCodeTransportIdentity, "authSessionId" | "ownerId">,
  ): string {
    return `${keyPart(identity.ownerId)}${keyPart(identity.authSessionId)}`;
  }

  #adjustTombstoneCount(
    tombstone: SharedCodeLifecycleTombstone,
    delta: 1 | -1,
  ): void {
    const identityKey = this.#tombstoneIdentityKey(tombstone);
    const counts = this.#tombstoneCountsByIdentity.get(identityKey) ?? {
      authoritative: 0,
      speculative: 0,
    };
    if (tombstone.authoritative) {
      this.#authoritativeTombstones += delta;
      counts.authoritative += delta;
    } else {
      this.#speculativeTombstones += delta;
      counts.speculative += delta;
    }
    if (counts.authoritative === 0 && counts.speculative === 0) {
      this.#tombstoneCountsByIdentity.delete(identityKey);
    } else {
      this.#tombstoneCountsByIdentity.set(identityKey, counts);
    }
  }

  #deleteTombstone(
    tombstones: SharedCodeLifecycleTombstones,
    key: string,
  ): void {
    const tombstone = tombstones.get(key);
    if (!tombstone) return;
    tombstones.delete(key);
    this.#adjustTombstoneCount(tombstone, -1);
  }

  #hasTombstone(
    tombstones: SharedCodeLifecycleTombstones,
    key: string,
  ): boolean {
    const tombstone = tombstones.get(key);
    if (!tombstone) return false;
    if (tombstone.expiresAt > this.#now()) return true;
    this.#deleteTombstone(tombstones, key);
    return false;
  }

  #clearSpeculativeTombstones(
    predicate: (tombstone: SharedCodeLifecycleTombstone) => boolean,
  ): void {
    for (const tombstones of this.#tombstoneMaps()) {
      for (const [key, tombstone] of tombstones) {
        if (!tombstone.authoritative && predicate(tombstone)) {
          this.#deleteTombstone(tombstones, key);
        }
      }
    }
  }

  #tombstoneMaps(): SharedCodeLifecycleTombstones[] {
    return [
      this.#cancelledTransportCandidates,
      this.#failedTransportRetirements,
      this.#retiredSessionAttachmentIds,
      this.#retiringTransportIds,
    ];
  }

  #pruneTombstones(now: number): void {
    for (const tombstones of this.#tombstoneMaps()) {
      for (const [key, tombstone] of tombstones) {
        if (tombstone.expiresAt <= now) {
          this.#deleteTombstone(tombstones, key);
        }
      }
    }
  }

  #beginPendingTransportCandidate(key: string): void {
    this.#pendingTransportCandidates.set(
      key,
      (this.#pendingTransportCandidates.get(key) ?? 0) + 1,
    );
  }

  #endPendingTransportCandidate(key: string): void {
    const count = this.#pendingTransportCandidates.get(key) ?? 0;
    if (count <= 1) {
      this.#pendingTransportCandidates.delete(key);
    } else {
      this.#pendingTransportCandidates.set(key, count - 1);
    }
  }

  #assertTransportCandidateCurrent(key: string): void {
    if (this.#hasTombstone(this.#cancelledTransportCandidates, key)) {
      throw new Error(
        "The shared Cantrip Code transport was revoked while attaching.",
      );
    }
  }

  #revocationGeneration(input: SharedCodeTransportIdentity): string {
    return this.#revocationKeys(input)
      .map((key) => this.#revocationGenerations.get(key) ?? 0)
      .join(":");
  }

  #beginAcquisitionRevocationObservation(
    input: SharedCodeTransportIdentity,
  ): () => void {
    const keys = this.#revocationKeys(input);
    for (const key of keys) {
      this.#pendingAcquisitionsByRevocationKey.set(
        key,
        (this.#pendingAcquisitionsByRevocationKey.get(key) ?? 0) + 1,
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const remaining =
          (this.#pendingAcquisitionsByRevocationKey.get(key) ?? 0) - 1;
        if (remaining <= 0) {
          this.#pendingAcquisitionsByRevocationKey.delete(key);
          this.#discardUnusedRevocationGeneration(key);
        } else {
          this.#pendingAcquisitionsByRevocationKey.set(key, remaining);
        }
      }
    };
  }

  #beginRevocation(key: string): void {
    this.#revocationGenerations.set(
      key,
      (this.#revocationGenerations.get(key) ?? 0) + 1,
    );
    this.#activeRevocations.set(
      key,
      (this.#activeRevocations.get(key) ?? 0) + 1,
    );
  }

  #endRevocation(key: string): void {
    const count = this.#activeRevocations.get(key) ?? 0;
    if (count <= 1) {
      this.#activeRevocations.delete(key);
    } else {
      this.#activeRevocations.set(key, count - 1);
    }
    this.#discardUnusedRevocationGeneration(key);
  }

  #discardUnusedRevocationGeneration(key: string): void {
    if (
      !this.#activeRevocations.has(key) &&
      !this.#pendingAcquisitionsByRevocationKey.has(key)
    ) {
      this.#revocationGenerations.delete(key);
    }
  }

  #assertAcquisitionCurrent(
    input: CreateSharedCodeSessionAttachmentInput,
    expectedRevocationGeneration: string,
  ): void {
    this.#assertOpen();
    if (
      this.#revocationGeneration(input) !== expectedRevocationGeneration ||
      this.#revocationKeys(input).some(
        (key) => (this.#activeRevocations.get(key) ?? 0) > 0,
      ) ||
      !this.#bridge.isConnected(input.workerId)
    ) {
      throw new Error(
        "The shared Cantrip Code transport identity changed while attaching.",
      );
    }
  }

  #assertCreateInput(input: CreateSharedCodeSessionAttachmentInput): void {
    this.#assertOpen();
    if (input.runtime.sessionId !== input.sessionId) {
      throw new Error(
        "The live Cantrip Code runtime does not match this session attachment.",
      );
    }
    if (!input.runtime.sessionIncarnationId) {
      throw new Error(
        "A shared Code session attachment requires an exact runtime incarnation.",
      );
    }
    if (
      input.transport.protectedRecord.protectedContent.keyRevision !==
      input.protectedKeyRevision
    ) {
      throw new Error(
        "The shared Code transport key revision does not match its protected record.",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("The shared Cantrip Code transport registry is closed.");
    }
    if (!this.#repository) {
      throw new Error("Shared Cantrip Code control plane is unavailable.");
    }
  }

  #reserveSessionCapacity(): () => void {
    if (
      this.#sessions.size + this.#sessionReservations >=
      this.#maxSessionAttachments
    ) {
      throw new Error(
        "This server has reached its shared Code session attachment limit.",
      );
    }
    this.#sessionReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#sessionReservations -= 1;
    };
  }

  #reserveTransportCapacity(): () => void {
    if (
      this.#rootsByTransportId.size + this.#transportReservations >=
      this.#maxTransports
    ) {
      throw new Error(
        "This server has reached its shared Code transport limit.",
      );
    }
    this.#transportReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#transportReservations -= 1;
    };
  }

  async #createRoot(
    input: CreateSharedCodeSessionAttachmentInput,
    identityKey: string,
  ): Promise<SharedCodeTransportRoot> {
    if (
      this.#pendingRetirements.has(input.transport.transportId) ||
      this.#hasTombstone(
        this.#retiringTransportIds,
        input.transport.transportId,
      ) ||
      this.#hasTombstone(
        this.#failedTransportRetirements,
        input.transport.transportId,
      )
    ) {
      throw new Error(
        "This shared Code transport identity was already retired.",
      );
    }
    const releaseTransportReservation = this.#reserveTransportCapacity();
    try {
      if (!this.#bridge.isConnected(input.workerId)) {
        throw new Error("Cantrip Code worker is offline.");
      }
      const tunnel = await this.#repository!.registerManagedTunnel(
        input.ownerId,
        {
          name: "Cantrip Code",
          description: "Shared protected editor transport.",
          projectId: null,
          origin: "code",
          management: "managed-ephemeral",
          protocolHint: "http-websocket",
          source: { kind: "desktop-loopback" },
          destination: {
            kind: "worker-adapter",
            workerId: input.workerId,
            adapter: "code",
            resourceId: input.transport.transportId,
          },
          managedBy: { kind: "code", id: input.transport.transportId },
          desiredState: "started",
          status: "starting",
        },
        {
          id: input.transport.transportId,
          protectedRecord: input.transport.protectedRecord,
        },
      );
      if (!tunnel || tunnel.id !== input.transport.transportId) {
        throw new Error(
          "Could not register the shared protected Code transport.",
        );
      }
      const now = this.#now();
      const root: SharedCodeTransportRoot = {
        authSessionId: input.authSessionId,
        createdAt: now,
        expiresAt: Math.min(now + this.#idleTtlMs, now + this.#maxLifetimeMs),
        generation: Symbol(input.transport.transportId),
        hardExpiresAt: now + this.#maxLifetimeMs,
        identityKey,
        ownerId: input.ownerId,
        protectedKeyRevision: input.protectedKeyRevision,
        serverId: input.serverId,
        sessionAttachmentIds: new Set(),
        state: "active",
        transportId: tunnel.id,
        workerId: input.workerId,
        serverControlPlaneGeneration: input.serverControlPlaneGeneration,
        workerProcessGeneration: input.workerProcessGeneration,
      };
      this.#rootsByIdentity.set(identityKey, root);
      this.#rootsByTransportId.set(root.transportId, root);
      this.#trackWorkerDisconnect(root.workerId);
      this.#changed?.({
        attachmentId: root.transportId,
        ownerId: root.ownerId,
        projectId: null,
        tunnelId: root.transportId,
      });
      serverLogger.info("Shared Cantrip Code transport created", {
        event: "code.transport.created",
        operation: "create-transport",
        status: "completed",
        subsystem: "code",
        transportId: root.transportId,
        workerId: root.workerId,
      });
      return root;
    } finally {
      releaseTransportReservation();
    }
  }

  async #authorizeRoute(
    root: SharedCodeTransportRoot,
    session: SharedCodeSessionAttachment,
  ): Promise<void> {
    const expiresAt = new Date(session.expiresAt).toISOString();
    const result = codeTransportRouteAuthorizeResultSchema.parse(
      await this.#bridge.request(
        root.workerId,
        {
          type: "code.transport.route.authorize",
          ownerId: root.ownerId,
          authSessionId: root.authSessionId,
          serverId: root.serverId,
          serverControlPlaneGeneration: root.serverControlPlaneGeneration,
          protectedKeyRevision: root.protectedKeyRevision,
          workerProcessGeneration: root.workerProcessGeneration,
          transportId: root.transportId,
          attachmentId: session.attachmentId,
          sessionId: session.sessionId,
          expectedSessionIncarnationId: session.sessionIncarnationId,
          routeGrant: session.routeGrant,
          expiresAt,
        },
        { ownerId: root.ownerId, timeoutMs: 5_000 },
      ),
    );
    if (
      result.transportId !== root.transportId ||
      result.ownerId !== root.ownerId ||
      result.authSessionId !== root.authSessionId ||
      result.serverId !== root.serverId ||
      result.serverControlPlaneGeneration !==
        root.serverControlPlaneGeneration ||
      result.protectedKeyRevision !== root.protectedKeyRevision ||
      result.workerProcessGeneration !== root.workerProcessGeneration ||
      result.attachmentId !== session.attachmentId ||
      result.sessionId !== session.sessionId ||
      result.sessionIncarnationId !== session.sessionIncarnationId ||
      result.expiresAt !== expiresAt
    ) {
      throw new Error(
        "The worker acknowledged a different shared Code route authorization.",
      );
    }
  }

  async #revokeRoute(
    root: SharedCodeTransportRoot,
    attachmentId: string,
  ): Promise<void> {
    const result = codeTransportRouteRevokeResultSchema.parse(
      await this.#bridge.request(
        root.workerId,
        {
          type: "code.transport.route.revoke",
          ownerId: root.ownerId,
          authSessionId: root.authSessionId,
          serverId: root.serverId,
          serverControlPlaneGeneration: root.serverControlPlaneGeneration,
          protectedKeyRevision: root.protectedKeyRevision,
          workerProcessGeneration: root.workerProcessGeneration,
          transportId: root.transportId,
          attachmentId,
        },
        { ownerId: root.ownerId, timeoutMs: 5_000 },
      ),
    );
    if (
      result.transportId !== root.transportId ||
      result.ownerId !== root.ownerId ||
      result.authSessionId !== root.authSessionId ||
      result.serverId !== root.serverId ||
      result.serverControlPlaneGeneration !==
        root.serverControlPlaneGeneration ||
      result.protectedKeyRevision !== root.protectedKeyRevision ||
      result.workerProcessGeneration !== root.workerProcessGeneration ||
      result.attachmentId !== attachmentId
    ) {
      throw new Error(
        "The worker acknowledged a different shared Code route revocation.",
      );
    }
  }

  async #revokeWorkerTransport(root: SharedCodeTransportRoot): Promise<void> {
    const result = codeTransportRevokeResultSchema.parse(
      await this.#bridge.request(
        root.workerId,
        {
          type: "code.transport.revoke",
          ownerId: root.ownerId,
          authSessionId: root.authSessionId,
          serverId: root.serverId,
          serverControlPlaneGeneration: root.serverControlPlaneGeneration,
          protectedKeyRevision: root.protectedKeyRevision,
          workerProcessGeneration: root.workerProcessGeneration,
          transportId: root.transportId,
        },
        { ownerId: root.ownerId, timeoutMs: 5_000 },
      ),
    );
    if (
      result.transportId !== root.transportId ||
      result.ownerId !== root.ownerId ||
      result.authSessionId !== root.authSessionId ||
      result.serverId !== root.serverId ||
      result.serverControlPlaneGeneration !==
        root.serverControlPlaneGeneration ||
      result.protectedKeyRevision !== root.protectedKeyRevision ||
      result.workerProcessGeneration !== root.workerProcessGeneration
    ) {
      throw new Error(
        "The worker acknowledged a different shared Code transport revocation.",
      );
    }
  }

  async #removeSession(
    session: SharedCodeSessionAttachment,
    reason: string,
  ): Promise<void> {
    if (this.#sessions.get(session.attachmentId) !== session) return;
    this.#recordTombstone(
      this.#retiredSessionAttachmentIds,
      this.#sessionAttachmentKey(session),
      session,
      true,
    );
    const root = session.transport;
    try {
      await this.#revokeRoute(root, session.attachmentId);
    } catch (error) {
      await this.#retireRoot(root, "Code route revocation failed");
      throw error;
    }
    this.#sessions.delete(session.attachmentId);
    root.sessionAttachmentIds.delete(session.attachmentId);
    const failures: unknown[] = [];
    if (session.stopSessionOnRelease) {
      try {
        await this.#sessionOwnership.release(
          this.#sessionOwnershipIdentity(session),
        );
      } catch (error) {
        this.#retainPendingSessionStop(session);
        failures.push(error);
      }
    }
    serverLogger.info("Shared Cantrip Code session detached", {
      attachmentId: session.attachmentId,
      event: "code.session-attachment.revoked",
      operation: "revoke-session-attachment",
      reasonCode: "session-attachment-released",
      sessionId: session.sessionId,
      status: "completed",
      subsystem: "code",
      transportId: root.transportId,
      workerId: root.workerId,
    });
    if (root.sessionAttachmentIds.size === 0) {
      try {
        await this.#retireRoot(root, reason);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Could not clean up every shared Cantrip Code session resource.",
      );
    }
  }

  #retainPendingSessionStop(session: SharedCodeSessionAttachment): void {
    const identity = this.#sessionOwnershipIdentity(session);
    const key = this.#pendingSessionStopKey(identity);
    if (this.#pendingSessionStops.has(key)) return;
    this.#pendingSessionStops.set(key, {
      authSessionId: session.authSessionId,
      identity,
      operation: null,
    });
    serverLogger.warn("Shared Cantrip Code session stop is incomplete", {
      event: "code.session.stop-pending",
      operation: "stop-session",
      reasonCode: "session-stop-failed",
      sessionId: session.sessionId,
      status: "failed",
      subsystem: "code",
      workerId: session.transport.workerId,
    });
  }

  async #retireRoot(
    root: SharedCodeTransportRoot,
    reason: string,
    options: { workerTransportAlreadyGone?: boolean } = {},
  ): Promise<void> {
    if (root.state === "retiring") {
      const pending = this.#pendingRetirements.get(root.transportId);
      if (pending) await this.#runRetirementCleanup(pending);
      return;
    }
    if (this.#rootsByTransportId.get(root.transportId) !== root) return;
    root.state = "retiring";
    this.#recordTombstone(
      this.#retiringTransportIds,
      root.transportId,
      root,
      true,
    );
    const sessions = [...root.sessionAttachmentIds]
      .map((attachmentId) => this.#sessions.get(attachmentId))
      .filter((session): session is SharedCodeSessionAttachment =>
        Boolean(session),
      );
    for (const session of sessions) {
      this.#recordTombstone(
        this.#retiredSessionAttachmentIds,
        this.#sessionAttachmentKey(session),
        session,
        true,
      );
      this.#sessions.delete(session.attachmentId);
    }
    root.sessionAttachmentIds.clear();
    this.#rootsByTransportId.delete(root.transportId);
    if (this.#rootsByIdentity.get(root.identityKey) === root) {
      this.#rootsByIdentity.delete(root.identityKey);
    }
    for (const [relayAttachmentId, relayRoot] of this.#relayRoots) {
      if (relayRoot === root) this.#relayRoots.delete(relayAttachmentId);
    }

    const sessionStops = new Map<string, SharedCodeSessionOwnershipIdentity>();
    for (const session of sessions) {
      if (!session.stopSessionOnRelease || !session.sessionIncarnationId) {
        continue;
      }
      sessionStops.set(
        this.#sessionOwnershipKey(session),
        this.#sessionOwnershipIdentity(session),
      );
    }
    const retirement: SharedCodePendingRetirement = {
      cleanupResourcesPending: Boolean(this.#cleanupTunnelResources),
      managedTunnelPending: true,
      operation: null,
      reason,
      root,
      routeAttachmentIds: new Set(
        options.workerTransportAlreadyGone
          ? []
          : sessions.map((session) => session.attachmentId),
      ),
      sessionStops,
      workerTransportPending: !options.workerTransportAlreadyGone,
    };
    this.#pendingRetirements.set(root.transportId, retirement);
    this.#changed?.({
      attachmentId: root.transportId,
      ownerId: root.ownerId,
      projectId: null,
      tunnelId: root.transportId,
    });
    this.#stopTrackingWorkerIfUnused(root.workerId);
    await this.#runRetirementCleanup(retirement);
  }

  async #runRetirementCleanup(
    retirement: SharedCodePendingRetirement,
  ): Promise<void> {
    if (retirement.operation) {
      await retirement.operation;
      return;
    }
    const operation = this.#performRetirementCleanup(retirement);
    retirement.operation = operation;
    try {
      await operation;
    } finally {
      if (retirement.operation === operation) retirement.operation = null;
    }
  }

  async #performRetirementCleanup(
    retirement: SharedCodePendingRetirement,
  ): Promise<void> {
    const tasks: Array<{
      readonly complete: () => void;
      readonly component: string;
      readonly promise: Promise<unknown>;
    }> = [];
    for (const attachmentId of retirement.routeAttachmentIds) {
      tasks.push({
        complete: () => retirement.routeAttachmentIds.delete(attachmentId),
        component: "worker-route",
        promise: this.#revokeRoute(retirement.root, attachmentId),
      });
    }
    for (const [ownershipKey, identity] of retirement.sessionStops) {
      tasks.push({
        complete: () => retirement.sessionStops.delete(ownershipKey),
        component: "code-session",
        promise: Promise.resolve().then(() =>
          this.#sessionOwnership.release(identity),
        ),
      });
    }
    if (retirement.workerTransportPending) {
      tasks.push({
        complete: () => {
          retirement.workerTransportPending = false;
          // A successful whole-transport revocation also removes every route.
          retirement.routeAttachmentIds.clear();
        },
        component: "worker-transport",
        promise: this.#revokeWorkerTransport(retirement.root),
      });
    }
    if (retirement.managedTunnelPending) {
      tasks.push({
        complete: () => {
          retirement.managedTunnelPending = false;
        },
        component: "managed-tunnel",
        promise: Promise.resolve().then(() =>
          this.#repository!.removeManagedTunnel(retirement.root.ownerId, {
            kind: "code",
            id: retirement.root.transportId,
          }),
        ),
      });
    }
    if (retirement.cleanupResourcesPending) {
      tasks.push({
        complete: () => {
          retirement.cleanupResourcesPending = false;
        },
        component: "tunnel-resources",
        promise: Promise.resolve().then(() =>
          this.#cleanupTunnelResources?.(
            retirement.root.ownerId,
            retirement.root.transportId,
            retirement.reason,
            1008,
          ),
        ),
      });
    }

    const results = await Promise.allSettled(tasks.map((task) => task.promise));
    const failures: Array<{ component: string; reason: unknown }> = [];
    results.forEach((result, index) => {
      const task = tasks[index]!;
      if (result.status === "fulfilled") {
        task.complete();
      } else {
        failures.push({ component: task.component, reason: result.reason });
        if (task.component === "worker-transport") {
          this.#recordTombstone(
            this.#failedTransportRetirements,
            retirement.root.transportId,
            retirement.root,
            true,
          );
        }
      }
    });
    const effectiveFailures = failures.filter(
      (failure) =>
        failure.component !== "worker-route" ||
        retirement.workerTransportPending,
    );

    if (effectiveFailures.length === 0) {
      if (
        this.#pendingRetirements.get(retirement.root.transportId) === retirement
      ) {
        this.#pendingRetirements.delete(retirement.root.transportId);
      }
      this.#stopTrackingWorkerIfUnused(retirement.root.workerId);
      serverLogger.info("Shared Cantrip Code transport revoked", {
        event: "code.transport.revoked",
        operation: "revoke-transport",
        reasonCode: "transport-released",
        status: "completed",
        subsystem: "code",
        transportId: retirement.root.transportId,
        workerId: retirement.root.workerId,
      });
      return;
    }

    serverLogger.warn("Shared Cantrip Code transport cleanup is incomplete", {
      counts: { failedComponents: effectiveFailures.length },
      event: "code.transport.retirement-partial",
      operation: "revoke-transport",
      reasonCode: "transport-cleanup-failed",
      status: "failed",
      subsystem: "code",
      transportId: retirement.root.transportId,
      workerId: retirement.root.workerId,
      failedComponents: [
        ...new Set(effectiveFailures.map((failure) => failure.component)),
      ].sort(),
    });
    throw new AggregateError(
      effectiveFailures.map((failure) => failure.reason),
      "Could not clean up every shared Cantrip Code transport resource.",
    );
  }

  async #retryPendingRetirements(): Promise<void> {
    await Promise.allSettled(
      [...this.#pendingRetirements.values()].map((retirement) =>
        this.#runRetirementCleanup(retirement),
      ),
    );
  }

  async #reconcilePendingContinuityRetirements(
    input: CreateSharedCodeSessionAttachmentInput,
    identityKey: string,
  ): Promise<void> {
    const continuityKey = sharedCodeTransportContinuityIdentityKey(input);
    for (const retirement of this.#pendingRetirements.values()) {
      if (
        sharedCodeTransportContinuityIdentityKey(retirement.root) !==
        continuityKey
      ) {
        continue;
      }
      if (retirement.operation) {
        await retirement.operation.catch(() => undefined);
      }
      if (retirement.root.identityKey !== identityKey) {
        retirement.routeAttachmentIds.clear();
        retirement.workerTransportPending = false;
      }
      await this.#runRetirementCleanup(retirement);
    }
  }

  async #runPendingSessionStop(
    key: string,
    pending: SharedCodePendingSessionStop,
  ): Promise<void> {
    if (pending.operation) {
      await pending.operation;
      return;
    }
    const operation = Promise.resolve()
      .then(() => this.#sessionOwnership.release(pending.identity))
      .then(() => {
        if (this.#pendingSessionStops.get(key) === pending) {
          this.#pendingSessionStops.delete(key);
        }
        serverLogger.info("Shared Cantrip Code session stop completed", {
          event: "code.session.stop-retried",
          operation: "stop-session",
          sessionId: pending.identity.sessionId,
          status: "completed",
          subsystem: "code",
          workerId: pending.identity.workerId,
        });
      });
    pending.operation = operation;
    try {
      await operation;
    } finally {
      if (pending.operation === operation) pending.operation = null;
    }
  }

  async #retryPendingSessionStops(): Promise<void> {
    await Promise.allSettled(
      [...this.#pendingSessionStops.entries()].map(([key, pending]) =>
        this.#runPendingSessionStop(key, pending),
      ),
    );
  }

  async #revokeSessionsWhere(
    predicate: (session: SharedCodeSessionAttachment) => boolean,
    reason: string,
  ): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(predicate);
    const results = await Promise.allSettled(
      sessions.map((session) =>
        this.revokeSessionAttachment({
          attachmentId: session.attachmentId,
          authSessionId: session.authSessionId,
          ownerId: session.ownerId,
        }),
      ),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, reason);
  }

  async #retireRootsWhere(
    predicate: (root: SharedCodeTransportRoot) => boolean,
    reason: string,
    options: { workerTransportAlreadyGone?: boolean } = {},
  ): Promise<void> {
    const roots = [...this.#rootsByTransportId.values()].filter(predicate);
    const results = await Promise.allSettled(
      roots.map((root) => {
        const continuityKey = sharedCodeTransportContinuityIdentityKey(root);
        return this.#serialize(this.#identityQueueKey(continuityKey), () =>
          this.#retireRoot(root, reason, options),
        );
      }),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, reason);
  }

  #authorizedSession(
    session: SharedCodeSessionAttachment,
    authorization: SharedCodeSessionAttachmentAuthorization,
  ): boolean {
    return (
      session.ownerId === authorization.ownerId &&
      session.authSessionId === authorization.authSessionId
    );
  }

  async #assertActiveTransportGrant(
    input: CreateSharedCodeSessionAttachmentInput,
  ): Promise<void> {
    const principal =
      await this.#repository!.encryptionRegistry.findActiveWorkerPrincipal(
        input.ownerId,
        input.workerId,
      );
    if (!principal) {
      throw new Error(
        "The worker has no active encryption principal for this Code transport.",
      );
    }
    const grants = await this.#repository!.encryptionRegistry.listActiveGrants(
      input.ownerId,
      principal.id,
    );
    if (
      grants.status !== "ok" ||
      Math.max(
        ...grants.grants
          .filter((grant) => grant.component === "tunnel-content")
          .map((grant) => grant.keyRevision),
        0,
      ) !== input.protectedKeyRevision
    ) {
      throw new Error(
        "The latest active worker tunnel-content encryption grant is unavailable or revoked.",
      );
    }
  }

  #sessionMatchesCreate(
    session: SharedCodeSessionAttachment,
    input: CreateSharedCodeSessionAttachmentInput,
  ): boolean {
    return (
      session.ownerId === input.ownerId &&
      session.authSessionId === input.authSessionId &&
      session.transport.identityKey === sharedCodeTransportIdentityKey(input) &&
      session.sessionId === input.sessionId &&
      session.sessionIncarnationId === input.runtime.sessionIncarnationId &&
      session.explorerId === input.explorerId &&
      session.projectId === input.projectId &&
      session.worktreeId === input.worktreeId &&
      session.worktreePath === input.worktreePath
    );
  }

  #sessionOwnershipKey(session: SharedCodeSessionAttachment): string {
    return this.#pendingSessionStopKey(this.#sessionOwnershipIdentity(session));
  }

  #pendingSessionStopKey(identity: SharedCodeSessionOwnershipIdentity): string {
    return `${keyPart(identity.ownerId)}${keyPart(identity.workerId)}${keyPart(identity.sessionId)}${identity.sessionIncarnationId}`;
  }

  #sessionOwnershipIdentity(
    session: SharedCodeSessionAttachment,
  ): SharedCodeSessionOwnershipIdentity {
    return {
      ownerId: session.ownerId,
      sessionId: session.sessionId,
      sessionIncarnationId: session.sessionIncarnationId,
      workerId: session.transport.workerId,
    };
  }

  #recordRootActivity(
    root: SharedCodeTransportRoot,
  ): SharedCodeTransportRootLeaseState | null {
    if (!this.#validateRoot(root)) return null;
    root.expiresAt = Math.min(
      root.hardExpiresAt,
      this.#now() + this.#idleTtlMs,
    );
    return this.#validateRoot(root);
  }

  #validateRoot(
    root: SharedCodeTransportRoot,
  ): SharedCodeTransportRootLeaseState | null {
    const now = this.#now();
    if (
      root.state !== "active" ||
      this.#rootsByTransportId.get(root.transportId) !== root ||
      root.expiresAt <= now ||
      root.hardExpiresAt <= now
    ) {
      return null;
    }
    return {
      expiresAt: new Date(root.expiresAt).toISOString(),
      generation: root.generation,
      hardExpiresAt: new Date(root.hardExpiresAt).toISOString(),
    };
  }

  #pruneExpired(): void {
    const now = this.#now();
    this.#pruneTombstones(now);
    void this.#retryPendingRetirements();
    void this.#retryPendingSessionStops();
    for (const session of [...this.#sessions.values()]) {
      if (session.expiresAt > now && session.hardExpiresAt > now) continue;
      const continuityKey = sharedCodeTransportContinuityIdentityKey(
        session.transport,
      );
      void this.#serialize(this.#identityQueueKey(continuityKey), async () => {
        const current = this.#sessions.get(session.attachmentId);
        const currentNow = this.#now();
        if (
          current !== session ||
          (session.expiresAt > currentNow && session.hardExpiresAt > currentNow)
        ) {
          return;
        }
        await this.#removeSession(session, "Code session lease expired");
      }).catch(() => undefined);
    }
    for (const root of [...this.#rootsByTransportId.values()]) {
      if (root.expiresAt > now && root.hardExpiresAt > now) continue;
      const continuityKey = sharedCodeTransportContinuityIdentityKey(root);
      void this.#serialize(this.#identityQueueKey(continuityKey), async () => {
        const currentNow = this.#now();
        if (
          this.#rootsByTransportId.get(root.transportId) !== root ||
          (root.expiresAt > currentNow && root.hardExpiresAt > currentNow)
        ) {
          return;
        }
        await this.#retireRoot(root, "Code transport lease expired");
      }).catch(() => undefined);
    }
  }

  #sessionWire(session: SharedCodeSessionAttachment): CodeSharedAttachmentWire {
    return {
      formatVersion: 2,
      transport: this.#transportWire(session.transport),
      session: {
        formatVersion: 2,
        attachmentId: session.attachmentId,
        transportId: session.transport.transportId,
        sessionId: session.sessionId,
        routeGrant: session.routeGrant,
        expiresAt: new Date(session.expiresAt).toISOString(),
        runtime: session.runtime,
      },
    };
  }

  #transportWire(root: SharedCodeTransportRoot): CodeTransportWire {
    return {
      formatVersion: 2,
      transportId: root.transportId,
      tunnelId: root.transportId,
      workerId: root.workerId,
      expiresAt: new Date(root.expiresAt).toISOString(),
    };
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#identityQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#identityQueues.set(key, tail);
    return current.finally(() => {
      if (this.#identityQueues.get(key) === tail) {
        this.#identityQueues.delete(key);
      }
    });
  }

  #attachmentQueueKey(attachmentId: string): string {
    return `attachment:${keyPart(attachmentId)}`;
  }

  #identityQueueKey(baseIdentityKey: string): string {
    return `identity:${baseIdentityKey}`;
  }

  #trackWorkerDisconnect(workerId: string): void {
    if (this.#workerDisconnectSubscriptions.has(workerId)) return;
    const bridge = this.#bridge as WorkerCommandBus & {
      subscribeWorkerOffline?: WorkerCommandBus["subscribeWorkerDisconnect"];
    };
    const subscribe =
      bridge.subscribeWorkerOffline ?? bridge.subscribeWorkerDisconnect;
    const unsubscribe = subscribe.call(bridge, workerId, () => {
      void this.revokeWorker(workerId).catch(() => undefined);
    });
    this.#workerDisconnectSubscriptions.set(workerId, unsubscribe);
  }

  #stopTrackingWorkerIfUnused(workerId: string): void {
    if (
      [...this.#rootsByTransportId.values()].some(
        (root) => root.workerId === workerId,
      ) ||
      [...this.#pendingRetirements.values()].some(
        (retirement) => retirement.root.workerId === workerId,
      )
    ) {
      return;
    }
    this.#workerDisconnectSubscriptions.get(workerId)?.();
    this.#workerDisconnectSubscriptions.delete(workerId);
  }
}
