import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import * as tar from "tar";
import { expect, it, vi } from "vitest";
import { extractCodeGraphArchive } from "../src/codegraph/archive.js";
import { extractManagedRuntimeArchive } from "../src/managed-runtimes/archive.js";

const observation = vi.hoisted(() => ({
  onEntry: undefined as (() => void) | undefined,
  onWrite: undefined as (() => void) | undefined,
}));
vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return {
    ...actual,
    x: (options: tar.TarOptionsWithAliases) =>
      actual.x({
        ...options,
        filter(
          entryPath: string,
          entry: tar.ReadEntry | import("node:fs").Stats,
        ) {
          observation.onEntry?.();
          return options.filter?.(entryPath, entry) ?? true;
        },
      }),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (
      ...args: Parameters<typeof actual.createWriteStream>
    ) => {
      const stream = actual.createWriteStream(...args);
      stream.once("open", () => observation.onWrite?.());
      return stream;
    },
  };
});

// Small stored ZIP fixture, with actual CRCs and directory offsets. No external
// archiver or platform-specific executable is needed for the Windows path.
function storedZip(files: { name: string; body: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, body } of files) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    header.copy(record, 8, 6, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

it.each(
  ["web", "codegraph"].flatMap((component) =>
    (["tar.gz", "zip"] as const).map((format) => ({ component, format })),
  ),
)(
  "cancels $component $format extraction during an actual file write and joins cleanup",
  async ({ component, format }) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-extraction-cancel-"),
    );
    const contents = path.join(root, "contents");
    const destination = path.join(root, "staging");
    const archive = path.join(root, `archive.${format}`);
    const shutdown = new AbortController();
    const extract = () =>
      component === "web"
        ? extractManagedRuntimeArchive(
            archive,
            format,
            destination,
            {},
            shutdown.signal,
          )
        : extractCodeGraphArchive(
            archive,
            format,
            destination,
            shutdown.signal,
          );
    try {
      await mkdir(contents);
      await mkdir(destination);
      const files = Array.from({ length: 20 }, (_, index) => ({
        name: `${index}.bin`,
        body: randomBytes(256 * 1024),
      }));
      if (format === "zip") await writeFile(archive, storedZip(files));
      else {
        for (const file of files)
          await writeFile(path.join(contents, file.name), file.body);
        await tar.c(
          { cwd: contents, file: archive, gzip: true },
          files.map((file) => file.name),
        );
      }
      let entries = 0;
      observation.onEntry = () => {
        if (++entries === 2)
          shutdown.abort(new Error("cancel active extraction"));
      };
      observation.onWrite = () =>
        shutdown.abort(new Error("cancel active extraction"));
      await expect(extract()).rejects.toThrow(
        /cancel active extraction|aborted/u,
      );
      expect(shutdown.signal.aborted).toBe(true);
      expect((await readdir(destination)).length).toBeLessThan(files.length);
      await rm(destination, { recursive: true });
      await expect(extract()).rejects.toThrow("cancel active extraction");
      expect(await readdir(root)).not.toContain("staging");
    } finally {
      observation.onEntry = undefined;
      observation.onWrite = undefined;
      shutdown.abort();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
