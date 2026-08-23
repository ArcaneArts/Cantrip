import { createElement } from "react";
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

import {
  explorerWorkerEncryptionBindingKey,
  explorerWorkerEncryptionBindingReady,
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
    ...overrides,
  });
}

describe("Explorer worker encryption binding", () => {
  beforeEach(() => {
    runtime.wait.mockReset();
    runtime.wait.mockResolvedValue(undefined);
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

  it("keeps a reactivated binding closed until the new authorization completes", async () => {
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

    let resolveReactivation!: () => void;
    runtime.wait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReactivation = resolve;
        }),
    );
    await act(async () => {
      renderer.update(createElement(Probe, { enabled: true }));
    });
    expect(runtime.wait).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)).toBe(false);

    await act(async () => resolveReactivation());
    expect(observed.at(-1)).toBe(true);
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
