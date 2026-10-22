import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { afterEach, expect, it, vi } from "vitest";
import { handleExplorerCommand } from "../../../cantrip_worker/src/commands/explorer";
import { SurfaceStreamReplayGuard } from "../../../cantrip_worker/src/surface-stream-encryption";
import type { WorkerEncryptionService } from "../../../cantrip_worker/src/worker-encryption";
import { createExplorerFile } from "./api/files";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";

const transport = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({ request: transport }));
const roots: string[] = [];
afterEach(async () => {
  clientEncryption.lock();
  clearClientSession();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("creates the named file through the encrypted API/worker operation and returns encrypted collision errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-create-file-api-"));
  roots.push(root);
  const parent = "SENTINEL-private-folder";
  const name = "SENTINEL-private-file.ts";
  await mkdir(path.join(root, parent));
  const identity = { ownerId: "file-owner", serverId: "file-server" };
  setClientSession({
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: null,
    serverId: identity.serverId,
    user: {
      id: identity.ownerId,
      kind: "account",
      displayName: "Files",
      email: "file@example.com",
      role: "member",
    },
  });
  clientEncryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity,
    masterKeyRevision: 1,
  });
  const workerEncryption = {
    ownerId: () => identity.ownerId,
    componentKey: () => ({
      keyRevision: 1,
      key: clientEncryption.componentKey({
        component: "surface-private-state",
        identity,
        keyRevision: 1,
      }),
    }),
  } as unknown as WorkerEncryptionService;
  const surfaceStreamReplay = new SurfaceStreamReplayGuard();
  const binding = {
    projectId: "project",
    worktreeId: "worktree",
    workerId: "worker",
  };
  transport.mockImplementation(async (url: string, options: RequestInit) => {
    expect(url).toBe("/api/explorers/explorer-file/operation");
    expect(options.method).toBe("POST");
    expect(options.body).not.toContain("SENTINEL");
    const input = JSON.parse(options.body as string);
    expect(Object.keys(input).sort()).toEqual([
      "binding",
      "operationId",
      "protectedRequest",
      "sequence",
    ]);
    expect(input.binding).toEqual(binding);
    const { binding: _binding, ...operation } = input;
    const result = await handleExplorerCommand(
      {
        ...operation,
        type: "explorer.operation",
        root,
        explorerId: "explorer-file",
        serverId: identity.serverId,
      },
      { workerEncryption, surfaceStreamReplay },
    );
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(JSON.stringify(result)).not.toContain("already exists");
    return result;
  });
  await expect(
    createExplorerFile("explorer-file", { path: parent, name }, binding),
  ).resolves.toMatchObject({
    name,
    path: `${parent}/${name}`,
    kind: "file",
    size: 0,
  });
  await expect(readFile(path.join(root, parent, name), "utf8")).resolves.toBe(
    "",
  );
  await expect(
    createExplorerFile("explorer-file", { path: parent, name }, binding),
  ).rejects.toThrow("already exists");
  expect(transport).toHaveBeenCalledTimes(2);
});
