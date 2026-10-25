import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workerCommandSchema } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRepositoryOperation } from "./repository-operation-dispatch.js";
import { RepositoryManagedOperationStore } from "./repository-managed-operation-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-repository-dispatch-"),
  );
  directories.push(directory);
  const command = workerCommandSchema.parse({
    type: "repository.operation",
    serverId: "server-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    worktreeId: "22222222-2222-4222-8222-222222222222",
    operationId: "33333333-3333-4333-8333-333333333333",
    cwd: "/authorized/worktree",
    sourcePath: "/authorized/primary",
    repository: null,
    protectedRequest: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  });
  if (command.type !== "repository.operation")
    throw new Error("Wrong fixture command.");
  return {
    command,
    scope: {
      ownerId: "owner-1",
      serverId: command.serverId,
      projectId: command.projectId,
      worktreeId: command.worktreeId,
      workerId: "worker-1",
    },
    store: new RepositoryManagedOperationStore(directory),
    inspect: vi.fn(async () => {
      throw new Error("Unexpected inspection.");
    }),
    repositoryForCheckout: vi.fn(async (): Promise<string | null> => null),
    dispatch: vi.fn(async () => ({ marker: "leaf-result" })),
  };
}

describe("dispatchRepositoryOperation", () => {
  it("routes to the authorized checkout even when private arguments specify another path", async () => {
    const input = await fixture();
    await expect(
      dispatchRepositoryOperation({
        ...input,
        request: {
          type: "worktree.status",
          arguments: {
            cwd: "/untrusted",
            worktreePath: "/untrusted",
            sourcePath: "/untrusted",
          },
        },
      }),
    ).resolves.toEqual({ ok: true, result: { marker: "leaf-result" } });
    expect(input.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree.status",
        sourcePath: "/authorized/primary",
        worktreePath: "/authorized/worktree",
      }),
    );
  });

  it("returns no current operation without inspecting or dispatching Git", async () => {
    const input = await fixture();
    await expect(
      dispatchRepositoryOperation({
        ...input,
        request: { type: "git.operation.current", arguments: {} },
      }),
    ).resolves.toEqual({ ok: true, result: { operation: null } });
    expect(input.inspect).not.toHaveBeenCalled();
    expect(input.dispatch).not.toHaveBeenCalled();
  });

  it("rejects controls for an operation that is not recorded", async () => {
    const input = await fixture();
    await expect(
      dispatchRepositoryOperation({
        ...input,
        request: {
          type: "git.operation.control",
          arguments: {
            operationId: input.command.operationId,
            action: "abort",
          },
        },
      }),
    ).rejects.toThrow("Git operation not found.");
    expect(input.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a private source identity different from the authorized peer", async () => {
    const input = await fixture();
    await expect(
      dispatchRepositoryOperation({
        ...input,
        command: {
          ...input.command,
          peerWorktree: { id: "authorized-peer", cwd: "/authorized/peer" },
        },
        request: {
          type: "git.worktree.changes.preview",
          arguments: { request: { sourceWorktreeId: "other-peer" } },
        },
      }),
    ).rejects.toThrow(
      "The protected source worktree does not match the routed peer worktree.",
    );
    expect(input.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an extra peer on an operation that cannot move changes", async () => {
    const input = await fixture();
    await expect(
      dispatchRepositoryOperation({
        ...input,
        command: {
          ...input.command,
          peerWorktree: { id: "peer", cwd: "/authorized/peer" },
        },
        request: { type: "worktree.status", arguments: {} },
      }),
    ).rejects.toThrow(
      "A peer worktree is only valid for a worktree changes move.",
    );
    expect(input.dispatch).not.toHaveBeenCalled();
  });
});
