import { createHash } from "node:crypto";
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
  decryptCantripOsSystemFrame,
  encryptCantripOsSystemFrame,
} from "@cantrip/crypto";
import {
  sealPrivateSystem,
  verifyPrivateSystem,
  openPrivateSystem,
} from "./private-system-file.js";
import { privateSystemFixture } from "./private-system-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-private-system-"));
  directories.push(directory);
  const data = Buffer.alloc(2 * 1_048_576 + 317, 0x61);
  data.write("PRIVATE_ROOT_AND_MACHINE_IDENTITY");
  async function* archive() {
    for (let at = 0; at < data.length; at += 177_713)
      yield data.subarray(at, at + 177_713);
  }
  return {
    ...privateSystemFixture(),
    directory,
    data,
    archive,
    destination: join(directory, "archive.ctos-system"),
  };
}
describe("private system archive", () => {
  it("streams unknown-length input, encrypts mount metadata and authenticates the exact bytes with a historical key", async () => {
    const f = await fixture(),
      receipt = await sealPrivateSystem({ ...f, archive: f.archive() });
    expect(receipt).toMatchObject({
      archiveBytes: f.data.length,
      archiveSha256: createHash("sha256").update(f.data).digest("hex"),
      chunks: 3,
      keyRevision: 1,
    });
    const encrypted = await readFile(f.destination, "utf8");
    for (const value of [
      "PRIVATE_ROOT_AND_MACHINE_IDENTITY",
      "/private/host/雪",
      f.context.containerId,
      f.manifest.snapshot.imageId,
    ])
      expect(encrypted).not.toContain(value);
    f.rotate();
    const destination = join(f.directory, "verified.tar");
    const opened = await openPrivateSystem({
      ...f,
      source: f.destination,
      destination,
      expected: { manifest: f.manifest, receipt },
    });
    expect(opened).toEqual({ manifest: f.manifest, receipt });
    expect((await readFile(destination)).equals(f.data)).toBe(true);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(f.destination)).mode & 0o777).toBe(0o600);
  });
  it("rejects truncation, corruption, reordering, duplication, trailing records and cross-stream splicing without publishing plaintext", async () => {
    const f = await fixture();
    await sealPrivateSystem({ ...f, archive: f.archive() });
    const other = join(f.directory, "other.ctos-system");
    await sealPrivateSystem({ ...f, destination: other, archive: f.archive() });
    const a = (await readFile(f.destination, "utf8")).trimEnd().split("\n");
    const b = (await readFile(other, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(a[0]!).streamId).not.toBe(JSON.parse(b[0]!).streamId);
    const corrupt = JSON.parse(a[1]!);
    corrupt.envelope.ciphertext =
      (corrupt.envelope.ciphertext[0] === "A" ? "B" : "A") +
      corrupt.envelope.ciphertext.slice(1);
    const candidates = [
      a.slice(0, -1),
      [a[0]!, a[2]!, a[1]!, ...a.slice(3)],
      [a[0]!, a[1]!, a[1]!, ...a.slice(2)],
      [a[0]!, JSON.stringify(corrupt), ...a.slice(2)],
      [...a, a.at(-1)!],
      [a[0]!, b[1]!, ...a.slice(2)],
    ];
    for (let n = 0; n < candidates.length; n++) {
      const source = join(f.directory, `bad-${n}`),
        destination = join(f.directory, `out-${n}`);
      await writeFile(source, candidates[n]!.join("\n") + "\n");
      await expect(
        openPrivateSystem({ ...f, source, destination }),
      ).rejects.toThrow();
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      (await readdir(f.directory)).filter((p) => p.endsWith(".partial")),
    ).toEqual([]);
  });
  it("rejects an authenticated footer whose committed size or manifest digest is false", async () => {
    const f = await fixture();
    await sealPrivateSystem({ ...f, archive: f.archive() });
    const lines = (await readFile(f.destination, "utf8")).trimEnd().split("\n");
    const header = JSON.parse(lines[0]!);
    const original = JSON.parse(lines.at(-1)!);
    const identity = {
      context: f.context,
      streamId: header.streamId,
      keyRevision: 1,
      componentKey: f.revisions.get(1)!,
    };
    const end = JSON.parse(
      new TextDecoder().decode(
        await decryptCantripOsSystemFrame({ ...identity, frame: original }),
      ),
    );
    for (const changed of [
      { archiveBytes: end.archiveBytes + 1 },
      { manifestSha256: "0".repeat(64) },
    ]) {
      const footer = await encryptCantripOsSystemFrame({
        ...identity,
        kind: "end",
        sequence: original.sequence,
        plaintext: Buffer.from(JSON.stringify({ ...end, ...changed })),
      });
      const source = join(f.directory, "false-footer"),
        destination = join(f.directory, "unpublished.tar");
      await writeFile(
        source,
        [...lines.slice(0, -1), JSON.stringify(footer)].join("\n") + "\n",
      );
      await expect(
        openPrivateSystem({ ...f, source, destination }),
      ).rejects.toThrow("incomplete or changed");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("does not replace existing output or publish an archive with a changed original proof", async () => {
    const f = await fixture(),
      receipt = await sealPrivateSystem({ ...f, archive: f.archive() });
    const before = await readFile(f.destination);
    await expect(
      sealPrivateSystem({ ...f, archive: f.archive() }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(f.destination)).equals(before)).toBe(true);
    const destination = join(f.directory, "changed-proof.tar");
    await expect(
      openPrivateSystem({
        ...f,
        source: f.destination,
        destination,
        expected: {
          manifest: f.manifest,
          receipt: { ...receipt, archiveBytes: receipt.archiveBytes + 1 },
        },
      }),
    ).rejects.toThrow("proof changed");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps interrupted, empty, revoked-owner and cancelled streams unpublished", async () => {
    for (const mode of ["error", "empty", "owner", "cancel"] as const) {
      const f = await fixture(),
        controller = new AbortController();
      async function* archive() {
        if (mode === "empty") return;
        yield f.data;
        if (mode === "error") throw new Error("actual stream failed");
        if (mode === "owner") f.changeOwner();
        if (mode === "cancel") controller.abort();
      }
      await expect(
        sealPrivateSystem({
          ...f,
          archive: archive(),
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      await expect(stat(f.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(f.directory)).toEqual([]);
    }
  });
  it("requires an actual matching owner and granted historical key", async () => {
    const f = await fixture();
    await sealPrivateSystem({ ...f, archive: f.archive() });
    f.lock();
    await expect(
      verifyPrivateSystem({ ...f, source: f.destination }),
    ).rejects.toThrow("grant");
    f.changeOwner();
    await expect(
      verifyPrivateSystem({ ...f, source: f.destination }),
    ).rejects.toThrow("account");
  });
});
