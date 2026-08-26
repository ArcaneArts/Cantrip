import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientEncryptionSnapshot } from "@/lib/client-encryption";
import type { ClientSessionContext } from "@/lib/client-session";

const runtime = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    encryption: {
      clientId: "client-a",
      identity: { ownerId: "owner-a", serverId: "server-a" },
      masterKeyRevision: 3,
      status: "ready" as const,
    },
    listeners,
    session: {
      serverId: "server-a",
      user: { id: "owner-a" },
    },
    worker: {
      workerId: "worker-a",
      online: true,
      startedAt: "2026-08-26T00:00:00.000Z",
      encryption: {
        supported: true,
        state: "ready" as const,
        principalId: "11111111-1111-4111-8111-111111111111",
        grants: [
          { component: "surface-private-state" as const, keyRevision: 3 },
          { component: "private-surface-metadata" as const, keyRevision: 3 },
        ],
        lastSyncedAt: "2026-08-26T00:00:00.000Z",
        error: null,
      },
    },
    wait: vi.fn<() => Promise<void>>(async () => undefined),
  };
});

vi.mock("@/lib/api", () => ({
  getWorkers: vi.fn(async () => []),
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    getSnapshot: () => runtime.encryption,
    subscribe: (listener: () => void) => {
      runtime.listeners.add(listener);
      return () => runtime.listeners.delete(listener);
    },
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => runtime.session,
}));
vi.mock("@/lib/surface-private-state-worker-encryption", () => ({
  waitForSurfacePrivateStateWorkerEncryption: runtime.wait,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [runtime.worker],
    isError: false,
    refetch: vi.fn(async () => undefined),
  }),
}));

import {
  explorerWorkerEncryptionBindingKey,
  explorerWorkerEncryptionBindingReady,
  explorerWorkerSecurityFingerprint,
  resetExplorerWorkerEncryptionReadinessForTests,
  useExplorerWorkerEncryption,
} from "./use-explorer-worker-encryption";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const explorer = {
  activeWorkerId: "worker-a",
  id: "explorer-a",
  projectId: "project-a",
  worktreeId: "worktree-a",
};
const encryption = {
  clientId: "client-a",
  identity: { ownerId: "owner-a", serverId: "server-a" },
  masterKeyRevision: 3,
  status: "ready",
} satisfies ClientEncryptionSnapshot;
const session = {
  serverId: "server-a",
  user: { id: "owner-a" },
} as ClientSessionContext;

function binding(
  overrides: Partial<
    Parameters<typeof explorerWorkerEncryptionBindingKey>[0]
  > = {},
): string {
  return explorerWorkerEncryptionBindingKey({
    encryption,
    explorer,
    session,
    worker: runtime.worker,
    ...overrides,
  });
}

describe("Explorer worker encryption binding", () => {
  beforeEach(() => {
    resetExplorerWorkerEncryptionReadinessForTests();
    runtime.wait.mockReset();
    runtime.wait.mockResolvedValue(undefined);
    runtime.worker = {
      ...runtime.worker,
      online: true,
      startedAt: "2026-08-26T00:00:00.000Z",
      encryption: {
        ...runtime.worker.encryption,
        state: "ready",
        principalId: "11111111-1111-4111-8111-111111111111",
        grants: [
          { component: "surface-private-state" as const, keyRevision: 3 },
          { component: "private-surface-metadata" as const, keyRevision: 3 },
        ],
        lastSyncedAt: "2026-08-26T00:00:00.000Z",
        error: null,
      },
    };
  });

  it("invalidates readiness when the Explorer or its worker binding changes", () => {
    const current = binding();

    expect(binding({ explorer: { ...explorer, id: "explorer-b" } })).not.toBe(
      current,
    );
    expect(
      binding({ explorer: { ...explorer, projectId: "project-b" } }),
    ).not.toBe(current);
    expect(
      binding({ explorer: { ...explorer, worktreeId: "worktree-b" } }),
    ).not.toBe(current);
    expect(
      binding({ explorer: { ...explorer, activeWorkerId: "worker-b" } }),
    ).not.toBe(current);
  });

  it("invalidates readiness across server, account, and key revisions", () => {
    const current = binding();

    expect(
      binding({
        session: {
          ...session,
          serverId: "server-b",
        },
      }),
    ).not.toBe(current);
    expect(
      binding({
        session: {
          ...session,
          user: { ...session.user, id: "owner-b" },
        },
      }),
    ).not.toBe(current);
    expect(
      binding({
        encryption: { ...encryption, masterKeyRevision: 4 },
      }),
    ).not.toBe(current);
    expect(
      binding({
        encryption: {
          ...encryption,
          identity: { ownerId: "owner-a", serverId: "server-b" },
        },
      }),
    ).not.toBe(current);
  });

  it("fingerprints material worker security state but ignores heartbeat timestamps", () => {
    const current = explorerWorkerSecurityFingerprint(runtime.worker);
    expect(
      explorerWorkerSecurityFingerprint({
        ...runtime.worker,
        encryption: {
          ...runtime.worker.encryption,
          lastSyncedAt: "2026-08-26T00:10:00.000Z",
        },
      }),
    ).toBe(current);
    expect(
      explorerWorkerSecurityFingerprint({
        ...runtime.worker,
        startedAt: "2026-08-26T00:10:00.000Z",
      }),
    ).not.toBe(current);
    expect(
      explorerWorkerSecurityFingerprint({
        ...runtime.worker,
        online: false,
      }),
    ).not.toBe(current);
    expect(
      explorerWorkerSecurityFingerprint({
        ...runtime.worker,
        encryption: {
          ...runtime.worker.encryption,
          grants: [
            { component: "surface-private-state" as const, keyRevision: 4 },
            {
              component: "private-surface-metadata" as const,
              keyRevision: 4,
            },
          ],
        },
      }),
    ).not.toBe(current);
  });

  it("only opens the operation gate for the exact completed binding", () => {
    const current = binding();
    const previous = binding({
      session: { ...session, serverId: "server-previous" },
    });

    expect(explorerWorkerEncryptionBindingReady(current, null)).toBe(false);
    expect(explorerWorkerEncryptionBindingReady(current, previous)).toBe(false);
    expect(explorerWorkerEncryptionBindingReady(current, current)).toBe(true);
  });

  it("does not authorize while inactive and safely authorizes on activation", async () => {
    const observed: boolean[] = [];
    const Probe = ({ enabled }: { enabled: boolean }) => {
      observed.push(useExplorerWorkerEncryption(explorer, enabled).ready);
      return null;
    };
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { enabled: false }));
    });
    expect(runtime.wait).not.toHaveBeenCalled();
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { enabled: true }));
    });
    expect(runtime.wait).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)).toBe(true);

    await act(async () => renderer.unmount());
  });

  it("shares one readiness operation across StrictMode effect replay", async () => {
    const Probe = () => {
      useExplorerWorkerEncryption(explorer, true);
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(StrictMode, null, createElement(Probe)),
      );
    });
    expect(runtime.wait).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it("reuses a completed binding through a brief reactivation gap", async () => {
    const observed: boolean[] = [];
    const Probe = ({ enabled }: { enabled: boolean }) => {
      observed.push(useExplorerWorkerEncryption(explorer, enabled).ready);
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { enabled: true }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => {
      renderer.update(createElement(Probe, { enabled: false }));
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { enabled: true }));
    });
    expect(runtime.wait).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)).toBe(true);
    await act(async () => renderer.unmount());
  });

  it("does not cache a failed readiness operation as success", async () => {
    runtime.wait.mockRejectedValueOnce(new Error("authorization failed"));
    const observed: Array<{ error: string | null; ready: boolean }> = [];
    let retry!: () => void;
    const Probe = () => {
      const state = useExplorerWorkerEncryption(explorer, true);
      retry = state.retry;
      observed.push({ error: state.error, ready: state.ready });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    expect(observed.at(-1)).toMatchObject({ ready: false });
    expect(observed.at(-1)?.error).not.toBeNull();

    runtime.wait.mockResolvedValueOnce(undefined);
    await act(async () => retry());
    expect(runtime.wait).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)).toEqual({ error: null, ready: true });
    await act(async () => renderer.unmount());
  });

  it("invalidates a completed lease when the worker incarnation changes", async () => {
    const Probe = () => {
      useExplorerWorkerEncryption(explorer, true);
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    expect(runtime.wait).toHaveBeenCalledTimes(1);

    runtime.worker = {
      ...runtime.worker,
      startedAt: "2026-08-26T00:15:00.000Z",
    };
    await act(async () => renderer.update(createElement(Probe)));
    expect(runtime.wait).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it("deduplicates concurrent consumers without cancelling the active lease", async () => {
    let resolveAuthorization!: () => void;
    runtime.wait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const observed = new Map<string, boolean>();
    const Probe = ({
      enabled,
      explorer: currentExplorer,
      name,
    }: {
      enabled: boolean;
      explorer: typeof explorer;
      name: string;
    }) => {
      observed.set(
        name,
        useExplorerWorkerEncryption(currentExplorer, enabled).ready,
      );
      return null;
    };
    const secondExplorer = {
      ...explorer,
      id: "explorer-b",
      projectId: "project-b",
      worktreeId: "worktree-b",
    };
    const probes = (firstEnabled: boolean) =>
      createElement(
        "div",
        null,
        createElement(Probe, {
          enabled: firstEnabled,
          explorer,
          name: "first",
        }),
        createElement(Probe, {
          enabled: true,
          explorer: secondExplorer,
          name: "second",
        }),
      );
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(probes(true));
    });
    expect(runtime.wait).toHaveBeenCalledTimes(1);

    await act(async () => renderer.update(probes(false)));
    expect(runtime.wait).toHaveBeenCalledTimes(1);

    await act(async () => resolveAuthorization());
    expect(observed.get("first")).toBe(false);
    expect(observed.get("second")).toBe(true);

    await act(async () => renderer.unmount());
  });
});
