import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cantripOsBackupArchiveMetadataSchema } from "@cantrip/protocol/cantrip-os-backup";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import {
  exportRecoveryArchive,
  recoveryControl,
} from "../src/os-executor/recovery-carrier.js";
import {
  openPrivateBackup,
  sealPrivateBackup,
  type BackupKeyAccess,
} from "../src/os-executor/private-backup-file.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);

describe.skipIf(!enabled)("real package private backup transfer", () => {
  it("captures through the actual carrier, seals privately, verifies and restores into a new account", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const directory = await mkdtemp(join(tmpdir(), "cantrip-backup-transfer-"));
    const source = `sealed-${randomUUID().slice(0, 10)}`,
      target = `opened-${randomUUID().slice(0, 10)}`;
    const captureId = randomUUID(),
      restoreId = randomUUID(),
      backupId = randomUUID();
    let connection: OsExecutorConnection | undefined;
    try {
      let status = await executorControl<{
        instance_id: string;
        attachment: { owner_id: string; worker_id: string } | null;
      }>(transport, ["status"]);
      if (!status.attachment)
        status = await executorControl(transport, [
          "attach",
          randomUUID(),
          randomUUID(),
        ]);
      const attachment = status.attachment!;
      const expected = [
        "--expect",
        JSON.stringify({
          guestInstanceId: status.instance_id,
          ownerId: attachment.owner_id,
          workerId: attachment.worker_id,
        }),
      ];
      await workspaceControl(transport, ["create", source]);
      await workspaceControl(transport, ["create", target]);
      const binding = await executorControl<OsExecutorBinding>(transport, [
        "open",
        source,
      ]);
      connection = new OsExecutorConnection(transport, binding);
      await connection.request("initialize", {
        clientName: "private-backup-source",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      const large = Buffer.alloc(2 * 1_048_576 + 317, 0x62);
      const files = new Map([
        [".gitignore", Buffer.from(".env\n")],
        [".env", Buffer.from("DUMMY_PRIVATE_ENV=retained\n")],
        ["雪-😀.txt", Buffer.from("Unicode workspace data")],
        ["profile.bin", large],
      ]);
      for (const [name, bytes] of files)
        await connection.request("fs/writeFile", {
          path: guestFileUri(`${binding.home}/${name}`),
          dataBase64: bytes.toString("base64"),
          sandbox: null,
        });
      await connection.close();
      const capture = await recoveryControl({
        transport,
        args: [...expected, "capture", captureId, source],
      });
      expect(capture).toMatchObject({
        operation_id: captureId,
        action: "capture",
        state: "captured",
      });
      const receipt = capture.receipt!;
      const metadata = cantripOsBackupArchiveMetadataSchema.parse({
        version: 1,
        archiveBytes: receipt.archive_bytes,
        archiveSha256: receipt.archive_sha256,
        manifest: receipt.manifest,
      });
      const context = {
        ownerId: attachment.owner_id,
        serverId: "phase5-private-backup-fixture",
        backupId,
      };
      const key = randomBytes(32);
      const keys: BackupKeyAccess = {
        ownerId: () => context.ownerId,
        serverIdentity: () => context.serverId,
        componentKey: (_scope, revision = 1) => {
          if (revision !== 1)
            throw new Error("No fixture key grant for that revision");
          return { key: new Uint8Array(key), keyRevision: 1 };
        },
      };
      const encrypted = join(directory, `${backupId}.ctos`);
      const sealed = await sealPrivateBackup({
        context,
        keys,
        metadata,
        destination: encrypted,
        archive: exportRecoveryArchive({
          transport,
          args: [...expected, "export", captureId],
        }),
      });
      const ciphertext = await readFile(encrypted, "utf8");
      expect(ciphertext).not.toContain("DUMMY_PRIVATE_ENV");
      expect(ciphertext).not.toContain(binding.home);
      const verified = join(directory, "verified.tar");
      expect(
        (
          await openPrivateBackup({
            context,
            keys,
            source: encrypted,
            destination: verified,
          })
        ).metadata,
      ).toEqual(metadata);
      const received = await recoveryControl({
        transport,
        args: [
          ...expected,
          "receive",
          restoreId,
          target,
          "--request",
          JSON.stringify({
            archive_bytes: metadata.archiveBytes,
            archive_sha256: metadata.archiveSha256,
          }),
        ],
        input: createReadStream(verified),
      });
      expect(received).toMatchObject({
        operation_id: restoreId,
        state: "received",
      });
      const restored = await recoveryControl({
        transport,
        args: [...expected, "restore", restoreId],
      });
      expect(restored).toMatchObject({
        operation_id: restoreId,
        state: "restored",
      });
      const current = await executorControl<OsExecutorBinding>(transport, [
        "open",
        target,
      ]);
      connection = new OsExecutorConnection(transport, current);
      await connection.request("initialize", {
        clientName: "private-backup-restored",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      for (const [name, expectedBytes] of files) {
        const file = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          { path: guestFileUri(`${current.home}/${name}`), sandbox: null },
        );
        expect(Buffer.from(file.dataBase64, "base64")).toEqual(expectedBytes);
      }
      const forgotten = await recoveryControl({
        transport,
        args: [...expected, "forget", captureId],
      });
      expect(forgotten.state).toBe("captured");
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase5-private-backup/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(`roundtrip-${transport.kind}-${backupId}.json`, artifacts),
        JSON.stringify(
          {
            transport: transport.kind,
            backupId,
            captureId,
            restoreId,
            sourceUid: binding.uid,
            destinationUid: current.uid,
            archiveBytes: sealed.archiveBytes,
            chunks: sealed.chunks,
            keyRevision: sealed.keyRevision,
            archiveSha256: metadata.archiveSha256,
            encryptedSha256: createHash("sha256")
              .update(ciphertext)
              .digest("hex"),
            ignoredAndUnicodeAndBinaryPreserved: true,
            plaintextAbsentFromStoredBackup: true,
            actualProductServerGrantAcceptance: false,
          },
          null,
          2,
        ) + "\n",
      );
      key.fill(0);
    } finally {
      await connection?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180000);
});
