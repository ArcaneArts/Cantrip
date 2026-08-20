import type { AuthMode, UserSummary } from "@cantrip/protocol";

import { clearClientEncryptionMemory } from "@/lib/client-encryption";
import { getActiveServerConnection } from "@/lib/server-connections";

export interface ClientSessionContext {
  authMode: AuthMode;
  csrfToken: string | null;
  expiresAt: string | null;
  serverId: string;
  user: UserSummary;
}

type AuthenticationRequiredListener = (reason: string) => void;

type ClientSessionRuntimeState = {
  authenticationRequiredListeners: Set<AuthenticationRequiredListener>;
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
      session: null,
      sessionChannel: null,
      sessionChannelName: null,
    };
  }
  hotState.clientSession ??= {
    authenticationRequiredListeners: new Set(),
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

function synchronizeSession(next: ClientSessionContext): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channelName = `cantrip.session.v1.${next.serverId}.${next.user.id}`;
  if (runtime.sessionChannelName !== channelName) {
    runtime.sessionChannel?.close();
    runtime.sessionChannelName = channelName;
    runtime.sessionChannel = new BroadcastChannel(channelName);
    runtime.sessionChannel.addEventListener("message", (event) => {
      const update = event.data as {
        csrfToken?: unknown;
        expiresAt?: unknown;
      };
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
    });
  }
  if (next.csrfToken && next.expiresAt) {
    runtime.sessionChannel?.postMessage({
      csrfToken: next.csrfToken,
      expiresAt: next.expiresAt,
    });
  }
}

export function setClientSession(next: ClientSessionContext): void {
  if (
    runtime.session &&
    (runtime.session.serverId !== next.serverId ||
      runtime.session.user.id !== next.user.id)
  ) {
    clearClientEncryptionMemory();
  }
  runtime.session = next;
  synchronizeSession(next);
}

export function clearClientSession(): void {
  clearClientEncryptionMemory();
  runtime.session = null;
  runtime.sessionChannel?.close();
  runtime.sessionChannel = null;
  runtime.sessionChannelName = null;
}

export function getClientSession(): ClientSessionContext | null {
  return runtime.session;
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
