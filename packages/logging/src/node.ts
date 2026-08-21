import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  DailyLogArchive,
  type DailyLogArchiveOptions,
  type DailyLogArchiveStorage,
} from "./archive.js";

export class NodeDailyLogArchiveStorage implements DailyLogArchiveStorage {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    await chmod(this.#directory, 0o700).catch(() => undefined);
  }

  async list() {
    await this.ensureDirectory();
    const entries = await readdir(this.#directory, { withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const metadata = await stat(this.#resolve(entry.name));
          return {
            createdAtMs:
              metadata.birthtimeMs > 0 ? metadata.birthtimeMs : undefined,
            modifiedAtMs: metadata.mtimeMs,
            name: entry.name,
            size: metadata.size,
          };
        }),
    );
  }

  async append(name: string, contents: Uint8Array): Promise<void> {
    const target = this.#resolve(name);
    await appendFile(target, contents, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);
  }

  async compress(
    source: string,
    temporary: string,
    level: number,
  ): Promise<void> {
    const target = this.#resolve(temporary);
    await pipeline(
      createReadStream(this.#resolve(source)),
      createGzip({ level }),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  }

  async rename(source: string, destination: string): Promise<void> {
    await rename(this.#resolve(source), this.#resolve(destination));
  }

  async remove(name: string): Promise<void> {
    await rm(this.#resolve(name), { force: true });
  }

  #resolve(name: string): string {
    if (path.basename(name) !== name)
      throw new Error("Archive file names cannot contain paths.");
    return path.join(this.#directory, name);
  }
}

export type NodeDailyLogArchiveOptions = Omit<
  DailyLogArchiveOptions,
  "schedule" | "storage" | "unschedule"
> & { directory: string };

export function createNodeDailyLogArchive(
  options: NodeDailyLogArchiveOptions,
): DailyLogArchive {
  return new DailyLogArchive({
    ...options,
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    },
    storage: new NodeDailyLogArchiveStorage(options.directory),
    unschedule(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}
