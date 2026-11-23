import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleWorkerLinkCommand,
  type WorkerLinkCommand,
  type WorkerLinkCommandDependencies,
} from "../src/commands/worker-link.js";
import {
  handleWorktreeCommand,
  type WorktreeCommandDependencies,
} from "../src/commands/worktree.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Tests supply only ports a command is allowed to call. Unexpected dependencies
// remain absent so crossing a feature/ownership boundary fails visibly.
function linkDependencies(partial: Partial<WorkerLinkCommandDependencies>) {
  return partial as WorkerLinkCommandDependencies;
}

const route: WorkerLinkCommand = {
  type: "worker-link.session.route",
  sessionId: randomUUID(),
  routeGeneration: 3,
  preferredRoute: "relay",
};
const revoke: WorkerLinkCommand = {
  type: "worker-link.session.revoke",
  sessionId: randomUUID(),
  revocation: { reason: "released", revokedAt: new Date().toISOString() },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkerLink command ordering", () => {
  it("waits for gateway acceptance before replacing the peer route", async () => {
    const acceptance = deferred<unknown>();
    const replaceRouteGeneration = vi.fn().mockResolvedValue(undefined);
    const result = handleWorkerLinkCommand(
      route,
      linkDependencies({
        workerLinkGateway: {
          handleCoordinatorCommand: () => acceptance.promise,
        } as unknown as WorkerLinkCommandDependencies["workerLinkGateway"],
        workerLinkPeerGateway: {
          replaceRouteGeneration,
        } as unknown as WorkerLinkCommandDependencies["workerLinkPeerGateway"],
      }),
    );
    expect(replaceRouteGeneration).not.toHaveBeenCalled();
    const accepted = { accepted: true };
    acceptance.resolve(accepted);
    await expect(result).resolves.toBe(accepted);
    expect(replaceRouteGeneration).toHaveBeenCalledWith(
      route.sessionId,
      route.routeGeneration,
    );
  });

  it("does not mutate the peer when gateway acceptance rejects", async () => {
    const error = new Error("stale generation");
    const replaceRouteGeneration = vi.fn();
    await expect(
      handleWorkerLinkCommand(
        route,
        linkDependencies({
          workerLinkGateway: {
            handleCoordinatorCommand: async () => {
              throw error;
            },
          },
          workerLinkPeerGateway: {
            replaceRouteGeneration,
          } as unknown as WorkerLinkCommandDependencies["workerLinkPeerGateway"],
        }),
      ),
    ).rejects.toBe(error);
    expect(replaceRouteGeneration).not.toHaveBeenCalled();
  });

  it("waits for peer revocation before retiring the gateway session", async () => {
    const revoked = deferred<void>();
    const handleCoordinatorCommand = vi
      .fn()
      .mockResolvedValue({ revoked: true });
    const revokeSession = vi.fn(() => revoked.promise);
    const result = handleWorkerLinkCommand(
      revoke,
      linkDependencies({
        workerLinkGateway: { handleCoordinatorCommand },
        workerLinkPeerGateway: {
          revokeSession,
        } as unknown as WorkerLinkCommandDependencies["workerLinkPeerGateway"],
      }),
    );
    expect(revokeSession).toHaveBeenCalledWith(
      revoke.sessionId,
      revoke.revocation.reason,
    );
    expect(handleCoordinatorCommand).not.toHaveBeenCalled();
    revoked.resolve();
    await expect(result).resolves.toEqual({ revoked: true });
    expect(handleCoordinatorCommand).toHaveBeenCalledWith(revoke);
  });

  it("propagates peer revocation errors without acknowledging gateway retirement", async () => {
    const error = new Error("peer close failed");
    const handleCoordinatorCommand = vi.fn();
    await expect(
      handleWorkerLinkCommand(
        revoke,
        linkDependencies({
          workerLinkGateway: { handleCoordinatorCommand },
          workerLinkPeerGateway: {
            revokeSession: async () => {
              throw error;
            },
          } as unknown as WorkerLinkCommandDependencies["workerLinkPeerGateway"],
        }),
      ),
    ).rejects.toBe(error);
    expect(handleCoordinatorCommand).not.toHaveBeenCalled();
  });

  it("rejects a capability for another worker before allocating broker resources", async () => {
    const prepare = vi.fn();
    await expect(
      handleWorkerLinkCommand(
        {
          type: "direct.capability.prepare",
          binding: { workerId: "other" },
        } as WorkerLinkCommand,
        linkDependencies({
          config: { workerId: "current" },
          directBroker: {
            prepare,
          } as unknown as WorkerLinkCommandDependencies["directBroker"],
        }),
      ),
    ).rejects.toThrow("another worker");
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([null, new Date(Date.now() + 30_000).toISOString()])(
    "keeps the broker's actual renewed authority: %s",
    async (expiry) => {
      const renew = vi.fn(() => expiry);
      await expect(
        handleWorkerLinkCommand(
          {
            type: "direct.capability.renew",
            capabilityId: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          linkDependencies({
            directBroker: {
              renew,
            } as unknown as WorkerLinkCommandDependencies["directBroker"],
          }),
        ),
      ).resolves.toEqual(
        expiry ? { renewed: true, leaseExpiresAt: expiry } : { renewed: false },
      );
    },
  );
});

describe("Worktree command retirement", () => {
  it("stops owned runs before removal and reads the latest observation supervisor afterward", async () => {
    const order: string[] = [];
    const removal = deferred<void>();
    let supervisor: ReturnType<
      WorktreeCommandDependencies["getCodegraphProjects"]
    > = null;
    const dependencies = {
      worktrees: {
        remove: async (
          _source: string,
          target: string,
          options: { beforeRemove: (target: string) => Promise<void> },
        ) => {
          await options.beforeRemove(target);
          order.push("remove");
          await removal.promise;
          return { removed: true };
        },
      },
      runConfigurationRuntimes: {
        stopForPath: async () => {
          order.push("stop");
        },
      },
      codegraphObservations: {
        forgetPath: () => {
          order.push("forget");
        },
      },
      getCodegraphProjects: () => supervisor,
    } as unknown as WorktreeCommandDependencies;
    const result = handleWorktreeCommand(
      {
        type: "worktree.remove",
        sourcePath: "/source",
        worktreePath: "/worktree",
        force: false,
        allowExternal: false,
      },
      dependencies,
    );
    await vi.waitFor(() => expect(order).toEqual(["stop", "remove"]));
    supervisor = {
      detach: () => {
        order.push("detach");
      },
    } as unknown as NonNullable<typeof supervisor>;
    removal.resolve();
    await expect(result).resolves.toEqual({ removed: true });
    expect(order).toEqual(["stop", "remove", "forget", "detach"]);
  });

  it("leaves observations attached when removal fails", async () => {
    const forgetPath = vi.fn(),
      getCodegraphProjects = vi.fn();
    const error = new Error("dirty worktree");
    await expect(
      handleWorktreeCommand(
        {
          type: "worktree.remove",
          sourcePath: "/source",
          worktreePath: "/worktree",
          force: false,
          allowExternal: false,
        },
        {
          worktrees: {
            remove: async () => {
              throw error;
            },
          },
          codegraphObservations: { forgetPath },
          getCodegraphProjects,
        } as unknown as WorktreeCommandDependencies,
      ),
    ).rejects.toBe(error);
    expect(forgetPath).not.toHaveBeenCalled();
    expect(getCodegraphProjects).not.toHaveBeenCalled();
  });
});
