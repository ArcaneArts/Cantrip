import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { encryptCantripOsBackupMessage } from "@cantrip/crypto";
import { cantripOsBackupRequestEnvelopeSchema } from "@cantrip/protocol/cantrip-os-backup-operations";
import { backupFile } from "./backup-context.js";
import { CantripOsBackupManager } from "./backup-manager.js";
import { CantripOsController } from "./controller.js";
import { sealPrivateBackup } from "./private-backup-file.js";

it("removes verified plaintext when captured placement fails before any guest receive", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-backup-staging-"),
  );
  const key = randomBytes(32),
    operationId = randomUUID(),
    backupId = randomUUID(),
    workspaceId = randomUUID();
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  const keys = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  };
  const controller = new CantripOsController(directory, "worker");
  const authority = vi
    .spyOn(controller, "assertAdministrativeScope")
    .mockResolvedValue();
  let guestCalls = 0;
  const ports = {
    control: async () => {
      guestCalls++;
      throw new Error("Unexpected guest effect");
    },
    exportArchive: async function* () {
      guestCalls++;
      throw new Error("Unexpected export");
    },
  };
  try {
    await sealPrivateBackup({
      destination: backupFile(directory, scope, backupId),
      context: { ownerId: scope.ownerId, serverId: scope.serverId, backupId },
      keys,
      metadata: {
        version: 1,
        archiveBytes: 0,
        archiveSha256: createHash("sha256").digest("hex"),
        manifest: {
          cantrip: { scope: { ...scope, guestInstanceId: randomUUID() } },
        },
      },
      archive: (async function* () {})(),
    });
    const protectedRequest = cantripOsBackupRequestEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ...scope,
        operationId,
        keyRevision: 1,
        componentKey: key,
        direction: "request",
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            action: "restore",
            workspaceId,
            backupId,
            replace: false,
          }),
        ),
      }),
    );
    const result = await new CantripOsBackupManager(
      directory,
      "worker",
      controller,
      keys,
      ports,
    ).handle({
      type: "cantrip-os.backup.restore",
      operationId,
      scope,
      backupId,
      backupScope: scope,
      replace: false,
      transport: { kind: "docker", container: "unused" },
      protectedRequest,
      workspace: {
        id: workspaceId,
        guestWorkspaceId: "example",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/home/example",
      },
    });
    expect(result.state).toBe("failed");
    expect(guestCalls).toBe(0);
    await expect(
      stat(
        path.join(
          path.dirname(backupFile(directory, scope, operationId)),
          "restore-staging",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(backupFile(directory, scope, backupId))).isFile()).toBe(
      true,
    );
  } finally {
    authority.mockRestore();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
