import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  explorerEntrySchema,
  explorerMarkdownFileForPath,
  explorerEntryNameSchema,
} from "@cantrip/protocol";
import { EXPLORER_FILE_IMPORT_CHUNK_BYTES } from "@cantrip/protocol/surface-stream";
import type { ExplorerFileImportChunk } from "@cantrip/protocol/surface-stream";
import { resolveMutableDirectory } from "./explorer.js";

type Import = {
  root: string;
  path: string;
  name: string;
  size: number;
  offset: number;
  directoryPath: string;
  temporary: string;
  handle: FileHandle;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Worker-owned, bounded-memory staging. A dropped file never replaces an entry. */
export class ExplorerFileImports {
  readonly #imports = new Map<string, Import>();
  readonly #busy = new Set<string>();
  #closed = false;

  async cancel(key: string): Promise<void> {
    const current = this.#imports.get(key);
    if (!current) return;
    this.#imports.delete(key);
    if (current.timer) clearTimeout(current.timer);
    try {
      await current.handle.close();
    } finally {
      await rm(current.temporary, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#imports.keys()].map((key) => this.cancel(key)));
  }

  async write(
    key: string,
    root: string,
    sequence: number,
    request: ExplorerFileImportChunk,
  ) {
    if (this.#closed) throw new Error("The worker is shutting down.");
    explorerEntryNameSchema.parse(request.name);
    if (this.#busy.has(key))
      throw new Error("This file import is already writing a chunk.");
    if (
      !this.#imports.has(key) &&
      new Set([...this.#imports.keys(), ...this.#busy]).size >= 16
    )
      throw new Error("Too many file imports are active.");
    this.#busy.add(key);
    try {
      let current = this.#imports.get(key);
      if (!current) {
        if (sequence !== 0 || request.offset !== 0)
          throw new Error(
            "The file import is unavailable. Drop the file again.",
          );
        const { directoryPath } = await resolveMutableDirectory(
          root,
          request.path,
        );
        const temporary = await mkdtemp(
          path.join(tmpdir(), "cantrip-file-import-"),
        );
        let handle;
        try {
          handle = await open(path.join(temporary, "content"), "wx", 0o600);
          if (this.#closed) {
            await handle.close();
            throw new Error("The worker is shutting down.");
          }
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
        current = {
          root,
          path: request.path,
          name: request.name,
          size: request.size,
          offset: 0,
          directoryPath,
          temporary,
          handle,
          timer: null,
        };
        this.#imports.set(key, current);
      }
      if (current.timer) clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        void this.cancel(key).catch(() => {});
      }, 5 * 60_000);
      current.timer.unref();
      if (
        current.root !== root ||
        current.path !== request.path ||
        current.name !== request.name ||
        current.size !== request.size ||
        current.offset !== request.offset
      )
        throw new Error("The file import destination or offset changed.");
      const bytes = Buffer.from(request.data, "base64");
      const offset = current.offset + bytes.byteLength;
      if (
        bytes.byteLength > EXPLORER_FILE_IMPORT_CHUNK_BYTES ||
        offset > current.size ||
        (request.eof
          ? offset !== current.size
          : bytes.byteLength === 0 || offset >= current.size)
      )
        throw new Error("The file import chunk has an invalid size.");
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await current.handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          current.offset + written,
        );
        if (!result.bytesWritten)
          throw new Error("The file import stopped writing.");
        written += result.bytesWritten;
      }
      current.offset = offset;
      if (!request.eof) return { offset, entry: null };
      const { directoryPath } = await resolveMutableDirectory(
        root,
        request.path,
      );
      if (directoryPath !== current.directoryPath)
        throw new Error("The destination folder moved during the file import.");
      const destination = path.join(directoryPath, request.name);
      // Treat dangling links as collisions too, including on Windows.
      const existing = await lstat(destination).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (existing)
        throw new Error(`An entry named ${request.name} already exists.`);
      try {
        await copyFile(
          path.join(current.temporary, "content"),
          destination,
          constants.COPYFILE_EXCL,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`An entry named ${request.name} already exists.`);
        throw error;
      }
      const metadata = await lstat(destination);
      const entry = explorerEntrySchema.parse({
        kind: "file",
        name: request.name,
        path: request.path ? `${request.path}/${request.name}` : request.name,
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        viewable: true,
        markdown: explorerMarkdownFileForPath(request.name),
        symbolicLink: false,
      });
      await this.cancel(key);
      return { offset, entry };
    } catch (error) {
      await this.cancel(key).catch(() => {});
      throw error;
    } finally {
      this.#busy.delete(key);
    }
  }
}
