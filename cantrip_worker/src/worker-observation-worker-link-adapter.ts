import { createHash } from "node:crypto";

import {
  workerObservationEnvelopeSchema,
  workerObservationPayloadSchema,
  type InstalledWorkerLinkGrant,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerObservationEnvelope,
  type WorkerObservationEventIdentity,
  type WorkerObservationPayload,
} from "@cantrip/protocol";

import {
  WorkerLinkChannelRejectedError,
  type WorkerLinkAdapterEmitter,
  type WorkerLinkResourceAdapter,
} from "./worker-link-gateway.js";

const MAX_PENDING_OBSERVATIONS = 256;
const MAX_PENDING_OBSERVATION_BYTES = 4 * 1_024 * 1_024;
const MAX_TRACKED_OPERATION_SEQUENCES = 4_096;
const OBSERVATION_RETRY_MS = 5;
const textEncoder = new TextEncoder();

interface ObservationCandidate {
  readonly identity: Omit<WorkerObservationEventIdentity, "sequence">;
  readonly identitySequence?: number;
  readonly observedAt: string;
  readonly payload: WorkerObservationPayload;
}

interface ActiveSubscription {
  readonly emitter: WorkerLinkAdapterEmitter;
  nextContinuitySequence: number;
  pendingBytes: number;
  readonly pending: Uint8Array[];
  retryTimer: ReturnType<typeof setTimeout> | null;
  readonly subscriptionId: string;
  readonly topics: ReadonlySet<WorkerObservationPayload["topic"]>;
}

export interface WorkerObservationHubOptions {
  now?: () => number;
}

export class WorkerObservationHub implements WorkerLinkResourceAdapter {
  readonly kind = "observations" as const;
  readonly #operationSequences = new Map<string, number>();
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  readonly #now: () => number;

  constructor(options: WorkerObservationHubOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  open: WorkerLinkResourceAdapter["open"] = ({ emit, grant, lane }) => {
    const installation = grant.observation;
    if (
      grant.binding.resource.kind !== "observations" ||
      !installation ||
      grant.binding.resource.attachmentId !== installation.subscriptionId ||
      lane !== "events" ||
      !grant.binding.operations.includes("events:subscribe")
    ) {
      throw new WorkerLinkChannelRejectedError(
        "unauthorized",
        "The observation subscription is not authorized.",
      );
    }
    if (this.#subscriptions.has(grant.binding.grantId)) {
      throw new WorkerLinkChannelRejectedError(
        "resource-unavailable",
        "The observation subscription already has an active channel.",
      );
    }
    const active: ActiveSubscription = {
      emitter: emit,
      nextContinuitySequence: 0,
      pendingBytes: 0,
      pending: [],
      retryTimer: null,
      subscriptionId: installation.subscriptionId,
      topics: new Set(installation.topics),
    };
    this.#subscriptions.set(grant.binding.grantId, active);
    return {
      close: () => {
        if (this.#subscriptions.get(grant.binding.grantId) === active) {
          this.#subscriptions.delete(grant.binding.grantId);
        }
        if (active.retryTimer) clearTimeout(active.retryTimer);
        active.retryTimer = null;
      },
      credit: () => this.#drain(active, grant),
    };
  };

  publishCommandEvent(command: WorkerCommand, event: WorkerEvent): boolean {
    if (command.type !== "chat.turn") return false;
    const payload = workerObservationPayloadSchema.safeParse({
      topic: "chat-progress",
      chatId: command.chatId,
      clientMessageId: command.clientMessageId,
      executionLaneId: command.executionLaneId,
      contextKind: command.contextKind,
      worktreeId: command.worktreeId,
      scratchRootId: command.scratchRootId,
      event,
    });
    if (!payload.success) return false;
    const turnId = eventTurnId(event);
    const messageId = eventMessageId(event);
    return this.#publish({
      identity: {
        operationId: command.clientMessageId,
        turnId,
        messageId,
      },
      ...(event.type === "agent.inference-progress"
        ? { identitySequence: event.progress.sequence }
        : {}),
      observedAt: new Date(this.#now()).toISOString(),
      payload: payload.data,
    });
  }

  publishNotification(notification: WorkerNotification): boolean {
    const topic = notificationTopic(notification);
    if (!topic) return false;
    const payload = workerObservationPayloadSchema.safeParse({
      topic,
      notification,
    });
    if (!payload.success) return false;
    return this.#publish({
      identity: {
        operationId: notificationOperationId(notification),
        turnId: null,
        messageId: notificationMessageId(notification),
      },
      observedAt:
        notification.type === "git.operation.observed"
          ? notification.observedAt
          : new Date(this.#now()).toISOString(),
      payload: payload.data,
    });
  }

  #publish(candidate: ObservationCandidate): boolean {
    const sequence =
      candidate.identitySequence ??
      this.#nextOperationSequence(candidate.identity.operationId);
    let accepted = false;
    for (const [grantId, subscription] of this.#subscriptions) {
      if (!subscription.topics.has(candidate.payload.topic)) continue;
      const envelope = workerObservationEnvelopeSchema.safeParse({
        protocolVersion: 1,
        subscriptionId: subscription.subscriptionId,
        continuitySequence: subscription.nextContinuitySequence,
        observedAt: candidate.observedAt,
        identity: { ...candidate.identity, sequence },
        payload: candidate.payload,
      });
      if (!envelope.success) continue;
      const encoded = textEncoder.encode(JSON.stringify(envelope.data));
      if (!this.#enqueue(subscription, grantId, encoded)) {
        this.#subscriptions.delete(grantId);
        if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
        subscription.retryTimer = null;
        void subscription.emitter.close("congested");
        continue;
      }
      subscription.nextContinuitySequence += 1;
      accepted = true;
    }
    return accepted;
  }

  #enqueue(
    subscription: ActiveSubscription,
    grantId: string,
    encoded: Uint8Array,
  ): boolean {
    if (
      subscription.pending.length === 0 &&
      subscription.emitter.data(encoded)
    ) {
      return true;
    }
    if (
      subscription.pending.length >= MAX_PENDING_OBSERVATIONS ||
      subscription.pendingBytes + encoded.byteLength >
        MAX_PENDING_OBSERVATION_BYTES
    ) {
      return false;
    }
    subscription.pending.push(encoded);
    subscription.pendingBytes += encoded.byteLength;
    this.#scheduleDrain(subscription, grantId);
    return true;
  }

  #drain(
    subscription: ActiveSubscription,
    grant: InstalledWorkerLinkGrant,
  ): void {
    if (this.#subscriptions.get(grant.binding.grantId) !== subscription) return;
    while (subscription.pending.length > 0) {
      const next = subscription.pending[0]!;
      if (!subscription.emitter.data(next)) {
        this.#scheduleDrain(subscription, grant.binding.grantId);
        return;
      }
      subscription.pending.shift();
      subscription.pendingBytes -= next.byteLength;
    }
  }

  #scheduleDrain(subscription: ActiveSubscription, grantId: string): void {
    if (subscription.retryTimer) return;
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = null;
      if (this.#subscriptions.get(grantId) !== subscription) return;
      while (subscription.pending.length > 0) {
        const next = subscription.pending[0]!;
        if (!subscription.emitter.data(next)) {
          this.#scheduleDrain(subscription, grantId);
          return;
        }
        subscription.pending.shift();
        subscription.pendingBytes -= next.byteLength;
      }
    }, OBSERVATION_RETRY_MS);
    subscription.retryTimer.unref();
  }

  #nextOperationSequence(operationId: string): number {
    const sequence = this.#operationSequences.get(operationId) ?? 0;
    this.#operationSequences.delete(operationId);
    this.#operationSequences.set(operationId, sequence + 1);
    if (this.#operationSequences.size > MAX_TRACKED_OPERATION_SEQUENCES) {
      const oldest = this.#operationSequences.keys().next().value;
      if (oldest !== undefined) this.#operationSequences.delete(oldest);
    }
    return sequence;
  }
}

function eventTurnId(event: WorkerEvent): string | null {
  switch (event.type) {
    case "agent.activity":
      return event.activity.correlation?.turnId ?? null;
    case "agent.message":
      return event.message.correlation?.turnId ?? null;
    case "agent.protected-message":
    case "agent.protected-task-message":
      return event.telemetry.turnId;
    default:
      return null;
  }
}

function eventMessageId(event: WorkerEvent): string | null {
  switch (event.type) {
    case "agent.activity":
      return event.activity.id;
    case "agent.message":
      return event.message.id;
    case "agent.protected-message":
    case "agent.protected-task-message":
      return event.message.id;
    case "agent.inference-progress":
      return event.progress.requestId;
    default:
      return null;
  }
}

function notificationTopic(
  notification: WorkerNotification,
): "filesystem" | "runtime" | "worktree" | null {
  switch (notification.type) {
    case "worktree.filesystem.changed":
      return "filesystem";
    case "worktree.inventory.observed":
    case "worktree.status.observed":
    case "git.operation.observed":
      return "worktree";
    case "terminal.runtime.observed":
    case "codegraph.status.observed":
    case "project.run-configuration-runtime.observed":
    case "project.run-configuration-definitions.changed":
      return "runtime";
    default:
      return null;
  }
}

function notificationOperationId(notification: WorkerNotification): string {
  if (notification.type === "git.operation.observed") {
    return notification.operationId;
  }
  return stableObservationId(notificationMessageParts(notification));
}

function notificationMessageId(notification: WorkerNotification): string {
  return stableObservationId([
    notification.type,
    ...notificationMessageParts(notification),
  ]);
}

function notificationMessageParts(notification: WorkerNotification): string[] {
  switch (notification.type) {
    case "worktree.filesystem.changed":
    case "worktree.status.observed":
      return [notification.sourcePath, notification.worktreePath];
    case "worktree.inventory.observed":
      return [notification.sourcePath];
    case "git.operation.observed":
      return [notification.projectId, notification.worktreeId];
    case "terminal.runtime.observed":
      return [notification.terminalId];
    case "codegraph.status.observed":
      return [notification.status.projectId, notification.status.worktreeId];
    case "project.run-configuration-runtime.observed":
      return [
        notification.observation.projectId,
        notification.observation.runtimeId,
      ];
    case "project.run-configuration-definitions.changed":
      return [
        notification.projectId,
        notification.change.id ?? notification.sourcePath,
      ];
    default:
      return [notification.type];
  }
}

function stableObservationId(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

export function decodeWorkerObservationPayload(
  payload: Uint8Array,
): WorkerObservationEnvelope {
  return workerObservationEnvelopeSchema.parse(
    JSON.parse(new TextDecoder().decode(payload)),
  );
}
