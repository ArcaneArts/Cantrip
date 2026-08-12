import { randomBytes, randomUUID } from "node:crypto";

import {
  directAttachmentTicketSchema,
  directCapabilityPrepareResultSchema,
  type DirectAttachmentTicket,
  type DirectResourceKind,
  type WorkerCommand,
  type WorkerSummary,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";

interface DirectGrant {
  attachmentId: string;
  authSessionId: string;
  ownerId: string;
  timer: ReturnType<typeof setTimeout>;
  unsubscribeDisconnect: () => void;
  workerId: string;
}

export interface DirectAttachmentPrepareInput {
  attachmentId?: string;
  authSessionId: string;
  channels: string[];
  ownerId: string;
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

export class DirectAttachmentUnavailableError extends Error {}

export class DirectAttachmentCoordinator {
  readonly #grants = new Map<string, DirectGrant>();

  constructor(private readonly workers: WorkerCommandBus) {}

  async prepare(
    input: DirectAttachmentPrepareInput,
  ): Promise<DirectAttachmentTicket> {
    if (
      !input.worker.online ||
      !this.workers.isConnected(input.worker.workerId)
    ) {
      throw new DirectAttachmentUnavailableError("Worker is offline.");
    }
    if (!input.worker.directBroker.available) {
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
            binding,
            secret,
            tunnelRoute: input.tunnelRoute ?? null,
          },
          { ownerId: input.ownerId, timeoutMs: 5_000 },
        ),
      );
    } catch {
      throw new DirectAttachmentUnavailableError(
        "Worker could not prepare a local direct capability.",
      );
    }
    if (prepared.capabilityId !== capabilityId) {
      throw new Error("Worker acknowledged another direct capability.");
    }
    const timer = setTimeout(
      () => void this.revoke(capabilityId, "Direct capability expired"),
      Math.max(1, leaseExpiresAt - now),
    );
    timer.unref();
    const unsubscribeDisconnect = this.workers.subscribeWorkerDisconnect(
      input.worker.workerId,
      () => this.#forget(capabilityId),
    );
    this.#grants.set(capabilityId, {
      attachmentId: binding.attachmentId,
      authSessionId: input.authSessionId,
      ownerId: input.ownerId,
      timer,
      unsubscribeDisconnect,
      workerId: input.worker.workerId,
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
    this.#forget(capabilityId);
    await this.workers
      .request(
        grant.workerId,
        {
          type: "direct.capability.revoke",
          capabilityId,
          reason,
        },
        { ownerId: grant.ownerId, timeoutMs: 5_000 },
      )
      .catch(() => undefined);
    return true;
  }

  async revokeSession(authSessionId: string): Promise<void> {
    await Promise.all(
      [...this.#grants]
        .filter(([, grant]) => grant.authSessionId === authSessionId)
        .map(([capabilityId]) =>
          this.revoke(capabilityId, "Authorization session was revoked"),
        ),
    );
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

  async revokeAttachment(attachmentId: string): Promise<void> {
    await Promise.all(
      [...this.#grants]
        .filter(([, grant]) => grant.attachmentId === attachmentId)
        .map(([capabilityId]) =>
          this.revoke(capabilityId, "Owning attachment was revoked"),
        ),
    );
  }

  async revokeOwner(ownerId: string): Promise<void> {
    await Promise.all(
      [...this.#grants]
        .filter(([, grant]) => grant.ownerId === ownerId)
        .map(([capabilityId]) =>
          this.revoke(capabilityId, "Account sessions were revoked"),
        ),
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#grants.keys()].map((capabilityId) =>
        this.revoke(capabilityId, "Cantrip Server is stopping"),
      ),
    );
  }

  #forget(capabilityId: string): void {
    const grant = this.#grants.get(capabilityId);
    if (!grant) return;
    clearTimeout(grant.timer);
    grant.unsubscribeDisconnect();
    this.#grants.delete(capabilityId);
  }
}
