import type { AuthMode, UserSummary } from "@cantrip/protocol";

import { clearClientEncryptionMemory } from "@/lib/client-encryption";
import {
  getActiveServerConnection,
  type ServerConnection,
} from "@/lib/server-connections";

export interface ClientSessionContext {
  authMode: AuthMode;
  csrfToken: string | null;
  expiresAt: string | null;
  serverId: string;
  user: UserSummary;
}

export type AuthenticationRequiredAction = "refresh-encryption" | "sign-out";

type AuthenticationRequiredListener = (reason: string) => void;
export interface ClientSessionIdentityChange {
  current: ClientSessionIdentitySnapshot | null;
  kind: "changed" | "cleared" | "initialized";
  previous: ClientSessionIdentitySnapshot | null;
}
type ClientSessionIdentityListener = (
  change: ClientSessionIdentityChange,
) => void;

type ClientSessionRuntimeState = {
  authenticationRequiredListeners: Set<AuthenticationRequiredListener>;
  identityGeneration: number;
  identityIncarnationId: string | null;
  identityListeners: Set<ClientSessionIdentityListener>;
  identityStorageKey: string | null;
  session: ClientSessionContext | null;
  sessionChannel: BroadcastChannel | null;
  sessionChannelName: string | null;
};

type ClientSessionHotState = {
  clientSession?: ClientSessionRuntimeState;
};

export function clientSessionForRuntime(
  hotState?: ClientSessionHotState,
): ClientSessionRuntimeState {
  if (!hotState) {
    return {
      authenticationRequiredListeners: new Set(),
      identityGeneration: 0,
      identityIncarnationId: null,
      identityListeners: new Set(),
      identityStorageKey: null,
      session: null,
      sessionChannel: null,
      sessionChannelName: null,
    };
  }
  hotState.clientSession ??= {
    authenticationRequiredListeners: new Set(),
    identityGeneration: 0,
    identityIncarnationId: null,
    identityListeners: new Set(),
    identityStorageKey: null,
    session: null,
    sessionChannel: null,
    sessionChannelName: null,
  };
  return hotState.clientSession;
}

// Keep authentication identity and the unlocked encryption service on the same
// lifetime during development hot reloads. Otherwise a reloaded workspace
// adapter can observe an empty session while the mounted application remains
// authenticated, incorrectly reporting that workspace encryption is locked.
const runtime = clientSessionForRuntime(
  import.meta.hot?.data as ClientSessionHotState | undefined,
);
runtime.identityListeners ??= new Set();
runtime.identityGeneration ??= 0;
runtime.identityIncarnationId ??= null;
runtime.identityStorageKey ??= null;

function identityIncarnationStorageKey(
  session: ClientSessionContext,
  connection = getActiveServerConnection(),
): string {
  return [
    "cantrip.client-identity.v2",
    connection?.id ?? "unconfigured",
    connection?.url ?? "unconfigured",
    connection?.accountId ?? "unbound",
    session.serverId,
    session.user.id,
  ]
    .map((part) => encodeURIComponent(part))
    .join(".");
}

function validIdentityIncarnationId(value: string | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      ),
  );
}

function acquireIdentityIncarnation(
  session: ClientSessionContext,
): { incarnationId: string; storageKey: string } {
  const key = identityIncarnationStorageKey(session);
  try {
    const existing = globalThis.localStorage?.getItem(key) ?? null;
    if (validIdentityIncarnationId(existing)) {
      return { incarnationId: existing, storageKey: key };
    }
    const created = crypto.randomUUID();
    globalThis.localStorage?.setItem(key, created);
    const winner = globalThis.localStorage?.getItem(key) ?? created;
    return {
      incarnationId: validIdentityIncarnationId(winner) ? winner : created,
      storageKey: key,
    };
  } catch {
    return { incarnationId: crypto.randomUUID(), storageKey: key };
  }
}

function retireIdentityIncarnationId(
  storageKey: string | null,
  incarnationId: string | null,
): void {
  if (!incarnationId || !storageKey) return;
  try {
    if (globalThis.localStorage?.getItem(storageKey) === incarnationId) {
      globalThis.localStorage.removeItem(storageKey);
    }
  } catch {
    // The in-memory identity still rotates when storage is unavailable.
  }
}

function notifyClientSessionIdentityChanged(
  change: ClientSessionIdentityChange,
): void {
  for (const listener of runtime.identityListeners) listener(change);
}

function synchronizeSession(next: ClientSessionContext): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channelName = `${runtime.identityStorageKey ?? identityIncarnationStorageKey(next)}.session`;
  if (runtime.sessionChannelName !== channelName) {
    runtime.sessionChannel?.close();
    runtime.sessionChannelName = channelName;
    runtime.sessionChannel = new BroadcastChannel(channelName);
    runtime.sessionChannel.addEventListener("message", (event) => {
      const update = event.data as {
        csrfToken?: unknown;
        expiresAt?: unknown;
        identityIncarnationId?: unknown;
        retiredIdentityIncarnationId?: unknown;
      };
      if (
        runtime.identityIncarnationId &&
        update.retiredIdentityIncarnationId === runtime.identityIncarnationId
      ) {
        clearClientSessionInternal(false);
        return;
      }
      if (
        runtime.session &&
        typeof update.csrfToken === "string" &&
        update.csrfToken.length >= 32 &&
        typeof update.expiresAt === "string"
      ) {
        runtime.session = {
          ...runtime.session,
          csrfToken: update.csrfToken,
          expiresAt: update.expiresAt,
        };
      }
      const incomingIncarnationId =
        typeof update.identityIncarnationId === "string"
          ? update.identityIncarnationId
          : null;
      if (
        runtime.session &&
        validIdentityIncarnationId(incomingIncarnationId)
      ) {
        const key =
          runtime.identityStorageKey ??
          identityIncarnationStorageKey(runtime.session);
        let canonical = incomingIncarnationId;
        try {
          const stored = globalThis.localStorage?.getItem(key) ?? null;
          if (validIdentityIncarnationId(stored)) {
            canonical = stored;
          } else {
            globalThis.localStorage?.setItem(key, canonical);
          }
        } catch {
          // The BroadcastChannel value still converges this renderer when
          // shared storage is unavailable.
        }
        if (runtime.identityIncarnationId !== canonical) {
          const previous = getClientSessionIdentitySnapshot();
          runtime.identityGeneration += 1;
          runtime.identityIncarnationId = canonical;
          notifyClientSessionIdentityChanged({
            current: getClientSessionIdentitySnapshot(),
            kind: "changed",
            previous,
          });
        }
      }
    });
  }
  if (runtime.identityIncarnationId) {
    runtime.sessionChannel?.postMessage({
      ...(next.csrfToken && next.expiresAt
        ? { csrfToken: next.csrfToken, expiresAt: next.expiresAt }
        : {}),
      identityIncarnationId: runtime.identityIncarnationId,
    });
  }
}

export function setClientSession(next: ClientSessionContext): void {
  const previous = getClientSessionIdentitySnapshot();
  const hadSession = Boolean(runtime.session);
  const identityChanged =
    !runtime.session ||
    runtime.session.serverId !== next.serverId ||
    runtime.session.user.id !== next.user.id;
  if (
    runtime.session &&
    (runtime.session.serverId !== next.serverId ||
      runtime.session.user.id !== next.user.id)
  ) {
    clearClientEncryptionMemory();
    retireIdentityIncarnationId(
      runtime.identityStorageKey,
      runtime.identityIncarnationId,
    );
  }
  if (identityChanged) runtime.identityGeneration += 1;
  runtime.session = next;
  if (identityChanged || !runtime.identityIncarnationId) {
    const acquired = acquireIdentityIncarnation(next);
    runtime.identityIncarnationId = acquired.incarnationId;
    runtime.identityStorageKey = acquired.storageKey;
  }
  synchronizeSession(next);
  if (identityChanged) {
    notifyClientSessionIdentityChanged({
      current: getClientSessionIdentitySnapshot(),
      kind: hadSession ? "changed" : "initialized",
      previous,
    });
  }
}

function clearClientSessionInternal(broadcast: boolean): void {
  const previous = getClientSessionIdentitySnapshot();
  const identityChanged = Boolean(runtime.session);
  if (identityChanged) runtime.identityGeneration += 1;
  clearClientEncryptionMemory();
  if (broadcast && runtime.identityIncarnationId) {
    runtime.sessionChannel?.postMessage({
      retiredIdentityIncarnationId: runtime.identityIncarnationId,
    });
  }
  retireIdentityIncarnationId(
    runtime.identityStorageKey,
    runtime.identityIncarnationId,
  );
  runtime.session = null;
  runtime.identityIncarnationId = null;
  runtime.identityStorageKey = null;
  runtime.sessionChannel?.close();
  runtime.sessionChannel = null;
  runtime.sessionChannelName = null;
  if (identityChanged) {
    notifyClientSessionIdentityChanged({
      current: null,
      kind: "cleared",
      previous,
    });
  }
}

export function clearClientSession(): void {
  clearClientSessionInternal(true);
}

export function rotateClientSessionIdentity(
  previousConnection?: ServerConnection | null,
): void {
  if (!runtime.session || !runtime.identityIncarnationId) return;
  const previous = clientSessionIdentitySnapshot(
    previousConnection === undefined
      ? getActiveServerConnection()
      : previousConnection,
  );
  retireIdentityIncarnationId(
    runtime.identityStorageKey,
    runtime.identityIncarnationId,
  );
  runtime.identityGeneration += 1;
  const acquired = acquireIdentityIncarnation(runtime.session);
  runtime.identityIncarnationId = acquired.incarnationId;
  runtime.identityStorageKey = acquired.storageKey;
  synchronizeSession(runtime.session);
  notifyClientSessionIdentityChanged({
    current: getClientSessionIdentitySnapshot(),
    kind: "changed",
    previous,
  });
}

export function onClientSessionIdentityChanged(
  listener: ClientSessionIdentityListener,
): () => void {
  runtime.identityListeners.add(listener);
  return () => runtime.identityListeners.delete(listener);
}

export function getClientSession(): ClientSessionContext | null {
  return runtime.session;
}

export interface ClientSessionIdentitySnapshot {
  accountId: string | null;
  connectionId: string | null;
  generation: number;
  incarnationId: string;
  serverId: string;
  serverUrl: string | null;
  userId: string;
}

function clientSessionIdentitySnapshot(
  connection: ServerConnection | null,
): ClientSessionIdentitySnapshot | null {
  return runtime.session && runtime.identityIncarnationId
    ? {
        accountId: connection?.accountId ?? null,
        connectionId: connection?.id ?? null,
        generation: runtime.identityGeneration,
        incarnationId: runtime.identityIncarnationId,
        serverId: runtime.session.serverId,
        serverUrl: connection?.url ?? null,
        userId: runtime.session.user.id,
      }
    : null;
}

export function getClientSessionIdentitySnapshot(): ClientSessionIdentitySnapshot | null {
  return clientSessionIdentitySnapshot(getActiveServerConnection());
}

export function clientSessionIdentityMatches(
  expected: ClientSessionIdentitySnapshot,
): boolean {
  const current = getClientSessionIdentitySnapshot();
  return (
    current !== null &&
    current.accountId === expected.accountId &&
    current.connectionId === expected.connectionId &&
    current.generation === expected.generation &&
    current.incarnationId === expected.incarnationId &&
    current.serverId === expected.serverId &&
    current.serverUrl === expected.serverUrl &&
    current.userId === expected.userId
  );
}

export function authenticationRequiredAction(): AuthenticationRequiredAction {
  return runtime.session?.authMode === "none"
    ? "refresh-encryption"
    : "sign-out";
}

export function clientStorageScope(): string {
  const serverId =
    runtime.session?.serverId ??
    getActiveServerConnection()?.id ??
    "unconfigured";
  return `${serverId}:${runtime.session?.user.id ?? "signed-out"}`;
}

export function scopedClientStorageKey(key: string): string {
  return `${key}.${clientStorageScope()}`;
}

export function onAuthenticationRequired(
  listener: AuthenticationRequiredListener,
): () => void {
  runtime.authenticationRequiredListeners.add(listener);
  return () => runtime.authenticationRequiredListeners.delete(listener);
}

export function notifyAuthenticationRequired(reason: string): void {
  if (!runtime.session) return;
  for (const listener of runtime.authenticationRequiredListeners)
    listener(reason);
}
