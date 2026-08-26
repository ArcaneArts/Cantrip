import { createHash, timingSafeEqual } from "node:crypto";

import {
  WORKER_LINK_MAX_GRANTS_PER_SESSION,
  WORKER_LINK_MAX_PAYLOAD_BYTES,
  installedWorkerLinkGrantSchema,
  workerLinkCoordinatorCommandSchema,
  workerLinkFrameHeaderSchema,
  workerLinkSessionSchema,
  type InstalledWorkerLinkGrant,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkChannelRejectCode,
  type WorkerLinkCoordinatorCommand,
  type WorkerLinkFrameHeader,
  type WorkerLinkResourceKind,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_CHANNEL_IDLE_MS = 5 * 60_000;
const DEFAULT_CHANNEL_LIFETIME_MS = 12 * 60 * 60_000;
const MAX_ACTIVE_SESSIONS = 256;
const MAX_INSTALLED_GRANTS = 2_048;
const MAX_ACTIVE_CHANNELS = 1_024;
const MAX_OPEN_NONCES = 8_192;
const MAX_INVALID_ATTEMPTS_PER_SESSION = 32;

interface InstalledSessionState {
  channels: Set<string>;
  grants: Map<string, InstalledGrantState>;
  identityKey: string;
  session: WorkerLinkSession;
}

interface InstalledGrantState {
  activeChannels: Set<string>;
  grant: InstalledWorkerLinkGrant;
}

interface ActiveChannel {
  adapter: WorkerLinkAdapterChannel;
  grantId: string;
  identity: Extract<WorkerLinkFrameHeader, { kind: "open" }>["channel"];
  lane: Extract<WorkerLinkFrameHeader, { kind: "open" }>["lane"];
  lastActivityAtMs: number;
  openedAtMs: number;
  route: Extract<WorkerLinkFrameHeader, { kind: "open" }>["effectiveRoute"];
  routeGeneration: number;
  sessionId: string;
}

export interface WorkerLinkAdapterChannel {
  close?(code: WorkerLinkChannelCloseCode): Promise<void> | void;
}

export interface WorkerLinkResourceAdapter {
  readonly kind: WorkerLinkResourceKind;
  open(context: {
    channel: Extract<WorkerLinkFrameHeader, { kind: "open" }>["channel"];
    grant: InstalledWorkerLinkGrant;
    lane: Extract<WorkerLinkFrameHeader, { kind: "open" }>["lane"];
    session: WorkerLinkSession;
  }): Promise<WorkerLinkAdapterChannel> | WorkerLinkAdapterChannel;
}

export interface WorkerLinkGatewayOptions {
  channelIdleMs?: number;
  channelLifetimeMs?: number;
  maxActiveChannels?: number;
  maxActiveSessions?: number;
  maxInstalledGrants?: number;
  maxInvalidAttemptsPerSession?: number;
  maxOpenNonces?: number;
  now?: () => number;
  ownerId: string | (() => string | null);
  serverGeneration: string | (() => string | null);
  serverId: string | (() => string | null);
  sweepIntervalMs?: number;
  workerId: string;
  workerProcessGeneration: string;
}

export interface WorkerLinkGatewayStats {
  channels: number;
  grants: number;
  invalidAttempts: number;
  sessions: number;
}

export class WorkerLinkChannelRejectedError extends Error {
  constructor(
    readonly code: WorkerLinkChannelRejectCode,
    message: string,
  ) {
    super(message);
  }
}

export class WorkerLinkGateway {
  readonly #adapters = new Map<
    WorkerLinkResourceKind,
    WorkerLinkResourceAdapter
  >();
  readonly #channels = new Map<string, ActiveChannel>();
  #closed = false;
  readonly #grantTombstones = new Map<string, number>();
  readonly #identitySessions = new Map<string, string>();
  readonly #invalidAttempts = new Map<string, number>();
  readonly #now: () => number;
  readonly #openNonces = new Map<string, number>();
  readonly #sessions = new Map<string, InstalledSessionState>();
  readonly #sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(private readonly options: WorkerLinkGatewayOptions) {
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs =
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#sweepTimer =
      sweepIntervalMs > 0
        ? setInterval(() => void this.sweepExpired(), sweepIntervalMs)
        : null;
    this.#sweepTimer?.unref();
  }

  registerAdapter(adapter: WorkerLinkResourceAdapter): () => void {
    if (this.#adapters.has(adapter.kind)) {
      throw new Error(
        `A WorkerLink adapter is already registered for ${adapter.kind}.`,
      );
    }
    this.#adapters.set(adapter.kind, adapter);
    return () => {
      if (this.#adapters.get(adapter.kind) !== adapter) return;
      this.#adapters.delete(adapter.kind);
      for (const [channelId, channel] of this.#channels) {
        const grant = this.#grant(channel.sessionId, channel.grantId);
        if (grant?.grant.binding.resource.kind === adapter.kind) {
          void this.#closeChannel(channelId, "revoked");
        }
      }
    };
  }

  async handleCoordinatorCommand(
    input: WorkerLinkCoordinatorCommand,
  ): Promise<{ accepted: true; revoked?: boolean }> {
    this.#assertOpen();
    await this.sweepExpired();
    const command = workerLinkCoordinatorCommandSchema.parse(input);
    switch (command.type) {
      case "worker-link.session.install":
        await this.#installSession(command.session);
        return { accepted: true };
      case "worker-link.session.renew":
        this.#renewSession(command.sessionId, command.lease);
        return { accepted: true };
      case "worker-link.session.route":
        await this.#replaceRoute(
          command.sessionId,
          command.routeGeneration,
          command.preferredRoute,
        );
        return { accepted: true };
      case "worker-link.session.revoke":
        return {
          accepted: true,
          revoked: await this.#removeSession(command.sessionId, "revoked"),
        };
      case "worker-link.grant.install":
        this.#installGrant(command.sessionId, command.grant);
        return { accepted: true };
      case "worker-link.grant.renew":
        this.#renewGrant(
          command.sessionId,
          command.grantId,
          command.grantGeneration,
          command.lease,
        );
        return { accepted: true };
      case "worker-link.grant.revoke":
        return {
          accepted: true,
          revoked: await this.#removeGrant(
            command.sessionId,
            command.grantId,
            command.grantGeneration,
            "revoked",
          ),
        };
    }
  }

  async openChannel(
    input: Extract<WorkerLinkFrameHeader, { kind: "open" }>,
  ): Promise<Extract<WorkerLinkFrameHeader, { kind: "accept" }>> {
    this.#assertOpen();
    await this.sweepExpired();
    const parsed = workerLinkFrameHeaderSchema.parse(input);
    if (parsed.kind !== "open") {
      throw new WorkerLinkChannelRejectedError(
        "protocol-error",
        "WorkerLink channel opening requires an open frame.",
      );
    }
    const state = this.#sessions.get(parsed.sessionId);
    if (!state) {
      throw this.#rejection(
        parsed.sessionId,
        "unauthorized",
        "WorkerLink session is not installed.",
      );
    }
    if (!this.#identityStillCurrent(state.session)) {
      await this.#removeSession(parsed.sessionId, "revoked");
      throw this.#rejection(
        parsed.sessionId,
        "wrong-server-generation",
        "WorkerLink session identity is no longer current.",
      );
    }
    const now = this.#now();
    if (Date.parse(state.session.lease.expiresAt) <= now) {
      await this.#removeSession(parsed.sessionId, "lifetime-expired");
      throw this.#rejection(
        parsed.sessionId,
        "grant-expired",
        "WorkerLink session has expired.",
      );
    }
    if (
      parsed.routeGeneration !== state.session.routeGeneration ||
      !["local", "relay"].includes(parsed.effectiveRoute) ||
      !state.session.routePolicy.enabled.includes(parsed.effectiveRoute)
    ) {
      throw this.#rejection(
        parsed.sessionId,
        "route-generation-stale",
        "WorkerLink route generation is stale or unavailable.",
      );
    }
    if (parsed.sequence !== 0 || parsed.channelKind !== "reliable-stream") {
      throw this.#rejection(
        parsed.sessionId,
        "unsupported-channel",
        "WorkerLink channel kind or opening sequence is unsupported.",
      );
    }
    if (
      this.#channels.has(parsed.channel.channelId) ||
      this.#channels.size >=
        (this.options.maxActiveChannels ?? MAX_ACTIVE_CHANNELS)
    ) {
      throw this.#rejection(
        parsed.sessionId,
        "limit-exceeded",
        "WorkerLink channel capacity is exhausted.",
      );
    }
    const installed = state.grants.get(parsed.grant.binding.grantId);
    if (!installed) {
      const tombstone = this.#grantTombstones.get(parsed.grant.binding.grantId);
      throw this.#rejection(
        parsed.sessionId,
        tombstone !== undefined &&
          parsed.grant.binding.grantGeneration <= tombstone
          ? "grant-revoked"
          : "unauthorized",
        "WorkerLink grant is not installed.",
      );
    }
    if (
      canonical(installed.grant.binding) !== canonical(parsed.grant.binding)
    ) {
      const identity = parsed.grant.binding.identity;
      const code =
        identity.accountSessionId !==
        installed.grant.binding.identity.accountSessionId
          ? "wrong-account-session"
          : identity.workerProcessGeneration !==
              installed.grant.binding.identity.workerProcessGeneration
            ? "wrong-worker-generation"
            : identity.serverGeneration !==
                installed.grant.binding.identity.serverGeneration
              ? "wrong-server-generation"
              : "unauthorized";
      throw this.#rejection(
        parsed.sessionId,
        code,
        "WorkerLink grant binding does not match installed authority.",
      );
    }
    if (Date.parse(installed.grant.binding.lease.expiresAt) <= now) {
      await this.#removeGrant(
        parsed.sessionId,
        installed.grant.binding.grantId,
        installed.grant.binding.grantGeneration,
        "lifetime-expired",
      );
      throw this.#rejection(
        parsed.sessionId,
        "grant-expired",
        "WorkerLink grant has expired.",
      );
    }
    if (!tokenMatches(parsed.grant.token, installed.grant.tokenHash)) {
      throw this.#rejection(
        parsed.sessionId,
        "unauthorized",
        "WorkerLink grant token was rejected.",
      );
    }
    if (
      !installed.grant.binding.lanes.includes(parsed.lane) ||
      !installed.grant.binding.operations.includes("stream:open")
    ) {
      throw this.#rejection(
        parsed.sessionId,
        "unauthorized",
        "WorkerLink grant does not authorize this channel.",
      );
    }
    if (installed.activeChannels.size >= installed.grant.binding.maxChannels) {
      throw this.#rejection(
        parsed.sessionId,
        "limit-exceeded",
        "WorkerLink grant channel capacity is exhausted.",
      );
    }
    if (this.#openNonces.has(parsed.openNonce)) {
      throw this.#rejection(
        parsed.sessionId,
        "grant-replayed",
        "WorkerLink channel open was replayed.",
      );
    }
    this.#pruneOpenNonces(now);
    if (
      this.#openNonces.size >= (this.options.maxOpenNonces ?? MAX_OPEN_NONCES)
    ) {
      throw this.#rejection(
        parsed.sessionId,
        "limit-exceeded",
        "WorkerLink replay cache capacity is exhausted.",
      );
    }
    const adapter = this.#adapters.get(installed.grant.binding.resource.kind);
    if (!adapter) {
      throw this.#rejection(
        parsed.sessionId,
        "resource-unavailable",
        "WorkerLink resource adapter is unavailable.",
      );
    }
    this.#openNonces.set(
      parsed.openNonce,
      Date.parse(installed.grant.binding.lease.absoluteExpiresAt),
    );
    let adapterChannel: WorkerLinkAdapterChannel;
    try {
      adapterChannel = await adapter.open({
        channel: parsed.channel,
        grant: installed.grant,
        lane: parsed.lane,
        session: state.session,
      });
    } catch {
      throw this.#rejection(
        parsed.sessionId,
        "resource-unavailable",
        "WorkerLink resource adapter rejected the channel.",
      );
    }
    if (
      this.#sessions.get(parsed.sessionId) !== state ||
      state.grants.get(installed.grant.binding.grantId) !== installed
    ) {
      try {
        await adapterChannel.close?.("revoked");
      } catch {
        // The authority result remains a rejection even if adapter cleanup fails.
      }
      throw this.#rejection(
        parsed.sessionId,
        "grant-revoked",
        "WorkerLink authority changed while opening the channel.",
      );
    }
    const channel: ActiveChannel = {
      adapter: adapterChannel,
      grantId: installed.grant.binding.grantId,
      identity: parsed.channel,
      lane: parsed.lane,
      lastActivityAtMs: now,
      openedAtMs: now,
      route: parsed.effectiveRoute,
      routeGeneration: parsed.routeGeneration,
      sessionId: parsed.sessionId,
    };
    this.#channels.set(parsed.channel.channelId, channel);
    state.channels.add(parsed.channel.channelId);
    installed.activeChannels.add(parsed.channel.channelId);
    this.#invalidAttempts.delete(parsed.sessionId);
    return {
      protocolVersion: parsed.protocolVersion,
      sessionId: parsed.sessionId,
      routeGeneration: parsed.routeGeneration,
      effectiveRoute: parsed.effectiveRoute,
      channel: parsed.channel,
      lane: parsed.lane,
      sequence: 0,
      kind: "accept",
      initialCreditBytes: parsed.initialCreditBytes,
    };
  }

  recordActivity(
    channelId: string,
    routeGeneration: number,
    payloadBytes = 0,
  ): boolean {
    const channel = this.#channels.get(channelId);
    if (
      !channel ||
      channel.routeGeneration !== routeGeneration ||
      payloadBytes < 0 ||
      payloadBytes > WORKER_LINK_MAX_PAYLOAD_BYTES
    ) {
      return false;
    }
    channel.lastActivityAtMs = this.#now();
    return true;
  }

  async closeChannel(
    channelId: string,
    code: WorkerLinkChannelCloseCode = "normal",
  ): Promise<boolean> {
    return this.#closeChannel(channelId, code);
  }

  async sweepExpired(): Promise<number> {
    const now = this.#now();
    this.#pruneOpenNonces(now);
    let revoked = 0;
    const expiredSessions = [...this.#sessions.values()]
      .filter((state) => Date.parse(state.session.lease.expiresAt) <= now)
      .map((state) => state.session.sessionId);
    for (const sessionId of expiredSessions) {
      if (await this.#removeSession(sessionId, "lifetime-expired")) {
        revoked += 1;
      }
    }
    const expiredGrants: Array<[string, string, number]> = [];
    for (const state of this.#sessions.values()) {
      for (const grant of state.grants.values()) {
        if (Date.parse(grant.grant.binding.lease.expiresAt) <= now) {
          expiredGrants.push([
            state.session.sessionId,
            grant.grant.binding.grantId,
            grant.grant.binding.grantGeneration,
          ]);
        }
      }
    }
    for (const [sessionId, grantId, generation] of expiredGrants) {
      if (
        await this.#removeGrant(
          sessionId,
          grantId,
          generation,
          "lifetime-expired",
        )
      ) {
        revoked += 1;
      }
    }
    const idleMs = this.options.channelIdleMs ?? DEFAULT_CHANNEL_IDLE_MS;
    const lifetimeMs =
      this.options.channelLifetimeMs ?? DEFAULT_CHANNEL_LIFETIME_MS;
    for (const [channelId, channel] of [...this.#channels]) {
      const code =
        now - channel.openedAtMs >= lifetimeMs
          ? "lifetime-expired"
          : now - channel.lastActivityAtMs >= idleMs
            ? "idle-timeout"
            : null;
      if (code && (await this.#closeChannel(channelId, code))) revoked += 1;
    }
    return revoked;
  }

  async revokeAll(code: WorkerLinkChannelCloseCode = "revoked"): Promise<void> {
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(
      sessionIds.map((sessionId) => this.#removeSession(sessionId, code)),
    );
    this.#openNonces.clear();
    this.#invalidAttempts.clear();
  }

  async reconcileSecurityIdentity(): Promise<number> {
    let revoked = 0;
    for (const state of [...this.#sessions.values()]) {
      if (
        !this.#identityStillCurrent(state.session) &&
        (await this.#removeSession(state.session.sessionId, "revoked"))
      ) {
        revoked += 1;
      }
    }
    return revoked;
  }

  stats(): WorkerLinkGatewayStats {
    let grants = 0;
    let invalidAttempts = 0;
    for (const state of this.#sessions.values()) grants += state.grants.size;
    for (const count of this.#invalidAttempts.values()) {
      invalidAttempts += count;
    }
    return {
      channels: this.#channels.size,
      grants,
      invalidAttempts,
      sessions: this.#sessions.size,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    await this.revokeAll("revoked");
    this.#adapters.clear();
  }

  async #installSession(input: WorkerLinkSession): Promise<void> {
    const session = workerLinkSessionSchema.parse(input);
    this.#validateSessionIdentity(session);
    if (Date.parse(session.lease.expiresAt) <= this.#now()) {
      throw new Error("WorkerLink session is already expired.");
    }
    if (
      session.routePolicy.enabled.some(
        (route) => !["local", "relay"].includes(route),
      ) ||
      !session.routePolicy.enabled.includes(session.preferredRoute) ||
      !["local", "relay"].includes(session.preferredRoute)
    ) {
      throw new Error("WorkerLink LAN/WAN routes are not operational.");
    }
    const existing = this.#sessions.get(session.sessionId);
    if (existing) {
      if (canonical(existing.session) !== canonical(session)) {
        throw new Error(
          "WorkerLink session installation conflicts with existing state.",
        );
      }
      return;
    }
    if (
      this.#sessions.size >=
      (this.options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS)
    ) {
      throw new Error("WorkerLink session capacity is exhausted.");
    }
    const identityKey = identityKeyOf(session);
    const replacedId = this.#identitySessions.get(identityKey);
    if (replacedId) await this.#removeSession(replacedId, "route-replaced");
    this.#sessions.set(session.sessionId, {
      channels: new Set(),
      grants: new Map(),
      identityKey,
      session,
    });
    this.#identitySessions.set(identityKey, session.sessionId);
  }

  #renewSession(sessionId: string, lease: WorkerLinkSession["lease"]): void {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error("WorkerLink session is not installed.");
    validateRenewal(state.session.lease, lease, this.#now());
    state.session = workerLinkSessionSchema.parse({ ...state.session, lease });
  }

  async #replaceRoute(
    sessionId: string,
    routeGeneration: number,
    preferredRoute: "local" | "relay",
  ): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error("WorkerLink session is not installed.");
    if (
      routeGeneration === state.session.routeGeneration &&
      preferredRoute === state.session.preferredRoute
    ) {
      return;
    }
    if (
      routeGeneration !== state.session.routeGeneration + 1 ||
      !state.session.routePolicy.enabled.includes(preferredRoute)
    ) {
      throw new Error("WorkerLink route replacement generation is invalid.");
    }
    state.session = workerLinkSessionSchema.parse({
      ...state.session,
      preferredRoute,
      routeGeneration,
    });
    await Promise.all(
      [...state.channels].map((channelId) =>
        this.#closeChannel(channelId, "route-replaced"),
      ),
    );
  }

  #installGrant(sessionId: string, input: InstalledWorkerLinkGrant): void {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error("WorkerLink session is not installed.");
    const grant = installedWorkerLinkGrantSchema.parse(input);
    if (
      grant.binding.sessionId !== sessionId ||
      canonical(grant.binding.identity) !== canonical(state.session.identity)
    ) {
      throw new Error("WorkerLink grant escaped its exact session identity.");
    }
    if (
      Date.parse(grant.binding.lease.expiresAt) <= this.#now() ||
      Date.parse(grant.binding.lease.expiresAt) >
        Date.parse(state.session.lease.expiresAt) ||
      Date.parse(grant.binding.lease.absoluteExpiresAt) >
        Date.parse(state.session.lease.absoluteExpiresAt)
    ) {
      throw new Error("WorkerLink grant lease is outside its session lease.");
    }
    const tombstone = this.#grantTombstones.get(grant.binding.grantId);
    if (tombstone !== undefined && grant.binding.grantGeneration <= tombstone) {
      throw new Error("WorkerLink grant generation was already revoked.");
    }
    const existing = state.grants.get(grant.binding.grantId);
    if (existing) {
      if (canonical(existing.grant) !== canonical(grant)) {
        throw new Error(
          "WorkerLink grant installation conflicts with existing state.",
        );
      }
      return;
    }
    if (state.grants.size >= WORKER_LINK_MAX_GRANTS_PER_SESSION) {
      throw new Error("WorkerLink per-session grant capacity is exhausted.");
    }
    if (
      this.#installedGrantCount() >=
      (this.options.maxInstalledGrants ?? MAX_INSTALLED_GRANTS)
    ) {
      throw new Error("WorkerLink grant capacity is exhausted.");
    }
    state.grants.set(grant.binding.grantId, {
      activeChannels: new Set(),
      grant,
    });
  }

  #renewGrant(
    sessionId: string,
    grantId: string,
    generation: number,
    lease: InstalledWorkerLinkGrant["binding"]["lease"],
  ): void {
    const state = this.#sessions.get(sessionId);
    const grant = state?.grants.get(grantId);
    if (
      !state ||
      !grant ||
      grant.grant.binding.grantGeneration !== generation
    ) {
      throw new Error("WorkerLink grant is not installed at this generation.");
    }
    validateRenewal(grant.grant.binding.lease, lease, this.#now());
    if (
      Date.parse(lease.expiresAt) > Date.parse(state.session.lease.expiresAt)
    ) {
      throw new Error("WorkerLink grant renewal exceeds its session lease.");
    }
    grant.grant = installedWorkerLinkGrantSchema.parse({
      ...grant.grant,
      binding: { ...grant.grant.binding, lease },
    });
  }

  async #removeSession(
    sessionId: string,
    code: WorkerLinkChannelCloseCode,
  ): Promise<boolean> {
    const state = this.#sessions.get(sessionId);
    if (!state) return false;
    this.#sessions.delete(sessionId);
    if (this.#identitySessions.get(state.identityKey) === sessionId) {
      this.#identitySessions.delete(state.identityKey);
    }
    this.#invalidAttempts.delete(sessionId);
    await Promise.all(
      [...state.channels].map((channelId) =>
        this.#closeChannel(channelId, code),
      ),
    );
    for (const grant of state.grants.values()) {
      this.#rememberGrantRevocation(
        grant.grant.binding.grantId,
        grant.grant.binding.grantGeneration,
      );
    }
    state.grants.clear();
    return true;
  }

  async #removeGrant(
    sessionId: string,
    grantId: string,
    generation: number,
    code: WorkerLinkChannelCloseCode,
  ): Promise<boolean> {
    const state = this.#sessions.get(sessionId);
    const grant = state?.grants.get(grantId);
    this.#rememberGrantRevocation(grantId, generation);
    if (
      !state ||
      !grant ||
      grant.grant.binding.grantGeneration !== generation
    ) {
      return false;
    }
    state.grants.delete(grantId);
    await Promise.all(
      [...grant.activeChannels].map((channelId) =>
        this.#closeChannel(channelId, code),
      ),
    );
    return true;
  }

  async #closeChannel(
    channelId: string,
    code: WorkerLinkChannelCloseCode,
  ): Promise<boolean> {
    const channel = this.#channels.get(channelId);
    if (!channel) return false;
    this.#channels.delete(channelId);
    const state = this.#sessions.get(channel.sessionId);
    state?.channels.delete(channelId);
    state?.grants.get(channel.grantId)?.activeChannels.delete(channelId);
    try {
      await channel.adapter.close?.(code);
    } catch {
      // Adapter cleanup is isolated to this already-retired channel.
    }
    return true;
  }

  #validateSessionIdentity(session: WorkerLinkSession): void {
    const serverId = resolveIdentityPart(this.options.serverId);
    if (!serverId || session.identity.serverId !== serverId) {
      throw new Error("WorkerLink session belongs to another server.");
    }
    const serverGeneration = resolveIdentityPart(this.options.serverGeneration);
    if (
      !serverGeneration ||
      session.identity.serverGeneration !== serverGeneration
    ) {
      throw new Error(
        "WorkerLink session belongs to another server generation.",
      );
    }
    const ownerId = resolveIdentityPart(this.options.ownerId);
    if (!ownerId || session.identity.ownerId !== ownerId) {
      throw new Error("WorkerLink session belongs to another account.");
    }
    if (session.identity.workerId !== this.options.workerId) {
      throw new Error("WorkerLink session belongs to another worker.");
    }
    if (
      session.identity.workerProcessGeneration !==
      this.options.workerProcessGeneration
    ) {
      throw new Error("WorkerLink session targets another worker process.");
    }
  }

  #identityStillCurrent(session: WorkerLinkSession): boolean {
    return (
      session.identity.serverId ===
        resolveIdentityPart(this.options.serverId) &&
      session.identity.serverGeneration ===
        resolveIdentityPart(this.options.serverGeneration) &&
      session.identity.ownerId === resolveIdentityPart(this.options.ownerId) &&
      session.identity.workerId === this.options.workerId &&
      session.identity.workerProcessGeneration ===
        this.options.workerProcessGeneration
    );
  }

  #rejection(
    sessionId: string,
    code: WorkerLinkChannelRejectCode,
    message: string,
  ): WorkerLinkChannelRejectedError {
    const attemptKey = this.#sessions.has(sessionId) ? sessionId : "unknown";
    const attempts = (this.#invalidAttempts.get(attemptKey) ?? 0) + 1;
    this.#invalidAttempts.set(attemptKey, attempts);
    if (
      attempts >
      (this.options.maxInvalidAttemptsPerSession ??
        MAX_INVALID_ATTEMPTS_PER_SESSION)
    ) {
      void this.#removeSession(sessionId, "protocol-error");
      return new WorkerLinkChannelRejectedError(
        "limit-exceeded",
        "WorkerLink invalid-attempt limit was exceeded.",
      );
    }
    return new WorkerLinkChannelRejectedError(code, message);
  }

  #rememberGrantRevocation(grantId: string, generation: number): void {
    this.#grantTombstones.set(
      grantId,
      Math.max(generation, this.#grantTombstones.get(grantId) ?? 0),
    );
    while (this.#grantTombstones.size > MAX_INSTALLED_GRANTS * 2) {
      const oldest = this.#grantTombstones.keys().next().value;
      if (oldest === undefined) break;
      this.#grantTombstones.delete(oldest);
    }
  }

  #pruneOpenNonces(now: number): void {
    for (const [nonce, expiresAt] of this.#openNonces) {
      if (expiresAt <= now) this.#openNonces.delete(nonce);
    }
  }

  #grant(sessionId: string, grantId: string): InstalledGrantState | null {
    return this.#sessions.get(sessionId)?.grants.get(grantId) ?? null;
  }

  #installedGrantCount(): number {
    let count = 0;
    for (const state of this.#sessions.values()) count += state.grants.size;
    return count;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WorkerLink gateway is closed.");
  }
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function resolveIdentityPart(
  value: string | (() => string | null),
): string | null {
  return typeof value === "function" ? value() : value;
}

function identityKeyOf(session: WorkerLinkSession): string {
  const identity = session.identity;
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

function validateRenewal(
  current: WorkerLinkSession["lease"],
  next: WorkerLinkSession["lease"],
  now: number,
): void {
  if (
    next.issuedAt !== current.issuedAt ||
    next.absoluteExpiresAt !== current.absoluteExpiresAt ||
    Date.parse(next.expiresAt) <= now ||
    Date.parse(next.expiresAt) > Date.parse(next.absoluteExpiresAt)
  ) {
    throw new Error("WorkerLink lease renewal is invalid.");
  }
}
