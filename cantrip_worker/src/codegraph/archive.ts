import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import * as tar from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_EXPANDED_BYTES = 1_500_000_000;
const MAX_SINGLE_ENTRY_BYTES = 512_000_000;

export type CodeGraphArchiveKind = "tar.gz" | "zip";

function normalizedArchivePath(candidate: string): string {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate)
  ) {
    throw new Error(`CodeGraph archive contains an unsafe path: ${candidate}`);
  }
  const withoutTrailingSlash = candidate.replace(/\/+$/u, "");
  if (withoutTrailingSlash.length === 0) {
    throw new Error("CodeGraph archive contains an empty path.");
  }
  const segments = withoutTrailingSlash.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`CodeGraph archive contains an unsafe path: ${candidate}`);
  }
  return segments.join("/").normalize("NFC");
}

export function validateCodeGraphArchivePath(candidate: string): string {
  return normalizedArchivePath(candidate);
}

function destinationFor(root: string, candidate: string): string {
  const normalized = normalizedArchivePath(candidate);
  const destination = path.resolve(root, ...normalized.split("/"));
  const resolvedRoot = path.resolve(root);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(
      `CodeGraph archive path escapes its staging root: ${candidate}`,
    );
  }
  return destination;
}

function recordEntry(
  seen: Set<string>,
  candidate: string,
  size: number,
  totals: { bytes: number; entries: number },
  caseInsensitive: boolean,
): void {
  const normalized = normalizedArchivePath(candidate);
  const identity = caseInsensitive ? normalized.toLowerCase() : normalized;
  if (seen.has(identity)) {
    throw new Error(
      `CodeGraph archive contains a duplicate path: ${candidate}`,
    );
  }
  seen.add(identity);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_SINGLE_ENTRY_BYTES
  ) {
    throw new Error(`CodeGraph archive entry is too large: ${candidate}`);
  }
  totals.entries += 1;
  totals.bytes += size;
  if (
    totals.entries > MAX_ARCHIVE_ENTRIES ||
    totals.bytes > MAX_EXPANDED_BYTES
  ) {
    throw new Error("CodeGraph archive exceeds its extraction limits.");
  }
}

async function inspectTarArchive(archivePath: string): Promise<void> {
  const seen = new Set<string>();
  const totals = { bytes: 0, entries: 0 };
  await tar.t({
    file: archivePath,
    strict: true,
    onentry(entry) {
      if (entry.type !== "File" && entry.type !== "Directory") {
        throw new Error(
          `CodeGraph archive contains an unsupported ${entry.type} entry: ${entry.path}`,
        );
      }
      recordEntry(
        seen,
        entry.path,
        entry.type === "File" ? entry.size : 0,
        totals,
        process.platform === "win32",
      );
    },
  });
}

async function extractTarArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  await inspectTarArchive(archivePath);
  await tar.x({
    cwd: destination,
    file: archivePath,
    preservePaths: false,
    strict: true,
    onentry(entry) {
      destinationFor(destination, entry.path);
      if (entry.type !== "File" && entry.type !== "Directory") {
        throw new Error(
          `CodeGraph archive contains an unsupported ${entry.type} entry: ${entry.path}`,
        );
      }
    },
  });
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { autoClose: true, lazyEntries: true, validateEntrySizes: true },
      (error, zipfile) => {
        if (error || !zipfile)
          reject(error ?? new Error("Could not open CodeGraph zip archive."));
        else resolve(zipfile);
      },
    );
  });
}

function zipEntryType(
  entry: Entry,
): "directory" | "file" | "symlink" | "other" {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) return "symlink";
  if (entry.fileName.endsWith("/") || fileType === 0o040000) return "directory";
  if (fileType === 0 || fileType === 0o100000) return "file";
  return "other";
}

function openZipEntryStream(
  zipfile: ZipFile,
  entry: Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream)
        reject(error ?? new Error(`Could not read ${entry.fileName}.`));
      else resolve(stream);
    });
  });
}

async function extractZipArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  const zipfile = await openZip(archivePath);
  const seen = new Set<string>();
  const totals = { bytes: 0, entries: 0 };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      reject(error);
    };
    zipfile.once("error", fail);
    zipfile.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on("entry", (entry) => {
      void (async () => {
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw new Error(
            `CodeGraph archive contains an encrypted entry: ${entry.fileName}`,
          );
        }
        const type = zipEntryType(entry);
        if (type === "symlink" || type === "other") {
          throw new Error(
            `CodeGraph archive contains an unsupported ${type} entry: ${entry.fileName}`,
          );
        }
        recordEntry(
          seen,
          entry.fileName,
          type === "file" ? entry.uncompressedSize : 0,
          totals,
          process.platform === "win32",
        );
        const output = destinationFor(destination, entry.fileName);
        if (type === "directory") {
          await mkdir(output, { recursive: true });
          zipfile.readEntry();
          return;
        }
        await mkdir(path.dirname(output), { recursive: true });
        const stream = await openZipEntryStream(zipfile, entry);
        await pipeline(
          stream,
          createWriteStream(output, { flags: "wx", mode: 0o600 }),
        );
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (process.platform !== "win32" && (unixMode & 0o111) !== 0) {
          await chmod(output, 0o700);
        }
        zipfile.readEntry();
      })().catch(fail);
    });
    zipfile.readEntry();
  });
}

export async function extractCodeGraphArchive(
  archivePath: string,
  kind: CodeGraphArchiveKind,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (kind === "tar.gz") {
    await extractTarArchive(archivePath, destination);
    return;
  }
  await extractZipArchive(archivePath, destination);
}
