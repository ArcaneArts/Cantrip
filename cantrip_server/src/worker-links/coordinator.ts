import { createHash, randomBytes, randomUUID } from "node:crypto";

import { normalizeLogError, type ServiceLogger } from "@cantrip/logging";
import type { WorkerNotification } from "@cantrip/protocol";
import {
  WORKER_LINK_MAX_CHANNELS_PER_GRANT,
  WORKER_LINK_MAX_GRANTS_PER_SESSION,
  WORKER_LINK_MAX_PEER_SIGNALING_BYTES,
  WORKER_LINK_MAX_PEER_SIGNALS,
  installedWorkerLinkGrantSchema,
  workerLinkGrantBindingSchema,
  workerLinkIdentityResolveResultSchema,
  workerLinkLeaseSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionSchema,
  workerLinkPeerSignalEnvelopeSchema,
  workerLinkSessionSchema,
  type InstalledWorkerLinkGrant,
  type WorkerLinkGrantOperation,
  type WorkerLinkCoordinatorCommand,
  type WorkerLinkLease,
  type WorkerLinkOperationalRoute,
  type WorkerLinkPeerCandidateAdvertisement,
  type WorkerLinkPeerConfiguration,
  type WorkerLinkPeerCoordinatorCommand,
  type WorkerLinkPeerMailbox,
  type WorkerLinkPeerMailboxReadRequest,
  type WorkerLinkPeerRoute,
  type WorkerLinkPeerSession,
  type WorkerLinkPeerSignalEnvelope,
  type WorkerLinkQosLane,
  type WorkerLinkResourceGrant,
  type WorkerLinkResourceKind,
  type WorkerLinkRevokeReason,
  type WorkerLinkSession,
  type WorkerLinkSessionIdentity,
} from "@cantrip/protocol/worker-link";

import { serverLogger } from "../logger.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

const DEFAULT_SESSION_LEASE_MS = 2 * 60_000;
const DEFAULT_SESSION_LIFETIME_MS = 12 * 60 * 60_000;
const DEFAULT_GRANT_LEASE_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const WORKER_COMMAND_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_SESSIONS = 1_024;

interface WorkerLinkSessionState {
  grants: Map<string, WorkerLinkGrantState>;
  peers: Map<string, WorkerLinkPeerState>;
  ready: boolean;
  session: WorkerLinkSession;
}

interface WorkerLinkGrantState {
  grant: InstalledWorkerLinkGrant;
}

interface WorkerLinkPeerState {
  candidateAdvertisements: WorkerLinkPeerCandidateAdvertisement[];
  clientSignalQueue: Promise<void>;
  lastAdvertisementSequence: number;
  lastClientSignalSequence: number;
  lastWorkerSignalSequence: number;
  peerSession: WorkerLinkPeerSession;
  ready: boolean;
  signals: WorkerLinkPeerSignalEnvelope[];
}

interface WorkerSubscription {
  sessionIds: Set<string>;
  unsubscribe: () => void;
}

export interface WorkerLinkCoordinatorOptions {
  maxActiveSessions?: number;
  now?: () => number;
  peerConfiguration?: WorkerLinkPeerConfiguration;
  serverGeneration: string;
  serverId: string;
  sessionLeaseMs?: number;
  sessionLifetimeMs?: number;
  sweepIntervalMs?: number;
}

export interface WorkerLinkSessionOpenInput {
  accountSessionId: string;
  clientInstanceId: string;
  ownerId: string;
  workerId: string;
}

export interface WorkerLinkGrantIssueInput {
  absoluteExpiresAt?: string;
  attachmentId?: string | null;
  lanes: WorkerLinkQosLane[];
  leaseMs?: number;
  maxChannels?: number;
  operations: WorkerLinkGrantOperation[];
  resourceId: string;
  resourceKind: WorkerLinkResourceKind;
  sessionId: string;
}

export interface WorkerLinkCoordinatorStats {
  grants: number;
  sessions: number;
}

export interface WorkerLinkPeerSessionOpenInput {
  route: WorkerLinkPeerRoute;
  routeGeneration: number;
  sessionId: string;
}

export class WorkerLinkUnavailableError extends Error {}

export class WorkerLinkCoordinator {
  readonly #accountSessionFences = new Map<string, number>();
  #closed = false;
  readonly #identitySessions = new Map<string, string>();
  readonly #now: () => number;
  readonly #openingPeerSessions = new Map<
    string,
    Promise<WorkerLinkPeerSession>
  >();
  readonly #openingSessions = new Map<string, Promise<WorkerLinkSession>>();
  readonly #ownerFences = new Map<string, number>();
  readonly #resourceFences = new Map<string, number>();
  readonly #sessions = new Map<string, WorkerLinkSessionState>();
  readonly #sweepTimer: ReturnType<typeof setInterval> | null;
  readonly #workerSubscriptions = new Map<string, WorkerSubscription>();

  constructor(
    private readonly workers: WorkerCommandBus,
    private readonly options: WorkerLinkCoordinatorOptions,
    private readonly logger: ServiceLogger = serverLogger,
  ) {
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs =
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#sweepTimer =
      sweepIntervalMs > 0
        ? setInterval(() => void this.sweepExpired(), sweepIntervalMs)
        : null;
    this.#sweepTimer?.unref();
  }

  async openSession(
    input: WorkerLinkSessionOpenInput,
  ): Promise<WorkerLinkSession> {
    this.#assertOpen();
    this.#assertIdentityAuthorized(input.ownerId, input.accountSessionId);
    await this.sweepExpired();
    const identity = await this.#identity(input);
    const identityKey = identityKeyOf(identity);
    const existingId = this.#identitySessions.get(identityKey);
    const existing = existingId ? this.#sessions.get(existingId) : undefined;
    if (existing?.ready) return existing.session;
    const opening = this.#openingSessions.get(identityKey);
    if (opening) return opening;
    if (
      this.#sessions.size + this.#openingSessions.size >=
      (this.options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS)
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink session limit has been reached.",
      );
    }
    const promise = this.#openNewSession(identity, identityKey);
    this.#openingSessions.set(identityKey, promise);
    try {
      return await promise;
    } finally {
      if (this.#openingSessions.get(identityKey) === promise) {
        this.#openingSessions.delete(identityKey);
      }
    }
  }

  async issueGrant(
    input: WorkerLinkGrantIssueInput,
  ): Promise<WorkerLinkResourceGrant> {
    this.#assertOpen();
    await this.sweepExpired();
    const state = this.#readySession(input.sessionId);
    const resourceKey = resourceKeyOf(
      state.session.identity.ownerId,
      input.resourceKind,
      input.resourceId,
    );
    if (this.#resourceFences.has(resourceKey)) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink resource is being revoked.",
      );
    }
    if (state.grants.size >= WORKER_LINK_MAX_GRANTS_PER_SESSION) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink grant limit has been reached.",
      );
    }
    const now = this.#now();
    const sessionExpiry = Date.parse(state.session.lease.expiresAt);
    const requestedAbsoluteExpiry = input.absoluteExpiresAt
      ? Date.parse(input.absoluteExpiresAt)
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(requestedAbsoluteExpiry) && input.absoluteExpiresAt) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink resource lifetime is invalid.",
      );
    }
    const absoluteExpiry = Math.min(
      Date.parse(state.session.lease.absoluteExpiresAt),
      requestedAbsoluteExpiry,
    );
    if (absoluteExpiry <= now) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink resource lifetime has expired.",
      );
    }
    const leaseExpiry = Math.min(
      sessionExpiry,
      absoluteExpiry,
      now + Math.max(1, input.leaseMs ?? DEFAULT_GRANT_LEASE_MS),
    );
    const lease = workerLinkLeaseSchema.parse({
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(leaseExpiry).toISOString(),
      absoluteExpiresAt: new Date(absoluteExpiry).toISOString(),
    });
    const binding = workerLinkGrantBindingSchema.parse({
      grantId: randomUUID(),
      grantGeneration: 1,
      sessionId: state.session.sessionId,
      identity: state.session.identity,
      resource: {
        kind: input.resourceKind,
        resourceId: input.resourceId,
        attachmentId: input.attachmentId ?? null,
      },
      lanes: input.lanes,
      operations: input.operations,
      maxChannels: Math.min(
        input.maxChannels ?? 4,
        WORKER_LINK_MAX_CHANNELS_PER_GRANT,
      ),
      lease,
    });
    const token = randomBytes(32).toString("base64url");
    const installedGrant = installedWorkerLinkGrantSchema.parse({
      binding,
      tokenHash: tokenHash(token),
    });
    const grantState: WorkerLinkGrantState = {
      grant: installedGrant,
    };
    state.grants.set(binding.grantId, grantState);
    try {
      await this.#request(state.session.identity.workerId, {
        type: "worker-link.grant.install",
        sessionId: state.session.sessionId,
        grant: installedGrant,
      });
    } catch (error) {
      if (state.grants.get(binding.grantId) === grantState) {
        state.grants.delete(binding.grantId);
      }
      throw error;
    }
    if (
      this.#sessions.get(state.session.sessionId) !== state ||
      state.grants.get(binding.grantId) !== grantState ||
      this.#resourceFences.has(resourceKey)
    ) {
      await this.#bestEffortRequest(
        state.session.identity.workerId,
        {
          type: "worker-link.grant.revoke",
          sessionId: state.session.sessionId,
          grantId: binding.grantId,
          grantGeneration: binding.grantGeneration,
          revocation: revocation("released", this.#now()),
        },
        state.session.identity.ownerId,
      );
      throw new WorkerLinkUnavailableError(
        "The WorkerLink grant was revoked while it was being installed.",
      );
    }
    return { binding, token };
  }

  async openPeerSession(
    input: WorkerLinkPeerSessionOpenInput,
  ): Promise<WorkerLinkPeerSession> {
    this.#assertOpen();
    await this.sweepExpired();
    const state = this.#readySession(input.sessionId);
    const configuration = this.options.peerConfiguration;
    if (
      !configuration ||
      configuration.relayOnly ||
      !configuration.directRoutes[input.route]
    ) {
      throw new WorkerLinkUnavailableError(
        "The requested WorkerLink peer route is disabled.",
      );
    }
    if (input.routeGeneration !== state.session.routeGeneration) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer route generation is stale.",
      );
    }
    const existing = [...state.peers.values()].find(
      (peer) =>
        peer.ready &&
        peer.peerSession.route === input.route &&
        peer.peerSession.routeGeneration === input.routeGeneration,
    );
    if (existing) return existing.peerSession;
    const peerKey = peerRoundKeyOf(input);
    const opening = this.#openingPeerSessions.get(peerKey);
    if (opening) return opening;
    const promise = this.#installPeerSession(state, input, configuration);
    this.#openingPeerSessions.set(peerKey, promise);
    try {
      return await promise;
    } finally {
      if (this.#openingPeerSessions.get(peerKey) === promise) {
        this.#openingPeerSessions.delete(peerKey);
      }
    }
  }

  async #installPeerSession(
    state: WorkerLinkSessionState,
    input: WorkerLinkPeerSessionOpenInput,
    configuration: WorkerLinkPeerConfiguration,
  ): Promise<WorkerLinkPeerSession> {
    if (state.peers.size >= configuration.maxPeerSessionsPerClient) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink client peer-session limit has been reached.",
      );
    }
    let workerPeers = 0;
    for (const candidate of this.#sessions.values()) {
      if (
        candidate.session.identity.workerId === state.session.identity.workerId
      ) {
        workerPeers += candidate.peers.size;
      }
    }
    if (workerPeers >= configuration.maxPeerSessionsPerWorker) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink worker peer-session limit has been reached.",
      );
    }
    const now = this.#now();
    const peerSession = workerLinkPeerSessionSchema.parse({
      peerSessionId: randomUUID(),
      sessionId: state.session.sessionId,
      identity: state.session.identity,
      routeGeneration: state.session.routeGeneration,
      route: input.route,
      lease: {
        issuedAt: new Date(now).toISOString(),
        expiresAt: state.session.lease.expiresAt,
        absoluteExpiresAt: state.session.lease.absoluteExpiresAt,
      },
    });
    const peerState: WorkerLinkPeerState = {
      candidateAdvertisements: [],
      clientSignalQueue: Promise.resolve(),
      lastAdvertisementSequence: -1,
      lastClientSignalSequence: -1,
      lastWorkerSignalSequence: -1,
      peerSession,
      ready: false,
      signals: [],
    };
    state.peers.set(peerSession.peerSessionId, peerState);
    try {
      await this.#request(state.session.identity.workerId, {
        type: "worker-link.peer.install",
        peerSession,
        configuration,
      });
    } catch (error) {
      if (state.peers.get(peerSession.peerSessionId) === peerState) {
        state.peers.delete(peerSession.peerSessionId);
      }
      throw error;
    }
    if (
      this.#sessions.get(state.session.sessionId) !== state ||
      state.peers.get(peerSession.peerSessionId) !== peerState ||
      state.session.routeGeneration !== peerSession.routeGeneration
    ) {
      await this.#bestEffortRequest(
        state.session.identity.workerId,
        {
          type: "worker-link.peer.revoke",
          peerSessionId: peerSession.peerSessionId,
          sessionId: peerSession.sessionId,
          revocation: revocation("route-replaced", this.#now()),
        },
        state.session.identity.ownerId,
      );
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer session was revoked during installation.",
      );
    }
    peerState.ready = true;
    return peerSession;
  }

  async signalPeer(input: WorkerLinkPeerSignalEnvelope): Promise<void> {
    const envelope = workerLinkPeerSignalEnvelopeSchema.parse(input);
    if (envelope.sender !== "client") {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer signal sender is invalid.",
      );
    }
    const state = this.#readySession(envelope.sessionId);
    const peer = state.peers.get(envelope.peerSessionId);
    if (!peer) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer signal authority is unavailable.",
      );
    }
    const operation = peer.clientSignalQueue.then(() =>
      this.#forwardPeerSignal(state, peer, envelope),
    );
    peer.clientSignalQueue = operation.catch(() => undefined);
    await operation;
  }

  async #forwardPeerSignal(
    state: WorkerLinkSessionState,
    peer: WorkerLinkPeerState,
    envelope: WorkerLinkPeerSignalEnvelope,
  ): Promise<void> {
    if (
      !peer?.ready ||
      this.#sessions.get(envelope.sessionId) !== state ||
      state.peers.get(envelope.peerSessionId) !== peer ||
      envelope.routeGeneration !== peer.peerSession.routeGeneration ||
      envelope.route !== peer.peerSession.route ||
      Date.parse(peer.peerSession.lease.expiresAt) <= this.#now()
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer signal authority is unavailable.",
      );
    }
    if (envelope.signalSequence !== peer.lastClientSignalSequence + 1) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer signal sequence is invalid.",
      );
    }
    if (envelope.signalSequence >= WORKER_LINK_MAX_PEER_SIGNALS) {
      await this.revokePeerSession(
        peer.peerSession.sessionId,
        peer.peerSession.peerSessionId,
        "protocol-violation",
      );
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer signal limit has been reached.",
      );
    }
    await this.#request(state.session.identity.workerId, {
      type: "worker-link.peer.signal",
      envelope,
    });
    if (
      this.#sessions.get(envelope.sessionId) === state &&
      state.peers.get(envelope.peerSessionId) === peer
    ) {
      peer.lastClientSignalSequence = envelope.signalSequence;
    }
  }

  readPeerMailbox(
    sessionId: string,
    peerSessionId: string,
    input: WorkerLinkPeerMailboxReadRequest,
  ): WorkerLinkPeerMailbox {
    const request = workerLinkPeerMailboxReadRequestSchema.parse(input);
    const state = this.#readySession(sessionId);
    const peer = state.peers.get(peerSessionId);
    if (
      !peer?.ready ||
      Date.parse(peer.peerSession.lease.expiresAt) <= this.#now()
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer mailbox is unavailable.",
      );
    }
    if (
      (request.afterSignalSequence !== null &&
        request.afterSignalSequence > peer.lastWorkerSignalSequence) ||
      (request.afterAdvertisementSequence !== null &&
        request.afterAdvertisementSequence > peer.lastAdvertisementSequence)
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink peer mailbox cursor is invalid.",
      );
    }
    if (request.afterSignalSequence !== null) {
      peer.signals = peer.signals.filter(
        (signal) => signal.signalSequence > request.afterSignalSequence!,
      );
    }
    if (request.afterAdvertisementSequence !== null) {
      peer.candidateAdvertisements = peer.candidateAdvertisements.filter(
        (advertisement) =>
          advertisement.advertisementSequence >
          request.afterAdvertisementSequence!,
      );
    }
    return workerLinkPeerMailboxSchema.parse({
      peerSessionId,
      sessionId,
      routeGeneration: peer.peerSession.routeGeneration,
      route: peer.peerSession.route,
      signals: peer.signals,
      candidateAdvertisements: peer.candidateAdvertisements,
    });
  }

  async revokePeerSession(
    sessionId: string,
    peerSessionId: string,
    reason: WorkerLinkRevokeReason = "released",
  ): Promise<boolean> {
    const state = this.#sessions.get(sessionId);
    const peer = state?.peers.get(peerSessionId);
    if (!state || !peer) return false;
    state.peers.delete(peerSessionId);
    await this.#bestEffortRequest(
      state.session.identity.workerId,
      {
        type: "worker-link.peer.revoke",
        peerSessionId,
        sessionId,
        revocation: revocation(reason, this.#now()),
      },
      state.session.identity.ownerId,
    );
    return true;
  }

  async renewSession(
    sessionId: string,
    leaseMs = this.options.sessionLeaseMs ?? DEFAULT_SESSION_LEASE_MS,
  ): Promise<WorkerLinkSession> {
    this.#assertOpen();
    await this.sweepExpired();
    const state = this.#readySession(sessionId);
    const lease = renewedLease(state.session.lease, leaseMs, this.#now());
    await this.#request(state.session.identity.workerId, {
      type: "worker-link.session.renew",
      sessionId,
      lease,
    });
    if (this.#sessions.get(sessionId) !== state) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink session was revoked during renewal.",
      );
    }
    state.session = workerLinkSessionSchema.parse({ ...state.session, lease });
    for (const peer of [...state.peers.values()]) {
      if (!peer.ready) continue;
      const renewedPeerLease = renewedLease(
        peer.peerSession.lease,
        leaseMs,
        this.#now(),
        Date.parse(lease.expiresAt),
      );
      try {
        await this.#request(state.session.identity.workerId, {
          type: "worker-link.peer.renew",
          peerSessionId: peer.peerSession.peerSessionId,
          sessionId,
          lease: renewedPeerLease,
        });
        if (state.peers.get(peer.peerSession.peerSessionId) === peer) {
          peer.peerSession = workerLinkPeerSessionSchema.parse({
            ...peer.peerSession,
            lease: renewedPeerLease,
          });
        }
      } catch {
        state.peers.delete(peer.peerSession.peerSessionId);
        await this.#bestEffortRequest(
          state.session.identity.workerId,
          {
            type: "worker-link.peer.revoke",
            peerSessionId: peer.peerSession.peerSessionId,
            sessionId,
            revocation: revocation("lease-expired", this.#now()),
          },
          state.session.identity.ownerId,
        );
      }
    }
    return state.session;
  }

  async replaceRoute(
    sessionId: string,
    preferredRoute: WorkerLinkOperationalRoute,
  ): Promise<WorkerLinkSession> {
    this.#assertOpen();
    await this.sweepExpired();
    const state = this.#readySession(sessionId);
    if (state.session.preferredRoute === preferredRoute) return state.session;
    if (!state.session.routePolicy.enabled.includes(preferredRoute)) {
      throw new WorkerLinkUnavailableError(
        "The requested WorkerLink route is not enabled.",
      );
    }
    const routeGeneration = state.session.routeGeneration + 1;
    await this.#request(state.session.identity.workerId, {
      type: "worker-link.session.route",
      sessionId,
      routeGeneration,
      preferredRoute,
    });
    if (this.#sessions.get(sessionId) !== state) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink session was revoked during route replacement.",
      );
    }
    state.session = workerLinkSessionSchema.parse({
      ...state.session,
      preferredRoute,
      routeGeneration,
    });
    await Promise.all(
      [...state.peers.keys()].map((peerSessionId) =>
        this.revokePeerSession(
          state.session.sessionId,
          peerSessionId,
          "route-replaced",
        ),
      ),
    );
    return state.session;
  }

  async renewGrant(
    sessionId: string,
    grantId: string,
    leaseMs = DEFAULT_GRANT_LEASE_MS,
  ): Promise<WorkerLinkLease> {
    this.#assertOpen();
    await this.sweepExpired();
    const state = this.#readySession(sessionId);
    const grantState = state.grants.get(grantId);
    if (!grantState) {
      throw new WorkerLinkUnavailableError("The WorkerLink grant is missing.");
    }
    const renewed = renewedLease(
      grantState.grant.binding.lease,
      leaseMs,
      this.#now(),
      Date.parse(state.session.lease.expiresAt),
    );
    await this.#request(state.session.identity.workerId, {
      type: "worker-link.grant.renew",
      sessionId,
      grantId,
      grantGeneration: grantState.grant.binding.grantGeneration,
      lease: renewed,
    });
    if (
      this.#sessions.get(sessionId) !== state ||
      state.grants.get(grantId) !== grantState
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink grant was revoked during renewal.",
      );
    }
    grantState.grant = installedWorkerLinkGrantSchema.parse({
      ...grantState.grant,
      binding: { ...grantState.grant.binding, lease: renewed },
    });
    return renewed;
  }

  async revokeGrant(
    sessionId: string,
    grantId: string,
    reason:
      | "released"
      | "resource-stopped"
      | "resource-deleted"
      | "lease-expired" = "released",
  ): Promise<boolean> {
    const state = this.#sessions.get(sessionId);
    const grantState = state?.grants.get(grantId);
    if (!state || !grantState) return false;
    state.grants.delete(grantId);
    await this.#bestEffortRequest(
      state.session.identity.workerId,
      {
        type: "worker-link.grant.revoke",
        sessionId,
        grantId,
        grantGeneration: grantState.grant.binding.grantGeneration,
        revocation: revocation(reason, this.#now()),
      },
      state.session.identity.ownerId,
    );
    return true;
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
    const state = this.#sessions.get(sessionId);
    if (!state) return false;
    this.#removeSession(state);
    await this.#bestEffortRequest(
      state.session.identity.workerId,
      {
        type: "worker-link.session.revoke",
        sessionId,
        revocation: revocation(reason, this.#now()),
      },
      state.session.identity.ownerId,
    );
    return true;
  }

  async revokeAccountSession(accountSessionId: string): Promise<number> {
    incrementFence(this.#accountSessionFences, accountSessionId);
    try {
      return await this.#revokeSessionsWhere(
        (session) => session.identity.accountSessionId === accountSessionId,
        "account-session-ended",
      );
    } finally {
      decrementFence(this.#accountSessionFences, accountSessionId);
    }
  }

  async revokeOwner(ownerId: string): Promise<number> {
    incrementFence(this.#ownerFences, ownerId);
    try {
      return await this.#revokeSessionsWhere(
        (session) => session.identity.ownerId === ownerId,
        "account-session-ended",
      );
    } finally {
      decrementFence(this.#ownerFences, ownerId);
    }
  }

  async revokeResource(
    ownerId: string,
    resourceKind: WorkerLinkResourceKind,
    resourceId: string,
    reason: "resource-stopped" | "resource-deleted" = "resource-stopped",
  ): Promise<number> {
    const key = resourceKeyOf(ownerId, resourceKind, resourceId);
    incrementFence(this.#resourceFences, key);
    try {
      const matches: Array<[string, string]> = [];
      for (const state of this.#sessions.values()) {
        if (state.session.identity.ownerId !== ownerId) continue;
        for (const [grantId, grant] of state.grants) {
          if (
            grant.grant.binding.resource.kind === resourceKind &&
            grant.grant.binding.resource.resourceId === resourceId
          ) {
            matches.push([state.session.sessionId, grantId]);
          }
        }
      }
      const results = await Promise.all(
        matches.map(([sessionId, grantId]) =>
          this.revokeGrant(sessionId, grantId, reason),
        ),
      );
      return results.filter(Boolean).length;
    } finally {
      decrementFence(this.#resourceFences, key);
    }
  }

  async revokeAttachment(
    ownerId: string,
    resourceKind: WorkerLinkResourceKind,
    resourceId: string,
    attachmentId: string,
    reason: "resource-stopped" | "resource-deleted" = "resource-stopped",
  ): Promise<number> {
    const key = resourceKeyOf(ownerId, resourceKind, resourceId);
    incrementFence(this.#resourceFences, key);
    try {
      const matches: Array<[string, string]> = [];
      for (const state of this.#sessions.values()) {
        if (state.session.identity.ownerId !== ownerId) continue;
        for (const [grantId, grant] of state.grants) {
          const resource = grant.grant.binding.resource;
          if (
            resource.kind === resourceKind &&
            resource.resourceId === resourceId &&
            resource.attachmentId === attachmentId
          ) {
            matches.push([state.session.sessionId, grantId]);
          }
        }
      }
      const results = await Promise.all(
        matches.map(([sessionId, grantId]) =>
          this.revokeGrant(sessionId, grantId, reason),
        ),
      );
      return results.filter(Boolean).length;
    } finally {
      decrementFence(this.#resourceFences, key);
    }
  }

  async revokeWorker(
    workerId: string,
    workerProcessGeneration?: string,
    reason:
      | "worker-disconnected"
      | "worker-generation-changed" = "worker-disconnected",
  ): Promise<number> {
    return this.#revokeSessionsWhere(
      (session) =>
        session.identity.workerId === workerId &&
        (workerProcessGeneration === undefined ||
          session.identity.workerProcessGeneration === workerProcessGeneration),
      reason,
    );
  }

  async sweepExpired(): Promise<number> {
    const now = this.#now();
    let revoked = 0;
    const expiredGrants: Array<[string, string]> = [];
    const expiredPeers: Array<[string, string]> = [];
    const expiredSessions: string[] = [];
    for (const state of this.#sessions.values()) {
      if (Date.parse(state.session.lease.expiresAt) <= now) {
        expiredSessions.push(state.session.sessionId);
        continue;
      }
      for (const [grantId, grant] of state.grants) {
        if (Date.parse(grant.grant.binding.lease.expiresAt) <= now) {
          expiredGrants.push([state.session.sessionId, grantId]);
        }
      }
      for (const [peerSessionId, peer] of state.peers) {
        if (Date.parse(peer.peerSession.lease.expiresAt) <= now) {
          expiredPeers.push([state.session.sessionId, peerSessionId]);
        }
      }
    }
    for (const [sessionId, peerSessionId] of expiredPeers) {
      if (
        await this.revokePeerSession(sessionId, peerSessionId, "lease-expired")
      ) {
        revoked += 1;
      }
    }
    for (const [sessionId, grantId] of expiredGrants) {
      if (await this.revokeGrant(sessionId, grantId, "lease-expired")) {
        revoked += 1;
      }
    }
    for (const sessionId of expiredSessions) {
      if (await this.revokeSession(sessionId, "lease-expired")) revoked += 1;
    }
    return revoked;
  }

  stats(): WorkerLinkCoordinatorStats {
    let grants = 0;
    for (const state of this.#sessions.values()) grants += state.grants.size;
    return { grants, sessions: this.#sessions.size };
  }

  sessionForAuthorization(
    sessionId: string,
    authorization: { accountSessionId: string; ownerId: string },
  ): WorkerLinkSession | null {
    const state = this.#sessions.get(sessionId);
    if (
      !state?.ready ||
      state.session.identity.ownerId !== authorization.ownerId ||
      state.session.identity.accountSessionId !==
        authorization.accountSessionId ||
      Date.parse(state.session.lease.expiresAt) <= this.#now()
    ) {
      return null;
    }
    return state.session;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(
      sessionIds.map((sessionId) =>
        this.revokeSession(sessionId, "server-shutdown"),
      ),
    );
    for (const subscription of this.#workerSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.#workerSubscriptions.clear();
  }

  async #openNewSession(
    identity: WorkerLinkSessionIdentity,
    identityKey: string,
  ): Promise<WorkerLinkSession> {
    await this.#revokeSessionsWhere(
      (session) =>
        session.identity.workerId === identity.workerId &&
        session.identity.workerProcessGeneration !==
          identity.workerProcessGeneration,
      "worker-generation-changed",
    );
    this.#assertOpen();
    this.#assertIdentityAuthorized(identity.ownerId, identity.accountSessionId);
    const now = this.#now();
    const absoluteExpiresAt =
      now +
      Math.max(
        1,
        this.options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS,
      );
    const session = workerLinkSessionSchema.parse({
      sessionId: randomUUID(),
      identity,
      lease: {
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(
          Math.min(
            absoluteExpiresAt,
            now +
              Math.max(
                1,
                this.options.sessionLeaseMs ?? DEFAULT_SESSION_LEASE_MS,
              ),
          ),
        ).toISOString(),
        absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
      },
      routePolicy: {
        priority: ["local", "lan", "wan", "relay"],
        enabled: ["local", "relay"],
      },
      routeGeneration: 1,
      preferredRoute: "local",
    });
    const state: WorkerLinkSessionState = {
      grants: new Map(),
      peers: new Map(),
      ready: false,
      session,
    };
    this.#sessions.set(session.sessionId, state);
    this.#identitySessions.set(identityKey, session.sessionId);
    this.#registerWorkerSession(identity.workerId, session.sessionId);
    try {
      await this.#request(identity.workerId, {
        type: "worker-link.session.install",
        session,
      });
    } catch (error) {
      if (this.#sessions.get(session.sessionId) === state) {
        this.#removeSession(state);
      }
      throw error;
    }
    if (
      this.#sessions.get(session.sessionId) !== state ||
      this.#accountSessionFences.has(identity.accountSessionId) ||
      this.#ownerFences.has(identity.ownerId)
    ) {
      await this.#bestEffortRequest(
        identity.workerId,
        {
          type: "worker-link.session.revoke",
          sessionId: session.sessionId,
          revocation: revocation("released", this.#now()),
        },
        identity.ownerId,
      );
      throw new WorkerLinkUnavailableError(
        "The WorkerLink session was revoked while it was being installed.",
      );
    }
    state.ready = true;
    return session;
  }

  async #identity(
    input: WorkerLinkSessionOpenInput,
  ): Promise<WorkerLinkSessionIdentity> {
    const resolved = workerLinkIdentityResolveResultSchema.parse(
      await this.workers.request(
        input.workerId,
        { type: "worker-link.identity.resolve" },
        { ownerId: input.ownerId, timeoutMs: WORKER_COMMAND_TIMEOUT_MS },
      ),
    );
    if (
      resolved.serverId !== this.options.serverId ||
      resolved.ownerId !== input.ownerId ||
      resolved.workerId !== input.workerId
    ) {
      throw new WorkerLinkUnavailableError(
        "WorkerLink identity resolution did not match the authorized worker.",
      );
    }
    return {
      serverId: this.options.serverId,
      serverGeneration: this.options.serverGeneration,
      ownerId: input.ownerId,
      accountSessionId: input.accountSessionId,
      clientInstanceId: input.clientInstanceId,
      workerId: input.workerId,
      workerProcessGeneration: resolved.workerProcessGeneration,
    };
  }

  #readySession(sessionId: string): WorkerLinkSessionState {
    const state = this.#sessions.get(sessionId);
    if (!state?.ready) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink session is unavailable.",
      );
    }
    this.#assertIdentityAuthorized(
      state.session.identity.ownerId,
      state.session.identity.accountSessionId,
    );
    return state;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink coordinator is shutting down.",
      );
    }
  }

  #assertIdentityAuthorized(ownerId: string, accountSessionId: string): void {
    if (
      this.#ownerFences.has(ownerId) ||
      this.#accountSessionFences.has(accountSessionId)
    ) {
      throw new WorkerLinkUnavailableError(
        "The WorkerLink account session is no longer authorized.",
      );
    }
  }

  async #receivePeerNotification(
    workerId: string,
    notification: WorkerNotification,
  ): Promise<void> {
    if (
      notification.type !== "worker-link.peer.signal" &&
      notification.type !== "worker-link.peer.candidates"
    ) {
      return;
    }
    const peerSessionId =
      notification.type === "worker-link.peer.signal"
        ? notification.envelope.peerSessionId
        : notification.advertisement.peerSessionId;
    let state: WorkerLinkSessionState | undefined;
    let peer: WorkerLinkPeerState | undefined;
    for (const candidate of this.#sessions.values()) {
      const match = candidate.peers.get(peerSessionId);
      if (match) {
        state = candidate;
        peer = match;
        break;
      }
    }
    if (!state || !peer) return;
    const authority =
      notification.type === "worker-link.peer.signal"
        ? notification.envelope
        : notification.advertisement;
    if (
      state.session.identity.workerId !== workerId ||
      authority.sessionId !== peer.peerSession.sessionId ||
      authority.routeGeneration !== peer.peerSession.routeGeneration ||
      authority.route !== peer.peerSession.route ||
      Date.parse(peer.peerSession.lease.expiresAt) <= this.#now()
    ) {
      await this.revokePeerSession(
        peer.peerSession.sessionId,
        peer.peerSession.peerSessionId,
        "protocol-violation",
      );
      return;
    }
    if (notification.type === "worker-link.peer.signal") {
      const sequence = notification.envelope.signalSequence;
      if (sequence <= peer.lastWorkerSignalSequence) {
        const recorded = peer.signals.find(
          (signal) => signal.signalSequence === sequence,
        );
        if (
          recorded &&
          canonical(recorded) !== canonical(notification.envelope)
        ) {
          await this.revokePeerSession(
            peer.peerSession.sessionId,
            peer.peerSession.peerSessionId,
            "protocol-violation",
          );
        }
        return;
      }
      if (
        sequence !== peer.lastWorkerSignalSequence + 1 ||
        peer.signals.length >= WORKER_LINK_MAX_PEER_SIGNALS ||
        peerMailboxBytes(peer, notification.envelope) >
          WORKER_LINK_MAX_PEER_SIGNALING_BYTES
      ) {
        await this.revokePeerSession(
          peer.peerSession.sessionId,
          peer.peerSession.peerSessionId,
          "protocol-violation",
        );
        return;
      }
      peer.signals.push(notification.envelope);
      peer.lastWorkerSignalSequence = sequence;
      return;
    }
    const sequence = notification.advertisement.advertisementSequence;
    if (sequence <= peer.lastAdvertisementSequence) {
      const recorded = peer.candidateAdvertisements.find(
        (advertisement) => advertisement.advertisementSequence === sequence,
      );
      if (
        recorded &&
        canonical(recorded) !== canonical(notification.advertisement)
      ) {
        await this.revokePeerSession(
          peer.peerSession.sessionId,
          peer.peerSession.peerSessionId,
          "protocol-violation",
        );
      }
      return;
    }
    if (
      sequence !== peer.lastAdvertisementSequence + 1 ||
      peer.candidateAdvertisements.length >= WORKER_LINK_MAX_PEER_SIGNALS ||
      peerMailboxBytes(peer, notification.advertisement) >
        WORKER_LINK_MAX_PEER_SIGNALING_BYTES
    ) {
      await this.revokePeerSession(
        peer.peerSession.sessionId,
        peer.peerSession.peerSessionId,
        "protocol-violation",
      );
      return;
    }
    peer.candidateAdvertisements.push(notification.advertisement);
    peer.lastAdvertisementSequence = sequence;
  }

  #registerWorkerSession(workerId: string, sessionId: string): void {
    let subscription = this.#workerSubscriptions.get(workerId);
    if (!subscription) {
      const listener = () => {
        void this.revokeWorker(workerId).catch((error) => {
          this.logger.event("warn", "WorkerLink disconnect revocation failed", {
            event: "worker-link.session.revoke-failed",
            subsystem: "worker-link",
            operation: "revoke-worker",
            reasonCode: "worker-disconnected",
            status: "failed",
            workerId,
            error: normalizeLogError(error),
          });
        });
      };
      const unsubscribeOffline = this.workers.subscribeWorkerOffline
        ? this.workers.subscribeWorkerOffline(workerId, listener)
        : this.workers.subscribeWorkerDisconnect(workerId, listener);
      const unsubscribeNotifications = this.workers.subscribeNotifications?.(
        workerId,
        (notification) => this.#receivePeerNotification(workerId, notification),
      );
      subscription = {
        sessionIds: new Set(),
        unsubscribe: () => {
          unsubscribeOffline();
          unsubscribeNotifications?.();
        },
      };
      this.#workerSubscriptions.set(workerId, subscription);
    }
    subscription.sessionIds.add(sessionId);
  }

  #removeSession(state: WorkerLinkSessionState): void {
    const { session } = state;
    if (this.#sessions.get(session.sessionId) !== state) return;
    this.#sessions.delete(session.sessionId);
    const identityKey = identityKeyOf(session.identity);
    if (this.#identitySessions.get(identityKey) === session.sessionId) {
      this.#identitySessions.delete(identityKey);
    }
    const subscription = this.#workerSubscriptions.get(
      session.identity.workerId,
    );
    subscription?.sessionIds.delete(session.sessionId);
    if (subscription?.sessionIds.size === 0) {
      subscription.unsubscribe();
      this.#workerSubscriptions.delete(session.identity.workerId);
    }
    state.grants.clear();
    state.peers.clear();
  }

  async #revokeSessionsWhere(
    predicate: (session: WorkerLinkSession) => boolean,
    reason: Parameters<WorkerLinkCoordinator["revokeSession"]>[1],
  ): Promise<number> {
    const sessionIds = [...this.#sessions.values()]
      .filter((state) => predicate(state.session))
      .map((state) => state.session.sessionId);
    const results = await Promise.all(
      sessionIds.map((sessionId) => this.revokeSession(sessionId, reason)),
    );
    return results.filter(Boolean).length;
  }

  async #request(
    workerId: string,
    command: WorkerLinkCoordinatorCommand | WorkerLinkPeerCoordinatorCommand,
    ownerId?: string,
  ): Promise<void> {
    const result = await this.workers.request(workerId, command, {
      ownerId:
        ownerId ??
        ("session" in command
          ? command.session.identity.ownerId
          : "peerSession" in command
            ? command.peerSession.identity.ownerId
            : this.#sessions.get(
                "sessionId" in command
                  ? command.sessionId
                  : command.envelope.sessionId,
              )?.session.identity.ownerId),
      timeoutMs: WORKER_COMMAND_TIMEOUT_MS,
    });
    if (
      !result ||
      typeof result !== "object" ||
      (result as { accepted?: unknown }).accepted !== true
    ) {
      throw new WorkerLinkUnavailableError(
        `Worker did not acknowledge ${command.type}.`,
      );
    }
  }

  async #bestEffortRequest(
    workerId: string,
    command: WorkerLinkCoordinatorCommand | WorkerLinkPeerCoordinatorCommand,
    ownerId?: string,
  ): Promise<void> {
    try {
      await this.#request(workerId, command, ownerId);
    } catch (error) {
      this.logger.event("warn", "WorkerLink revocation was not acknowledged", {
        event: "worker-link.revocation.unacknowledged",
        subsystem: "worker-link",
        operation: command.type,
        reasonCode: "worker-unavailable",
        status: "degraded",
        workerId,
        error: normalizeLogError(error),
      });
    }
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function peerMailboxBytes(
  peer: WorkerLinkPeerState,
  incoming: WorkerLinkPeerSignalEnvelope | WorkerLinkPeerCandidateAdvertisement,
): number {
  const signals =
    "signalSequence" in incoming ? [...peer.signals, incoming] : peer.signals;
  const candidateAdvertisements =
    "advertisementSequence" in incoming
      ? [...peer.candidateAdvertisements, incoming]
      : peer.candidateAdvertisements;
  return new TextEncoder().encode(
    JSON.stringify({ signals, candidateAdvertisements }),
  ).byteLength;
}

function revocation(reason: WorkerLinkRevokeReason, now: number) {
  return { reason, revokedAt: new Date(now).toISOString() } as const;
}

function renewedLease(
  current: WorkerLinkLease,
  leaseMs: number,
  now: number,
  parentExpiresAt = Number.POSITIVE_INFINITY,
): WorkerLinkLease {
  const absoluteExpiresAt = Date.parse(current.absoluteExpiresAt);
  const expiresAt = Math.min(
    absoluteExpiresAt,
    parentExpiresAt,
    now + Math.max(1, leaseMs),
  );
  if (expiresAt <= now) {
    throw new WorkerLinkUnavailableError("The WorkerLink lease has expired.");
  }
  return workerLinkLeaseSchema.parse({
    issuedAt: current.issuedAt,
    expiresAt: new Date(expiresAt).toISOString(),
    absoluteExpiresAt: current.absoluteExpiresAt,
  });
}

function identityKeyOf(identity: WorkerLinkSessionIdentity): string {
  return [
    identity.serverId,
    identity.serverGeneration,
    identity.ownerId,
    identity.accountSessionId,
    identity.clientInstanceId,
    identity.workerId,
    identity.workerProcessGeneration,
  ]
    .map((part) => `${part.length}:${part}`)
    .join("");
}

function peerRoundKeyOf(input: WorkerLinkPeerSessionOpenInput): string {
  return `${input.sessionId}:${input.routeGeneration}:${input.route}`;
}

function resourceKeyOf(
  ownerId: string,
  kind: WorkerLinkResourceKind,
  resourceId: string,
): string {
  return `${ownerId.length}:${ownerId}${kind.length}:${kind}${resourceId.length}:${resourceId}`;
}

function incrementFence(fences: Map<string, number>, key: string): void {
  fences.set(key, (fences.get(key) ?? 0) + 1);
}

function decrementFence(fences: Map<string, number>, key: string): void {
  const count = fences.get(key) ?? 0;
  if (count <= 1) fences.delete(key);
  else fences.set(key, count - 1);
}
