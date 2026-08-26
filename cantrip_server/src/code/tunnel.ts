import {
  codeRuntimeStatusSchema,
  type CodeProtectedAttachmentWire,
  type CodeRuntimeStatus,
  type ProtectedTunnelContentRecord,
} from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";
import { serverLogger } from "../logger.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  canonicalCodeAuthSessionId,
  type CreateSharedCodeSessionAttachmentInput,
  type SharedCodeSessionAttachmentAuthorization,
  type SharedCodeSessionOwnershipIdentity,
  type SharedCodeSessionRevocationIdentity,
  SharedCodeTransportRegistry,
  type SharedCodeTransportRootIdentity,
} from "./shared-transport.js";

interface ProtectedCodeAttachmentBinding {
  attachmentId: string;
  authSessionId: string | null;
  codeTabId: string;
  createdAt: number;
  explorerId: string | null;
  expiresAt: number;
  generation: symbol;
  hardExpiresAt: number;
  ownerId: string;
  projectId: string | null;
  protectedKeyRevision: number;
  registrationLease: CodeAttachmentRegistrationLease | null;
  serverId: string | null;
  sessionIncarnationId: string | null;
  sessionId: string;
  stopSessionOnRelease: boolean;
  tunnelId: string;
  workerId: string;
  worktreeId: string | null;
  worktreePath: string | null;
}

export interface CreateProtectedCodeAttachmentInput {
  authSessionId?: string | null;
  codeTabId: string;
  ownerId: string;
  projectId: string | null;
  protectedRecord: ProtectedTunnelContentRecord;
  runtime: CodeRuntimeStatus;
  serverId?: string;
  sessionId: string;
  stopSessionOnRelease?: boolean;
  tunnelId: string;
  workerId: string;
  worktreeId?: string | null;
  worktreePath?: string | null;
  registrationLease?: CodeAttachmentRegistrationLease;
}

export interface CodeTunnelBrokerOptions {
  idleTtlMs?: number;
  maxAttachments?: number;
  maxLifecycleTombstones?: number;
  maxLifetimeMs?: number;
  now?: () => number;
}

export interface CodeAttachmentRegistrationLeaseInput {
  readonly authSessionId: string | null;
  readonly explorerId?: string | null;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly tunnelId: string;
}

export interface CodeAttachmentRegistrationLease extends CodeAttachmentRegistrationLeaseInput {
  readonly explorerGeneration: symbol | null;
}

export interface AbortCodeAttachmentRegistrationSessionInput {
  readonly lease: CodeAttachmentRegistrationLease;
  readonly runtime: CodeRuntimeStatus | null;
  readonly workerId: string;
}

interface CodeSessionOwnershipIdentity {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sessionIncarnationId: string | null;
  readonly workerId: string;
}

interface ExplorerCodeLifecycle {
  generation: symbol;
  leaseCount: number;
  mutationCount: number;
  tail: Promise<void>;
}

interface CodeAttachmentRegistrationLeaseState {
  readonly explorerLifecycle: ExplorerCodeLifecycle | null;
  readonly release: () => void;
  readonly released: Promise<void>;
}

export class ExplorerCodeAttachmentLeaseError extends Error {}

export interface CodeTunnelActivityLease {
  readonly expiresAt: string | null;
  readonly managed: boolean;
}

export interface CodeAttachmentRootIdentity {
  readonly authSessionId: string | null;
  readonly ownerId: string;
  readonly protectedKeyRevision: number;
  readonly rootAttachmentId: string;
  readonly serverId: string;
  readonly tunnelId: string;
  readonly workerId: string;
}

export interface CodeAttachmentRootLeaseState {
  readonly expiresAt: string;
  readonly generation: symbol;
  readonly hardExpiresAt: string;
}

export interface CodeAttachmentRootLease extends CodeAttachmentRootLeaseState {
  readonly recordActivity: () => CodeAttachmentRootLeaseState | null;
  readonly validate: () => CodeAttachmentRootLeaseState | null;
}

export interface CodeAttachmentRootLeaseResult {
  readonly lease: CodeAttachmentRootLease | null;
  readonly managed: boolean;
}

type CleanupTunnelResources = (
  ownerId: string,
  tunnelId: string,
  reason: string,
  code?: number,
) => Promise<void> | void;

type CodeTunnelChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}) => void;

type WorkerOfflineSubscription = {
  subscribeWorkerOffline?: WorkerCommandBus["subscribeWorkerDisconnect"];
};

function subscribeWorkerTerminalOffline(
  bridge: WorkerCommandBus,
  workerId: string,
  listener: () => void,
): () => void {
  const subscribeOffline = (
    bridge as WorkerCommandBus & WorkerOfflineSubscription
  ).subscribeWorkerOffline;
  return subscribeOffline
    ? subscribeOffline.call(bridge, workerId, listener)
    : bridge.subscribeWorkerDisconnect(workerId, listener);
}

export class CodeTunnelBroker {
  readonly #attachmentRevocations = new Map<string, number>();
  readonly #attachments = new Map<string, ProtectedCodeAttachmentBinding>();
  readonly #relayAttachments = new Map<
    string,
    ProtectedCodeAttachmentBinding
  >();
  readonly #authSessionRevocations = new Map<string, number>();
  readonly #idleTtlMs: number;
  readonly #maxAttachments: number;
  readonly #maxLifetimeMs: number;
  readonly #now: () => number;
  readonly #ownerRevocations = new Map<string, number>();
  readonly #pendingRegistrations = new Map<
    Promise<void>,
    CreateProtectedCodeAttachmentInput
  >();
  readonly #pendingSharedRegistrations = new Map<
    Promise<void>,
    CreateSharedCodeSessionAttachmentInput
  >();
  readonly #removals = new Map<string, Promise<boolean>>();
  readonly #registrationLeases = new Map<
    CodeAttachmentRegistrationLease,
    CodeAttachmentRegistrationLeaseState
  >();
  readonly #registrationLeaseStates = new WeakMap<
    CodeAttachmentRegistrationLease,
    CodeAttachmentRegistrationLeaseState
  >();
  readonly #sessionStopFences = new Map<string, number>();
  readonly #sessionStopIncarnations = new Map<string, string>();
  readonly #sessionStopOperations = new Map<string, Promise<void>>();
  readonly #deferredSessionStops = new Map<string, Promise<void>>();
  readonly #failedDeferredSessionStops = new Map<
    string,
    CodeSessionOwnershipIdentity
  >();
  readonly #sessionRevocations = new Map<string, number>();
  readonly #sharedAttachmentRevocations = new Map<string, number>();
  readonly #sharedTransportRevocations = new Map<string, number>();
  readonly #sharedTransports: SharedCodeTransportRegistry;
  readonly #explorerLifecycles = new Map<string, ExplorerCodeLifecycle>();
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  readonly #workerDisconnectSubscriptions = new Map<string, () => void>();
  readonly #workerSecurityRevocations = new Map<string, number>();
  #changed: CodeTunnelChange | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #cleanupTunnelResources: CleanupTunnelResources | null = null;
  #repository: ServerRepository | null = null;

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: CodeTunnelBrokerOptions = {},
  ) {
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxAttachments = options.maxAttachments ?? 128;
    this.#now = options.now ?? Date.now;
    this.#sharedTransports = new SharedCodeTransportRegistry(bridge, {
      idleTtlMs: this.#idleTtlMs,
      maxLifetimeMs: this.#maxLifetimeMs,
      maxSessionAttachments: this.#maxAttachments * 4,
      maxTombstones: options.maxLifecycleTombstones,
      maxTransports: this.#maxAttachments,
      now: this.#now,
      sessionOwnership: {
        runAcquisition: (identity, operation) =>
          this.#enqueueSessionStopOperation(identity, operation),
        release: (identity) =>
          this.#enqueueSessionStopOperation(identity, () =>
            this.#stopSharedSessionIfUnowned(identity),
          ),
      },
    });
    this.#sweepTimer = setInterval(
      () => this.#prune(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  configureControlPlane(
    repository: ServerRepository,
    changed: CodeTunnelChange,
    cleanupTunnelResources?: CleanupTunnelResources,
  ): void {
    if (this.#attachments.size > 0) {
      throw new Error("Code control plane must be configured before use.");
    }
    this.#repository = repository;
    this.#changed = changed;
    this.#cleanupTunnelResources = cleanupTunnelResources ?? null;
    this.#sharedTransports.configureControlPlane(
      repository,
      changed,
      cleanupTunnelResources,
    );
  }

  async createSharedSessionAttachment(
    input: CreateSharedCodeSessionAttachmentInput & {
      registrationLease?: CodeAttachmentRegistrationLease;
    },
  ) {
    const lease = input.registrationLease;
    if (
      lease &&
      (lease.ownerId !== input.ownerId ||
        lease.authSessionId !== input.authSessionId ||
        lease.sessionId !== input.sessionId ||
        lease.tunnelId !== input.attachmentId ||
        !this.registrationLeaseIsActive(lease))
    ) {
      throw new ExplorerCodeAttachmentLeaseError(
        "The Explorer changed while its shared editor was opening.",
      );
    }
    this.#assertSharedSecurityRegistrationAllowed(input);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#pendingSharedRegistrations.set(pending, input);
    try {
      const attachment =
        await this.#sharedTransports.createSessionAttachment(input);
      if (
        this.#sharedSecurityRegistrationIsFenced(input) ||
        (lease && !this.registrationLeaseIsActive(lease))
      ) {
        await this.#sharedTransports.revokeSessionAttachment({
          attachmentId: input.attachmentId,
          authSessionId: input.authSessionId,
          ownerId: input.ownerId,
        });
        this.#assertSharedSecurityRegistrationAllowed(input);
        throw new ExplorerCodeAttachmentLeaseError(
          "The Explorer changed while its shared editor was opening.",
        );
      }
      return attachment;
    } finally {
      this.#pendingSharedRegistrations.delete(pending);
      finish();
    }
  }

  renewSharedSessionAttachment(
    authorization: SharedCodeSessionAttachmentAuthorization,
  ) {
    return this.#sharedTransports.renewSessionAttachment(authorization);
  }

  async revokeSharedSessionAttachment(
    authorization: SharedCodeSessionAttachmentAuthorization,
  ): Promise<boolean> {
    const key = this.#sharedAttachmentKey(
      authorization.ownerId,
      authorization.authSessionId,
      authorization.attachmentId,
    );
    this.#beginFence(this.#sharedAttachmentRevocations, key);
    const matchingLeases = [...this.#registrationLeases].filter(
      ([lease]) =>
        lease.ownerId === authorization.ownerId &&
        lease.authSessionId === authorization.authSessionId &&
        lease.tunnelId === authorization.attachmentId,
    );
    const matchingRegistrations = [...this.#pendingSharedRegistrations].filter(
      ([, input]) =>
        input.ownerId === authorization.ownerId &&
        input.authSessionId === authorization.authSessionId &&
        input.attachmentId === authorization.attachmentId,
    );
    const observedPending =
      matchingLeases.length > 0 || matchingRegistrations.length > 0;
    try {
      await Promise.allSettled([
        ...matchingLeases.map(([, state]) => state.released),
        ...matchingRegistrations.map(([pending]) => pending),
      ]);
      return (
        (await this.#sharedTransports.revokeSessionAttachment(authorization)) ||
        observedPending
      );
    } finally {
      this.#endFence(this.#sharedAttachmentRevocations, key);
    }
  }

  revokeSharedSession(identity: SharedCodeSessionRevocationIdentity) {
    return this.#sharedTransports.revokeSession(identity);
  }

  async revokeSharedWorkerSecurity(
    ownerId: string,
    workerId: string,
    protectedKeyRevision?: number,
  ): Promise<void> {
    const key = this.#workerSecurityKey(
      ownerId,
      workerId,
      protectedKeyRevision ?? "all",
    );
    this.#beginFence(this.#workerSecurityRevocations, key);
    const initialRevocation = this.#sharedTransports.revokeWorkerSecurity(
      ownerId,
      workerId,
      protectedKeyRevision,
    );
    void initialRevocation.catch(() => undefined);
    try {
      await this.#waitForSharedRegistrations(
        (input) =>
          input.ownerId === ownerId &&
          input.workerId === workerId &&
          (protectedKeyRevision === undefined ||
            input.protectedKeyRevision === protectedKeyRevision),
      );
      const finalRevocation = this.#sharedTransports.revokeWorkerSecurity(
        ownerId,
        workerId,
        protectedKeyRevision,
      );
      await Promise.all([initialRevocation, finalRevocation]);
    } finally {
      this.#endFence(this.#workerSecurityRevocations, key);
    }
  }

  async revokeSharedTransport(
    ownerId: string,
    authSessionId: string,
    transportId: string,
  ): Promise<boolean> {
    const key = this.#sharedTransportKey(ownerId, authSessionId, transportId);
    this.#beginFence(this.#sharedTransportRevocations, key);
    const matchingRegistrations = [...this.#pendingSharedRegistrations].filter(
      ([, input]) =>
        input.ownerId === ownerId &&
        input.authSessionId === authSessionId &&
        input.transport.transportId === transportId,
    );
    const observedPending = matchingRegistrations.length > 0;
    try {
      await Promise.allSettled(
        matchingRegistrations.map(([pending]) => pending),
      );
      return (
        (await this.#sharedTransports.revokeTransport(
          ownerId,
          authSessionId,
          transportId,
        )) || observedPending
      );
    } finally {
      this.#endFence(this.#sharedTransportRevocations, key);
    }
  }

  sharedTransportStats() {
    return this.#sharedTransports.stats();
  }

  async createProtectedAttachment(
    input: CreateProtectedCodeAttachmentInput,
  ): Promise<CodeProtectedAttachmentWire> {
    if (input.runtime.sessionId !== input.sessionId) {
      throw new Error(
        "The live Cantrip Code runtime does not match this attachment.",
      );
    }
    this.#assertRegistrationAllowed(input);
    if (
      this.#attachments.has(input.tunnelId) ||
      [...this.#pendingRegistrations.values()].some(
        (pending) => pending.tunnelId === input.tunnelId,
      )
    ) {
      throw new Error("This protected Cantrip Code attachment already exists.");
    }
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#pendingRegistrations.set(pending, input);
    try {
      const attachment = input.registrationLease?.explorerId
        ? await this.#withExplorerRegistration(input.registrationLease, () =>
            this.#createProtectedAttachment(input),
          )
        : await this.#createProtectedAttachment(input);
      if (
        this.#registrationIsFenced(input) ||
        (input.registrationLease &&
          !this.registrationLeaseIsActive(input.registrationLease))
      ) {
        await this.#removeCreatedAttachment(
          attachment.attachmentId,
          input.ownerId,
        );
        this.#assertRegistrationAllowed(input);
      }
      return attachment;
    } finally {
      this.#pendingRegistrations.delete(pending);
      finish();
    }
  }

  acquireRegistrationLease(
    input: CodeAttachmentRegistrationLeaseInput,
  ): CodeAttachmentRegistrationLease | null {
    if (
      this.#registrationIdentityIsFenced(input) ||
      this.#sessionStopFences.has(
        this.#sessionOwnershipKey(input.ownerId, input.sessionId),
      ) ||
      this.#deferredStopCapacityReached(input.ownerId) ||
      this.#attachments.size + this.#registrationLeases.size >=
        this.#maxAttachments
    ) {
      return null;
    }
    const explorerId = input.explorerId ?? null;
    let explorerLifecycle: ExplorerCodeLifecycle | null = null;
    if (explorerId) {
      const key = this.#explorerKey(input.ownerId, explorerId);
      explorerLifecycle = this.#explorerLifecycles.get(key) ?? null;
      if (!explorerLifecycle) {
        explorerLifecycle = {
          generation: Symbol(key),
          leaseCount: 0,
          mutationCount: 0,
          tail: Promise.resolve(),
        };
        this.#explorerLifecycles.set(key, explorerLifecycle);
      }
      if (explorerLifecycle.mutationCount > 0) return null;
      explorerLifecycle.leaseCount += 1;
    }
    const lease: CodeAttachmentRegistrationLease = {
      ...input,
      explorerId,
      explorerGeneration: explorerLifecycle?.generation ?? null,
    };
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { explorerLifecycle, release, released };
    this.#registrationLeases.set(lease, state);
    this.#registrationLeaseStates.set(lease, state);
    return lease;
  }

  releaseRegistrationLease(lease: CodeAttachmentRegistrationLease): void {
    const state = this.#registrationLeaseStates.get(lease);
    if (!state) return;
    this.#consumeRegistrationLease(lease, state);
  }

  abortRegistrationSession(
    input: AbortCodeAttachmentRegistrationSessionInput,
  ): Promise<boolean> {
    const state = this.#registrationLeaseStates.get(input.lease);
    if (!state || this.#registrationLeases.get(input.lease) !== state) {
      return Promise.resolve(false);
    }
    const sessionKey = this.#sessionOwnershipKey(
      input.lease.ownerId,
      input.lease.sessionId,
    );
    const sessionIncarnationId =
      input.runtime?.sessionId === input.lease.sessionId
        ? (input.runtime.sessionIncarnationId ?? null)
        : null;
    this.#beginFence(this.#sessionStopFences, sessionKey);
    this.#consumeRegistrationLease(input.lease, state);
    const operation = this.#enqueueSessionStopOperation(
      {
        ownerId: input.lease.ownerId,
        sessionId: input.lease.sessionId,
        sessionIncarnationId,
        workerId: input.workerId,
      },
      () =>
        this.#stopAbortedRegistrationIfUnowned({
          ownerId: input.lease.ownerId,
          sessionId: input.lease.sessionId,
          sessionIncarnationId,
          workerId: input.workerId,
        }),
    );
    return operation
      .then(() => true)
      .finally(() => this.#endFence(this.#sessionStopFences, sessionKey));
  }

  #consumeRegistrationLease(
    lease: CodeAttachmentRegistrationLease,
    state: CodeAttachmentRegistrationLeaseState,
  ): void {
    this.#registrationLeaseStates.delete(lease);
    this.#registrationLeases.delete(lease);
    state.release();
    if (lease.explorerId && state.explorerLifecycle) {
      state.explorerLifecycle.leaseCount -= 1;
      this.#removeExplorerLifecycleIfUnused(
        lease.ownerId,
        lease.explorerId,
        state.explorerLifecycle,
      );
    }
  }

  registrationLeaseIsActive(lease: CodeAttachmentRegistrationLease): boolean {
    const state = this.#registrationLeaseStates.get(lease);
    if (!state || this.#registrationLeases.get(lease) !== state) return false;
    if (this.#registrationIdentityIsFenced(lease)) return false;
    if (!lease.explorerId) return true;
    return this.#explorerLeaseIsActive(
      state.explorerLifecycle ?? undefined,
      lease,
    );
  }

  attachmentRegistrationLeaseIsActive(
    attachmentId: string,
    lease: CodeAttachmentRegistrationLease,
  ): boolean {
    const binding = this.#attachments.get(attachmentId);
    return Boolean(
      binding &&
      binding.registrationLease === lease &&
      !this.#removals.has(attachmentId) &&
      this.registrationLeaseIsActive(lease),
    );
  }

  async mutateExplorer<T>(
    ownerId: string,
    explorerId: string,
    mutation: () => Promise<T>,
    didMutate: (result: T) => boolean,
  ): Promise<T> {
    const key = this.#explorerKey(ownerId, explorerId);
    let lifecycle = this.#explorerLifecycles.get(key);
    if (!lifecycle) {
      lifecycle = {
        generation: Symbol(key),
        leaseCount: 0,
        mutationCount: 0,
        tail: Promise.resolve(),
      };
      this.#explorerLifecycles.set(key, lifecycle);
    }
    lifecycle.generation = Symbol(key);
    lifecycle.mutationCount += 1;
    const queued = this.#enqueueExplorerLifecycle(lifecycle);
    await queued.previous;
    try {
      await this.#waitForRegistrationLeases(
        (lease) => lease.ownerId === ownerId && lease.explorerId === explorerId,
      );
      const result = await mutation();
      if (didMutate(result)) {
        await Promise.all([
          this.#revokeWhere(
            (binding) =>
              binding.ownerId === ownerId && binding.explorerId === explorerId,
          ),
          this.#sharedTransports.revokeExplorer(ownerId, explorerId),
        ]);
      }
      return result;
    } finally {
      lifecycle.mutationCount -= 1;
      queued.release();
      this.#removeExplorerLifecycleIfUnused(ownerId, explorerId, lifecycle);
    }
  }

  recordTunnelActivity(tunnelId: string): string | null {
    const binding = this.#attachments.get(tunnelId);
    if (!binding) return null;
    return this.#recordBindingActivity(binding)?.expiresAt ?? null;
  }

  allowTunnelActivity(tunnelId: string): boolean {
    const lease = this.recordTunnelActivityLease(tunnelId);
    return !lease.managed || lease.expiresAt !== null;
  }

  recordTunnelActivityLease(tunnelId: string): CodeTunnelActivityLease {
    if (!this.#attachments.has(tunnelId)) {
      return { expiresAt: null, managed: false };
    }
    return {
      expiresAt: this.recordTunnelActivity(tunnelId),
      managed: true,
    };
  }

  acquireAttachmentRootLease(
    identity: CodeAttachmentRootIdentity,
  ): CodeAttachmentRootLeaseResult {
    const binding = this.#attachments.get(identity.tunnelId);
    if (!binding) {
      return this.#sharedTransports.acquireRootLease({
        ...identity,
        authSessionId: canonicalCodeAuthSessionId(
          identity.ownerId,
          identity.authSessionId,
        ),
      } as SharedCodeTransportRootIdentity);
    }
    if (
      binding.attachmentId !== identity.rootAttachmentId ||
      binding.authSessionId !== identity.authSessionId ||
      binding.ownerId !== identity.ownerId ||
      binding.protectedKeyRevision !== identity.protectedKeyRevision ||
      binding.serverId !== identity.serverId ||
      binding.tunnelId !== identity.tunnelId ||
      binding.workerId !== identity.workerId
    ) {
      return { lease: null, managed: true };
    }
    const initial = this.#recordBindingActivity(binding);
    if (!initial) return { lease: null, managed: true };
    const validate = (): CodeAttachmentRootLeaseState | null =>
      this.#validateBindingLease(binding);
    return {
      lease: {
        ...initial,
        recordActivity: () => this.#recordBindingActivity(binding),
        validate,
      },
      managed: true,
    };
  }

  bindRelayAttachment(
    relayAttachmentId: string,
    identity: CodeAttachmentRootIdentity,
  ): boolean {
    const binding = this.#attachments.get(identity.tunnelId);
    if (!binding) {
      return this.#sharedTransports.bindRelayAttachment(relayAttachmentId, {
        ...identity,
        authSessionId: canonicalCodeAuthSessionId(
          identity.ownerId,
          identity.authSessionId,
        ),
      } as SharedCodeTransportRootIdentity);
    }
    if (
      !binding ||
      binding.attachmentId !== identity.rootAttachmentId ||
      binding.authSessionId !== identity.authSessionId ||
      binding.ownerId !== identity.ownerId ||
      binding.protectedKeyRevision !== identity.protectedKeyRevision ||
      binding.serverId !== identity.serverId ||
      binding.tunnelId !== identity.tunnelId ||
      binding.workerId !== identity.workerId ||
      !this.#recordBindingActivity(binding)
    ) {
      return false;
    }
    this.#relayAttachments.set(relayAttachmentId, binding);
    return true;
  }

  allowRelayAttachmentActivity(
    relayAttachmentId: string,
    tunnelId: string,
  ): boolean {
    const binding = this.#relayAttachments.get(relayAttachmentId);
    if (!binding) {
      return (
        this.#sharedTransports.allowRelayAttachmentActivity(
          relayAttachmentId,
          tunnelId,
        ) ?? false
      );
    }
    if (
      !binding ||
      binding.tunnelId !== tunnelId ||
      !this.#recordBindingActivity(binding)
    ) {
      if (this.#relayAttachments.get(relayAttachmentId) === binding) {
        this.#relayAttachments.delete(relayAttachmentId);
      }
      return false;
    }
    return true;
  }

  releaseRelayAttachment(relayAttachmentId: string): void {
    this.#relayAttachments.delete(relayAttachmentId);
    this.#sharedTransports.releaseRelayAttachment(relayAttachmentId);
  }

  retiredSharedRelayAttachmentIsAuthorized(
    relayAttachmentId: string,
    ownerId: string,
    authSessionId: string | null,
  ): boolean {
    return this.#sharedTransports.retiredRelayAttachmentIsAuthorized(
      relayAttachmentId,
      {
        authSessionId: canonicalCodeAuthSessionId(ownerId, authSessionId),
        ownerId,
      },
    );
  }

  async #createProtectedAttachment(
    input: CreateProtectedCodeAttachmentInput,
  ): Promise<CodeProtectedAttachmentWire> {
    this.#assertRegistrationAllowed(input);
    this.#prune();
    if (
      this.#attachments.size + this.#pendingRegistrations.size >
      this.#maxAttachments
    ) {
      throw new Error(
        "This server has reached its Cantrip Code attachment limit.",
      );
    }
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error("Cantrip Code worker is offline.");
    }
    if (!this.#repository) {
      throw new Error("Cantrip Code protected control plane is unavailable.");
    }
    const tunnel = await this.#repository.registerManagedTunnel(
      input.ownerId,
      {
        name: "Cantrip Code",
        description: "Protected editor access for the owning Code surface.",
        projectId: input.projectId,
        origin: "code",
        management: "managed-ephemeral",
        protocolHint: "http-websocket",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-adapter",
          workerId: input.workerId,
          adapter: "code",
          resourceId: input.tunnelId,
        },
        managedBy: { kind: "code", id: input.tunnelId },
        desiredState: "started",
        status: "starting",
      },
      { id: input.tunnelId, protectedRecord: input.protectedRecord },
    );
    if (!tunnel || tunnel.id !== input.tunnelId) {
      throw new Error("Could not register the protected Code tunnel.");
    }
    const now = this.#now();
    const binding: ProtectedCodeAttachmentBinding = {
      attachmentId: tunnel.id,
      authSessionId: input.authSessionId ?? null,
      codeTabId: input.codeTabId,
      createdAt: now,
      explorerId: input.registrationLease?.explorerId ?? null,
      expiresAt: Math.min(now + this.#idleTtlMs, now + this.#maxLifetimeMs),
      generation: Symbol(input.tunnelId),
      hardExpiresAt: now + this.#maxLifetimeMs,
      ownerId: input.ownerId,
      projectId: input.projectId,
      protectedKeyRevision: input.protectedRecord.protectedContent.keyRevision,
      registrationLease: input.registrationLease ?? null,
      serverId: input.serverId ?? null,
      sessionIncarnationId: input.runtime.sessionIncarnationId ?? null,
      sessionId: input.sessionId,
      stopSessionOnRelease: input.stopSessionOnRelease ?? false,
      tunnelId: tunnel.id,
      workerId: input.workerId,
      worktreeId: input.worktreeId ?? null,
      worktreePath: input.worktreePath ?? null,
    };
    this.#attachments.set(binding.attachmentId, binding);
    this.#trackWorkerDisconnect(binding.workerId);
    this.#changed?.({
      attachmentId: binding.attachmentId,
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      tunnelId: binding.tunnelId,
    });
    serverLogger.info("Protected Cantrip Code attachment created", {
      attachmentId: binding.attachmentId,
      codeTabId: binding.codeTabId,
      event: "code.attachment.created",
      operation: "create-attachment",
      sessionId: binding.sessionId,
      status: "completed",
      subsystem: "code",
      tunnelId: binding.tunnelId,
      workerId: binding.workerId,
    });
    return {
      attachmentId: binding.attachmentId,
      tunnelId: binding.tunnelId,
      sessionId: binding.sessionId,
      expiresAt: new Date(binding.expiresAt).toISOString(),
      runtime: input.runtime,
    };
  }

  async revokeAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    const key = this.#attachmentKey(ownerId, attachmentId);
    this.#beginFence(this.#attachmentRevocations, key);
    try {
      await Promise.all([
        this.#waitForRegistrationLeases(
          (lease) =>
            lease.ownerId === ownerId && lease.tunnelId === attachmentId,
        ),
        this.#waitForRegistrations(
          (input) =>
            input.ownerId === ownerId && input.tunnelId === attachmentId,
        ),
      ]);
      return this.#removeCreatedAttachment(attachmentId, ownerId);
    } finally {
      this.#endFence(this.#attachmentRevocations, key);
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.#beginFence(this.#sessionRevocations, sessionId);
    try {
      await Promise.all([
        this.#waitForRegistrationLeases(
          (lease) => lease.sessionId === sessionId,
        ),
        this.#waitForRegistrations((input) => input.sessionId === sessionId),
      ]);
      await this.#revokeWhere((binding) => binding.sessionId === sessionId);
    } finally {
      this.#endFence(this.#sessionRevocations, sessionId);
    }
  }

  async revokeAuthSession(authSessionId: string): Promise<void> {
    this.#beginFence(this.#authSessionRevocations, authSessionId);
    const sharedRevocation =
      this.#sharedTransports.revokeAuthSession(authSessionId);
    void sharedRevocation.catch(() => undefined);
    try {
      await Promise.all([
        this.#waitForRegistrationLeases(
          (lease) => lease.authSessionId === authSessionId,
        ),
        this.#waitForRegistrations(
          (input) => input.authSessionId === authSessionId,
        ),
      ]);
      const finalSharedRevocation =
        this.#sharedTransports.revokeAuthSession(authSessionId);
      await Promise.all([
        this.#revokeWhere((binding) => binding.authSessionId === authSessionId),
        sharedRevocation,
        finalSharedRevocation,
      ]);
    } finally {
      this.#endFence(this.#authSessionRevocations, authSessionId);
    }
  }

  async revokeOwner(ownerId: string): Promise<void> {
    this.#beginFence(this.#ownerRevocations, ownerId);
    const sharedRevocation = this.#sharedTransports.revokeOwner(ownerId);
    void sharedRevocation.catch(() => undefined);
    try {
      await Promise.all([
        this.#waitForRegistrationLeases((lease) => lease.ownerId === ownerId),
        this.#waitForRegistrations((input) => input.ownerId === ownerId),
      ]);
      const finalSharedRevocation = this.#sharedTransports.revokeOwner(ownerId);
      await Promise.all([
        this.#revokeWhere((binding) => binding.ownerId === ownerId),
        sharedRevocation,
        finalSharedRevocation,
      ]);
    } finally {
      this.#endFence(this.#ownerRevocations, ownerId);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    this.#closePromise = (async () => {
      await this.#waitForRegistrationLeases(() => true);
      await Promise.allSettled([
        ...this.#pendingRegistrations.keys(),
        ...this.#pendingSharedRegistrations.keys(),
      ]);
      const bindings = [...this.#attachments.values()];
      const removals = await Promise.allSettled([
        ...bindings.map((binding) => this.#removeAttachment(binding)),
        this.#sharedTransports.close(),
      ]);
      while (this.#deferredSessionStops.size > 0) {
        await Promise.allSettled([...this.#deferredSessionStops.values()]);
      }
      this.#retryFailedDeferredSessionStops();
      while (this.#deferredSessionStops.size > 0) {
        await Promise.allSettled([...this.#deferredSessionStops.values()]);
      }
      removals.slice(0, bindings.length).forEach((result, index) => {
        if (result.status === "rejected") {
          this.#reportCleanupFailure(bindings[index]!, result.reason);
        }
      });
      for (const unsubscribe of this.#workerDisconnectSubscriptions.values()) {
        unsubscribe();
      }
      this.#workerDisconnectSubscriptions.clear();
      const failures = removals
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (this.#failedDeferredSessionStops.size > 0) {
        failures.push(
          new Error(
            `${this.#failedDeferredSessionStops.size} deferred Code session stop(s) remain incomplete.`,
          ),
        );
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Could not revoke every protected Cantrip Code attachment during shutdown.",
        );
      }
    })();
    return this.#closePromise;
  }

  #prune(): void {
    const now = this.#now();
    this.#retryFailedDeferredSessionStops();
    for (const binding of this.#attachments.values()) {
      if (binding.expiresAt <= now || binding.hardExpiresAt <= now) {
        void this.#removeAttachment(binding).catch((error) =>
          this.#reportCleanupFailure(binding, error),
        );
      }
    }
  }

  #retryFailedDeferredSessionStops(): void {
    for (const identity of this.#failedDeferredSessionStops.values()) {
      this.#scheduleDeferredSessionStop(
        identity,
        this.#sessionRegistrationWaits(identity),
      );
    }
  }

  #validateBindingLease(
    binding: ProtectedCodeAttachmentBinding,
  ): CodeAttachmentRootLeaseState | null {
    const now = this.#now();
    if (
      this.#attachments.get(binding.tunnelId) !== binding ||
      this.#removals.has(binding.attachmentId) ||
      binding.expiresAt <= now ||
      binding.hardExpiresAt <= now
    ) {
      if (this.#attachments.get(binding.tunnelId) === binding) {
        void this.#removeAttachment(binding).catch((error) =>
          this.#reportCleanupFailure(binding, error),
        );
      }
      return null;
    }
    return {
      expiresAt: new Date(binding.expiresAt).toISOString(),
      generation: binding.generation,
      hardExpiresAt: new Date(binding.hardExpiresAt).toISOString(),
    };
  }

  #recordBindingActivity(
    binding: ProtectedCodeAttachmentBinding,
  ): CodeAttachmentRootLeaseState | null {
    if (!this.#validateBindingLease(binding)) return null;
    binding.expiresAt = Math.min(
      binding.hardExpiresAt,
      this.#now() + this.#idleTtlMs,
    );
    return this.#validateBindingLease(binding);
  }

  async #removeAttachment(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<boolean> {
    if (this.#attachments.get(binding.attachmentId) !== binding) return false;
    const pending = this.#removals.get(binding.attachmentId);
    if (pending) return pending;
    const registrationLease = binding.registrationLease;
    if (registrationLease) {
      const registrationState =
        this.#registrationLeaseStates.get(registrationLease);
      if (
        registrationState &&
        this.#registrationLeases.get(registrationLease) === registrationState
      ) {
        this.#consumeRegistrationLease(registrationLease, registrationState);
      }
    }
    const removal = this.#removeOwnedAttachment(binding).finally(() => {
      if (this.#removals.get(binding.attachmentId) === removal) {
        this.#removals.delete(binding.attachmentId);
      }
    });
    this.#removals.set(binding.attachmentId, removal);
    return removal;
  }

  async #removeOwnedAttachment(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<boolean> {
    if (!this.#repository) {
      throw new Error("Cantrip Code protected control plane is unavailable.");
    }
    const tunnelRemoval = await Promise.allSettled([
      this.#repository.removeManagedTunnel(binding.ownerId, {
        kind: "code",
        id: binding.tunnelId,
      }),
    ]);
    const resourceCleanup = await Promise.allSettled([
      this.#cleanupTunnelResources?.(
        binding.ownerId,
        binding.tunnelId,
        "Code attachment revoked",
        1008,
      ),
      this.bridge.isConnected(binding.workerId)
        ? this.bridge
            .request(
              binding.workerId,
              { type: "code.endpoint.revoke", tunnelId: binding.tunnelId },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined)
        : Promise.resolve(),
    ]);
    const resourceFailures = [...tunnelRemoval, ...resourceCleanup]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    await this.#releaseSessionOwnership(binding);
    if (resourceFailures.length > 0) {
      throw new AggregateError(
        resourceFailures,
        "Could not clean up every protected Cantrip Code resource.",
      );
    }
    this.#attachments.delete(binding.attachmentId);
    for (const [relayAttachmentId, relayBinding] of this.#relayAttachments) {
      if (relayBinding === binding) {
        this.#relayAttachments.delete(relayAttachmentId);
      }
    }
    this.#changed?.({
      attachmentId: binding.attachmentId,
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      tunnelId: binding.tunnelId,
    });
    this.#stopTrackingWorkerIfUnused(binding.workerId);
    if (binding.explorerId) {
      const key = this.#explorerKey(binding.ownerId, binding.explorerId);
      const lifecycle = this.#explorerLifecycles.get(key);
      if (lifecycle) {
        this.#removeExplorerLifecycleIfUnused(
          binding.ownerId,
          binding.explorerId,
          lifecycle,
        );
      }
    }
    serverLogger.info("Protected Cantrip Code attachment revoked", {
      attachmentId: binding.attachmentId,
      codeTabId: binding.codeTabId,
      event: "code.attachment.revoked",
      operation: "revoke-attachment",
      sessionId: binding.sessionId,
      status: "completed",
      subsystem: "code",
      tunnelId: binding.tunnelId,
      workerId: binding.workerId,
    });
    return true;
  }

  async #releaseSessionOwnership(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<void> {
    if (!binding.stopSessionOnRelease) return;
    await this.#enqueueSessionStopOperation(binding, () =>
      this.#stopSessionIfUnowned(binding),
    );
  }

  async #enqueueSessionStopOperation<T>(
    identity: CodeSessionOwnershipIdentity,
    stopIfUnowned: () => Promise<T>,
  ): Promise<T> {
    const ownershipKey = this.#workerSessionOwnershipKey(identity);
    const previous = this.#sessionStopOperations.get(ownershipKey);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(stopIfUnowned);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionStopOperations.set(ownershipKey, tail);
    try {
      return await operation;
    } finally {
      if (this.#sessionStopOperations.get(ownershipKey) === tail) {
        this.#sessionStopOperations.delete(ownershipKey);
        this.#sessionStopIncarnations.delete(ownershipKey);
      }
    }
  }

  async #stopSessionIfUnowned(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<void> {
    await this.#stopUnifiedSessionIfUnowned(binding);
  }

  async #stopAbortedRegistrationIfUnowned(
    identity: CodeSessionOwnershipIdentity,
  ): Promise<void> {
    await this.#stopUnifiedSessionIfUnowned(identity);
  }

  async #stopSharedSessionIfUnowned(
    identity: SharedCodeSessionOwnershipIdentity,
  ): Promise<void> {
    await this.#stopUnifiedSessionIfUnowned(identity);
  }

  async #stopUnifiedSessionIfUnowned(
    identity: CodeSessionOwnershipIdentity,
  ): Promise<void> {
    if (!identity.sessionIncarnationId) return;
    const sessionKey = this.#sessionOwnershipKey(
      identity.ownerId,
      identity.sessionId,
    );
    this.#beginFence(this.#sessionStopFences, sessionKey);
    try {
      const registrationWaits = await this.#stopSessionOrReturnWaits(identity);
      if (registrationWaits.length > 0) {
        this.#scheduleDeferredSessionStop(identity, registrationWaits);
      }
    } finally {
      this.#endFence(this.#sessionStopFences, sessionKey);
    }
  }

  async #stopSessionOrReturnWaits(
    identity: CodeSessionOwnershipIdentity,
  ): Promise<readonly Promise<void>[]> {
    const sessionIncarnationId = identity.sessionIncarnationId;
    if (!sessionIncarnationId) return [];
    const registrationWaits = this.#sessionRegistrationWaits(identity);
    if (registrationWaits.length > 0) return registrationWaits;
    if (
      [...this.#attachments.values()].some(
        (binding) =>
          !this.#removals.has(binding.attachmentId) &&
          binding.ownerId === identity.ownerId &&
          binding.workerId === identity.workerId &&
          binding.sessionId === identity.sessionId &&
          binding.sessionIncarnationId === identity.sessionIncarnationId,
      ) ||
      this.#sharedTransports.hasSessionOwnership({
        ownerId: identity.ownerId,
        sessionId: identity.sessionId,
        sessionIncarnationId,
        workerId: identity.workerId,
      })
    ) {
      return [];
    }
    await this.#requestConditionalSessionStop(identity);
    return [];
  }

  #scheduleDeferredSessionStop(
    identity: CodeSessionOwnershipIdentity,
    waits: readonly Promise<void>[],
  ): void {
    const deferredKey = `${this.#workerSessionOwnershipKey(identity)}:${identity.sessionIncarnationId ?? "none"}`;
    if (this.#deferredSessionStops.has(deferredKey)) return;
    const operation = (async () => {
      let currentWaits = waits;
      do {
        await Promise.allSettled(currentWaits);
        currentWaits = await this.#enqueueSessionStopOperation(
          identity,
          async () => {
            const sessionKey = this.#sessionOwnershipKey(
              identity.ownerId,
              identity.sessionId,
            );
            this.#beginFence(this.#sessionStopFences, sessionKey);
            try {
              return await this.#stopSessionOrReturnWaits(identity);
            } finally {
              this.#endFence(this.#sessionStopFences, sessionKey);
            }
          },
        );
      } while (currentWaits.length > 0);
      this.#failedDeferredSessionStops.delete(deferredKey);
    })()
      .catch((error) => {
        const firstFailure = !this.#failedDeferredSessionStops.has(deferredKey);
        this.#failedDeferredSessionStops.set(deferredKey, identity);
        if (firstFailure) {
          serverLogger.warn("Deferred Cantrip Code session stop failed", {
            event: "code.session.deferred-stop-failed",
            operation: "stop-session",
            reasonCode: "session-stop-failed",
            sessionId: identity.sessionId,
            status: "failed",
            subsystem: "code",
            workerId: identity.workerId,
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.#deferredSessionStops.get(deferredKey) === operation) {
          this.#deferredSessionStops.delete(deferredKey);
        }
      });
    this.#deferredSessionStops.set(deferredKey, operation);
    void operation.catch(() => undefined);
  }

  async #requestConditionalSessionStop(
    identity: CodeSessionOwnershipIdentity,
  ): Promise<void> {
    if (!identity.sessionIncarnationId) return;
    const ownershipKey = this.#workerSessionOwnershipKey(identity);
    if (
      this.#sessionStopIncarnations.get(ownershipKey) ===
      identity.sessionIncarnationId
    ) {
      return;
    }
    const status = codeRuntimeStatusSchema.parse(
      await this.bridge.request(
        identity.workerId,
        {
          type: "code.stop",
          sessionId: identity.sessionId,
          expectedSessionIncarnationId: identity.sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      ),
    );
    if (status.sessionId !== identity.sessionId) {
      throw new Error(
        "Worker acknowledged a conditional Code session stop for the wrong session.",
      );
    }
    if (status.sessionIncarnationId === identity.sessionIncarnationId) {
      throw new Error(
        "Worker acknowledged a conditional Code session stop while the stopped incarnation remained current.",
      );
    }
    if (status.sessionIncarnationId == null && status.status !== "stopped") {
      throw new Error(
        "Worker acknowledged a conditional Code session stop with an invalid terminal status.",
      );
    }
    this.#sessionStopIncarnations.set(
      ownershipKey,
      identity.sessionIncarnationId,
    );
  }

  async #revokeWhere(
    predicate: (binding: ProtectedCodeAttachmentBinding) => boolean,
  ): Promise<void> {
    const removals = await Promise.allSettled(
      [...this.#attachments.values()]
        .filter(predicate)
        .map((binding) => this.#removeAttachment(binding)),
    );
    const failures = removals
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Could not revoke every protected Cantrip Code attachment.",
      );
    }
  }

  async #withExplorerRegistration<T>(
    lease: CodeAttachmentRegistrationLease,
    registration: () => Promise<T>,
  ): Promise<T> {
    if (!lease.explorerId) {
      throw new ExplorerCodeAttachmentLeaseError(
        "The Explorer changed while its editor was opening.",
      );
    }
    const key = this.#explorerKey(lease.ownerId, lease.explorerId);
    const lifecycle = this.#explorerLifecycles.get(key);
    if (!this.#explorerLeaseIsActive(lifecycle, lease)) {
      throw new ExplorerCodeAttachmentLeaseError(
        "The Explorer changed while its editor was opening.",
      );
    }
    const queued = this.#enqueueExplorerLifecycle(lifecycle);
    await queued.previous;
    try {
      if (!this.#explorerLeaseIsActive(lifecycle, lease)) {
        throw new ExplorerCodeAttachmentLeaseError(
          "The Explorer changed while its editor was opening.",
        );
      }
      const result = await registration();
      if (!this.#explorerLeaseIsActive(lifecycle, lease)) {
        if (
          typeof result === "object" &&
          result !== null &&
          "attachmentId" in result &&
          typeof result.attachmentId === "string"
        ) {
          await this.#removeCreatedAttachment(
            result.attachmentId,
            lease.ownerId,
          );
        }
        throw new ExplorerCodeAttachmentLeaseError(
          "The Explorer changed while its editor was opening.",
        );
      }
      return result;
    } finally {
      queued.release();
    }
  }

  #enqueueExplorerLifecycle(lifecycle: ExplorerCodeLifecycle): {
    previous: Promise<void>;
    release: () => void;
  } {
    const previous = lifecycle.tail.catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    lifecycle.tail = previous.then(() => current);
    return { previous, release };
  }

  #explorerLeaseIsActive(
    lifecycle: ExplorerCodeLifecycle | undefined,
    lease: CodeAttachmentRegistrationLease,
  ): lifecycle is ExplorerCodeLifecycle {
    const state = this.#registrationLeaseStates.get(lease);
    return Boolean(
      lifecycle &&
      lease.explorerId &&
      state &&
      state.explorerLifecycle === lifecycle &&
      this.#registrationLeases.get(lease) === state &&
      lifecycle.mutationCount === 0 &&
      lifecycle.generation === lease.explorerGeneration &&
      this.#explorerLifecycles.get(
        this.#explorerKey(lease.ownerId, lease.explorerId),
      ) === lifecycle,
    );
  }

  #explorerKey(ownerId: string, explorerId: string): string {
    return `${ownerId.length}:${ownerId}${explorerId}`;
  }

  #attachmentKey(ownerId: string, attachmentId: string): string {
    return `${ownerId.length}:${ownerId}${attachmentId}`;
  }

  #sessionOwnershipKey(ownerId: string, sessionId: string): string {
    return `${ownerId.length}:${ownerId}${sessionId.length}:${sessionId}`;
  }

  #workerSessionOwnershipKey(
    binding: Pick<
      CodeSessionOwnershipIdentity,
      "ownerId" | "sessionId" | "workerId"
    >,
  ): string {
    return `${this.#sessionOwnershipKey(binding.ownerId, binding.sessionId)}${binding.workerId.length}:${binding.workerId}`;
  }

  #deferredStopCapacityReached(ownerId: string): boolean {
    if (this.#failedDeferredSessionStops.size >= this.#maxAttachments * 8) {
      return true;
    }
    let ownerStops = 0;
    for (const identity of this.#failedDeferredSessionStops.values()) {
      if (identity.ownerId === ownerId) ownerStops += 1;
    }
    return ownerStops >= this.#maxAttachments;
  }

  #workerSecurityKey(
    ownerId: string,
    workerId: string,
    protectedKeyRevision: number | "all",
  ): string {
    return `${ownerId.length}:${ownerId}${workerId.length}:${workerId}:${protectedKeyRevision}`;
  }

  #sharedTransportKey(
    ownerId: string,
    authSessionId: string,
    transportId: string,
  ): string {
    return `${ownerId.length}:${ownerId}${authSessionId.length}:${authSessionId}${transportId}`;
  }

  #sharedAttachmentKey(
    ownerId: string,
    authSessionId: string,
    attachmentId: string,
  ): string {
    return `${ownerId.length}:${ownerId}${authSessionId.length}:${authSessionId}${attachmentId}`;
  }

  #sharedSecurityRegistrationIsFenced(
    input: CreateSharedCodeSessionAttachmentInput,
  ): boolean {
    return Boolean(
      this.#closed ||
      this.#ownerRevocations.has(input.ownerId) ||
      this.#authSessionRevocations.has(input.authSessionId) ||
      this.#sharedAttachmentRevocations.has(
        this.#sharedAttachmentKey(
          input.ownerId,
          input.authSessionId,
          input.attachmentId,
        ),
      ) ||
      this.#sharedTransportRevocations.has(
        this.#sharedTransportKey(
          input.ownerId,
          input.authSessionId,
          input.transport.transportId,
        ),
      ) ||
      this.#sessionStopFences.has(
        this.#sessionOwnershipKey(input.ownerId, input.sessionId),
      ) ||
      this.#workerSecurityRevocations.has(
        this.#workerSecurityKey(input.ownerId, input.workerId, "all"),
      ) ||
      this.#workerSecurityRevocations.has(
        this.#workerSecurityKey(
          input.ownerId,
          input.workerId,
          input.protectedKeyRevision,
        ),
      ),
    );
  }

  #assertSharedSecurityRegistrationAllowed(
    input: CreateSharedCodeSessionAttachmentInput,
  ): void {
    if (!this.#sharedSecurityRegistrationIsFenced(input)) return;
    throw new Error(
      this.#closed
        ? "The Cantrip Code tunnel broker is shutting down."
        : "The shared Cantrip Code security identity is being revoked.",
    );
  }

  #sessionRegistrationWaits(
    identity: CodeSessionOwnershipIdentity,
  ): Promise<void>[] {
    return [
      ...[...this.#registrationLeases].flatMap(([lease, state]) =>
        lease.ownerId === identity.ownerId &&
        lease.sessionId === identity.sessionId
          ? [state.released]
          : [],
      ),
      ...[...this.#pendingRegistrations].flatMap(([pending, input]) =>
        input.ownerId === identity.ownerId &&
        input.workerId === identity.workerId &&
        input.sessionId === identity.sessionId &&
        input.runtime.sessionIncarnationId === identity.sessionIncarnationId
          ? [pending]
          : [],
      ),
      ...[...this.#pendingSharedRegistrations].flatMap(([pending, input]) =>
        input.ownerId === identity.ownerId &&
        input.workerId === identity.workerId &&
        input.sessionId === identity.sessionId &&
        input.runtime.sessionIncarnationId === identity.sessionIncarnationId
          ? [pending]
          : [],
      ),
    ];
  }

  #assertRegistrationAllowed(input: CreateProtectedCodeAttachmentInput): void {
    const lease = input.registrationLease;
    if (
      lease &&
      (lease.ownerId !== input.ownerId ||
        lease.authSessionId !== (input.authSessionId ?? null) ||
        lease.sessionId !== input.sessionId ||
        lease.tunnelId !== input.tunnelId)
    ) {
      throw new Error(
        "The protected Cantrip Code registration lease does not match this attachment.",
      );
    }
    const sessionStopFenced = this.#sessionStopFences.has(
      this.#sessionOwnershipKey(input.ownerId, input.sessionId),
    );
    if (
      !this.#registrationIsFenced(input) &&
      !this.#deferredStopCapacityReached(input.ownerId) &&
      (!sessionStopFenced || Boolean(lease)) &&
      (!lease || this.registrationLeaseIsActive(lease))
    ) {
      return;
    }
    if (lease?.explorerId && !this.#closed) {
      throw new ExplorerCodeAttachmentLeaseError(
        "The Explorer changed while its editor was opening.",
      );
    }
    throw new Error(
      this.#closed
        ? "The Cantrip Code tunnel broker is shutting down."
        : "The protected Cantrip Code attachment is being revoked.",
    );
  }

  #registrationIsFenced(input: CreateProtectedCodeAttachmentInput): boolean {
    return this.#registrationIdentityIsFenced({
      authSessionId: input.authSessionId ?? null,
      explorerId: input.registrationLease?.explorerId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      tunnelId: input.tunnelId,
    });
  }

  #registrationIdentityIsFenced(
    input: CodeAttachmentRegistrationLeaseInput,
  ): boolean {
    return Boolean(
      this.#closed ||
      this.#ownerRevocations.has(input.ownerId) ||
      this.#sessionRevocations.has(input.sessionId) ||
      (input.authSessionId &&
        this.#authSessionRevocations.has(input.authSessionId)) ||
      this.#attachmentRevocations.has(
        this.#attachmentKey(input.ownerId, input.tunnelId),
      ),
    );
  }

  async #waitForRegistrations(
    predicate: (input: CreateProtectedCodeAttachmentInput) => boolean,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#pendingRegistrations]
        .filter(([, input]) => predicate(input))
        .map(([pending]) => pending),
    );
  }

  async #waitForSharedRegistrations(
    predicate: (input: CreateSharedCodeSessionAttachmentInput) => boolean,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#pendingSharedRegistrations]
        .filter(([, input]) => predicate(input))
        .map(([pending]) => pending),
    );
  }

  async #waitForRegistrationLeases(
    predicate: (lease: CodeAttachmentRegistrationLease) => boolean,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#registrationLeases]
        .filter(([lease]) => predicate(lease))
        .map(([, state]) => state.released),
    );
  }

  async #removeCreatedAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    const binding = this.#attachments.get(attachmentId);
    if (!binding || binding.ownerId !== ownerId) return false;
    return this.#removeAttachment(binding);
  }

  #beginFence(fences: Map<string, number>, key: string): void {
    fences.set(key, (fences.get(key) ?? 0) + 1);
  }

  #endFence(fences: Map<string, number>, key: string): void {
    const remaining = (fences.get(key) ?? 1) - 1;
    if (remaining > 0) fences.set(key, remaining);
    else fences.delete(key);
  }

  #removeExplorerLifecycleIfUnused(
    ownerId: string,
    explorerId: string,
    lifecycle: ExplorerCodeLifecycle,
  ): void {
    const key = this.#explorerKey(ownerId, explorerId);
    if (
      this.#explorerLifecycles.get(key) !== lifecycle ||
      lifecycle.leaseCount > 0 ||
      lifecycle.mutationCount > 0 ||
      [...this.#attachments.values()].some(
        (binding) =>
          binding.ownerId === ownerId && binding.explorerId === explorerId,
      )
    ) {
      return;
    }
    this.#explorerLifecycles.delete(key);
  }

  #trackWorkerDisconnect(workerId: string): void {
    if (this.#workerDisconnectSubscriptions.has(workerId)) return;
    const unsubscribe = subscribeWorkerTerminalOffline(
      this.bridge,
      workerId,
      () => {
        for (const binding of [...this.#attachments.values()]) {
          if (binding.workerId !== workerId) continue;
          void this.#removeAttachment(binding).catch((error) =>
            this.#reportCleanupFailure(binding, error),
          );
        }
        this.#stopTrackingWorkerIfUnused(workerId);
      },
    );
    this.#workerDisconnectSubscriptions.set(workerId, unsubscribe);
  }

  #stopTrackingWorkerIfUnused(workerId: string): void {
    if (
      [...this.#attachments.values()].some(
        (binding) => binding.workerId === workerId,
      )
    )
      return;
    this.#workerDisconnectSubscriptions.get(workerId)?.();
    this.#workerDisconnectSubscriptions.delete(workerId);
  }

  #reportCleanupFailure(
    binding: ProtectedCodeAttachmentBinding,
    error: unknown,
  ): void {
    serverLogger.warn("Protected Cantrip Code cleanup failed", {
      event: "code.attachment.cleanup-failed",
      subsystem: "code",
      operation: "revoke-attachment",
      reasonCode: "managed-tunnel-cleanup-failed",
      status: "failed",
      attachmentId: binding.attachmentId,
      codeTabId: binding.codeTabId,
      sessionId: binding.sessionId,
      tunnelId: binding.tunnelId,
      workerId: binding.workerId,
      errorClass: error instanceof Error ? error.name : "Error",
    });
  }
}
