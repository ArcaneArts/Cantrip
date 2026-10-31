import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { EXPLORER_FILE_IMPORT_CHUNK_BYTES } from "@cantrip/protocol/surface-stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleExplorerCommand } from "../../../cantrip_worker/src/commands/explorer";
import { ExplorerFileImports } from "../../../cantrip_worker/src/explorer-file-imports";
import { SurfaceStreamReplayGuard } from "../../../cantrip_worker/src/surface-stream-encryption";
import type { WorkerEncryptionService } from "../../../cantrip_worker/src/worker-encryption";
import { importExplorerFile } from "./api/explorer-import";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";

const transport = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({ request: transport }));
let root: string;
let fileImports: ExplorerFileImports;
const binding = {
  projectId: "project",
  worktreeId: "worktree",
  workerId: "worker",
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cantrip-import-api-"));
  await mkdir(path.join(root, "SENTINEL-folder"));
  fileImports = new ExplorerFileImports();
  const identity = { ownerId: "owner", serverId: "server" };
  setClientSession({
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: null,
    serverId: identity.serverId,
    user: {
      id: identity.ownerId,
      kind: "account",
      displayName: "Files",
      email: "files@example.com",
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
  transport.mockReset();
  transport.mockImplementation(async (url: string, options: RequestInit) => {
    expect(url).toBe("/api/explorers/explorer/operation");
    expect(options.method).toBe("POST");
    expect(options.body).not.toContain("SENTINEL");
    const { binding: sentBinding, ...operation } = JSON.parse(
      options.body as string,
    );
    expect(sentBinding).toEqual(binding);
    const response = await handleExplorerCommand(
      {
        ...operation,
        type: "explorer.operation",
        root,
        explorerId: "explorer",
        serverId: identity.serverId,
      },
      { fileImports, workerEncryption, surfaceStreamReplay },
    );
    expect(JSON.stringify(response)).not.toContain("SENTINEL");
    return response;
  });
});
afterEach(async () => {
  await fileImports.dispose();
  clientEncryption.lock();
  clearClientSession();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("streams exact binary bytes through encrypted app/worker messages with progress and bounded reads", async () => {
  const bytes = Uint8Array.from(
    { length: 2 * EXPLORER_FILE_IMPORT_CHUNK_BYTES + 17 },
    (_, i) => i % 256,
  );
  const file = new File([bytes], "SENTINEL-image.bin");
  const fullRead = vi.spyOn(file, "arrayBuffer");
  const slice = vi.spyOn(file, "slice");
  const onProgress = vi.fn();
  expect(
    await importExplorerFile("explorer", "SENTINEL-folder", file, binding, {
      isCurrent: () => true,
      onProgress,
    }),
  ).toMatchObject({
    path: "SENTINEL-folder/SENTINEL-image.bin",
    size: bytes.length,
  });
  expect(
    await readFile(path.join(root, "SENTINEL-folder/SENTINEL-image.bin")),
  ).toEqual(Buffer.from(bytes));
  expect(fullRead).not.toHaveBeenCalled();
  expect(slice).toHaveBeenCalledTimes(3);
  expect(onProgress.mock.calls.map(([offset]) => offset)).toEqual([
    EXPLORER_FILE_IMPORT_CHUNK_BYTES,
    2 * EXPLORER_FILE_IMPORT_CHUNK_BYTES,
    bytes.length,
  ]);
  const operations = transport.mock.calls.map(([, options]) =>
    JSON.parse(options.body),
  );
  expect(new Set(operations.map((v) => v.operationId)).size).toBe(1);
  expect(operations.map((v) => v.sequence)).toEqual([0, 1, 2]);
});

it("imports empty files and reports collisions without replacing bytes", async () => {
  const file = new File([], "SENTINEL-empty");
  const options = { isCurrent: () => true, onProgress: vi.fn() };
  await importExplorerFile("explorer", "", file, binding, options);
  await expect(
    importExplorerFile(
      "explorer",
      "",
      new File(["replacement"], file.name),
      binding,
      options,
    ),
  ).rejects.toThrow("already exists");
  expect(await readFile(path.join(root, file.name))).toHaveLength(0);
});

it("cancels an unfinished import when the project authorization changes", async () => {
  let current = true;
  await expect(
    importExplorerFile(
      "explorer",
      "",
      new File(
        [new Uint8Array(EXPLORER_FILE_IMPORT_CHUNK_BYTES + 1)],
        "SENTINEL-cancelled.bin",
      ),
      binding,
      {
        isCurrent: () => current,
        onProgress: () => {
          current = false;
        },
      },
    ),
  ).rejects.toThrow("project changed");
  expect(await readdir(root)).toEqual(["SENTINEL-folder"]);
  expect(transport).toHaveBeenCalledTimes(2);
});
