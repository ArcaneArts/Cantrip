import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  TunnelAttachmentCreateResult,
  WorkerLinkRoute,
} from "@cantrip/protocol";

import {
  createTunnelAttachment,
  deleteDirectAttachment,
  deleteTunnelAttachment,
  getTunnelTransportConfiguration,
  recordDirectAttachmentTelemetry,
  renewTunnelAttachmentLease,
} from "@/lib/api";
import { getActiveServerUrl } from "@/lib/server-connections";
import {
  refreshDesktopTunnelWorkerLinkForward,
  startDesktopTunnelWorkerLinkForward,
  stopDesktopTunnelWorkerLinkForward,
  type DesktopTunnelWorkerLinkBridge,
} from "@/lib/desktop-tunnel-worker-link";

const clientIdStorageKey = "cantrip.desktop-tunnel-client.v1";
const FINAL_TELEMETRY_TIMEOUT_MS = 2_000;
const DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS = 2_000;

const directCapabilityRetirements = new Map<string, Promise<void>>();
const relayRefreshes = new Map<string, Promise<boolean>>();

export interface DesktopTunnelForwardSummary {
  attachmentId: string;
  diagnosticTraceId: string | null;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  effectiveRoute?: WorkerLinkRoute | null;
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
  // Exclude forwards left by an older desktop host until its pool is removed.
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

const createDesktopTunnelRuntime = () => ({
  recentTerminalForwards: new Map<string, DesktopTunnelForwardTerminalEvent>(),
  terminalForwardSubscribers: new Set<{
    identity: Pick<
      DesktopTunnelForwardTerminalEvent,
      "attachmentId" | "diagnosticTraceId" | "tunnelId"
    >;
    listener(event: DesktopTunnelForwardTerminalEvent): void;
    notified: boolean;
  }>(),
  terminalForwardListenerReady: null as Promise<void> | null,
});
type DesktopTunnelRuntime = ReturnType<typeof createDesktopTunnelRuntime>;
const hotState = import.meta.hot?.data as
  { desktopTunnelRuntime?: DesktopTunnelRuntime } | undefined;
// Keep generic tunnel event ownership across Vite module replacement.
const desktopTunnelRuntime = hotState
  ? (hotState.desktopTunnelRuntime ??= createDesktopTunnelRuntime())
  : createDesktopTunnelRuntime();
const DESKTOP_TUNNEL_FORWARD_TERMINAL_EVENT = "cantrip-tunnel-forward-terminal";
const MAX_RECENT_TERMINAL_FORWARDS = 256;
const recentTerminalForwards = desktopTunnelRuntime.recentTerminalForwards;
const terminalForwardSubscribers =
  desktopTunnelRuntime.terminalForwardSubscribers;

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
  if (desktopTunnelRuntime.terminalForwardListenerReady) {
    return desktopTunnelRuntime.terminalForwardListenerReady;
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
      if (desktopTunnelRuntime.terminalForwardListenerReady === opening) {
        desktopTunnelRuntime.terminalForwardListenerReady = null;
      }
      throw error;
    });
  desktopTunnelRuntime.terminalForwardListenerReady = opening;
  return opening;
}

if (isTauri()) {
  void ensureDesktopTunnelForwardTerminalListener().catch(() => undefined);
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
  const configuration = await getTunnelTransportConfiguration(tunnelId);
  const attachment = await createTunnelAttachment(tunnelId, { clientId });
  let started: DesktopTunnelForwardSummary | null = null;
  try {
    started = await startDesktopTunnelWorkerLinkForward({
      attachmentId: attachment.attachmentId,
      dataProtection: configuration.dataProtection,
      diagnosticTraceId: options.diagnosticTraceId,
      expiresAt: attachment.expiresAt,
      preferredLocalPort: options.preferredLocalPort,
      serverUrl: getActiveServerUrl(),
      tunnelId: attachment.tunnelId,
      workerId: configuration.workerId,
    });
    configuration.dataProtection.key = "";
    attachment.secret = "";
    return started;
  } catch (error) {
    configuration.dataProtection.key = "";
    attachment.secret = "";
    await stopDesktopTunnelForward(tunnelId, {
      attachmentId: started?.attachmentId ?? attachment.attachmentId,
      diagnosticTraceId:
        started?.diagnosticTraceId ?? options.diagnosticTraceId ?? null,
      directCapabilityId: null,
    }).catch(() => undefined);
    await deleteTunnelAttachment(attachment.attachmentId).catch(() => {
      // Preserve the native bind/connection error if best-effort cleanup fails.
    });
    throw error;
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
  await stopDesktopTunnelWorkerLinkForward(tunnelId);
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
    serverUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DesktopTunnelForwardSummary> {
  if (!isTauri() || !forward.relayFallbackAvailable) {
    throw new Error("The desktop tunnel has no relay fallback.");
  }
  options.signal?.throwIfAborted();
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
): Promise<void> {
  const capabilityId = forward.directCapabilityId;
  if (!capabilityId) return;
  const existing = directCapabilityRetirements.get(capabilityId);
  if (existing) return raceWithAbort(existing, signal);
  const operation = (async () => {
    await retireDirectCapability(capabilityId, snapshot, serverUrl);
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
): Promise<void> {
  const retirementSignal = AbortSignal.timeout(
    DIRECT_CAPABILITY_RETIRE_TIMEOUT_MS,
  );
  await recordDirectAttachmentTelemetry(
    capabilityId,
    {
      bytesFromLocal: snapshot.bytesFromLocal ?? 0,
      bytesToLocal: snapshot.bytesToLocal ?? 0,
      connectionsClosed: snapshot.connectionsClosed ?? 0,
      connectionsOpened: snapshot.connectionsOpened ?? 0,
      ...(snapshot.lastDestinationRejectionCode
        ? {
            lastDestinationRejectionCode: snapshot.lastDestinationRejectionCode,
          }
        : {}),
    },
    { serverUrl, signal: retirementSignal },
  ).catch(() => undefined);
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

export function isDesktopTunnelWorkerLinkForward(
  forward: DesktopTunnelForwardSummary,
): boolean {
  return (
    forward.codePoolGeneration == null &&
    forward.directCapabilityId == null &&
    forward.relayFallbackAvailable === false
  );
}

export async function refreshDesktopTunnelWorkerLinkAttachment(
  forward: DesktopTunnelForwardSummary,
  options: {
    clientId?: string;
    serverUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  if (!isTauri() || !isDesktopTunnelWorkerLinkForward(forward)) return false;
  const { clientId, ...requestOptions } = options;
  const attachment = await createTunnelAttachment(
    forward.tunnelId,
    {
      clientId: clientId ?? desktopTunnelClientId(window.localStorage),
    },
    requestOptions,
  );
  try {
    if (attachment.attachmentId !== forward.attachmentId) {
      throw new Error(
        "The refreshed tunnel attachment identity did not match.",
      );
    }
    return refreshDesktopTunnelWorkerLinkForward(
      forward.tunnelId,
      forward.attachmentId,
      attachment.expiresAt,
    );
  } finally {
    attachment.secret = "";
  }
}

async function rotateDesktopTunnelRelay(
  forward: DesktopTunnelForwardSummary,
  signal?: AbortSignal,
  serverUrl?: string,
): Promise<boolean> {
  const attachment = await createTunnelAttachment(
    forward.tunnelId,
    {
      clientId: desktopTunnelClientId(window.localStorage),
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
