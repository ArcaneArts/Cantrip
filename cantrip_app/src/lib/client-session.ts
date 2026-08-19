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

const authenticationRequiredListeners =
  new Set<AuthenticationRequiredListener>();
let session: ClientSessionContext | null = null;
let sessionChannel: BroadcastChannel | null = null;
let sessionChannelName: string | null = null;

function synchronizeSession(next: ClientSessionContext): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channelName = `cantrip.session.v1.${next.serverId}.${next.user.id}`;
  if (sessionChannelName !== channelName) {
    sessionChannel?.close();
    sessionChannelName = channelName;
    sessionChannel = new BroadcastChannel(channelName);
    sessionChannel.addEventListener("message", (event) => {
      const update = event.data as {
        csrfToken?: unknown;
        expiresAt?: unknown;
      };
      if (
        session &&
        typeof update.csrfToken === "string" &&
        update.csrfToken.length >= 32 &&
        typeof update.expiresAt === "string"
      ) {
        session = {
          ...session,
          csrfToken: update.csrfToken,
          expiresAt: update.expiresAt,
        };
      }
    });
  }
  if (next.csrfToken && next.expiresAt) {
    sessionChannel?.postMessage({
      csrfToken: next.csrfToken,
      expiresAt: next.expiresAt,
    });
  }
}

export function setClientSession(next: ClientSessionContext): void {
  if (
    session &&
    (session.serverId !== next.serverId || session.user.id !== next.user.id)
  ) {
    clearClientEncryptionMemory();
  }
  session = next;
  synchronizeSession(next);
}

export function clearClientSession(): void {
  clearClientEncryptionMemory();
  session = null;
  sessionChannel?.close();
  sessionChannel = null;
  sessionChannelName = null;
}

export function getClientSession(): ClientSessionContext | null {
  return session;
}

export function clientStorageScope(): string {
  const serverId =
    session?.serverId ?? getActiveServerConnection()?.id ?? "unconfigured";
  return `${serverId}:${session?.user.id ?? "signed-out"}`;
}

export function scopedClientStorageKey(key: string): string {
  return `${key}.${clientStorageScope()}`;
}

export function onAuthenticationRequired(
  listener: AuthenticationRequiredListener,
): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export function notifyAuthenticationRequired(reason: string): void {
  if (!session) return;
  for (const listener of authenticationRequiredListeners) listener(reason);
}
