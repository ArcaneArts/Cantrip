import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_MAX_DIAGNOSTICS,
  RUN_CONFIGURATION_MAX_FILE_BYTES,
  RUN_CONFIGURATION_MAX_FILES,
  RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
  runConfigurationDeleteRequestSchema,
  runConfigurationDeleteResultSchema,
  runConfigurationDiagnosticSchema,
  runConfigurationFileSchema,
  runConfigurationIdSchema,
  runConfigurationReadResultSchema,
  runConfigurationRepositoryChangeSchema,
  runConfigurationRepositoryEntrySchema,
  runConfigurationRepositoryInventorySchema,
  runConfigurationWriteRequestSchema,
  runConfigurationWriteResultSchema,
  type RunConfigurationDeleteRequest,
  type RunConfigurationDeleteResult,
  type RunConfigurationDiagnostic,
  type RunConfigurationFile,
  type RunConfigurationReadResult,
  type RunConfigurationRepositoryChange,
  type RunConfigurationRepositoryEntry,
  type RunConfigurationRepositoryInventory,
  type RunConfigurationWriteRequest,
  type RunConfigurationWriteResult,
} from "@cantrip/protocol/run-configuration-definitions";

const WATCH_DEBOUNCE_MS = 40;
const WATCH_POLL_MS = 500;
const WATCH_RETRY_MS = 250;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function configurationRelativePath(fileName: string): string {
  return RUN_CONFIGURATION_REPOSITORY_DIRECTORY + "/" + fileName;
}

function isRepositoryTemporaryFile(fileName: string): boolean {
  return /^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/u.test(fileName);
}

function diagnostic(input: {
  code: string;
  field?: string | null;
  message: string;
  relativePath?: string | null;
  severity?: "error" | "warning";
}): RunConfigurationDiagnostic {
  return runConfigurationDiagnosticSchema.parse({
    severity: input.severity ?? "error",
    code: input.code,
    message: input.message,
    relativePath: input.relativePath ?? null,
    field: input.field ?? null,
  });
}

function boundedDiagnostics(
  values: RunConfigurationDiagnostic[],
): RunConfigurationDiagnostic[] {
  return values.slice(0, RUN_CONFIGURATION_MAX_DIAGNOSTICS);
}

function zodDiagnostics(
  relativePath: string,
  issues: Array<{ message: string; path: PropertyKey[] }>,
): RunConfigurationDiagnostic[] {
  return boundedDiagnostics(
    issues.map((issue) =>
      diagnostic({
        code: "schema-invalid",
        message: issue.message,
        relativePath,
        field:
          issue.path.length > 0
            ? issue.path.map((value) => String(value)).join(".")
            : null,
      }),
    ),
  );
}

async function realDirectory(
  parent: string,
  name: string,
  create: boolean,
): Promise<string | null> {
  const target = path.join(parent, name);
  if (create) {
    try {
      await mkdir(target, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(target + " must be a real directory.");
  }
  const canonical = await realpath(target);
  if (!isInside(parent, canonical)) {
    throw new Error(target + " resolves outside its parent directory.");
  }
  return canonical;
}

async function readRegularFile(
  absolutePath: string,
): Promise<{ bytes: Buffer; revision: string } | null> {
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("Run configuration paths must be regular files.");
    }
    if (metadata.size > RUN_CONFIGURATION_MAX_FILE_BYTES) {
      throw new Error(
        "Run configuration files cannot exceed " +
          RUN_CONFIGURATION_MAX_FILE_BYTES +
          " bytes.",
      );
    }
    const bytes = await handle.readFile();
    return { bytes, revision: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function unsupportedEntry(
  relativePath: string,
  code: string,
  message: string,
): RunConfigurationRepositoryEntry {
  return runConfigurationRepositoryEntrySchema.parse({
    relativePath,
    revision: null,
    id: null,
    status: "unsupported",
    document: null,
    diagnostics: [diagnostic({ code, message, relativePath })],
  });
}

function invalidEntry(input: {
  diagnostics: RunConfigurationDiagnostic[];
  document?: RunConfigurationFile | null;
  id?: string | null;
  relativePath: string;
  revision?: string | null;
}): RunConfigurationRepositoryEntry {
  return runConfigurationRepositoryEntrySchema.parse({
    relativePath: input.relativePath,
    revision: input.revision ?? null,
    id: input.document?.id ?? input.id ?? null,
    status: "invalid",
    document: input.document ?? null,
    diagnostics: boundedDiagnostics(input.diagnostics),
  });
}

function readyEntry(input: {
  document: RunConfigurationFile;
  relativePath: string;
  revision: string;
}): RunConfigurationRepositoryEntry {
  return runConfigurationRepositoryEntrySchema.parse({
    relativePath: input.relativePath,
    revision: input.revision,
    id: input.document.id,
    status: "ready",
    document: input.document,
    diagnostics: [],
  });
}

function inspectUnsupportedDocument(
  value: unknown,
  relativePath: string,
  revision: string,
  fileId: string,
): RunConfigurationRepositoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== "cantrip.run-configuration") return null;
  const documentId = runConfigurationIdSchema.safeParse(record.id);
  if (!documentId.success) {
    return invalidEntry({
      relativePath,
      revision,
      id: fileId,
      diagnostics: [
        diagnostic({
          code: "schema-invalid",
          message: "Unsupported Run configurations still require a valid ID.",
          relativePath,
          field: "id",
        }),
      ],
    });
  }
  if (documentId.data !== fileId) {
    return invalidEntry({
      relativePath,
      revision,
      id: fileId,
      diagnostics: [
        diagnostic({
          code: "identity-mismatch",
          message: "The document ID must match its lowercase UUID filename.",
          relativePath,
          field: "id",
        }),
      ],
    });
  }
  if (record.version !== 1) {
    return invalidEntry({
      relativePath,
      revision,
      id: fileId,
      diagnostics: [
        diagnostic({
          code: "version-unsupported",
          message: "This Run configuration version is not supported.",
          relativePath,
          field: "version",
        }),
      ],
    });
  }
  if (
    typeof record.provider === "string" &&
    record.provider !== "shell" &&
    record.provider !== "node" &&
    record.provider !== "java" &&
    record.provider !== "dart" &&
    record.provider !== "flutter" &&
    record.provider !== "rust"
  ) {
    return runConfigurationRepositoryEntrySchema.parse({
      relativePath,
      revision,
      id: fileId,
      status: "unsupported",
      document: null,
      diagnostics: [
        diagnostic({
          code: "provider-unavailable",
          message:
            "The " +
            record.provider +
            " Run configuration provider is not available yet.",
          relativePath,
          field: "provider",
        }),
      ],
    });
  }
  return null;
}

async function inspectFile(
  directory: string,
  fileName: string,
): Promise<RunConfigurationRepositoryEntry> {
  const relativePath = configurationRelativePath(fileName);
  if (path.extname(fileName).toLowerCase() !== ".json") {
    return unsupportedEntry(
      relativePath,
      "extension-unsupported",
      "Run configuration definitions must use the .json extension.",
    );
  }
  const fileIdValue = path.basename(fileName, ".json");
  const fileIdResult = runConfigurationIdSchema.safeParse(fileIdValue);
  if (!fileIdResult.success) {
    return invalidEntry({
      relativePath,
      diagnostics: [
        diagnostic({
          code: "filename-invalid",
          message:
            "Run configuration filenames must be lowercase UUIDs with a .json extension.",
          relativePath,
        }),
      ],
    });
  }

  const absolutePath = path.join(directory, fileName);
  let contents;
  try {
    contents = await readRegularFile(absolutePath);
  } catch (error) {
    return invalidEntry({
      relativePath,
      id: fileIdResult.data,
      diagnostics: [
        diagnostic({
          code: "file-invalid",
          message: error instanceof Error ? error.message : String(error),
          relativePath,
        }),
      ],
    });
  }
  if (!contents) {
    return invalidEntry({
      relativePath,
      id: fileIdResult.data,
      diagnostics: [
        diagnostic({
          code: "file-missing",
          message: "The Run configuration disappeared while it was read.",
          relativePath,
        }),
      ],
    });
  }
  const encoded = contents.bytes.toString("utf8");
  if (encoded.includes("\0")) {
    return invalidEntry({
      relativePath,
      revision: contents.revision,
      id: fileIdResult.data,
      diagnostics: [
        diagnostic({
          code: "nul-rejected",
          message: "Run configuration files cannot contain NUL characters.",
          relativePath,
        }),
      ],
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch (error) {
    return invalidEntry({
      relativePath,
      revision: contents.revision,
      id: fileIdResult.data,
      diagnostics: [
        diagnostic({
          code: "json-invalid",
          message: error instanceof Error ? error.message : String(error),
          relativePath,
        }),
      ],
    });
  }

  const unsupported = inspectUnsupportedDocument(
    value,
    relativePath,
    contents.revision,
    fileIdResult.data,
  );
  if (unsupported) return unsupported;

  const parsed = runConfigurationFileSchema.safeParse(value);
  if (!parsed.success) {
    return invalidEntry({
      relativePath,
      revision: contents.revision,
      id: fileIdResult.data,
      diagnostics: zodDiagnostics(relativePath, parsed.error.issues),
    });
  }
  if (parsed.data.id !== fileIdResult.data) {
    return invalidEntry({
      relativePath,
      revision: contents.revision,
      document: parsed.data,
      diagnostics: [
        diagnostic({
          code: "identity-mismatch",
          message: "The document ID must match its lowercase UUID filename.",
          relativePath,
          field: "id",
        }),
      ],
    });
  }
  return readyEntry({
    relativePath,
    revision: contents.revision,
    document: parsed.data,
  });
}

function markDuplicateNames(
  entries: RunConfigurationRepositoryEntry[],
): RunConfigurationRepositoryEntry[] {
  const byName = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (!entry.document) return;
    const normalized = entry.document.name.toLowerCase();
    const indexes = byName.get(normalized) ?? [];
    indexes.push(index);
    byName.set(normalized, indexes);
  });
  const duplicates = new Set(
    [...byName.values()].filter((indexes) => indexes.length > 1).flat(),
  );
  return entries.map((entry, index) => {
    if (!duplicates.has(index) || !entry.document) return entry;
    return invalidEntry({
      relativePath: entry.relativePath,
      revision: entry.revision,
      document: entry.document,
      diagnostics: [
        ...entry.diagnostics,
        diagnostic({
          code: "name-duplicate",
          message: "Run configuration names must be unique within a project.",
          relativePath: entry.relativePath,
          field: "name",
        }),
      ],
    });
  });
}

async function writeTemporaryFile(
  directory: string,
  id: string,
  encoded: string,
): Promise<string> {
  const temporaryPath = path.join(
    directory,
    "." + id + "." + randomUUID() + ".tmp",
  );
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  return temporaryPath;
}

function entryFingerprint(entry: RunConfigurationRepositoryEntry): string {
  return [
    entry.status,
    entry.id ?? "",
    entry.revision ?? "",
    ...entry.diagnostics.map(({ code, message }) => code + ":" + message),
  ].join("\0");
}

function changeEvents(
  before: RunConfigurationRepositoryInventory,
  after: RunConfigurationRepositoryInventory,
): RunConfigurationRepositoryChange[] {
  const previous = new Map(
    before.entries.map((entry) => [entry.relativePath, entry]),
  );
  const current = new Map(
    after.entries.map((entry) => [entry.relativePath, entry]),
  );
  const changes: RunConfigurationRepositoryChange[] = [];
  for (const [relativePath, entry] of current) {
    const old = previous.get(relativePath);
    if (!old) {
      changes.push(
        runConfigurationRepositoryChangeSchema.parse({
          kind: "created",
          id: entry.id,
          relativePath,
          revision: entry.revision,
        }),
      );
    } else if (entryFingerprint(old) !== entryFingerprint(entry)) {
      changes.push(
        runConfigurationRepositoryChangeSchema.parse({
          kind: "updated",
          id: entry.id ?? old.id,
          relativePath,
          revision: entry.revision,
        }),
      );
    }
  }
  for (const [relativePath, entry] of previous) {
    if (current.has(relativePath)) continue;
    changes.push(
      runConfigurationRepositoryChangeSchema.parse({
        kind: "deleted",
        id: entry.id,
        relativePath,
        revision: null,
      }),
    );
  }
  if (
    changes.length === 0 &&
    JSON.stringify(before.diagnostics) !== JSON.stringify(after.diagnostics)
  ) {
    changes.push(
      runConfigurationRepositoryChangeSchema.parse({
        kind: "unknown",
        id: null,
        relativePath: null,
        revision: null,
      }),
    );
  }
  return changes.slice(0, RUN_CONFIGURATION_MAX_FILES);
}

export class RunConfigurationRepository {
  readonly #root: string;
  #mutation = Promise.resolve();

  private constructor(root: string) {
    this.#root = root;
  }

  static async open(projectRoot: string): Promise<RunConfigurationRepository> {
    const root = await realpath(projectRoot);
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("The project root must be a real directory.");
    }
    return new RunConfigurationRepository(root);
  }

  get root(): string {
    return this.#root;
  }

  async #repositoryDirectory(create: boolean): Promise<string | null> {
    const cantrip = await realDirectory(this.#root, ".cantrip", create);
    if (!cantrip) return null;
    return realDirectory(cantrip, "run-configurations", create);
  }

  async scan(): Promise<RunConfigurationRepositoryInventory> {
    let directory;
    try {
      directory = await this.#repositoryDirectory(false);
    } catch (error) {
      return runConfigurationRepositoryInventorySchema.parse({
        directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
        entries: [],
        diagnostics: [
          diagnostic({
            code: "directory-invalid",
            message: error instanceof Error ? error.message : String(error),
            relativePath: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
          }),
        ],
      });
    }
    if (!directory) {
      return runConfigurationRepositoryInventorySchema.parse({
        directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
        entries: [],
        diagnostics: [],
      });
    }

    let directoryEntries;
    try {
      directoryEntries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !isRepositoryTemporaryFile(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      return runConfigurationRepositoryInventorySchema.parse({
        directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
        entries: [],
        diagnostics: [
          diagnostic({
            code: "directory-unreadable",
            message: error instanceof Error ? error.message : String(error),
            relativePath: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
          }),
        ],
      });
    }

    const diagnostics: RunConfigurationDiagnostic[] = [];
    if (directoryEntries.length > RUN_CONFIGURATION_MAX_FILES) {
      diagnostics.push(
        diagnostic({
          code: "file-limit-exceeded",
          message:
            "Only the first " +
            RUN_CONFIGURATION_MAX_FILES +
            " Run configuration paths are inspected.",
          relativePath: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
        }),
      );
    }
    const entries = await Promise.all(
      directoryEntries.slice(0, RUN_CONFIGURATION_MAX_FILES).map((entry) => {
        const relativePath = configurationRelativePath(entry.name);
        if (!entry.isFile()) {
          return Promise.resolve(
            unsupportedEntry(
              relativePath,
              "path-unsupported",
              "Only regular JSON files are inspected; directories and symlinks are never followed.",
            ),
          );
        }
        return inspectFile(directory, entry.name);
      }),
    );
    return runConfigurationRepositoryInventorySchema.parse({
      directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
      entries: markDuplicateNames(entries),
      diagnostics: boundedDiagnostics(diagnostics),
    });
  }

  async read(idInput: string): Promise<RunConfigurationReadResult> {
    const id = runConfigurationIdSchema.parse(idInput);
    const directory = await this.#repositoryDirectory(false);
    if (!directory) {
      return runConfigurationReadResultSchema.parse({ found: false, id });
    }
    const fileName = id + ".json";
    const absolutePath = path.join(directory, fileName);
    try {
      await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return runConfigurationReadResultSchema.parse({ found: false, id });
      }
      throw error;
    }
    return runConfigurationReadResultSchema.parse({
      found: true,
      entry: await inspectFile(directory, fileName),
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release: () => void = () => undefined;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async write(
    input: RunConfigurationWriteRequest,
  ): Promise<RunConfigurationWriteResult> {
    const request = runConfigurationWriteRequestSchema.parse(input);
    return this.#exclusive(async () => {
      const id = request.document.id;
      const current = await this.read(id);
      if (request.expectedRevision === null && current.found) {
        return runConfigurationWriteResultSchema.parse({
          outcome: "already-exists",
          id,
          currentRevision: current.entry.revision,
          conflictingId: null,
        });
      }
      if (request.expectedRevision !== null && !current.found) {
        return runConfigurationWriteResultSchema.parse({
          outcome: "not-found",
          id,
          currentRevision: null,
          conflictingId: null,
        });
      }
      if (
        request.expectedRevision !== null &&
        current.found &&
        current.entry.revision !== request.expectedRevision
      ) {
        return runConfigurationWriteResultSchema.parse({
          outcome: "revision-mismatch",
          id,
          currentRevision: current.entry.revision,
          conflictingId: null,
        });
      }

      const inventory = await this.scan();
      const nameConflict = inventory.entries.find(
        (entry) =>
          entry.document &&
          entry.document.id !== id &&
          entry.document.name.toLowerCase() ===
            request.document.name.toLowerCase(),
      );
      if (nameConflict?.document) {
        return runConfigurationWriteResultSchema.parse({
          outcome: "name-conflict",
          id,
          currentRevision: current.found ? current.entry.revision : null,
          conflictingId: nameConflict.document.id,
        });
      }

      const document = runConfigurationFileSchema.parse(request.document);
      const encoded = JSON.stringify(document, null, 2) + "\n";
      const revision = sha256(encoded);
      if (
        current.found &&
        current.entry.revision === revision &&
        current.entry.status === "ready"
      ) {
        return runConfigurationWriteResultSchema.parse({
          outcome: "unchanged",
          entry: current.entry,
        });
      }

      const directory = await this.#repositoryDirectory(true);
      if (!directory) {
        throw new Error("Could not create the Run configuration directory.");
      }
      const target = path.join(directory, id + ".json");
      const temporary = await writeTemporaryFile(directory, id, encoded);
      try {
        if (request.expectedRevision === null) {
          try {
            await link(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              const latest = await this.read(id);
              return runConfigurationWriteResultSchema.parse({
                outcome: "already-exists",
                id,
                currentRevision: latest.found ? latest.entry.revision : null,
                conflictingId: null,
              });
            }
            throw error;
          }
          await unlink(temporary);
        } else {
          const latest = await this.read(id);
          if (
            !latest.found ||
            latest.entry.revision !== request.expectedRevision
          ) {
            return runConfigurationWriteResultSchema.parse({
              outcome: latest.found ? "revision-mismatch" : "not-found",
              id,
              currentRevision: latest.found ? latest.entry.revision : null,
              conflictingId: null,
            });
          }
          await rename(temporary, target);
        }
      } finally {
        await rm(temporary, { force: true });
      }

      const written = await this.read(id);
      if (!written.found || written.entry.status !== "ready") {
        throw new Error("The written Run configuration could not be verified.");
      }
      return runConfigurationWriteResultSchema.parse({
        outcome: current.found ? "updated" : "created",
        entry: written.entry,
      });
    });
  }

  async delete(
    input: RunConfigurationDeleteRequest,
  ): Promise<RunConfigurationDeleteResult> {
    const request = runConfigurationDeleteRequestSchema.parse(input);
    return this.#exclusive(async () => {
      const current = await this.read(request.id);
      if (!current.found) {
        return runConfigurationDeleteResultSchema.parse({
          outcome: "not-found",
          id: request.id,
          currentRevision: null,
        });
      }
      if (current.entry.revision !== request.expectedRevision) {
        return runConfigurationDeleteResultSchema.parse({
          outcome: "revision-mismatch",
          id: request.id,
          currentRevision: current.entry.revision,
        });
      }
      const directory = await this.#repositoryDirectory(false);
      if (!directory) {
        return runConfigurationDeleteResultSchema.parse({
          outcome: "not-found",
          id: request.id,
          currentRevision: null,
        });
      }
      const latest = await this.read(request.id);
      if (!latest.found || latest.entry.revision !== request.expectedRevision) {
        return runConfigurationDeleteResultSchema.parse({
          outcome: latest.found ? "revision-mismatch" : "not-found",
          id: request.id,
          currentRevision: latest.found ? latest.entry.revision : null,
        });
      }
      await unlink(path.join(directory, request.id + ".json"));
      return runConfigurationDeleteResultSchema.parse({
        outcome: "deleted",
        id: request.id,
        revision: request.expectedRevision,
      });
    });
  }

  async watch(
    listener: (
      change: RunConfigurationRepositoryChange,
    ) => void | Promise<void>,
  ): Promise<RunConfigurationRepositoryWatcher> {
    return RunConfigurationRepositoryWatcher.start(this, listener);
  }

  async deepestWatchDirectory(): Promise<string> {
    try {
      const repository = await this.#repositoryDirectory(false);
      if (repository) return repository;
    } catch {
      return this.#root;
    }
    try {
      return (await realDirectory(this.#root, ".cantrip", false)) ?? this.#root;
    } catch {
      return this.#root;
    }
  }
}

export class RunConfigurationRepositoryWatcher {
  readonly #repository: RunConfigurationRepository;
  readonly #listener: (
    change: RunConfigurationRepositoryChange,
  ) => void | Promise<void>;
  #baseline: RunConfigurationRepositoryInventory;
  #closed = false;
  #pollTimer: NodeJS.Timeout | null = null;
  #refreshRequestedDelay: number | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #refreshing = false;
  #watcher: FSWatcher | null = null;
  #watchedDirectory: string | null = null;

  private constructor(
    repository: RunConfigurationRepository,
    listener: (
      change: RunConfigurationRepositoryChange,
    ) => void | Promise<void>,
    baseline: RunConfigurationRepositoryInventory,
  ) {
    this.#repository = repository;
    this.#listener = listener;
    this.#baseline = baseline;
  }

  static async start(
    repository: RunConfigurationRepository,
    listener: (
      change: RunConfigurationRepositoryChange,
    ) => void | Promise<void>,
  ): Promise<RunConfigurationRepositoryWatcher> {
    const result = new RunConfigurationRepositoryWatcher(
      repository,
      listener,
      await repository.scan(),
    );
    await result.#arm();
    result.#pollTimer = setInterval(() => {
      void result.#refresh();
    }, WATCH_POLL_MS);
    result.#pollTimer.unref();
    return result;
  }

  close(): void {
    this.#closed = true;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    this.#refreshRequestedDelay = null;
    this.#refreshTimer = null;
    this.#watcher?.close();
    this.#watcher = null;
    this.#watchedDirectory = null;
  }

  async #arm(): Promise<void> {
    if (this.#closed) return;
    const directory = await this.#repository.deepestWatchDirectory();
    if (directory === this.#watchedDirectory && this.#watcher) return;
    this.#watcher?.close();
    this.#watcher = null;
    this.#watchedDirectory = directory;
    try {
      const watcher = watch(directory, { persistent: false }, () => {
        this.#scheduleRefresh();
      });
      watcher.on("error", () => {
        if (this.#watcher === watcher) {
          this.#watcher = null;
          this.#watchedDirectory = null;
        }
        this.#scheduleRefresh(WATCH_RETRY_MS);
      });
      this.#watcher = watcher;
    } catch {
      this.#watcher = null;
      this.#watchedDirectory = null;
      this.#scheduleRefresh(WATCH_RETRY_MS);
    }
  }

  #scheduleRefresh(delay = WATCH_DEBOUNCE_MS): void {
    if (this.#closed) return;
    if (this.#refreshing) {
      this.#refreshRequestedDelay =
        this.#refreshRequestedDelay === null
          ? delay
          : Math.min(this.#refreshRequestedDelay, delay);
      return;
    }
    if (this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#refresh();
    }, delay);
    this.#refreshTimer.unref();
  }

  async #refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing) {
      this.#refreshRequestedDelay = 0;
      return;
    }
    this.#refreshing = true;
    this.#refreshRequestedDelay = null;
    let retry = false;
    try {
      const current = await this.#repository.scan();
      if (this.#closed) return;
      const changes = changeEvents(this.#baseline, current);
      this.#baseline = current;
      await this.#arm();
      if (this.#closed) return;
      for (const change of changes) {
        if (this.#closed) return;
        await this.#listener(change);
      }
    } catch {
      retry = true;
    } finally {
      this.#refreshing = false;
      const requestedDelay = retry
        ? WATCH_RETRY_MS
        : this.#refreshRequestedDelay;
      this.#refreshRequestedDelay = null;
      if (!this.#closed && requestedDelay !== null) {
        this.#scheduleRefresh(requestedDelay);
      }
    }
  }
}
