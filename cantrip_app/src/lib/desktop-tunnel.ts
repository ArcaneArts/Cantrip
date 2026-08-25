import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CodeSharedAttachmentWire,
  DirectTunnelTicket,
  TunnelAttachmentCreateResult,
} from "@cantrip/protocol";

import {
  activateDirectTunnelAttachment,
  createDirectTunnelAttachment,
  createTunnelAttachment,
  deleteDirectAttachment,
  deleteTunnelAttachment,
  getTunnelDataProtection,
  recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease,
  explorerCodeSessionBindingCurrent,
  type BoundExplorerCodeSessionAttachment,
} from "@/lib/api";
import {
  onClientSessionIdentityChanged,
  rotateClientSessionIdentity,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import {
  getActiveServerUrl,
  onServerConnectionIdentityChanged,
} from "@/lib/server-connections";

const clientIdStorageKey = "cantrip.desktop-tunnel-client.v1";
const FINAL_TELEMETRY_TIMEOUT_MS = 2_000;
const DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS = 2_000;
const CODE_TRANSPORT_LEADER_STEP_TIMEOUT_MS = 10_000;
const CODE_TRANSPORT_MAINTENANCE_INTERVAL_MS = 10_000;
const CODE_TRANSPORT_MAINTENANCE_TIMEOUT_MS = 7_500;
const CODE_TRANSPORT_RELAY_RENEWAL_MARGIN_MS = 40_000;
const directCapabilityRetirements = new Map<string, Promise<void>>();
const relayRefreshes = new Map<string, Promise<boolean>>();

type DesktopCodeTransportRuntimeState = {
  identitySubscriptionsInstalled: boolean;
  maintenanceLeases: Map<string, DesktopCodeTransportLease>;
  maintenanceTimer: number | null;
  pendingRetirementLeases: Set<string>;
  recentTerminalForwards: Map<string, DesktopTunnelForwardTerminalEvent>;
  releaseAttempts: Map<string, Promise<boolean>>;
  terminalForwardListenerReady: Promise<void> | null;
  terminalForwardSubscribers: Set<{
    identity: Pick<
      DesktopTunnelForwardTerminalEvent,
      "attachmentId" | "diagnosticTraceId" | "tunnelId"
    >;
    listener: (event: DesktopTunnelForwardTerminalEvent) => void;
    notified: boolean;
  }>;
  windowInstanceId: string;
  windowRegistration: Promise<void> | null;
};

type DesktopTunnelHotState = {
  desktopCodeTransportRuntime?: DesktopCodeTransportRuntimeState;
};

export function desktopCodeTransportRuntime(
  hotState?: DesktopTunnelHotState,
): DesktopCodeTransportRuntimeState {
  const created = (): DesktopCodeTransportRuntimeState => ({
    identitySubscriptionsInstalled: false,
    maintenanceLeases: new Map<string, DesktopCodeTransportLease>(),
    maintenanceTimer: null,
    pendingRetirementLeases: new Set<string>(),
    recentTerminalForwards: new Map<
      string,
      DesktopTunnelForwardTerminalEvent
    >(),
    releaseAttempts: new Map<string, Promise<boolean>>(),
    terminalForwardListenerReady: null,
    terminalForwardSubscribers: new Set(),
    windowInstanceId: crypto.randomUUID(),
    windowRegistration: null,
  });
  if (!hotState) return created();
  hotState.desktopCodeTransportRuntime ??= created();
  return hotState.desktopCodeTransportRuntime;
}

// Exact native lease ids, the window token, maintenance timer, and identity
// subscriptions must survive Vite module replacement together. Preserving
// only the native token would strand opaque leases in the old JS module.
const codeTransportRuntime = desktopCodeTransportRuntime(
  import.meta.hot?.data as DesktopTunnelHotState | undefined,
);
const codeTransportMaintenanceLeases = codeTransportRuntime.maintenanceLeases;
const codeTransportPendingRetirementLeases =
  codeTransportRuntime.pendingRetirementLeases;
const codeTransportReleaseAttempts = codeTransportRuntime.releaseAttempts;
const desktopCodeWindowInstanceId = codeTransportRuntime.windowInstanceId;

function ensureDesktopCodeWindowRegistered(): Promise<void> {
  codeTransportRuntime.windowRegistration ??= invoke<void>(
    "register_code_transport_window_instance",
    { windowInstanceId: desktopCodeWindowInstanceId },
  )
    .catch((error) => {
      codeTransportRuntime.windowRegistration = null;
      throw error;
    });
  return codeTransportRuntime.windowRegistration;
}

export interface DesktopTunnelForwardSummary {
  attachmentId: string;
  diagnosticTraceId: string | null;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  routeState: "local-direct" | "relayed" | "degraded";
  relayFallbackAvailable?: boolean;
  relayCredentialExpiresAtEpochMs?: number | null;
  directCapabilityId: string | null;
  directFallbackReason: string | null;
  lastDestinationRejectionCode?: DesktopTunnelDestinationRejectionCode | null;
  tunnelId: string;
  bytesFromLocal?: number;
  bytesToLocal?: number;
  connectionsClosed?: number;
  connectionsOpened?: number;
  destinationRejectedCount?: number;
  codePoolGeneration?: string | null;
}

export interface DesktopTunnelForwardIdentity {
  attachmentId: string;
  diagnosticTraceId: string | null;
  directCapabilityId: string | null;
}

export interface DesktopTunnelForwardTerminalEvent {
  attachmentId: string;
  diagnosticTraceId: string | null;
  reasonCode: "attachment-invalidated" | "replaced" | "route-terminated";
  tunnelId: string;
}

const DESKTOP_TUNNEL_FORWARD_TERMINAL_EVENT = "cantrip-tunnel-forward-terminal";
const MAX_RECENT_TERMINAL_FORWARDS = 256;
const recentTerminalForwards = codeTransportRuntime.recentTerminalForwards;
const terminalForwardSubscribers =
  codeTransportRuntime.terminalForwardSubscribers;

function terminalForwardKey(
  identity: Pick<
    DesktopTunnelForwardTerminalEvent,
    "attachmentId" | "diagnosticTraceId" | "tunnelId"
  >,
): string {
  return [
    identity.tunnelId,
    identity.attachmentId,
    identity.diagnosticTraceId ?? "none",
  ].join("\0");
}

function publishDesktopTunnelForwardTerminal(
  event: DesktopTunnelForwardTerminalEvent,
): void {
  const key = terminalForwardKey(event);
  recentTerminalForwards.delete(key);
  recentTerminalForwards.set(key, event);
  while (recentTerminalForwards.size > MAX_RECENT_TERMINAL_FORWARDS) {
    const oldest = recentTerminalForwards.keys().next().value;
    if (oldest === undefined) break;
    recentTerminalForwards.delete(oldest);
  }
  for (const subscription of terminalForwardSubscribers) {
    if (
      !subscription.notified &&
      terminalForwardKey(subscription.identity) === key
    ) {
      subscription.notified = true;
      subscription.listener(event);
    }
  }
}

function ensureDesktopTunnelForwardTerminalListener(): Promise<void> {
  if (codeTransportRuntime.terminalForwardListenerReady) {
    return codeTransportRuntime.terminalForwardListenerReady;
  }
  const opening = import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<DesktopTunnelForwardTerminalEvent>(
        DESKTOP_TUNNEL_FORWARD_TERMINAL_EVENT,
        ({ payload }) => publishDesktopTunnelForwardTerminal(payload),
      ),
    )
    .then(() => undefined)
    .catch((error) => {
      if (codeTransportRuntime.terminalForwardListenerReady === opening) {
        codeTransportRuntime.terminalForwardListenerReady = null;
      }
      throw error;
    });
  codeTransportRuntime.terminalForwardListenerReady = opening;
  return opening;
}

if (isTauri()) {
  void ensureDesktopTunnelForwardTerminalListener().catch(() => undefined);
  ensureCodeTransportIdentitySubscriptionsInstalled();
}

export function subscribeDesktopTunnelForwardTerminal(
  identity: Pick<
    DesktopTunnelForwardTerminalEvent,
    "attachmentId" | "diagnosticTraceId" | "tunnelId"
  >,
  listener: (event: DesktopTunnelForwardTerminalEvent) => void,
): () => void {
  if (!isTauri()) return () => undefined;
  const subscription = { identity, listener, notified: false };
  terminalForwardSubscribers.add(subscription);
  const replay = recentTerminalForwards.get(terminalForwardKey(identity));
  if (replay) {
    queueMicrotask(() => {
      if (terminalForwardSubscribers.has(subscription)) {
        publishDesktopTunnelForwardTerminal(replay);
      }
    });
  }
  void ensureDesktopTunnelForwardTerminalListener()
    .then(() => listDesktopTunnelsWithOptions())
    .then((forwards) => {
      if (
        subscription.notified ||
        !terminalForwardSubscribers.has(subscription)
      ) {
        return;
      }
      const exact = forwards.some(
        (forward) =>
          forward.tunnelId === identity.tunnelId &&
          forward.attachmentId === identity.attachmentId &&
          forward.diagnosticTraceId === identity.diagnosticTraceId,
      );
      if (!exact) {
        publishDesktopTunnelForwardTerminal({
          ...identity,
          reasonCode: "route-terminated",
        });
      }
    })
    .catch(() => undefined);
  return () => {
    terminalForwardSubscribers.delete(subscription);
  };
}

interface DesktopTunnelTerminalSnapshot {
  attachmentId: string;
  tunnelId: string;
  directCapabilityId: string | null;
  lastDestinationRejectionCode?: DesktopTunnelDestinationRejectionCode | null;
  bytesFromLocal: number;
  bytesToLocal: number;
  connectionsClosed: number;
  connectionsOpened: number;
}

interface DesktopTunnelRelayRefreshResult {
  outcome: "accepted" | "stale" | "forward-unavailable";
}

export type DesktopTunnelDestinationRejectionCode =
  | "congested"
  | "limit-exceeded"
  | "protected-endpoint-unavailable"
  | "protected-record-unavailable"
  | "protected-target-invalid"
  | "protocol-error"
  | "target-rejected"
  | "target-unavailable"
  | "unauthorized";

export interface StartDesktopTunnelOptions {
  diagnosticTraceId?: string;
  preferredLocalPort?: number;
}

interface CodeTransportPoolIdentity {
  accountId: string | null;
  clientIdentityGeneration: number;
  clientIdentityIncarnationId: string;
  connectionId: string | null;
  protectedKeyRevision: number;
  securityScopeId: string;
  serverControlPlaneGeneration: string;
  serverId: string;
  serverUrl: string;
  transportId: string;
  userId: string;
  workerId: string;
  workerProcessGeneration: string;
}

type CodeTransportClientIdentity = Pick<
  CodeTransportPoolIdentity,
  | "accountId"
  | "clientIdentityIncarnationId"
  | "connectionId"
  | "serverId"
  | "serverUrl"
  | "userId"
>;

type CodeTransportForwardAcquisition =
  | { generation: string; reservationId: string; state: "leader" }
  | { generation: string; state: "waiting" }
  | {
      forward: DesktopTunnelForwardSummary;
      generation: string;
      leaseId: string;
      state: "ready";
    };

interface CodeTransportForwardCompletion {
  forward: DesktopTunnelForwardSummary;
  generation: string;
}

interface CodeTransportForwardRelease {
  released: boolean;
  remainingLeases: number;
  stopped: DesktopTunnelTerminalSnapshot | null;
}

export interface DesktopCodeTransportLease {
  binding: BoundExplorerCodeSessionAttachment["binding"];
  forward: DesktopTunnelForwardSummary;
  generation: string;
  leaseId: string;
  serverUrl: string;
}

function trackDesktopCodeTransportLease(
  lease: DesktopCodeTransportLease,
): DesktopCodeTransportLease {
  ensureCodeTransportIdentitySubscriptionsInstalled();
  codeTransportMaintenanceLeases.set(lease.leaseId, lease);
  if (
    codeTransportRuntime.maintenanceTimer === null &&
    typeof window !== "undefined" &&
    typeof window.setInterval === "function"
  ) {
    codeTransportRuntime.maintenanceTimer = window.setInterval(
      () => void maintainDesktopCodeTransportsOnce(),
      CODE_TRANSPORT_MAINTENANCE_INTERVAL_MS,
    );
  }
  return lease;
}

function ensureCodeTransportIdentitySubscriptionsInstalled(): void {
  if (!codeTransportRuntime.identitySubscriptionsInstalled) {
    codeTransportRuntime.identitySubscriptionsInstalled = true;
    const retireStale = () => {
      for (const candidate of codeTransportMaintenanceLeases.values()) {
        if (!explorerCodeSessionBindingCurrent(candidate.binding)) {
          void releaseDesktopCodeTransport(candidate);
        }
      }
    };
    const retireNativeIdentity = (identity: ClientSessionIdentitySnapshot) => {
      if (!identity.serverUrl) return;
      const nativeIdentity: CodeTransportClientIdentity = {
        accountId: identity.accountId,
        clientIdentityIncarnationId: identity.incarnationId,
        connectionId: identity.connectionId,
        serverId: identity.serverId,
        serverUrl: identity.serverUrl,
        userId: identity.userId,
      };
      void invoke("invalidate_code_transport_pool", {
        identity: nativeIdentity,
      }).catch(() => undefined);
    };
    onClientSessionIdentityChanged((change) => {
      if (change.kind === "initialized") return;
      if (change.previous) {
        retireNativeIdentity(change.previous);
      }
      retireStale();
    });
    onServerConnectionIdentityChanged((change) => {
      rotateClientSessionIdentity(change.previous);
    });
  }
}

function untrackDesktopCodeTransportLease(
  lease: DesktopCodeTransportLease,
): void {
  if (codeTransportMaintenanceLeases.get(lease.leaseId) === lease) {
    codeTransportMaintenanceLeases.delete(lease.leaseId);
  }
  codeTransportPendingRetirementLeases.delete(lease.leaseId);
  if (
    codeTransportMaintenanceLeases.size === 0 &&
    codeTransportRuntime.maintenanceTimer !== null
  ) {
    window.clearInterval(codeTransportRuntime.maintenanceTimer);
    codeTransportRuntime.maintenanceTimer = null;
  }
}

function pooledRelayRefreshDue(forward: DesktopTunnelForwardSummary): boolean {
  if (!forward.relayFallbackAvailable) return false;
  if (forward.routeState === "degraded") return true;
  const expiresAt = forward.relayCredentialExpiresAtEpochMs;
  return (
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now() + CODE_TRANSPORT_RELAY_RENEWAL_MARGIN_MS
  );
}

async function maintainDesktopCodeTransportLease(
  lease: DesktopCodeTransportLease,
): Promise<void> {
  if (codeTransportPendingRetirementLeases.has(lease.leaseId)) {
    await releaseDesktopCodeTransport(lease);
    return;
  }
  if (!explorerCodeSessionBindingCurrent(lease.binding)) {
    await releaseDesktopCodeTransport(lease);
    return;
  }
  const signal = AbortSignal.timeout(CODE_TRANSPORT_MAINTENANCE_TIMEOUT_MS);
  const forward = await invoke<DesktopTunnelForwardSummary | null>(
    "claim_code_transport_maintenance",
    {
      generation: lease.generation,
      leaseId: lease.leaseId,
      transportId: lease.forward.tunnelId,
      windowInstanceId: desktopCodeWindowInstanceId,
    },
  );
  if (!forward) return;
  if (!explorerCodeSessionBindingCurrent(lease.binding)) {
    await releaseDesktopCodeTransport(lease);
    return;
  }
  lease.forward = forward;
  if (forward.directCapabilityId && forward.routeState === "local-direct") {
    await recordDirectAttachmentTelemetry(
      forward.directCapabilityId,
      {
        bytesFromLocal: forward.bytesFromLocal ?? 0,
        bytesToLocal: forward.bytesToLocal ?? 0,
        connectionsClosed: forward.connectionsClosed ?? 0,
        connectionsOpened: forward.connectionsOpened ?? 0,
        ...(forward.lastDestinationRejectionCode
          ? {
              lastDestinationRejectionCode:
                forward.lastDestinationRejectionCode,
            }
          : {}),
      },
      { serverUrl: lease.serverUrl, signal },
    );
  } else {
    await renewTunnelAttachmentLease(forward.attachmentId, {
      serverUrl: lease.serverUrl,
      signal,
    });
  }
  if (!explorerCodeSessionBindingCurrent(lease.binding)) {
    await releaseDesktopCodeTransport(lease);
    return;
  }
  if (pooledRelayRefreshDue(forward)) {
    await refreshDesktopTunnelRelay(forward, {
      serverUrl: lease.serverUrl,
      signal,
    });
    if (!explorerCodeSessionBindingCurrent(lease.binding)) {
      await releaseDesktopCodeTransport(lease);
      return;
    }
  }
  if (
    forward.directCapabilityId &&
    forward.routeState !== "local-direct" &&
    forward.relayFallbackAvailable
  ) {
    lease.forward = await forceDesktopTunnelRelay(forward, {
      binding: lease.binding,
      serverUrl: lease.serverUrl,
      signal,
    });
  }
}

export async function maintainDesktopCodeTransportsOnce(): Promise<void> {
  await Promise.all(
    [...codeTransportMaintenanceLeases.values()].map((lease) =>
      maintainDesktopCodeTransportLease(lease).catch(() => undefined),
    ),
  );
}

export function desktopTunnelAvailable(): boolean {
  return isTauri();
}

export function desktopTunnelClientId(storage: Storage): string {
  const existing = storage.getItem(clientIdStorageKey);
  if (existing && existing.length <= 200) return existing;
  const clientId = crypto.randomUUID();
  storage.setItem(clientIdStorageKey, clientId);
  return clientId;
}

function nativeStartRequest(
  attachment: TunnelAttachmentCreateResult,
  clientId: string,
  direct: Awaited<ReturnType<typeof createDirectTunnelAttachment>> | null,
  dataProtection: Awaited<ReturnType<typeof getTunnelDataProtection>>,
  diagnosticTraceId?: string,
  preferredLocalPort?: number,
  serverUrl = getActiveServerUrl(),
) {
  return {
    attachmentId: attachment.attachmentId,
    clientId,
    diagnosticTraceId: diagnosticTraceId ?? null,
    dataProtection,
    direct,
    expiresAt: attachment.expiresAt,
    preferredLocalPort: preferredLocalPort ?? null,
    relay: {
      connectPath: attachment.connectPath,
      secret: attachment.secret,
      secretExpiresAtEpochMs: new Date(attachment.secretExpiresAt).getTime(),
      serverUrl,
    },
    tunnelId: attachment.tunnelId,
  };
}

export async function startDesktopTunnel(
  tunnelId: string,
  options: StartDesktopTunnelOptions = {},
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri()) {
    throw new Error(
      "Local tunnel attachments are only available in the desktop app.",
    );
  }
  const clientId = desktopTunnelClientId(window.localStorage);
  const dataProtection = await getTunnelDataProtection(tunnelId);
  const attachment = await createTunnelAttachment(tunnelId, { clientId });
  const direct = await createDirectTunnelAttachment(attachment.attachmentId, {
    diagnosticTraceId: options.diagnosticTraceId,
  }).catch(() => null);
  const request = nativeStartRequest(
    attachment,
    clientId,
    direct,
    dataProtection,
    options.diagnosticTraceId,
    options.preferredLocalPort,
  );
  let started: DesktopTunnelForwardSummary | null = null;
  try {
    started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    request.relay.secret = "";
    if (request.direct) request.direct.secret = "";
    request.dataProtection.key = "";
    attachment.secret = "";
    if (started.routeState === "local-direct") {
      if (!started.directCapabilityId) {
        throw new Error(
          "The local direct tunnel omitted its capability identity.",
        );
      }
      await activateDirectTunnelAttachment(attachment.attachmentId, {
        capabilityId: started.directCapabilityId,
      });
    } else if (direct) {
      await deleteDirectAttachment(direct.binding.capabilityId).catch(() => {
        // The relayed tunnel remains usable if best-effort capability cleanup fails.
      });
    }
    return started;
  } catch (error) {
    request.relay.secret = "";
    if (request.direct) request.direct.secret = "";
    request.dataProtection.key = "";
    attachment.secret = "";
    await stopDesktopTunnelForward(tunnelId, {
      attachmentId: started?.attachmentId ?? attachment.attachmentId,
      diagnosticTraceId:
        started?.diagnosticTraceId ?? options.diagnosticTraceId ?? null,
      directCapabilityId: started?.directCapabilityId ?? null,
    }).catch(() => {
      // Server revocation below remains authoritative.
    });
    await deleteTunnelAttachment(attachment.attachmentId).catch(() => {
      // Preserve the native bind/connection error if best-effort cleanup fails.
    });
    throw error;
  }
}

function desktopCodeTransportPoolIdentity(
  owned: BoundExplorerCodeSessionAttachment,
): CodeTransportPoolIdentity {
  const transport = owned.attachment.transport;
  return {
    accountId: owned.binding.identity.accountId,
    clientIdentityGeneration: owned.binding.identity.generation,
    clientIdentityIncarnationId: owned.binding.identity.incarnationId,
    connectionId: owned.binding.identity.connectionId,
    protectedKeyRevision: transport.protectedKeyRevision,
    securityScopeId: transport.securityScopeId,
    serverControlPlaneGeneration: transport.serverControlPlaneGeneration,
    serverId: transport.serverId,
    serverUrl: owned.binding.serverUrl,
    transportId: transport.transportId,
    userId: owned.binding.identity.userId,
    workerId: transport.workerId,
    workerProcessGeneration: transport.workerProcessGeneration,
  };
}

function assertDesktopCodeTransportBinding(
  owned: BoundExplorerCodeSessionAttachment,
): void {
  if (!explorerCodeSessionBindingCurrent(owned.binding)) {
    throw new Error(
      "The Cantrip Code server or authentication identity changed while connecting.",
    );
  }
}

async function failDesktopCodeTransportReservation(input: {
  generation: string;
  reservationId: string;
  transportId: string;
}): Promise<void> {
  await invoke("fail_code_transport_forward", {
    ...input,
    windowInstanceId: desktopCodeWindowInstanceId,
  }).catch(() => undefined);
}

async function publishDesktopCodeTransportReservation(input: {
  acquisitionId: string;
  consumerId: string;
  generation: string;
  reservationId: string;
  transportId: string;
}): Promise<CodeTransportForwardAcquisition> {
  let publicationError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await invoke<CodeTransportForwardAcquisition>(
        "publish_code_transport_forward",
        {
          generation: input.generation,
          reservationId: input.reservationId,
          transportId: input.transportId,
          windowInstanceId: desktopCodeWindowInstanceId,
        },
      );
    } catch (error) {
      publicationError = error;
    }
  }
  // Publication is a commit boundary. If the response was lost after native
  // committed it, exact acquisition idempotency returns the winning lease.
  try {
    const reconciled = await invoke<CodeTransportForwardAcquisition | null>(
      "reconcile_code_transport_forward",
      {
        acquisitionId: input.acquisitionId,
        consumerId: input.consumerId,
        generation: input.generation,
        reservationId: input.reservationId,
        transportId: input.transportId,
        windowInstanceId: desktopCodeWindowInstanceId,
      },
    );
    if (reconciled?.state === "ready") return reconciled;
  } catch {
    // Preserve the publication error; cleanup treats this as commit-ambiguous.
  }
  throw publicationError ?? new Error("The shared Code forward was not published.");
}

export async function acquireDesktopCodeTransport(
  owned: BoundExplorerCodeSessionAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<DesktopCodeTransportLease> {
  if (!isTauri()) {
    throw new Error(
      "Shared local Code transports are only available in the desktop app.",
    );
  }
  const wire = owned.attachment;
  const identity = desktopCodeTransportPoolIdentity(owned);
  const acquisitionId = crypto.randomUUID();
  const consumerId = wire.session.attachmentId;

  await ensureDesktopCodeWindowRegistered();
  for (;;) {
    options.signal?.throwIfAborted();
    assertDesktopCodeTransportBinding(owned);
    // Native acquisition mutates process-wide ownership. Never race it against
    // AbortSignal and discard its result: an abort after native commit must
    // release the exact lease or reservation it just created.
    const acquisition = await invoke<CodeTransportForwardAcquisition>(
      "acquire_code_transport_forward",
      {
        request: {
          acquisitionId,
          consumerId,
          identity,
          windowInstanceId: desktopCodeWindowInstanceId,
        },
      },
    );
    const acquisitionInvalid =
      options.signal?.aborted ||
      !explorerCodeSessionBindingCurrent(owned.binding);
    if (acquisitionInvalid) {
      if (acquisition.state === "ready") {
        await releaseDesktopCodeTransport({
          binding: owned.binding,
          forward: acquisition.forward,
          generation: acquisition.generation,
          leaseId: acquisition.leaseId,
          serverUrl: owned.binding.serverUrl,
        }).catch(() => undefined);
      } else if (acquisition.state === "leader") {
        await failDesktopCodeTransportReservation({
          generation: acquisition.generation,
          reservationId: acquisition.reservationId,
          transportId: wire.transport.transportId,
        });
      }
      options.signal?.throwIfAborted();
      assertDesktopCodeTransportBinding(owned);
    }
    if (acquisition.state === "ready") {
      return trackDesktopCodeTransportLease({
        binding: owned.binding,
        forward: acquisition.forward,
        generation: acquisition.generation,
        leaseId: acquisition.leaseId,
        serverUrl: owned.binding.serverUrl,
      });
    }
    if (acquisition.state === "waiting") {
      await raceWithAbort(
        invoke<boolean>("wait_code_transport_forward", {
          generation: acquisition.generation,
          transportId: wire.transport.transportId,
        }),
        options.signal,
      );
      continue;
    }

    const reservation = {
      generation: acquisition.generation,
      reservationId: acquisition.reservationId,
      transportId: wire.transport.transportId,
    };
    let attachment: TunnelAttachmentCreateResult | null = null;
    let direct: Awaited<
      ReturnType<typeof createDirectTunnelAttachment>
    > | null = null;
    let dataProtection: Awaited<
      ReturnType<typeof getTunnelDataProtection>
    > | null = null;
    let publishedLease: DesktopCodeTransportLease | null = null;
    let publicationMayHaveCommitted = false;
    try {
      // Once native elects this renderer, preparation is deliberately not
      // coupled to one React AbortSignal. Followers may already be waiting on
      // the reservation, so the elected leader must either publish or fail it.
      assertDesktopCodeTransportBinding(owned);
      dataProtection = await getTunnelDataProtection(
        wire.transport.transportId,
        {
          serverUrl: owned.binding.serverUrl,
          signal: AbortSignal.timeout(CODE_TRANSPORT_LEADER_STEP_TIMEOUT_MS),
        },
      );
      if (dataProtection.keyRevision !== wire.transport.protectedKeyRevision) {
        throw new Error(
          "The shared Code transport encryption revision changed.",
        );
      }
      assertDesktopCodeTransportBinding(owned);
      // Server tunnel attachments are keyed by tunnel + client id. A stable
      // desktop client id would let an old generation's delayed DELETE revoke
      // a replacement that reused the same attachment record. The native pool
      // generation is unique per physical forward and keeps cleanup exact.
      const clientId = acquisition.generation;
      attachment = await createTunnelAttachment(
        wire.transport.transportId,
        { clientId },
        {
          serverUrl: owned.binding.serverUrl,
          signal: AbortSignal.timeout(CODE_TRANSPORT_LEADER_STEP_TIMEOUT_MS),
        },
      );
      assertDesktopCodeTransportBinding(owned);
      const diagnosticTraceId = crypto.randomUUID();
      direct = await createDirectTunnelAttachment(
        attachment.attachmentId,
        { diagnosticTraceId },
        {
          serverUrl: owned.binding.serverUrl,
          signal: AbortSignal.timeout(CODE_TRANSPORT_LEADER_STEP_TIMEOUT_MS),
        },
      ).catch(() => null);
      assertDesktopCodeTransportBinding(owned);
      const request = nativeStartRequest(
        attachment,
        clientId,
        direct,
        dataProtection,
        diagnosticTraceId,
        undefined,
        owned.binding.serverUrl,
      );
      const completion = await invoke<CodeTransportForwardCompletion>(
        "complete_code_transport_forward",
        {
          ...reservation,
          request,
          windowInstanceId: desktopCodeWindowInstanceId,
        },
      );
      request.relay.secret = "";
      if (request.direct) request.direct.secret = "";
      request.dataProtection.key = "";
      attachment.secret = "";
      if (direct) direct.secret = "";
      dataProtection.key = "";
      if (completion.generation !== acquisition.generation) {
        throw new Error(
          "The shared Code forward changed while it was preparing.",
        );
      }
      assertDesktopCodeTransportBinding(owned);
      if (completion.forward.routeState === "local-direct") {
        if (!completion.forward.directCapabilityId || !direct) {
          throw new Error(
            "The shared local Code transport omitted its capability identity.",
          );
        }
        await activateDirectTunnelAttachment(
          attachment.attachmentId,
          { capabilityId: completion.forward.directCapabilityId },
          {
            serverUrl: owned.binding.serverUrl,
            signal: AbortSignal.timeout(CODE_TRANSPORT_LEADER_STEP_TIMEOUT_MS),
          },
        );
        assertDesktopCodeTransportBinding(owned);
      } else if (direct) {
        await deleteDirectAttachment(direct.binding.capabilityId, {
          serverUrl: owned.binding.serverUrl,
        }).catch(() => undefined);
      }
      publicationMayHaveCommitted = true;
      const published = await publishDesktopCodeTransportReservation({
        acquisitionId,
        consumerId,
        ...reservation,
      });
      if (published.state !== "ready") {
        throw new Error("The shared Code forward was not published.");
      }
      publishedLease = {
        binding: owned.binding,
        forward: published.forward,
        generation: published.generation,
        leaseId: published.leaseId,
        serverUrl: owned.binding.serverUrl,
      };
      options.signal?.throwIfAborted();
      assertDesktopCodeTransportBinding(owned);
      return trackDesktopCodeTransportLease(publishedLease);
    } catch (error) {
      if (publishedLease) {
        await releaseDesktopCodeTransport(publishedLease).catch(
          () => undefined,
        );
      } else {
        await failDesktopCodeTransportReservation(reservation);
      }
      if (
        !publicationMayHaveCommitted &&
        direct &&
        explorerCodeSessionBindingCurrent(owned.binding)
      ) {
        await deleteDirectAttachment(direct.binding.capabilityId, {
          serverUrl: owned.binding.serverUrl,
        }).catch(() => undefined);
      }
      if (
        !publicationMayHaveCommitted &&
        attachment &&
        explorerCodeSessionBindingCurrent(owned.binding)
      ) {
        await deleteTunnelAttachment(attachment.attachmentId, {
          serverUrl: owned.binding.serverUrl,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (attachment) attachment.secret = "";
      if (direct) direct.secret = "";
      if (dataProtection) dataProtection.key = "";
    }
  }
}

export async function releaseDesktopCodeTransport(
  lease: DesktopCodeTransportLease,
): Promise<boolean> {
  if (!isTauri()) return true;
  const existing = codeTransportReleaseAttempts.get(lease.leaseId);
  if (existing) return existing;
  codeTransportPendingRetirementLeases.add(lease.leaseId);
  // Abort-after-commit cleanup can reach here before the lease was returned to
  // the caller and tracked. Keep it process-locally retryable too.
  trackDesktopCodeTransportLease(lease);
  const attempt = releaseDesktopCodeTransportOnce(lease).finally(() => {
    if (codeTransportReleaseAttempts.get(lease.leaseId) === attempt) {
      codeTransportReleaseAttempts.delete(lease.leaseId);
    }
  });
  codeTransportReleaseAttempts.set(lease.leaseId, attempt);
  return attempt;
}

async function releaseDesktopCodeTransportOnce(
  lease: DesktopCodeTransportLease,
): Promise<boolean> {
  let result: CodeTransportForwardRelease;
  try {
    result = await invoke<CodeTransportForwardRelease>(
      "release_code_transport_forward",
      {
        generation: lease.generation,
        leaseId: lease.leaseId,
        transportId: lease.forward.tunnelId,
        windowInstanceId: desktopCodeWindowInstanceId,
      },
    );
  } catch {
    // The lease stays marked pending-retirement in the process registry. The
    // transport timer retries release and will never renew this lease again.
    return false;
  }
  untrackDesktopCodeTransportLease(lease);
  if (!result.stopped) return true;
  // A native exact-generation release is always safe. Server cleanup is not:
  // after a server/account switch, attaching the new credentials to the old
  // origin would cross the authentication boundary. The old server expires or
  // revokes its transient attachment authoritatively.
  if (!explorerCodeSessionBindingCurrent(lease.binding)) return true;
  await reportFinalDesktopTunnelTelemetry(result.stopped, {
    serverUrl: lease.serverUrl,
  }).catch(() => undefined);
  if (!explorerCodeSessionBindingCurrent(lease.binding)) return true;
  await deleteTunnelAttachment(result.stopped.attachmentId, {
    serverUrl: lease.serverUrl,
  }).catch(() => undefined);
  return true;
}

export async function startDirectDesktopTunnel(
  ticket: DirectTunnelTicket,
  expiresAt: string,
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri()) {
    throw new Error(
      "Local direct tunnel attachments are only available in the desktop app.",
    );
  }
  const request = {
    attachmentId: ticket.route.attachmentId,
    clientId: desktopTunnelClientId(window.localStorage),
    diagnosticTraceId: null,
    direct: ticket,
    expiresAt,
    preferredLocalPort: null,
    relay: null,
    tunnelId: ticket.route.tunnelId,
  };
  try {
    const started = await invoke<DesktopTunnelForwardSummary>(
      "start_tunnel_forward",
      { request },
    );
    if (started.routeState !== "local-direct") {
      throw new Error("The worker is not available on this device.");
    }
    return started;
  } finally {
    request.direct.secret = "";
    ticket.secret = "";
  }
}

export async function stopDesktopTunnel(
  tunnelId: string,
  attachmentId: string,
  expectedForward?: DesktopTunnelForwardIdentity,
): Promise<void> {
  await stopDesktopTunnelForward(tunnelId, expectedForward);
  await deleteTunnelAttachment(attachmentId);
}

export async function stopDesktopTunnelForward(
  tunnelId: string,
  expectedForward?: DesktopTunnelForwardIdentity,
): Promise<void> {
  if (!isTauri()) return;
  const snapshot = await invoke<DesktopTunnelTerminalSnapshot | null>(
    "stop_tunnel_forward",
    {
      ...(expectedForward
        ? {
            expectedAttachmentId: expectedForward.attachmentId,
            expectedDiagnosticTraceId: expectedForward.diagnosticTraceId,
            expectedDirectCapabilityId: expectedForward.directCapabilityId,
          }
        : {}),
      tunnelId,
    },
  ).catch(() => {
    // Server revocation remains authoritative if the local listener is gone.
    return null;
  });
  await reportFinalDesktopTunnelTelemetry(snapshot).catch(() => undefined);
}

export async function invalidateDesktopTunnelForward(
  tunnelId: string,
  expectedForward: DesktopTunnelForwardIdentity,
): Promise<void> {
  if (!isTauri()) return;
  const snapshot = await invoke<DesktopTunnelTerminalSnapshot | null>(
    "stop_tunnel_forward",
    {
      expectedAttachmentId: expectedForward.attachmentId,
      expectedDiagnosticTraceId: expectedForward.diagnosticTraceId,
      expectedDirectCapabilityId: expectedForward.directCapabilityId,
      terminalReasonCode: "attachment-invalidated",
      tunnelId,
    },
  ).catch(() => null);
  await reportFinalDesktopTunnelTelemetry(snapshot).catch(() => undefined);
}

export async function forceDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
  options: {
    binding?: BoundExplorerCodeSessionAttachment["binding"];
    serverUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri() || !forward.relayFallbackAvailable) {
    throw new Error("The desktop tunnel has no relay fallback.");
  }
  options.signal?.throwIfAborted();
  if (
    options.binding &&
    !explorerCodeSessionBindingCurrent(options.binding)
  ) {
    throw new Error("The shared Code transport security identity changed.");
  }
  const relayed = await raceWithAbort(
    invoke<DesktopTunnelForwardSummary | null>("force_tunnel_forward_relay", {
      directCapabilityId: forward.directCapabilityId,
      tunnelId: forward.tunnelId,
    }),
    options.signal,
  );
  options.signal?.throwIfAborted();
  if (!relayed || relayed.routeState !== "relayed") {
    throw new Error("The desktop tunnel could not switch to its relay.");
  }
  if (
    forward.directCapabilityId &&
    relayed.directCapabilityId === forward.directCapabilityId
  ) {
    await retireDirectCapabilityAndConfirm(
      forward,
      relayed,
      options.signal,
      options.serverUrl,
      options.binding,
    );
    return { ...relayed, directCapabilityId: null };
  }
  return relayed;
}

async function retireDirectCapabilityAndConfirm(
  forward: DesktopTunnelForwardSummary,
  snapshot: DesktopTunnelForwardSummary,
  signal?: AbortSignal,
  serverUrl?: string,
  binding?: BoundExplorerCodeSessionAttachment["binding"],
): Promise<void> {
  const capabilityId = forward.directCapabilityId;
  if (!capabilityId) return;
  const existing = directCapabilityRetirements.get(capabilityId);
  if (existing) return raceWithAbort(existing, signal);
  const operation = (async () => {
    await retireDirectCapability(
      capabilityId,
      snapshot,
      serverUrl,
      binding,
    );
    const confirmed = await raceWithAbort(
      invoke<boolean>("confirm_tunnel_forward_direct_retired", {
        directCapabilityId: capabilityId,
        tunnelId: forward.tunnelId,
      }),
      signal,
    );
    if (!confirmed) {
      throw new Error("The desktop tunnel stopped during direct retirement.");
    }
  })();
  const retirement = operation.finally(() => {
    if (directCapabilityRetirements.get(capabilityId) === retirement) {
      directCapabilityRetirements.delete(capabilityId);
    }
  });
  directCapabilityRetirements.set(capabilityId, retirement);
  await raceWithAbort(retirement, signal);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function retireDirectCapability(
  capabilityId: string,
  snapshot: DesktopTunnelForwardSummary,
  serverUrl?: string,
  binding?: BoundExplorerCodeSessionAttachment["binding"],
): Promise<void> {
  const retirementSignal = AbortSignal.timeout(
    DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS,
  );
  const bindingCurrent = () =>
    !binding || explorerCodeSessionBindingCurrent(binding);
  if (bindingCurrent()) {
    await recordDirectAttachmentTelemetry(
      capabilityId,
      {
        bytesFromLocal: snapshot.bytesFromLocal ?? 0,
        bytesToLocal: snapshot.bytesToLocal ?? 0,
        connectionsClosed: snapshot.connectionsClosed ?? 0,
        connectionsOpened: snapshot.connectionsOpened ?? 0,
        ...(snapshot.lastDestinationRejectionCode
          ? {
              lastDestinationRejectionCode:
                snapshot.lastDestinationRejectionCode,
            }
          : {}),
      },
      { serverUrl, signal: retirementSignal },
    ).catch(() => undefined);
  }
  if (!bindingCurrent()) return;
  await deleteDirectAttachment(capabilityId, {
    serverUrl,
    signal: AbortSignal.timeout(DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS),
  });
}

async function reportFinalDesktopTunnelTelemetry(
  snapshot: DesktopTunnelTerminalSnapshot | null,
  options: { serverUrl?: string } = {},
): Promise<void> {
  if (!snapshot?.directCapabilityId) return;
  await recordDirectAttachmentTelemetry(
    snapshot.directCapabilityId,
    {
      bytesFromLocal: snapshot.bytesFromLocal,
      bytesToLocal: snapshot.bytesToLocal,
      connectionsClosed: snapshot.connectionsClosed,
      connectionsOpened: snapshot.connectionsOpened,
      ...(snapshot.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: snapshot.lastDestinationRejectionCode,
          }
        : {}),
    },
    {
      ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      signal: AbortSignal.timeout(FINAL_TELEMETRY_TIMEOUT_MS),
    },
  );
}

export async function listDesktopTunnels(): Promise<
  DesktopTunnelForwardSummary[]
> {
  return listDesktopTunnelsWithOptions();
}

export function listDesktopTunnelsWithOptions(
  options: { signal?: AbortSignal } = {},
): Promise<DesktopTunnelForwardSummary[]> {
  return isTauri()
    ? raceWithAbort(
        invoke<DesktopTunnelForwardSummary[]>("list_tunnel_forwards"),
        options.signal,
      )
    : Promise.resolve([]);
}

export function refreshDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!isTauri() || !forward.relayFallbackAvailable) {
    return Promise.resolve(false);
  }
  options.signal?.throwIfAborted();
  const existing = relayRefreshes.get(forward.tunnelId);
  if (existing) {
    return options.signal ? raceWithAbort(existing, options.signal) : existing;
  }
  const refresh = rotateDesktopTunnelRelay(
    forward,
    options.signal,
    options.serverUrl,
  ).finally(() => {
    if (relayRefreshes.get(forward.tunnelId) === refresh) {
      relayRefreshes.delete(forward.tunnelId);
    }
  });
  relayRefreshes.set(forward.tunnelId, refresh);
  return refresh;
}

async function rotateDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
  signal?: AbortSignal,
  serverUrl?: string,
): Promise<boolean> {
  const attachment = await createTunnelAttachment(
    forward.tunnelId,
    {
      clientId:
        forward.codePoolGeneration ??
        desktopTunnelClientId(window.localStorage),
    },
    { serverUrl, signal },
  );
  if (attachment.attachmentId !== forward.attachmentId) {
    attachment.secret = "";
    throw new Error("The refreshed tunnel attachment identity did not match.");
  }
  const relay = {
    connectPath: attachment.connectPath,
    secret: attachment.secret,
    secretExpiresAtEpochMs: new Date(attachment.secretExpiresAt).getTime(),
    serverUrl: serverUrl ?? getActiveServerUrl(),
  };
  try {
    const result = await raceWithAbort(
      invoke<DesktopTunnelRelayRefreshResult | boolean>(
        "refresh_tunnel_forward_relay",
        {
          expiresAt: attachment.expiresAt,
          relay,
          tunnelId: forward.tunnelId,
        },
      ),
      signal,
    );
    const outcome =
      typeof result === "boolean"
        ? result
          ? "accepted"
          : "forward-unavailable"
        : result.outcome;
    return outcome !== "forward-unavailable";
  } finally {
    relay.secret = "";
    attachment.secret = "";
  }
}
