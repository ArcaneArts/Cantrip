import {
  workerObservationEnvelopeSchema,
  type WorkerLinkLease,
  type WorkerLinkResourceGrant,
  type WorkerObservationEnvelope,
} from "@cantrip/protocol";

import {
  createWorkerObservationGrant,
  deleteWorkerLinkGrant,
  renewWorkerLinkGrant,
} from "./api";
import {
  workerLinkManager,
  type WorkerLinkManager,
  type WorkerLinkReference,
  type WorkerLinkStream,
} from "./worker-link";

const OBSERVATION_TOPICS = [
  "chat-progress",
  "filesystem",
  "worktree",
  "runtime",
] as const;
const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_BYTES = 4 * 1_024 * 1_024;
const RENEW_AHEAD_MS = 20_000;
const MIN_RENEW_DELAY_MS = 1_000;
const MIN_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface WorkerObservationSink {
  handleWorkerObservation(
    workerId: string,
    envelope: WorkerObservationEnvelope,
  ): Promise<void> | void;
  recoverWorkerObservations(workerId: string): Promise<void> | void;
}

export interface WorkerObservationClientDependencies {
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  createGrant(
    sessionId: string,
    topics: Array<(typeof OBSERVATION_TOPICS)[number]>,
  ): Promise<WorkerLinkResourceGrant>;
  manager: Pick<WorkerLinkManager, "acquire">;
  now(): number;
  renewGrant(sessionId: string, grantId: string): Promise<WorkerLinkLease>;
  revokeGrant(sessionId: string, grantId: string): Promise<void>;
  setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
}

interface WorkerObservationState {
  connecting: boolean;
  desired: boolean;
  generation: number;
  grant: WorkerLinkResourceGrant | null;
  inbound: Uint8Array[];
  inboundBytes: number;
  draining: boolean;
  expectedSequence: number;
  receivedData: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reference: WorkerLinkReference | null;
  renewTimer: ReturnType<typeof setTimeout> | null;
  sessionId: string | null;
  stream: WorkerLinkStream | null;
  unsubscribes: Array<() => void>;
  workerId: string;
}

const defaultDependencies: WorkerObservationClientDependencies = {
  clearTimer: (timer) => globalThis.clearTimeout(timer),
  createGrant: createWorkerObservationGrant,
  manager: workerLinkManager,
  now: Date.now,
  renewGrant: renewWorkerLinkGrant,
  revokeGrant: deleteWorkerLinkGrant,
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

export class WorkerObservationClient {
  readonly #states = new Map<string, WorkerObservationState>();
  #stopped = false;

  constructor(
    private readonly sink: WorkerObservationSink,
    private readonly dependencies: WorkerObservationClientDependencies = defaultDependencies,
  ) {}

  start(): void {
    this.#stopped = false;
  }

  updateWorkers(workerIds: readonly string[]): void {
    if (this.#stopped) return;
    const desired = new Set(workerIds);
    for (const [workerId, state] of this.#states) {
      if (desired.has(workerId)) continue;
      state.desired = false;
      this.#retire(state, "normal", true, false);
      this.#states.delete(workerId);
    }
    for (const workerId of desired) {
      if (this.#states.has(workerId)) continue;
      const state: WorkerObservationState = {
        connecting: false,
        desired: true,
        generation: 0,
        grant: null,
        inbound: [],
        inboundBytes: 0,
        draining: false,
        expectedSequence: 0,
        receivedData: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        reference: null,
        renewTimer: null,
        sessionId: null,
        stream: null,
        unsubscribes: [],
        workerId,
      };
      this.#states.set(workerId, state);
      void this.#connect(state);
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const state of this.#states.values()) {
      state.desired = false;
      this.#retire(state, "normal", true, false);
    }
    this.#states.clear();
  }

  async #connect(state: WorkerObservationState): Promise<void> {
    if (this.#stopped || !state.desired || state.connecting || state.stream) {
      return;
    }
    state.connecting = true;
    const generation = ++state.generation;
    let reference: WorkerLinkReference | null = null;
    let grant: WorkerLinkResourceGrant | null = null;
    try {
      reference = await this.dependencies.manager.acquire(state.workerId);
      const sessionId = reference.link.session.sessionId;
      grant = await this.dependencies.createGrant(sessionId, [
        ...OBSERVATION_TOPICS,
      ]);
      const stream = await reference.link.openEventSubscription(grant);
      if (!this.#isCurrent(state, generation)) {
        stream.close("normal");
        await this.dependencies
          .revokeGrant(sessionId, grant.binding.grantId)
          .catch(() => undefined);
        reference.release();
        return;
      }
      state.reference = reference;
      state.grant = grant;
      state.sessionId = sessionId;
      state.stream = stream;
      state.expectedSequence = 0;
      state.connecting = false;
      state.unsubscribes = [
        stream.onData((payload) => this.#receive(state, generation, payload)),
        stream.onError(() => this.#retire(state, "protocol-error", true, true)),
        stream.onClose((code) => this.#retire(state, code, false, true)),
        stream.onHalfClose(() =>
          this.#retire(state, "protocol-error", true, true),
        ),
      ];
      this.#scheduleRenewal(state, generation, grant.binding.lease);
    } catch {
      state.connecting = false;
      if (grant && reference) {
        await this.dependencies
          .revokeGrant(reference.link.session.sessionId, grant.binding.grantId)
          .catch(() => undefined);
      }
      reference?.release();
      if (this.#isCurrent(state, generation)) this.#scheduleReconnect(state);
    }
  }

  #receive(
    state: WorkerObservationState,
    generation: number,
    payload: Uint8Array,
  ): void {
    if (!this.#isCurrent(state, generation) || !state.stream) return;
    if (
      state.inbound.length >= MAX_PENDING_EVENTS ||
      state.inboundBytes + payload.byteLength > MAX_PENDING_BYTES
    ) {
      this.#retire(state, "congested", true, true);
      return;
    }
    const copy = payload.slice();
    state.inbound.push(copy);
    state.inboundBytes += copy.byteLength;
    this.#drain(state, generation);
  }

  #drain(state: WorkerObservationState, generation: number): void {
    if (state.draining || !this.#isCurrent(state, generation)) return;
    state.draining = true;
    void (async () => {
      try {
        while (
          this.#isCurrent(state, generation) &&
          state.stream &&
          state.inbound.length > 0
        ) {
          const payload = state.inbound.shift()!;
          state.inboundBytes -= payload.byteLength;
          const envelope = workerObservationEnvelopeSchema.parse(
            JSON.parse(decoder.decode(payload)),
          );
          if (
            envelope.subscriptionId !==
              state.grant?.binding.resource.attachmentId ||
            envelope.continuitySequence !== state.expectedSequence
          ) {
            throw new Error("Worker observation continuity was lost.");
          }
          await this.sink.handleWorkerObservation(state.workerId, envelope);
          state.receivedData = true;
          if (
            !this.#isCurrent(state, generation) ||
            !state.stream.acknowledge(payload.byteLength)
          ) {
            throw new Error(
              "Worker observation credit acknowledgement failed.",
            );
          }
          state.expectedSequence += 1;
          state.reconnectAttempt = 0;
        }
      } catch {
        if (this.#isCurrent(state, generation)) {
          this.#retire(state, "protocol-error", true, true);
        }
      } finally {
        state.draining = false;
        if (this.#isCurrent(state, generation) && state.inbound.length > 0) {
          this.#drain(state, generation);
        }
      }
    })();
  }

  #scheduleRenewal(
    state: WorkerObservationState,
    generation: number,
    lease: WorkerLinkLease,
  ): void {
    if (!this.#isCurrent(state, generation) || !state.grant) return;
    if (state.renewTimer) this.dependencies.clearTimer(state.renewTimer);
    const delay = Math.max(
      MIN_RENEW_DELAY_MS,
      Date.parse(lease.expiresAt) - this.dependencies.now() - RENEW_AHEAD_MS,
    );
    state.renewTimer = this.dependencies.setTimer(() => {
      state.renewTimer = null;
      if (!this.#isCurrent(state, generation) || !state.grant) return;
      void this.dependencies
        .renewGrant(state.grant.binding.sessionId, state.grant.binding.grantId)
        .then((renewed) => this.#scheduleRenewal(state, generation, renewed))
        .catch(() => this.#retire(state, "revoked", true, true));
    }, delay);
  }

  #retire(
    state: WorkerObservationState,
    code: Parameters<WorkerLinkStream["close"]>[0] = "normal",
    closeStream: boolean,
    reconnect: boolean,
  ): void {
    const hadData = state.receivedData;
    state.generation += 1;
    state.connecting = false;
    state.receivedData = false;
    if (state.reconnectTimer) {
      this.dependencies.clearTimer(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.renewTimer) {
      this.dependencies.clearTimer(state.renewTimer);
      state.renewTimer = null;
    }
    for (const unsubscribe of state.unsubscribes) unsubscribe();
    state.unsubscribes = [];
    state.inbound = [];
    state.inboundBytes = 0;
    state.draining = false;
    const stream = state.stream;
    const reference = state.reference;
    const grant = state.grant;
    const sessionId = state.sessionId;
    state.stream = null;
    state.reference = null;
    state.grant = null;
    state.sessionId = null;
    if (closeStream) stream?.close(code ?? "normal");
    if (grant && sessionId) {
      void this.dependencies
        .revokeGrant(sessionId, grant.binding.grantId)
        .catch(() => undefined);
    }
    reference?.release();
    if (hadData) void this.sink.recoverWorkerObservations(state.workerId);
    if (reconnect && state.desired && !this.#stopped) {
      this.#scheduleReconnect(state);
    }
  }

  #scheduleReconnect(state: WorkerObservationState): void {
    if (
      this.#stopped ||
      !state.desired ||
      state.reconnectTimer ||
      state.connecting ||
      state.stream
    ) {
      return;
    }
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      MIN_RECONNECT_DELAY_MS * 2 ** Math.min(state.reconnectAttempt, 5),
    );
    state.reconnectAttempt += 1;
    state.reconnectTimer = this.dependencies.setTimer(() => {
      state.reconnectTimer = null;
      void this.#connect(state);
    }, delay);
  }

  #isCurrent(state: WorkerObservationState, generation: number): boolean {
    return (
      !this.#stopped &&
      state.desired &&
      this.#states.get(state.workerId) === state &&
      state.generation === generation
    );
  }
}
