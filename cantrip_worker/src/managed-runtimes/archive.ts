import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import * as tar from "tar";
import type { ReadEntry } from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export type ManagedRuntimeArchiveFormat = "tar.gz" | "zip";

export interface ManagedRuntimeExtractionLimits {
  maxEntries: number;
  maxExpandedBytes: number;
  maxSingleEntryBytes: number;
}

const DEFAULT_LIMITS: ManagedRuntimeExtractionLimits = {
  maxEntries: 100_000,
  maxExpandedBytes: 12_000_000_000,
  maxSingleEntryBytes: 4_000_000_000,
};

function normalizedArchivePath(candidate: string): string {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate)
  ) {
    throw new Error(
      `Managed runtime archive contains an unsafe path: ${candidate}`,
    );
  }
  const withoutTrailingSlash = candidate.replace(/\/+$/u, "");
  if (!withoutTrailingSlash) {
    throw new Error("Managed runtime archive contains an empty path.");
  }
  const segments = withoutTrailingSlash.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Managed runtime archive contains an unsafe path: ${candidate}`,
    );
  }
  return segments.join("/").normalize("NFC");
}

export function validateManagedRuntimeArchivePath(candidate: string): string {
  return normalizedArchivePath(candidate);
}

function destinationFor(root: string, candidate: string): string {
  const normalized = normalizedArchivePath(candidate);
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(
      `Managed runtime archive path escapes staging: ${candidate}`,
    );
  }
  return destination;
}

function recordEntry(
  seen: Set<string>,
  candidate: string,
  size: number,
  totals: { bytes: number; entries: number },
  limits: ManagedRuntimeExtractionLimits,
): void {
  const normalized = normalizedArchivePath(candidate);
  const identity =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  if (seen.has(identity)) {
    throw new Error(
      `Managed runtime archive contains a duplicate path: ${candidate}`,
    );
  }
  seen.add(identity);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > limits.maxSingleEntryBytes
  ) {
    throw new Error(`Managed runtime archive entry is too large: ${candidate}`);
  }
  totals.entries += 1;
  totals.bytes += size;
  if (
    totals.entries > limits.maxEntries ||
    totals.bytes > limits.maxExpandedBytes
  ) {
    throw new Error("Managed runtime archive exceeds its extraction limits.");
  }
}

async function extractTar(
  archivePath: string,
  destination: string,
  limits: ManagedRuntimeExtractionLimits,
): Promise<void> {
  const seen = new Set<string>();
  const totals = { bytes: 0, entries: 0 };
  let inspectionError: Error | null = null;
  await tar.t({
    file: archivePath,
    strict: true,
    filter(_entryPath, entry) {
      if (inspectionError) return false;
      try {
        const archiveEntry = entry as ReadEntry;
        if (archiveEntry.type !== "File" && archiveEntry.type !== "Directory") {
          throw new Error(
            `Managed runtime archive contains unsupported ${archiveEntry.type}: ${archiveEntry.path}`,
          );
        }
        recordEntry(
          seen,
          archiveEntry.path,
          archiveEntry.type === "File" ? archiveEntry.size : 0,
          totals,
          limits,
        );
        return true;
      } catch (error) {
        inspectionError =
          error instanceof Error ? error : new Error(String(error));
        return false;
      }
    },
  });
  if (inspectionError) throw inspectionError;
  let extractionError: Error | null = null;
  await tar.x({
    cwd: destination,
    file: archivePath,
    preservePaths: false,
    strict: true,
    filter(_entryPath, entry) {
      if (extractionError) return false;
      try {
        const archiveEntry = entry as ReadEntry;
        destinationFor(destination, archiveEntry.path);
        if (archiveEntry.type !== "File" && archiveEntry.type !== "Directory") {
          throw new Error(
            `Managed runtime archive contains unsupported ${archiveEntry.type}: ${archiveEntry.path}`,
          );
        }
        return true;
      } catch (error) {
        extractionError =
          error instanceof Error ? error : new Error(String(error));
        return false;
      }
    },
  });
  if (extractionError) throw extractionError;
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { autoClose: true, lazyEntries: true, validateEntrySizes: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(error ?? new Error("Could not open managed runtime archive."));
        } else {
          resolve(zipfile);
        }
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
      if (error || !stream) {
        reject(error ?? new Error(`Could not read ${entry.fileName}.`));
      } else {
        resolve(stream);
      }
    });
  });
}

async function extractZip(
  archivePath: string,
  destination: string,
  limits: ManagedRuntimeExtractionLimits,
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
            `Managed runtime archive contains encrypted entry: ${entry.fileName}`,
          );
        }
        const type = zipEntryType(entry);
        if (type === "symlink" || type === "other") {
          throw new Error(
            `Managed runtime archive contains unsupported ${type}: ${entry.fileName}`,
          );
        }
        recordEntry(
          seen,
          entry.fileName,
          type === "file" ? entry.uncompressedSize : 0,
          totals,
          limits,
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

export async function extractManagedRuntimeArchive(
  archivePath: string,
  format: ManagedRuntimeArchiveFormat,
  destination: string,
  limits: Partial<ManagedRuntimeExtractionLimits> = {},
): Promise<void> {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (format === "tar.gz") {
    await extractTar(archivePath, destination, effectiveLimits);
  } else {
    await extractZip(archivePath, destination, effectiveLimits);
  }
}
