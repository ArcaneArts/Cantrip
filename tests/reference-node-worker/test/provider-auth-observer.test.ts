import type { WorkerNotification } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderAuthObserver } from "../src/provider-auth-observer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider auth live observer", () => {
  it("emits bounded safe transitions and replays terminal state on reconnect", async () => {
    vi.useFakeTimers();
    const notifications: WorkerNotification[] = [];
    let authenticated = false;
    const observer = new ProviderAuthObserver({
      emit: (notification) => {
        notifications.push(notification);
        return true;
      },
      pollIntervalMs: 5_000,
    });
    observer.start({
      credentialHomeKey: "account-home-1",
      observationId: "00000000-0000-4000-8000-000000000001",
      providerAccountId: "account-1",
      providerId: "provider-1",
      providerKind: "chatgpt",
      readStatus: async () => ({
        authenticated,
        authMode: authenticated ? "chatgpt" : null,
        email: authenticated ? "person@example.com" : null,
        planType: authenticated ? "plus" : null,
        weeklyUsage: authenticated
          ? { usedPercent: 20, resetsAt: 1_800_000_000 }
          : null,
        loginPending: !authenticated,
        loginError: null,
      }),
    });
    expect(notifications[0]).toMatchObject({
      type: "provider.auth.status.observed",
      sequence: 1,
      status: { state: "pending", failureCode: null },
    });
    await vi.advanceTimersByTimeAsync(0);
    authenticated = true;
    observer.wake("account-home-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications.at(-1)).toMatchObject({
      sequence: 2,
      status: {
        state: "authenticated",
        authMode: "chatgpt",
        email: "person@example.com",
        planType: "plus",
      },
    });
    expect(JSON.stringify(notifications)).not.toMatch(
      /accessToken|refreshToken|deviceCode|userCode|privateKey|credential/u,
    );

    const beforeReconnect = notifications.length;
    observer.reemitAll();
    expect(notifications).toHaveLength(beforeReconnect + 1);
    expect(notifications.at(-1)).toMatchObject({
      sequence: 3,
      status: { state: "authenticated" },
    });
    observer.close();
  });

  it("converges cancellation without relaying an upstream error", () => {
    const notifications: WorkerNotification[] = [];
    const observer = new ProviderAuthObserver({
      emit: (notification) => {
        notifications.push(notification);
        return true;
      },
    });
    observer.start({
      credentialHomeKey: "account-home-2",
      observationId: "00000000-0000-4000-8000-000000000002",
      providerAccountId: "account-2",
      providerId: "provider-2",
      providerKind: "grok",
      readStatus: async () => {
        throw new Error("access_token=must-never-be-relayed");
      },
    });
    observer.cancel("account-home-2");
    expect(notifications.at(-1)).toMatchObject({
      status: {
        state: "cancelled",
        failureCode: "authorization-cancelled",
      },
    });
    expect(JSON.stringify(notifications)).not.toContain(
      "must-never-be-relayed",
    );
    observer.close();
  });

  it("publishes an exact expired terminal state at the bounded deadline", async () => {
    vi.useFakeTimers();
    let now = 0;
    const notifications: WorkerNotification[] = [];
    const observer = new ProviderAuthObserver({
      emit: (notification) => {
        notifications.push(notification);
        return true;
      },
      now: () => now,
      pollIntervalMs: 5_000,
      ttlMs: 100,
    });
    observer.start({
      credentialHomeKey: "account-home-3",
      observationId: "00000000-0000-4000-8000-000000000003",
      providerAccountId: "account-3",
      providerId: "provider-3",
      providerKind: "chatgpt",
      readStatus: async () => ({
        authenticated: false,
        authMode: null,
        email: null,
        planType: null,
        weeklyUsage: null,
        loginPending: true,
        loginError: null,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    now = 101;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notifications.at(-1)).toMatchObject({
      status: {
        state: "expired",
        failureCode: "authorization-expired",
      },
    });
    observer.close();
  });
});
