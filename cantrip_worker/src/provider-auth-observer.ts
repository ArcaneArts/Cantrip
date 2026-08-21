import {
  providerAuthStatusObservationSchema,
  type CodexAuthStatus,
  type ProviderAuthFailureCode,
  type ProviderAuthSafeStatus,
  type WorkerNotification,
} from "@cantrip/protocol";

const DEFAULT_AUTH_OBSERVATION_TTL_MS = 15 * 60_000;
const DEFAULT_AUTH_STATUS_FALLBACK_MS = 5_000;
const MAX_AUTH_OBSERVATIONS = 64;

interface ProviderAuthObservationInput {
  credentialHomeKey: string;
  observationId: string;
  providerAccountId: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  readStatus(): Promise<CodexAuthStatus>;
}

interface ProviderAuthObservationSession extends ProviderAuthObservationInput {
  expiresAt: number;
  lastNotification: Extract<
    WorkerNotification,
    { type: "provider.auth.status.observed" }
  > | null;
  running: boolean;
  sequence: number;
  terminal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  wakeRequested: boolean;
}

export interface ProviderAuthObserverOptions {
  emit(notification: WorkerNotification): boolean;
  now?: () => number;
  pollIntervalMs?: number;
  setTimer?: typeof setTimeout;
  ttlMs?: number;
}

function failureCode(error: string): ProviderAuthFailureCode {
  const normalized = error.toLowerCase();
  if (normalized.includes("expired")) return "authorization-expired";
  if (normalized.includes("cancel")) return "authorization-cancelled";
  if (normalized.includes("denied") || normalized.includes("access_denied")) {
    return "authorization-denied";
  }
  return "authorization-failed";
}

function pendingStatus(): ProviderAuthSafeStatus {
  return {
    state: "pending",
    authMode: null,
    email: null,
    planType: null,
    weeklyUsage: null,
    failureCode: null,
  };
}

/**
 * Observes account-local authentication state and emits only the strict,
 * non-secret lifecycle projection over the worker command WebSocket.
 */
export class ProviderAuthObserver {
  readonly #emit: ProviderAuthObserverOptions["emit"];
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #sessions = new Map<string, ProviderAuthObservationSession>();
  readonly #setTimer: typeof setTimeout;
  readonly #ttlMs: number;

  constructor(options: ProviderAuthObserverOptions) {
    this.#emit = options.emit;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_AUTH_STATUS_FALLBACK_MS;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#ttlMs = options.ttlMs ?? DEFAULT_AUTH_OBSERVATION_TTL_MS;
  }

  start(input: ProviderAuthObservationInput): void {
    this.#remove(input.credentialHomeKey);
    const createdAt = this.#now();
    const session: ProviderAuthObservationSession = {
      ...input,
      expiresAt: createdAt + this.#ttlMs,
      lastNotification: null,
      running: false,
      sequence: 0,
      terminal: false,
      timer: null,
      wakeRequested: false,
    };
    this.#sessions.set(input.credentialHomeKey, session);
    this.#trim();
    this.#publish(session, pendingStatus());
    this.#schedule(session, 0);
  }

  wake(credentialHomeKey: string): void {
    const session = this.#sessions.get(credentialHomeKey);
    if (!session || session.terminal) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.running) {
      session.wakeRequested = true;
      return;
    }
    this.#schedule(session, 0);
  }

  cancel(credentialHomeKey: string): void {
    const session = this.#sessions.get(credentialHomeKey);
    if (!session || session.terminal) return;
    session.terminal = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    this.#publish(session, {
      ...pendingStatus(),
      state: "cancelled",
      failureCode: "authorization-cancelled",
    });
  }

  reemitAll(): void {
    for (const session of this.#sessions.values()) {
      if (session.lastNotification) {
        this.#publish(session, session.lastNotification.status);
      }
    }
  }

  close(): void {
    for (const session of this.#sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
    }
    this.#sessions.clear();
  }

  #schedule(session: ProviderAuthObservationSession, delay: number): void {
    if (
      session.terminal ||
      this.#sessions.get(session.credentialHomeKey) !== session
    ) {
      return;
    }
    session.timer = this.#setTimer(() => {
      session.timer = null;
      void this.#observe(session);
    }, delay);
    session.timer.unref?.();
  }

  async #observe(session: ProviderAuthObservationSession): Promise<void> {
    if (session.running || session.terminal) return;
    session.running = true;
    try {
      if (this.#now() >= session.expiresAt) {
        session.terminal = true;
        this.#publish(session, {
          ...pendingStatus(),
          state: "expired",
          failureCode: "authorization-expired",
        });
        return;
      }
      try {
        const status = await session.readStatus();
        if (status.authenticated) {
          session.terminal = true;
          this.#publish(session, {
            state: "authenticated",
            authMode: status.authMode,
            email: status.email,
            planType: status.planType,
            weeklyUsage: status.weeklyUsage,
            failureCode: null,
          });
          return;
        }
        if (status.loginError && !status.loginPending) {
          const code = failureCode(status.loginError);
          session.terminal = true;
          this.#publish(session, {
            ...pendingStatus(),
            state:
              code === "authorization-expired"
                ? "expired"
                : code === "authorization-cancelled"
                  ? "cancelled"
                  : "failed",
            failureCode: code,
          });
          return;
        }
      } catch {
        // A status read can fail while the local auth runtime restarts. Keep
        // the bounded observation alive; no upstream error text is relayed.
      }
    } finally {
      session.running = false;
    }
    if (session.wakeRequested) {
      session.wakeRequested = false;
      this.#schedule(session, 0);
    } else {
      this.#schedule(session, this.#pollIntervalMs);
    }
  }

  #publish(
    session: ProviderAuthObservationSession,
    status: ProviderAuthSafeStatus,
  ): void {
    const notification = providerAuthStatusObservationSchema.parse({
      type: "provider.auth.status.observed",
      observationId: session.observationId,
      providerId: session.providerId,
      providerAccountId: session.providerAccountId,
      providerKind: session.providerKind,
      sequence: ++session.sequence,
      observedAt: new Date(this.#now()).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      status,
    });
    session.lastNotification = notification;
    this.#emit(notification);
  }

  #remove(credentialHomeKey: string): void {
    const previous = this.#sessions.get(credentialHomeKey);
    if (previous?.timer) clearTimeout(previous.timer);
    this.#sessions.delete(credentialHomeKey);
  }

  #trim(): void {
    while (this.#sessions.size > MAX_AUTH_OBSERVATIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) return;
      this.#remove(oldest);
    }
  }
}
