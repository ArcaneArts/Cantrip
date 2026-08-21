export const DAILY_LOG_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const DAILY_LOG_ARCHIVE_PART_BYTES = 10 * 1024 * 1024;
export const DAILY_LOG_ARCHIVE_COMPRESSION_AGE_MS = 48 * 60 * 60 * 1_000;
export const DAILY_LOG_ARCHIVE_GZIP_LEVEL = 9;

const MANAGED_FILE_PATTERN =
  /^(?<source>[a-z0-9][a-z0-9-]*)-(?<day>\d{4}-\d{2}-\d{2})\.part-(?<part>\d{4})\.jsonl(?<gzip>\.gz)?$/u;

export type DailyLogArchiveEntry = {
  createdAtMs?: number;
  modifiedAtMs: number;
  name: string;
  size: number;
};

export type DailyLogArchiveStorage = {
  append(name: string, contents: Uint8Array): Promise<void>;
  compress(source: string, temporary: string, level: number): Promise<void>;
  ensureDirectory(): Promise<void>;
  list(): Promise<DailyLogArchiveEntry[]>;
  remove(name: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
};

export type DailyLogArchiveDiagnostic = (diagnostic: {
  error: unknown;
  operation: string;
}) => void;

export type DailyLogArchiveOptions = {
  compressionAgeMs?: number;
  legacyFileNames?: readonly string[];
  maxBytes?: number;
  now?: () => Date;
  onDiagnostic?: DailyLogArchiveDiagnostic;
  partBytes?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  source: string;
  storage: DailyLogArchiveStorage;
  unschedule?: (handle: unknown) => void;
};

type ManagedEntry = DailyLogArchiveEntry & {
  compressed: boolean;
  day: string;
  part: number;
};

function positiveSafeInteger(value: number | undefined, fallback: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("Daily log archive limits must be positive safe integers.");
  }
  return resolved;
}

function sourceKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    throw new Error(
      "Daily log archive source keys must use letters, numbers, or hyphens.",
    );
  }
  return normalized;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function partName(source: string, day: string, part: number): string {
  return `${source}-${day}.part-${String(part).padStart(4, "0")}.jsonl`;
}

function managedEntry(
  entry: DailyLogArchiveEntry,
  source: string,
): ManagedEntry | null {
  const match = MANAGED_FILE_PATTERN.exec(entry.name);
  if (!match?.groups || match.groups.source !== source) return null;
  return {
    ...entry,
    compressed: match.groups.gzip === ".gz",
    day: match.groups.day!,
    part: Number(match.groups.part),
  };
}

function logicalOrder(left: ManagedEntry, right: ManagedEntry): number {
  return (
    left.day.localeCompare(right.day) ||
    left.part - right.part ||
    Number(left.compressed) - Number(right.compressed)
  );
}

function conservativeCreatedAt(entry: ManagedEntry): number {
  if (entry.createdAtMs !== undefined && Number.isFinite(entry.createdAtMs)) {
    return entry.createdAtMs;
  }
  // Without creation time, treat the file as created at the end of its UTC
  // filename day so it can never become eligible early.
  return Date.parse(`${entry.day}T23:59:59.999Z`);
}

function nextUtcBoundary(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

const encoder = new TextEncoder();

/**
 * Environment-neutral UTC daily archive coordinator. All mutation is
 * serialized so append, rollover, compression, and quota deletion cannot race.
 */
export class DailyLogArchive {
  readonly #compressionAgeMs: number;
  readonly #legacyFileNames: Set<string>;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #onDiagnostic?: DailyLogArchiveDiagnostic;
  readonly #partBytes: number;
  readonly #schedule?: DailyLogArchiveOptions["schedule"];
  readonly #source: string;
  readonly #storage: DailyLogArchiveStorage;
  readonly #unschedule?: DailyLogArchiveOptions["unschedule"];
  #activeBytes = 0;
  #activeDay = "";
  #activeName = "";
  #archiveBytes = 0;
  #closed = false;
  #initialized = false;
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown;

  constructor(options: DailyLogArchiveOptions) {
    this.#source = sourceKey(options.source);
    this.#storage = options.storage;
    this.#maxBytes = positiveSafeInteger(
      options.maxBytes,
      DAILY_LOG_ARCHIVE_MAX_BYTES,
    );
    this.#partBytes = positiveSafeInteger(
      options.partBytes,
      DAILY_LOG_ARCHIVE_PART_BYTES,
    );
    this.#compressionAgeMs = positiveSafeInteger(
      options.compressionAgeMs,
      DAILY_LOG_ARCHIVE_COMPRESSION_AGE_MS,
    );
    this.#legacyFileNames = new Set(options.legacyFileNames ?? []);
    this.#now = options.now ?? (() => new Date());
    this.#onDiagnostic = options.onDiagnostic;
    this.#schedule = options.schedule;
    this.#unschedule = options.unschedule;
  }

  initialize(): Promise<void> {
    return this.#enqueue("initialize", async () => {
      await this.#initializeLocked();
    });
  }

  append(record: unknown): Promise<void> {
    const line = encoder.encode(`${JSON.stringify(record)}\n`);
    return this.#enqueue("append", async () => {
      if (this.#closed) return;
      await this.#initializeLocked();
      const day = utcDay(this.#now());
      if (day !== this.#activeDay) {
        await this.#openDayLocked(day);
        await this.#maintainLocked();
        this.#scheduleBoundary();
      }
      if (
        this.#activeBytes > 0 &&
        this.#activeBytes + line.byteLength > this.#partBytes
      ) {
        await this.#openNextPartLocked(day);
      }
      await this.#storage.append(this.#activeName, line);
      this.#activeBytes += line.byteLength;
      this.#archiveBytes += line.byteLength;
      if (this.#archiveBytes > this.#maxBytes) await this.#enforceQuotaLocked();
    });
  }

  maintain(): Promise<void> {
    return this.#enqueue("maintain", async () => {
      if (this.#closed) return;
      await this.#initializeLocked();
      const day = utcDay(this.#now());
      if (day !== this.#activeDay) await this.#openDayLocked(day);
      await this.#maintainLocked();
      this.#scheduleBoundary();
    });
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  close(): Promise<void> {
    return this.#enqueue("close", async () => {
      this.#closed = true;
      this.#clearTimer();
    });
  }

  #enqueue(operation: string, work: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(work).catch((error) => {
      try {
        this.#onDiagnostic?.({ error, operation });
      } catch {
        // Diagnostics must never make archive failures recursive.
      }
    });
    return this.#queue;
  }

  async #initializeLocked(): Promise<void> {
    if (this.#initialized || this.#closed) return;
    await this.#storage.ensureDirectory();
    await this.#recoverTemporaryFilesLocked();
    await this.#migrateLegacyFilesLocked();
    await this.#openDayLocked(utcDay(this.#now()));
    await this.#maintainLocked();
    this.#initialized = true;
    this.#scheduleBoundary();
  }

  async #managedEntries(): Promise<ManagedEntry[]> {
    return (await this.#storage.list())
      .map((entry) => managedEntry(entry, this.#source))
      .filter((entry): entry is ManagedEntry => entry !== null)
      .sort(logicalOrder);
  }

  async #openDayLocked(day: string): Promise<void> {
    const current = (await this.#managedEntries()).filter(
      (entry) => entry.day === day && !entry.compressed,
    );
    const newest = current.at(-1);
    if (newest && newest.size < this.#partBytes) {
      this.#activeDay = day;
      this.#activeName = newest.name;
      this.#activeBytes = newest.size;
      return;
    }
    const part = (newest?.part ?? 0) + 1;
    this.#activeDay = day;
    this.#activeName = partName(this.#source, day, part);
    this.#activeBytes = 0;
  }

  async #openNextPartLocked(day: string): Promise<void> {
    const parts = (await this.#managedEntries()).filter(
      (entry) => entry.day === day,
    );
    const next = Math.max(0, ...parts.map((entry) => entry.part)) + 1;
    this.#activeDay = day;
    this.#activeName = partName(this.#source, day, next);
    this.#activeBytes = 0;
  }

  async #maintainLocked(): Promise<void> {
    await this.#recoverTemporaryFilesLocked();
    const nowMs = this.#now().getTime();
    const entries = await this.#managedEntries();
    for (const entry of entries) {
      if (entry.compressed || entry.name === this.#activeName) continue;
      if (nowMs - conservativeCreatedAt(entry) <= this.#compressionAgeMs)
        continue;
      const completed = `${entry.name}.gz`;
      const temporary = `${completed}.tmp`;
      const names = new Set(
        (await this.#storage.list()).map(({ name }) => name),
      );
      if (names.has(completed)) {
        await this.#storage.remove(entry.name);
        continue;
      }
      await this.#storage.compress(
        entry.name,
        temporary,
        DAILY_LOG_ARCHIVE_GZIP_LEVEL,
      );
      await this.#storage.rename(temporary, completed);
      await this.#storage.remove(entry.name);
    }
    await this.#enforceQuotaLocked();
  }

  async #enforceQuotaLocked(): Promise<void> {
    let entries = await this.#managedEntries();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.#maxBytes) break;
      if (entry.name === this.#activeName) continue;
      await this.#storage.remove(entry.name);
      total -= entry.size;
    }
    this.#archiveBytes = total;
  }

  async #recoverTemporaryFilesLocked(): Promise<void> {
    const entries = await this.#storage.list();
    const names = new Set(entries.map(({ name }) => name));
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl.gz.tmp")) continue;
      const completed = entry.name.slice(0, -4);
      const source = completed.slice(0, -3);
      if (
        managedEntry({ ...entry, name: completed }, this.#source) &&
        (names.has(source) || names.has(completed))
      ) {
        await this.#storage.remove(entry.name);
      }
    }
  }

  async #migrateLegacyFilesLocked(): Promise<void> {
    if (this.#legacyFileNames.size === 0) return;
    const entries = await this.#storage.list();
    const legacy = entries
      .filter(({ name }) => {
        for (const base of this.#legacyFileNames) {
          if (
            name === base ||
            (/^[1-3]$/u.test(name.slice(base.length + 1)) &&
              name.startsWith(`${base}.`))
          )
            return true;
        }
        return false;
      })
      .sort(
        (left, right) =>
          left.modifiedAtMs - right.modifiedAtMs ||
          left.name.localeCompare(right.name),
      );
    const managed = await this.#managedEntries();
    const nextByDay = new Map<string, number>();
    for (const entry of managed)
      nextByDay.set(
        entry.day,
        Math.max(nextByDay.get(entry.day) ?? 0, entry.part),
      );
    for (const entry of legacy) {
      const day = utcDay(new Date(entry.createdAtMs ?? entry.modifiedAtMs));
      const part = (nextByDay.get(day) ?? 0) + 1;
      nextByDay.set(day, part);
      await this.#storage.rename(entry.name, partName(this.#source, day, part));
    }
  }

  #scheduleBoundary(): void {
    if (!this.#schedule || this.#closed) return;
    this.#clearTimer();
    const now = this.#now();
    const delay = Math.max(1, nextUtcBoundary(now) - now.getTime());
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      void this.maintain();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#unschedule?.(this.#timer);
    this.#timer = undefined;
  }
}

export function isManagedDailyLogFile(name: string, source: string): boolean {
  return (
    managedEntry({ modifiedAtMs: 0, name, size: 0 }, sourceKey(source)) !== null
  );
}
