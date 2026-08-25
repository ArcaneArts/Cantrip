import { describe, expect, it, vi } from "vitest";

import {
  authenticationRequiredAction,
  clearClientSession,
  clientSessionIdentityMatches,
  clientSessionForRuntime,
  getClientSession,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  rotateClientSessionIdentity,
  setClientSession,
  type ClientSessionContext,
} from "./client-session";

const session: ClientSessionContext = {
  authMode: "accounts",
  csrfToken: "c".repeat(32),
  expiresAt: "2026-08-20T13:00:00.000Z",
  serverId: "server-a",
  user: {
    id: "owner-a",
    kind: "account",
    displayName: "Owner A",
    email: "owner-a@example.com",
    role: "owner",
  },
};

describe("client session runtime", () => {
  it("preserves the authenticated identity across development hot reloads", () => {
    const hotState: Parameters<typeof clientSessionForRuntime>[0] = {};
    const mountedApplication = clientSessionForRuntime(hotState);
    mountedApplication.session = session;

    const reloadedWorkspaceCaller = clientSessionForRuntime(hotState);

    expect(reloadedWorkspaceCaller).toBe(mountedApplication);
    expect(reloadedWorkspaceCaller.session).toEqual(session);
  });

  it("routes local encryption challenges back to encryption recovery", () => {
    setClientSession({ ...session, authMode: "none" });

    expect(authenticationRequiredAction()).toBe("refresh-encryption");

    clearClientSession();
    expect(authenticationRequiredAction()).toBe("sign-out");
  });

  it("fences pooled transports across logout while retaining CSRF refreshes", () => {
    clearClientSession();
    setClientSession(session);
    const initial = getClientSessionIdentitySnapshot();
    expect(initial).not.toBeNull();

    setClientSession({
      ...session,
      csrfToken: "d".repeat(32),
      expiresAt: "2026-08-20T14:00:00.000Z",
    });
    expect(getClientSessionIdentitySnapshot()).toEqual(initial);
    expect(clientSessionIdentityMatches(initial!)).toBe(true);

    clearClientSession();
    expect(clientSessionIdentityMatches(initial!)).toBe(false);
    setClientSession(session);
    expect(getClientSessionIdentitySnapshot()?.generation).toBeGreaterThan(
      initial!.generation,
    );
    expect(clientSessionIdentityMatches(initial!)).toBe(false);
    clearClientSession();
  });

  it("publishes exact old and new incarnations when authentication identity rotates", () => {
    clearClientSession();
    const changes: Parameters<
      Parameters<typeof onClientSessionIdentityChanged>[0]
    >[0][] = [];
    const unsubscribe = onClientSessionIdentityChanged((change) => {
      changes.push(change);
    });

    setClientSession(session);
    const initialized = getClientSessionIdentitySnapshot();
    expect(initialized).not.toBeNull();
    rotateClientSessionIdentity();
    const rotated = getClientSessionIdentitySnapshot();
    expect(rotated).not.toBeNull();
    expect(rotated?.incarnationId).not.toBe(initialized?.incarnationId);
    expect(rotated?.generation).toBeGreaterThan(initialized!.generation);
    clearClientSession();

    expect(changes).toEqual([
      {
        current: initialized,
        kind: "initialized",
        previous: null,
      },
      {
        current: rotated,
        kind: "changed",
        previous: initialized,
      },
      {
        current: null,
        kind: "cleared",
        previous: rotated,
      },
    ]);
    unsubscribe();
  });

  it("broadcasts the exact retired incarnation before signing out", () => {
    clearClientSession();
    const messages: unknown[] = [];
    class TestBroadcastChannel {
      addEventListener(): void {}
      close(): void {}
      postMessage(message: unknown): void {
        messages.push(message);
      }
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    setClientSession(session);
    const incarnationId = getClientSessionIdentitySnapshot()?.incarnationId;

    clearClientSession();

    expect(messages).toContainEqual({
      retiredIdentityIncarnationId: incarnationId,
    });
    vi.unstubAllGlobals();
  });

  it("retires a sibling webview session when its shared incarnation signs out", () => {
    clearClientSession();
    let receive: (event: { data: unknown }) => void = () => {
      throw new Error("The shared client-session channel was not subscribed.");
    };
    class TestBroadcastChannel {
      addEventListener(
        _type: string,
        listener: (event: { data: unknown }) => void,
      ): void {
        receive = listener;
      }
      close(): void {}
      postMessage(): void {}
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    setClientSession(session);
    const incarnationId = getClientSessionIdentitySnapshot()?.incarnationId;

    receive({ data: { retiredIdentityIncarnationId: incarnationId } });

    expect(getClientSession()).toBeNull();
    expect(getClientSessionIdentitySnapshot()).toBeNull();
    vi.unstubAllGlobals();
  });
});
