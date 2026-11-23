import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sealPrivateBackup,
  openPrivateBackup,
  type BackupKeyAccess,
} from "./private-backup-file.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-private-backup-"));
  directories.push(directory);
  const context = {
    ownerId: "fixture-owner",
    serverId: "fixture-server",
    backupId: randomUUID(),
  };
  const revisions = new Map([
    [1, randomBytes(32)],
    [2, randomBytes(32)],
  ]);
  let current = 1;
  const keys: BackupKeyAccess = {
    ownerId: () => context.ownerId,
    serverIdentity: () => context.serverId,
    componentKey: (scope, revision = current) => {
      expect(scope).toBe("repository-content");
      const key = revisions.get(revision);
      if (!key)
        throw new Error("No active encryption grant for this revision.");
      return { key: new Uint8Array(key), keyRevision: revision };
    },
  };
  const data = Buffer.alloc(2 * 1_048_576 + 317, 0x61);
  data.write("DUMMY_PRIVATE_PROFILE_AND_IGNORED_ENV_BYTES");
  const metadata = {
    version: 1 as const,
    archiveBytes: data.length,
    archiveSha256: createHash("sha256").update(data).digest("hex"),
    manifest: {
      workspace: {
        home: "/private/雪",
        browserProfile: "DUMMY_BROWSER_PRIVATE_LABEL",
      },
      exclusions: [],
    },
  };
  async function* archive() {
    // Fragmentation deliberately differs from encrypted frame boundaries.
    for (let offset = 0; offset < data.length; offset += 177_713)
      yield data.subarray(offset, offset + 177_713);
  }
  return {
    directory,
    context,
    revisions,
    keys,
    data,
    metadata,
    archive,
    rotate: () => {
      current = 2;
    },
  };
}

describe("Worker private backup files", () => {
  it("streams private contents and metadata, authenticates EOF and restores with a historical granted key", async () => {
    const f = await fixture();
    const encrypted = join(f.directory, "backup.ctos");
    const sealed = await sealPrivateBackup({
      ...f,
      destination: encrypted,
      archive: f.archive(),
    });
    expect(sealed).toMatchObject({
      keyRevision: 1,
      chunks: 3,
      archiveBytes: f.data.length,
    });
    const ciphertext = await readFile(encrypted, "utf8");
    expect(ciphertext).not.toContain(
      "DUMMY_PRIVATE_PROFILE_AND_IGNORED_ENV_BYTES",
    );
    expect(ciphertext).not.toContain("DUMMY_BROWSER_PRIVATE_LABEL");
    expect(ciphertext).not.toContain("/private/");
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
    f.rotate();
    const destination = join(f.directory, "verified.tar");
    const opened = await openPrivateBackup({
      ...f,
      source: encrypted,
      destination,
    });
    expect(opened.keyRevision).toBe(1);
    expect(opened.metadata).toEqual(f.metadata);
    expect(await readFile(destination)).toEqual(f.data);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("rejects missing, reordered, duplicated, corrupted and trailing frames without publishing plaintext", async () => {
    const f = await fixture();
    const source = join(f.directory, "original.ctos");
    await sealPrivateBackup({
      ...f,
      destination: source,
      archive: f.archive(),
    });
    const lines = (await readFile(source, "utf8")).trimEnd().split("\n");
    const corrupt = JSON.parse(lines[1]!);
    corrupt.envelope.ciphertext =
      (corrupt.envelope.ciphertext[0] === "A" ? "B" : "A") +
      corrupt.envelope.ciphertext.slice(1);
    const candidates = [
      lines.slice(0, -1),
      [lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)],
      [lines[0]!, lines[1]!, lines[1]!, ...lines.slice(2)],
      [lines[0]!, JSON.stringify(corrupt), ...lines.slice(2)],
      [...lines, lines.at(-1)!],
      lines.slice(0, 2),
    ];
    for (let index = 0; index < candidates.length; index++) {
      const malformed = join(f.directory, `malformed-${index}.ctos`);
      const destination = join(f.directory, `rejected-${index}.tar`);
      await writeFile(malformed, candidates[index]!.join("\n") + "\n");
      await expect(
        openPrivateBackup({ ...f, source: malformed, destination }),
      ).rejects.toThrow();
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      (await readdir(f.directory)).some((name) => name.endsWith(".partial")),
    ).toBe(false);
  });

  it("preserves originals on capture mismatch, existing destination and unavailable historical grants", async () => {
    const f = await fixture();
    const destination = join(f.directory, "existing.ctos");
    await writeFile(destination, "keep original");
    await expect(
      sealPrivateBackup({ ...f, destination, archive: f.archive() }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("keep original");
    const mismatch = join(f.directory, "mismatch.ctos");
    await expect(
      sealPrivateBackup({
        ...f,
        metadata: { ...f.metadata, archiveSha256: "0".repeat(64) },
        destination: mismatch,
        archive: f.archive(),
      }),
    ).rejects.toThrow("differs");
    await expect(stat(mismatch)).rejects.toMatchObject({ code: "ENOENT" });
    const source = join(f.directory, "valid.ctos");
    await sealPrivateBackup({
      ...f,
      destination: source,
      archive: f.archive(),
    });
    f.revisions.delete(1);
    await expect(
      openPrivateBackup({
        ...f,
        source,
        destination: join(f.directory, "missing-key.tar"),
      }),
    ).rejects.toThrow("No active encryption grant");
    expect(
      (await readdir(f.directory)).some((name) => name.endsWith(".partial")),
    ).toBe(false);
  });

  it("does not publish a backup when its actual archive carrier fails after delivering a prefix", async () => {
    const f = await fixture();
    const destination = join(f.directory, "interrupted.ctos");
    async function* lostCarrier() {
      yield f.data.subarray(0, 1_048_576);
      throw new Error("Actual exporter delivery failed");
    }
    await expect(
      sealPrivateBackup({ ...f, destination, archive: lostCarrier() }),
    ).rejects.toThrow("exporter delivery failed");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.directory)).toEqual([]);
  });
});
