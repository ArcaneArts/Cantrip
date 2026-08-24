import { randomBytes, randomUUID } from "node:crypto";

import { normalizeLogError, type ServiceLogger } from "@cantrip/logging";
import {
  directAttachmentTicketSchema,
  directCapabilityPrepareResultSchema,
  type DirectAttachmentTicket,
  type DirectResourceKind,
  type DirectTransportTelemetry,
  type WorkerCommand,
  type WorkerSummary,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";
import { serverLogger } from "../logger.js";

interface DirectGrant {
  activatedAtMs: number | null;
  activationAttemptCount: number;
  activationCount: number;
  attachmentId: string;
  authSessionId: string;
  createdAtMs: number;
  diagnosticTraceId: string;
  leaseExpiresAtMs: number;
  mode: "direct-capability" | "direct-tunnel";
  ownerId: string;
  resourceId: string;
  resourceKind: DirectResourceKind;
  telemetryObservedAtMs: number | null;
  telemetryReportCount: number;
  timer: ReturnType<typeof setTimeout>;
  unsubscribeDisconnect: () => void;
  workerId: string;
  telemetry: DirectTransportTelemetry;
}

interface DirectResourceLifecycle {
  generation: symbol;
  pending: Set<Promise<void>>;
  revocationCount: number;
  tail: Promise<void>;
}

export interface DirectAttachmentPreparationLeaseInput {
  readonly attachmentId?: string;
  readonly authSessionId: string;
  readonly ownerId: string;
  readonly resourceId: string | null;
  readonly resourceKind: DirectResourceKind;
}

export interface DirectAttachmentPreparationLease extends DirectAttachmentPreparationLeaseInput {}

interface DirectAttachmentPreparationLeaseState {
  resourceId: string | null;
  readonly release: () => void;
  readonly released: Promise<void>;
}

export interface DirectTransportTelemetryDelta extends DirectTransportTelemetry {
  resourceId: string;
  resourceKind: DirectResourceKind;
}

export type DirectAttachmentActivationOutcome =
  | "attachment_missing"
  | "attachment_stale"
  | "capability_mismatch"
  | "completed";

export interface DirectAttachmentPrepareInput {
  attachmentId?: string;
  authSessionId: string;
  channels: string[];
  diagnosticTraceId?: string;
  ownerId: string;
  preparationLease: DirectAttachmentPreparationLease;
  resourceId: string;
  resourceKind: DirectResourceKind;
  leaseExpiresAt?: Date;
  tunnelRoute?: Extract<
    WorkerCommand,
    { type: "direct.capability.prepare" }
  >["tunnelRoute"];
  worker: WorkerSummary;
}

const CAPABILITY_TTL_MS = 15_000;
const LEASE_TTL_MS = 60_000;
const SAFE_ERROR_CLASSES = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "SyntaxError",
  "TypeError",
  "WorkerUnavailableError",
  "ZodError",
]);
const SAFE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_STATE",
  "ERR_SOCKET_CLOSED",
]);

export class DirectAttachmentUnavailableError extends Error {}

export class DirectAttachmentCoordinator {
  readonly #attachmentRevocations = new Map<string, number>();
  readonly #grants = new Map<string, DirectGrant>();
  readonly #ownerRevocations = new Map<string, number>();
  readonly #preparationLeases = new Map<
    DirectAttachmentPreparationLease,
    DirectAttachmentPreparationLeaseState
  >();
  readonly #preparationLeaseStates = new WeakMap<
    DirectAttachmentPreparationLease,
    DirectAttachmentPreparationLeaseState
  >();
  readonly #pendingPreparations = new Map<
    Promise<void>,
    DirectAttachmentPrepareInput
  >();
  readonly #resourceLifecycles = new Map<string, DirectResourceLifecycle>();
  readonly #resourceKindRevocations = new Map<string, number>();
  readonly #sessionRevocations = new Map<string, number>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    private readonly workers: WorkerCommandBus,
    private readonly logger: ServiceLogger = serverLogger,
  ) {}

  acquirePreparationLease(
    input: DirectAttachmentPreparationLeaseInput,
  ): DirectAttachmentPreparationLease | null {
    if (this.#preparationIdentityIsFenced(input)) return null;
    const lease: DirectAttachmentPreparationLease = { ...input };
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { release, released, resourceId: input.resourceId };
    this.#preparationLeases.set(lease, state);
    this.#preparationLeaseStates.set(lease, state);
    return lease;
  }

  bindPreparationLease(
    lease: DirectAttachmentPreparationLease,
    resourceKind: DirectResourceKind,
    resourceId: string,
  ): boolean {
    const state = this.#preparationLeaseStates.get(lease);
    if (
      !state ||
      this.#preparationLeases.get(lease) !== state ||
      lease.resourceKind !== resourceKind ||
      (state.resourceId !== null && state.resourceId !== resourceId) ||
      this.#resourceKindRevocations.has(
        this.#resourceKindKey(lease.ownerId, resourceKind),
      ) ||
      this.#preparationIdentityIsFenced({
        ...lease,
        resourceId,
      })
    ) {
      return false;
    }
    state.resourceId = resourceId;
    return true;
  }

  releasePreparationLease(lease: DirectAttachmentPreparationLease): void {
    const state = this.#preparationLeaseStates.get(lease);
    if (!state || this.#preparationLeases.get(lease) !== state) return;
    this.#preparationLeaseStates.delete(lease);
    this.#preparationLeases.delete(lease);
    state.release();
  }

  preparationLeaseIsActive(lease: DirectAttachmentPreparationLease): boolean {
    const state = this.#preparationLeaseStates.get(lease);
    return Boolean(
      state &&
      this.#preparationLeases.get(lease) === state &&
      !this.#preparationIdentityIsFenced({
        ...lease,
        resourceId: state.resourceId,
      }),
    );
  }

  async prepare(
    input: DirectAttachmentPrepareInput,
  ): Promise<DirectAttachmentTicket> {
    if (!this.#preparationLeaseMatches(input)) {
      throw new DirectAttachmentUnavailableError(
        this.#closed
          ? "The direct attachment coordinator is shutting down."
          : "The owning resource is being revoked.",
      );
    }
    const key = this.#resourceKey(
      input.ownerId,
      input.resourceKind,
      input.resourceId,
    );
    const lifecycle = this.#resourceLifecycle(key);
    if (lifecycle.revocationCount > 0) {
      throw new DirectAttachmentUnavailableError(
        "The owning resource is being revoked.",
      );
    }
    const generation = lifecycle.generation;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    lifecycle.pending.add(pending);
    this.#pendingPreparations.set(pending, input);
    try {
      const ticket = await this.#prepare(input);
      if (
        !this.#preparationLeaseMatches(input) ||
        lifecycle.generation !== generation ||
        lifecycle.revocationCount > 0 ||
        this.#resourceLifecycles.get(key) !== lifecycle
      ) {
        await this.revoke(
          ticket.binding.capabilityId,
          "Owning resource was revoked",
        );
        throw new DirectAttachmentUnavailableError(
          "The owning resource changed while direct access was being prepared.",
        );
      }
      return ticket;
    } finally {
      lifecycle.pending.delete(pending);
      this.#pendingPreparations.delete(pending);
      finish();
      this.#removeResourceLifecycleIfUnused(key, lifecycle);
    }
  }

  async #prepare(
    input: DirectAttachmentPrepareInput,
  ): Promise<DirectAttachmentTicket> {
    const startedAtMs = Date.now();
    const diagnosticTraceId = input.diagnosticTraceId ?? randomUUID();
    const mode = input.tunnelRoute ? "direct-tunnel" : "direct-capability";
    this.logger.debug("Direct attachment capability requested", {
      event: "direct_attachment.prepare.started",
      subsystem: "direct-attachment",
      operation: "prepare",
      status: "started",
      diagnosticTraceId,
      mode,
      attachmentId: input.attachmentId,
      resourceKind: input.resourceKind,
      workerId: input.worker.workerId,
      channelCount: new Set(input.channels).size,
    });
    if (
      !input.worker.online ||
      !this.workers.isConnected(input.worker.workerId)
    ) {
      this.#logPrepareFailure(
        diagnosticTraceId,
        input,
        mode,
        startedAtMs,
        "worker_offline",
      );
      throw new DirectAttachmentUnavailableError("Worker is offline.");
    }
    if (!input.worker.directBroker.available) {
      this.#logPrepareFailure(
        diagnosticTraceId,
        input,
        mode,
        startedAtMs,
        "direct_broker_unavailable",
      );
      throw new DirectAttachmentUnavailableError(
        "Worker does not offer a local direct broker.",
      );
    }
    const now = Date.now();
    const capabilityId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const requestedLease = input.leaseExpiresAt?.getTime();
    const leaseExpiresAt = Math.min(
      Number.isFinite(requestedLease) ? requestedLease! : now + LEASE_TTL_MS,
      now + 12 * 60 * 60_000,
    );
    if (leaseExpiresAt <= now) {
      this.#logPrepareFailure(
        diagnosticTraceId,
        input,
        mode,
        startedAtMs,
        "lease_expired",
      );
      throw new DirectAttachmentUnavailableError(
        "Direct attachment lease has already expired.",
      );
    }
    const binding = {
      capabilityId,
      ownerId: input.ownerId,
      authSessionId: input.authSessionId,
      workerId: input.worker.workerId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      attachmentId: input.attachmentId ?? randomUUID(),
      channels: [...new Set(input.channels)],
      expiresAt: new Date(now + CAPABILITY_TTL_MS).toISOString(),
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
    };
    const ticket = directAttachmentTicketSchema.parse({
      broker: input.worker.directBroker,
      binding,
      secret,
    });
    let prepared: ReturnType<typeof directCapabilityPrepareResultSchema.parse>;
    try {
      prepared = directCapabilityPrepareResultSchema.parse(
        await this.workers.request(
          input.worker.workerId,
          {
            type: "direct.capability.prepare",
            diagnosticTraceId,
            binding,
            secret,
            tunnelRoute: input.tunnelRoute ?? null,
          },
          { ownerId: input.ownerId, timeoutMs: 5_000 },
        ),
      );
    } catch (error) {
      this.#logPrepareFailure(
        diagnosticTraceId,
        input,
        mode,
        startedAtMs,
        "worker_prepare_failed",
        error,
      );
      throw new DirectAttachmentUnavailableError(
        "Worker could not prepare a local direct capability.",
      );
    }
    if (prepared.capabilityId !== capabilityId) {
      this.#logPrepareFailure(
        diagnosticTraceId,
        input,
        mode,
        startedAtMs,
        "worker_ack_mismatch",
      );
      throw new Error("Worker acknowledged another direct capability.");
    }
    const timer = setTimeout(
      () => void this.revoke(capabilityId, "Direct capability expired"),
      Math.max(1, leaseExpiresAt - now),
    );
    timer.unref();
    const unsubscribeDisconnect = this.workers.subscribeWorkerDisconnect(
      input.worker.workerId,
      () => this.#finalize(capabilityId, "worker_disconnected"),
    );
    this.#grants.set(capabilityId, {
      activatedAtMs: null,
      activationAttemptCount: 0,
      activationCount: 0,
      attachmentId: binding.attachmentId,
      authSessionId: input.authSessionId,
      createdAtMs: startedAtMs,
      diagnosticTraceId,
      leaseExpiresAtMs: leaseExpiresAt,
      mode,
      ownerId: input.ownerId,
      resourceId: input.resourceId,
      resourceKind: input.resourceKind,
      telemetryObservedAtMs: null,
      telemetryReportCount: 0,
      timer,
      unsubscribeDisconnect,
      workerId: input.worker.workerId,
      telemetry: {
        bytesFromLocal: 0,
        bytesToLocal: 0,
        connectionsClosed: 0,
        connectionsOpened: 0,
      },
    });
    this.logger.info("Direct attachment capability prepared", {
      event: "direct_attachment.prepare.completed",
      subsystem: "direct-attachment",
      operation: "prepare",
      status: "completed",
      diagnosticTraceId,
      mode,
      attachmentId: binding.attachmentId,
      resourceId: input.resourceId,
      resourceKind: input.resourceKind,
      workerId: input.worker.workerId,
      durationMs: Date.now() - startedAtMs,
      channelCount: binding.channels.length,
      leaseDurationMs: leaseExpiresAt - now,
    });
    return ticket;
  }

  async revoke(
    capabilityId: string,
    reason: string,
    authorization?: { authSessionId: string; ownerId: string },
  ): Promise<boolean> {
    const grant = this.#grants.get(capabilityId);
    if (!grant) return false;
    if (
      authorization &&
      (grant.ownerId !== authorization.ownerId ||
        grant.authSessionId !== authorization.authSessionId)
    ) {
      return false;
    }
    const reasonCode = directRevocationReasonCode(reason);
    this.#finalize(capabilityId, reasonCode);
    const revokeStartedAtMs = Date.now();
    const delivered = await this.workers
      .request(
        grant.workerId,
        {
          type: "direct.capability.revoke",
          capabilityId,
          reason,
        },
        { ownerId: grant.ownerId, timeoutMs: 5_000 },
      )
      .then(() => true)
      .catch(() => false);
    const log = delivered ? this.logger.info : this.logger.warn;
    log.call(this.logger, "Direct attachment capability revoked", {
      event: "direct_attachment.revoked",
      subsystem: "direct-attachment",
      operation: "revoke",
      status: delivered ? "completed" : "degraded",
      reasonCode,
      success: delivered,
      diagnosticTraceId: grant.diagnosticTraceId,
      mode: grant.mode,
      attachmentId: grant.attachmentId,
      resourceId: grant.resourceId,
      resourceKind: grant.resourceKind,
      workerId: grant.workerId,
      durationMs: Date.now() - revokeStartedAtMs,
    });
    return true;
  }

  async revokeSession(authSessionId: string): Promise<void> {
    this.#beginFence(this.#sessionRevocations, authSessionId);
    try {
      await Promise.all([
        this.#waitForPreparationLeases(
          (lease) => lease.authSessionId === authSessionId,
        ),
        this.#waitForPreparations(
          (input) => input.authSessionId === authSessionId,
        ),
      ]);
      await Promise.all(
        [...this.#grants]
          .filter(([, grant]) => grant.authSessionId === authSessionId)
          .map(([capabilityId]) =>
            this.revoke(capabilityId, "Authorization session was revoked"),
          ),
      );
    } finally {
      this.#endFence(this.#sessionRevocations, authSessionId);
    }
  }

  matches(
    capabilityId: string,
    authorization: {
      attachmentId: string;
      authSessionId: string;
      ownerId: string;
    },
  ): boolean {
    const grant = this.#grants.get(capabilityId);
    return Boolean(
      grant &&
      grant.ownerId === authorization.ownerId &&
      grant.authSessionId === authorization.authSessionId &&
      grant.attachmentId === authorization.attachmentId,
    );
  }

  recordActivationOutcome(
    capabilityId: string,
    authorization: {
      attachmentId: string;
      authSessionId: string;
      ownerId: string;
    },
    outcome: DirectAttachmentActivationOutcome,
  ): boolean {
    const grant = this.#grants.get(capabilityId);
    if (
      !grant ||
      grant.ownerId !== authorization.ownerId ||
      grant.authSessionId !== authorization.authSessionId ||
      grant.attachmentId !== authorization.attachmentId
    ) {
      this.logger.rateLimited(
        `direct-activation-uncorrelated:${authorization.ownerId}`,
        "warn",
        "Direct attachment activation could not be correlated",
        {
          event: "direct_attachment.activation.uncorrelated",
          subsystem: "direct-attachment",
          operation: "activate",
          status: outcome === "capability_mismatch" ? "rejected" : "degraded",
          reasonCode:
            outcome === "capability_mismatch"
              ? "capability_mismatch"
              : "grant_missing",
          mode: "local-direct",
          attachmentId: authorization.attachmentId,
        },
      );
      return false;
    }
    const now = Date.now();
    grant.activationAttemptCount += 1;
    if (outcome === "completed") {
      grant.activationCount += 1;
      grant.activatedAtMs ??= now;
      this.logger.info("Direct attachment route activated", {
        event: "direct_attachment.activation.completed",
        subsystem: "direct-attachment",
        operation: "activate",
        status: "completed",
        diagnosticTraceId: grant.diagnosticTraceId,
        mode: "local-direct",
        attachmentId: grant.attachmentId,
        resourceId: grant.resourceId,
        resourceKind: grant.resourceKind,
        workerId: grant.workerId,
        durationMs: now - grant.createdAtMs,
        activationAttemptCount: grant.activationAttemptCount,
        activationCount: grant.activationCount,
      });
      return true;
    }
    this.logger.warn("Direct attachment activation rejected", {
      event: "direct_attachment.activation.rejected",
      subsystem: "direct-attachment",
      operation: "activate",
      status: "rejected",
      reasonCode: outcome,
      diagnosticTraceId: grant.diagnosticTraceId,
      mode: "local-direct",
      attachmentId: grant.attachmentId,
      resourceId: grant.resourceId,
      resourceKind: grant.resourceKind,
      workerId: grant.workerId,
      durationMs: now - grant.createdAtMs,
      activationAttemptCount: grant.activationAttemptCount,
      activationCount: grant.activationCount,
    });
    return true;
  }

  recordTelemetry(
    capabilityId: string,
    authorization: { authSessionId: string; ownerId: string },
    telemetry: DirectTransportTelemetry,
  ): DirectTransportTelemetryDelta | null {
    const grant = this.#grants.get(capabilityId);
    if (
      !grant ||
      grant.ownerId !== authorization.ownerId ||
      grant.authSessionId !== authorization.authSessionId
    ) {
      return null;
    }
    const previous = grant.telemetry;
    const merged = {
      bytesFromLocal: Math.max(
        previous.bytesFromLocal,
        telemetry.bytesFromLocal,
      ),
      bytesToLocal: Math.max(previous.bytesToLocal, telemetry.bytesToLocal),
      connectionsClosed: Math.max(
        previous.connectionsClosed,
        telemetry.connectionsClosed,
      ),
      connectionsOpened: Math.max(
        previous.connectionsOpened,
        telemetry.connectionsOpened,
      ),
      ...((telemetry.lastDestinationRejectionCode ??
      previous.lastDestinationRejectionCode)
        ? {
            lastDestinationRejectionCode:
              telemetry.lastDestinationRejectionCode ??
              previous.lastDestinationRejectionCode,
          }
        : {}),
    };
    const delta = {
      bytesFromLocal: merged.bytesFromLocal - previous.bytesFromLocal,
      bytesToLocal: merged.bytesToLocal - previous.bytesToLocal,
      connectionsClosed: merged.connectionsClosed - previous.connectionsClosed,
      connectionsOpened: merged.connectionsOpened - previous.connectionsOpened,
      ...(merged.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: merged.lastDestinationRejectionCode,
          }
        : {}),
      resourceId: grant.resourceId,
      resourceKind: grant.resourceKind,
    };
    grant.telemetry = merged;
    grant.telemetryObservedAtMs = Date.now();
    grant.telemetryReportCount += 1;
    this.logger.debug("Direct attachment telemetry recorded", {
      event: "direct_attachment.telemetry.recorded",
      subsystem: "direct-attachment",
      operation: "record-telemetry",
      status: "completed",
      diagnosticTraceId: grant.diagnosticTraceId,
      mode: grant.mode,
      attachmentId: grant.attachmentId,
      resourceId: grant.resourceId,
      resourceKind: grant.resourceKind,
      workerId: grant.workerId,
      fromLocalBytes: merged.bytesFromLocal,
      toLocalBytes: merged.bytesToLocal,
      openedConnectionCount: merged.connectionsOpened,
      closedConnectionCount: merged.connectionsClosed,
      ...(merged.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: merged.lastDestinationRejectionCode,
          }
        : {}),
      telemetryReportCount: grant.telemetryReportCount,
      leaseRemainingMs: Math.max(0, grant.leaseExpiresAtMs - Date.now()),
    });
    return delta;
  }

  async revokeAttachment(attachmentId: string): Promise<void> {
    this.#beginFence(this.#attachmentRevocations, attachmentId);
    try {
      await Promise.all([
        this.#waitForPreparationLeases(
          (lease) => lease.attachmentId === attachmentId,
        ),
        this.#waitForPreparations(
          (input) => input.attachmentId === attachmentId,
        ),
      ]);
      await Promise.all(
        [...this.#grants]
          .filter(([, grant]) => grant.attachmentId === attachmentId)
          .map(([capabilityId]) =>
            this.revoke(capabilityId, "Owning attachment was revoked"),
          ),
      );
    } finally {
      this.#endFence(this.#attachmentRevocations, attachmentId);
    }
  }

  async revokeResource(
    ownerId: string,
    resourceKind: DirectResourceKind,
    resourceId: string,
  ): Promise<void> {
    await this.mutateResource(
      ownerId,
      resourceKind,
      resourceId,
      async () => undefined,
    );
  }

  async mutateResource<T>(
    ownerId: string,
    resourceKind: DirectResourceKind,
    resourceId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const key = this.#resourceKey(ownerId, resourceKind, resourceId);
    const kindKey = this.#resourceKindKey(ownerId, resourceKind);
    const lifecycle = this.#resourceLifecycle(key);
    lifecycle.generation = Symbol(key);
    lifecycle.revocationCount += 1;
    this.#beginFence(this.#resourceKindRevocations, kindKey);
    const queued = this.#enqueueResourceLifecycle(lifecycle);
    await queued.previous;
    try {
      await Promise.all([
        this.#waitForPreparationLeases((lease, state) => {
          return (
            lease.ownerId === ownerId &&
            lease.resourceKind === resourceKind &&
            (state.resourceId === null || state.resourceId === resourceId)
          );
        }),
        this.#waitForPreparations(
          (input) =>
            input.ownerId === ownerId &&
            input.resourceKind === resourceKind &&
            input.resourceId === resourceId,
        ),
      ]);
      await Promise.all(
        [...this.#grants]
          .filter(
            ([, grant]) =>
              grant.ownerId === ownerId &&
              grant.resourceKind === resourceKind &&
              grant.resourceId === resourceId,
          )
          .map(([capabilityId]) =>
            this.revoke(capabilityId, "Owning resource was revoked"),
          ),
      );
      return await mutation();
    } finally {
      queued.release();
      this.#endFence(this.#resourceKindRevocations, kindKey);
      lifecycle.revocationCount -= 1;
      this.#removeResourceLifecycleIfUnused(key, lifecycle);
    }
  }

  async revokeOwner(ownerId: string): Promise<void> {
    this.#beginFence(this.#ownerRevocations, ownerId);
    try {
      await Promise.all([
        this.#waitForPreparationLeases((lease) => lease.ownerId === ownerId),
        this.#waitForPreparations((input) => input.ownerId === ownerId),
      ]);
      await Promise.all(
        [...this.#grants]
          .filter(([, grant]) => grant.ownerId === ownerId)
          .map(([capabilityId]) =>
            this.revoke(capabilityId, "Account sessions were revoked"),
          ),
      );
    } finally {
      this.#endFence(this.#ownerRevocations, ownerId);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await Promise.all([
        this.#waitForPreparationLeases(() => true),
        Promise.allSettled([...this.#pendingPreparations.keys()]),
      ]);
      const activeCount = this.#grants.size;
      await Promise.all(
        [...this.#grants.keys()].map((capabilityId) =>
          this.revoke(capabilityId, "Cantrip Server is stopping"),
        ),
      );
      this.logger.info("Direct attachment coordinator stopped", {
        event: "direct_attachment.runtime.stopped",
        subsystem: "direct-attachment",
        operation: "shutdown",
        status: "completed",
        activeCapabilityCount: activeCount,
      });
    })();
    return this.#closePromise;
  }

  #preparationIdentityIsFenced(
    input: DirectAttachmentPreparationLeaseInput,
  ): boolean {
    return Boolean(
      this.#closed ||
      this.#ownerRevocations.has(input.ownerId) ||
      this.#sessionRevocations.has(input.authSessionId) ||
      (input.attachmentId &&
        this.#attachmentRevocations.has(input.attachmentId)) ||
      (input.resourceId === null &&
        this.#resourceKindRevocations.has(
          this.#resourceKindKey(input.ownerId, input.resourceKind),
        )) ||
      (input.resourceId !== null &&
        (this.#resourceLifecycles.get(
          this.#resourceKey(
            input.ownerId,
            input.resourceKind,
            input.resourceId,
          ),
        )?.revocationCount ?? 0) > 0),
    );
  }

  #preparationLeaseMatches(input: DirectAttachmentPrepareInput): boolean {
    const lease = input.preparationLease;
    const state = this.#preparationLeaseStates.get(lease);
    return Boolean(
      state &&
      this.#preparationLeases.get(lease) === state &&
      lease.ownerId === input.ownerId &&
      lease.authSessionId === input.authSessionId &&
      (lease.attachmentId === undefined ||
        lease.attachmentId === input.attachmentId) &&
      lease.resourceKind === input.resourceKind &&
      state.resourceId === input.resourceId &&
      !this.#preparationIdentityIsFenced({
        ...lease,
        resourceId: state.resourceId,
      }),
    );
  }

  async #waitForPreparationLeases(
    predicate: (
      lease: DirectAttachmentPreparationLease,
      state: DirectAttachmentPreparationLeaseState,
    ) => boolean,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#preparationLeases]
        .filter(([lease, state]) => predicate(lease, state))
        .map(([, state]) => state.released),
    );
  }

  async #waitForPreparations(
    predicate: (input: DirectAttachmentPrepareInput) => boolean,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#pendingPreparations]
        .filter(([, input]) => predicate(input))
        .map(([pending]) => pending),
    );
  }

  #beginFence(fences: Map<string, number>, key: string): void {
    fences.set(key, (fences.get(key) ?? 0) + 1);
  }

  #endFence(fences: Map<string, number>, key: string): void {
    const remaining = (fences.get(key) ?? 1) - 1;
    if (remaining > 0) fences.set(key, remaining);
    else fences.delete(key);
  }

  #resourceLifecycle(key: string): DirectResourceLifecycle {
    let lifecycle = this.#resourceLifecycles.get(key);
    if (!lifecycle) {
      lifecycle = {
        generation: Symbol(key),
        pending: new Set(),
        revocationCount: 0,
        tail: Promise.resolve(),
      };
      this.#resourceLifecycles.set(key, lifecycle);
    }
    return lifecycle;
  }

  #enqueueResourceLifecycle(lifecycle: DirectResourceLifecycle): {
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

  #resourceKey(
    ownerId: string,
    resourceKind: DirectResourceKind,
    resourceId: string,
  ): string {
    return `${ownerId.length}:${ownerId}${resourceKind.length}:${resourceKind}${resourceId}`;
  }

  #resourceKindKey(ownerId: string, resourceKind: DirectResourceKind): string {
    return `${ownerId.length}:${ownerId}${resourceKind}`;
  }

  #removeResourceLifecycleIfUnused(
    key: string,
    lifecycle: DirectResourceLifecycle,
  ): void {
    if (
      this.#resourceLifecycles.get(key) !== lifecycle ||
      lifecycle.pending.size > 0 ||
      lifecycle.revocationCount > 0 ||
      [...this.#grants.values()].some(
        (grant) =>
          this.#resourceKey(
            grant.ownerId,
            grant.resourceKind,
            grant.resourceId,
          ) === key,
      )
    ) {
      return;
    }
    this.#resourceLifecycles.delete(key);
  }

  #finalize(capabilityId: string, reasonCode: string): DirectGrant | null {
    const grant = this.#grants.get(capabilityId);
    if (!grant) return null;
    clearTimeout(grant.timer);
    grant.unsubscribeDisconnect();
    this.#grants.delete(capabilityId);
    const resourceKey = this.#resourceKey(
      grant.ownerId,
      grant.resourceKind,
      grant.resourceId,
    );
    const lifecycle = this.#resourceLifecycles.get(resourceKey);
    if (lifecycle) {
      this.#removeResourceLifecycleIfUnused(resourceKey, lifecycle);
    }
    const now = Date.now();
    this.logger.info("Direct attachment final state captured", {
      event: "direct_attachment.finalized",
      subsystem: "direct-attachment",
      operation: "finalize",
      status: "completed",
      reasonCode,
      diagnosticTraceId: grant.diagnosticTraceId,
      mode: grant.mode,
      attachmentId: grant.attachmentId,
      resourceId: grant.resourceId,
      resourceKind: grant.resourceKind,
      workerId: grant.workerId,
      durationMs: now - grant.createdAtMs,
      activationAttemptCount: grant.activationAttemptCount,
      activationCount: grant.activationCount,
      telemetryReportCount: grant.telemetryReportCount,
      fromLocalBytes: grant.telemetry.bytesFromLocal,
      toLocalBytes: grant.telemetry.bytesToLocal,
      openedConnectionCount: grant.telemetry.connectionsOpened,
      closedConnectionCount: grant.telemetry.connectionsClosed,
      ...(grant.telemetry.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode:
              grant.telemetry.lastDestinationRejectionCode,
          }
        : {}),
      ...(grant.activatedAtMs === null
        ? {}
        : { activationAgeMs: now - grant.activatedAtMs }),
      ...(grant.telemetryObservedAtMs === null
        ? {}
        : { telemetryAgeMs: now - grant.telemetryObservedAtMs }),
    });
    return grant;
  }

  #logPrepareFailure(
    diagnosticTraceId: string,
    input: DirectAttachmentPrepareInput,
    mode: DirectGrant["mode"],
    startedAtMs: number,
    reasonCode: string,
    error?: unknown,
  ): void {
    this.logger.warn("Direct attachment preparation failed", {
      event: "direct_attachment.prepare.failed",
      subsystem: "direct-attachment",
      operation: "prepare",
      status: "failed",
      reasonCode,
      diagnosticTraceId,
      mode,
      attachmentId: input.attachmentId,
      resourceId: input.resourceId,
      resourceKind: input.resourceKind,
      workerId: input.worker.workerId,
      durationMs: Date.now() - startedAtMs,
      ...(error === undefined ? {} : safeErrorMetadata(error)),
    });
  }
}

function safeErrorMetadata(error: unknown): {
  errorClass: string;
  errorCode?: string;
} {
  const normalized = normalizeLogError(error);
  const errorClass = SAFE_ERROR_CLASSES.has(normalized.name)
    ? normalized.name
    : "Error";
  const errorCode =
    normalized.code && SAFE_ERROR_CODES.has(normalized.code)
      ? normalized.code
      : undefined;
  return {
    errorClass,
    ...(errorCode ? { errorCode } : {}),
  };
}

function directRevocationReasonCode(reason: string): string {
  if (reason.includes("expired")) return "expired";
  if (reason.includes("session")) return "session_revoked";
  if (reason.includes("attachment")) return "attachment_revoked";
  if (reason.includes("resource")) return "resource_revoked";
  if (reason.includes("Server")) return "server_shutdown";
  return "revoked";
}
