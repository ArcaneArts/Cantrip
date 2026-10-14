import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeSettingsSynchronizer } from "../src/code-settings-sync.js";
import {
  handleCodeCommand,
  type CodeCommand,
  type CodeCommandDependencies,
} from "../src/commands/code.js";
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
function codeDependencies(partial: Partial<CodeCommandDependencies>) {
  return partial as CodeCommandDependencies;
}
function linkDependencies(partial: Partial<WorkerLinkCommandDependencies>) {
  return partial as WorkerLinkCommandDependencies;
}

const stop: CodeCommand = {
  type: "code.stop",
  sessionId: randomUUID(),
  expectedSessionIncarnationId: randomUUID(),
};
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

describe("Code command ownership", () => {
  it("claims an incarnation before awaiting endpoint closure and retiring", async () => {
    const events: string[] = [];
    const closing = deferred<void>();
    const status = { state: "stopped" };
    const retire = vi.fn(async () => {
      events.push("retire");
      return status;
    });
    const claimStop = vi.fn(() => {
      events.push("claim");
      return { accepted: true as const, retire };
    });
    const closeSession = vi.fn(async () => {
      events.push("close");
      await closing.promise;
    });
    const result = handleCodeCommand(
      stop,
      codeDependencies({
        code: { claimStop } as unknown as CodeCommandDependencies["code"],
        codeDirectEndpoints: {
          closeSession,
        } as unknown as CodeCommandDependencies["codeDirectEndpoints"],
      }),
      {},
    );
    expect(events).toEqual(["claim", "close"]);
    expect(claimStop).toHaveBeenCalledWith(
      stop.sessionId,
      stop.expectedSessionIncarnationId,
    );
    expect(closeSession).toHaveBeenCalledWith(
      stop.sessionId,
      stop.expectedSessionIncarnationId,
    );
    expect(retire).not.toHaveBeenCalled();
    closing.resolve();
    await expect(result).resolves.toBe(status);
    expect(events).toEqual(["claim", "close", "retire"]);
  });

  it("a stale stop cannot close endpoints or retire the live incarnation", async () => {
    const status = { state: "running" };
    const closeSession = vi.fn();
    await expect(
      handleCodeCommand(
        stop,
        codeDependencies({
          code: {
            claimStop: () => ({ accepted: false, status }),
          } as unknown as CodeCommandDependencies["code"],
          codeDirectEndpoints: {
            closeSession,
          } as unknown as CodeCommandDependencies["codeDirectEndpoints"],
        }),
        {},
      ),
    ).resolves.toBe(status);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("propagates an endpoint closure failure without retiring the runtime", async () => {
    const error = new Error("endpoint close failed");
    const retire = vi.fn();
    await expect(
      handleCodeCommand(
        stop,
        codeDependencies({
          code: {
            claimStop: () => ({ accepted: true, retire }),
          } as unknown as CodeCommandDependencies["code"],
          codeDirectEndpoints: {
            closeSession: async () => {
              throw error;
            },
          } as unknown as CodeCommandDependencies["codeDirectEndpoints"],
        }),
        {},
      ),
    ).rejects.toBe(error);
    expect(retire).not.toHaveBeenCalled();
  });

  it("reads the current synchronizer after asynchronous authorization", async () => {
    const authorization = deferred<CodeSettingsSynchronizer | null>();
    const status = { state: "ready", profileId: "latest" };
    let current: CodeSettingsSynchronizer | null = null;
    const result = handleCodeCommand(
      { type: "code.settings.status" },
      codeDependencies({
        ensureCodeSettingsSynchronizer: () => authorization.promise,
        getCodeSettingsSynchronizer: () => current,
        unavailableCodeSettingsStatus: () => {
          throw new Error("stale synchronizer");
        },
      }),
      {},
    );
    current = { status: () => status } as unknown as CodeSettingsSynchronizer;
    authorization.resolve(null);
    await expect(result).resolves.toBe(status);
  });

  it("rejects a profile replaced during authorization before synchronizing", async () => {
    const authorization = deferred<CodeSettingsSynchronizer | null>();
    let profile = "old";
    const synchronize = vi.fn();
    const result = handleCodeCommand(
      { type: "code.settings.workbench.open", profileId: "old" } as CodeCommand,
      codeDependencies({
        ensureCodeSettingsSynchronizer: () => authorization.promise,
        getDefaultCodeProfileId: () => profile,
      }),
      {},
    );
    const rejected = expect(result).rejects.toThrow(
      "profile binding is invalid",
    );
    profile = "replacement";
    authorization.resolve({
      synchronize,
    } as unknown as CodeSettingsSynchronizer);
    await rejected;
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("preserves captured transport generation and current security identity", async () => {
    const command = {
      type: "code.transport.route.revoke",
      transportId: randomUUID(),
    } as CodeCommand;
    const identity = { protectedKeyRevision: 8 };
    const revokeSharedRoute = vi.fn().mockResolvedValue({ revoked: true });
    await expect(
      handleCodeCommand(
        command,
        codeDependencies({
          activeCodeTransportSecurityIdentity: () =>
            identity as ReturnType<
              CodeCommandDependencies["activeCodeTransportSecurityIdentity"]
            >,
          codeDirectEndpoints: {
            revokeSharedRoute,
          } as unknown as CodeCommandDependencies["codeDirectEndpoints"],
        }),
        { codeTransportLifecycleGeneration: 42 },
      ),
    ).resolves.toEqual({ revoked: true });
    expect(revokeSharedRoute).toHaveBeenCalledWith(command, identity, 42);
  });
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
