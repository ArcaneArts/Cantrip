import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  codeSettingsPayloadSchema,
  codeSettingsReservedKeys,
  codeSettingsWorkerStatusSchema,
  type CodeSettingsJsonObject,
  type CodeSettingsResolution,
  type CodeSettingsStoredProfile,
  type CodeSettingsWorkerStatus,
} from "@cantrip/protocol/code-settings";
import { parse, parseTree, type ParseError } from "jsonc-parser";
import { z } from "zod";

import {
  CodeSettingsClient,
  CodeSettingsClientConflictError,
  CodeSettingsClientError,
} from "./code-settings-client.js";
import {
  openWorkerCodeSettings,
  protectWorkerCodeSettings,
} from "./code-settings-encryption.js";
import { workerLogError, workerLogger } from "./logger.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const DEFAULT_DEBOUNCE_MS = 350;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;
const reservedKeys = new Set<string>(codeSettingsReservedKeys);

interface CodeSettingsWatcher {
  close(): void;
  once(event: "error", listener: () => void): CodeSettingsWatcher;
}

type CodeSettingsWatchFactory = (
  directory: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => CodeSettingsWatcher;

class LocalCodeSettingsChangedError extends Error {
  constructor() {
    super("VS Code settings changed while synchronization was in progress.");
    this.name = "LocalCodeSettingsChangedError";
  }
}

interface LocalSettingsSnapshot {
  raw: string | null;
  reserved: Record<string, unknown>;
  settings: CodeSettingsJsonObject;
}

interface SyncConflict {
  base: CodeSettingsJsonObject;
  local: CodeSettingsJsonObject;
  remote: CodeSettingsJsonObject;
  remoteRevision: number;
  conflictCount: number;
}

interface PersistedSyncState {
  version: 1;
  profileId: "default";
  revision: number | null;
  base: CodeSettingsJsonObject | null;
  baseHash: string | null;
  initializedFromWorker: boolean;
  backupCreated: boolean;
  conflict: SyncConflict | null;
}

const settingsObjectSchema = codeSettingsPayloadSchema.shape.settings;
const persistedStateSchema = z
  .object({
    version: z.literal(1),
    profileId: z.literal("default"),
    revision: z.number().int().positive().safe().nullable(),
    base: settingsObjectSchema.nullable(),
    baseHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    initializedFromWorker: z.boolean(),
    backupCreated: z.boolean(),
    conflict: z
      .object({
        base: settingsObjectSchema,
        local: settingsObjectSchema,
        remote: settingsObjectSchema,
        remoteRevision: z.number().int().positive().safe(),
        conflictCount: z.number().int().positive().safe(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.revision === null) !== (value.base === null)) {
      context.addIssue({
        code: "custom",
        message: "Code settings revision and base snapshot must agree.",
      });
    }
    if ((value.base === null) !== (value.baseHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Code settings base snapshot and digest must agree.",
      });
    }
  });

const emptyState = (): PersistedSyncState => ({
  version: 1,
  profileId: "default",
  revision: null,
  base: null,
  baseHash: null,
  initializedFromWorker: false,
  backupCreated: false,
  conflict: null,
});

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeValue(nested)]),
    );
  }
  return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

function rejectDuplicateTopLevelKeys(raw: string): void {
  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0)
    throw new Error("VS Code settings contain invalid JSONC.");
  if (!root) return;
  if (root.type !== "object") {
    throw new Error("VS Code settings must be a JSON object.");
  }
  const keys = new Set<string>();
  for (const property of root.children ?? []) {
    const key = property.children?.[0]?.value;
    if (typeof key !== "string") continue;
    if (keys.has(key)) {
      throw new Error("VS Code settings contain a duplicate top-level key.");
    }
    keys.add(key);
  }
}

export function parseAndNormalizeCodeSettings(raw: string): {
  reserved: Record<string, unknown>;
  settings: CodeSettingsJsonObject;
} {
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (source.trim().length === 0) return { reserved: {}, settings: {} };
  rejectDuplicateTopLevelKeys(source);
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    errors.length > 0 ||
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("VS Code settings contain invalid JSONC.");
  }
  const synced: Record<string, unknown> = {};
  const reserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    (reservedKeys.has(key) ? reserved : synced)[key] = normalizeValue(value);
  }
  const settings = codeSettingsPayloadSchema.parse({
    formatVersion: 1,
    settings: normalizeValue(synced),
  }).settings;
  return { reserved, settings };
}

export function codeSettingsDigest(settings: CodeSettingsJsonObject): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeValue(settings)))
    .digest("hex");
}

export function codeSettingsRetryDelay(input: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  random?: () => number;
}): number {
  const attempt = Math.max(0, Math.floor(input.attempt));
  const baseDelayMs = Math.max(1, Math.floor(input.baseDelayMs));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(input.maxDelayMs));
  const jitterRatio = Math.min(
    1,
    Math.max(0, input.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO),
  );
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.min(attempt, 30),
  );
  if (attempt === 0 || jitterRatio === 0) return exponential;
  const random = Math.min(1, Math.max(0, (input.random ?? Math.random)()));
  const factor = 1 - jitterRatio + random * jitterRatio * 2;
  return Math.max(1, Math.min(maxDelayMs, Math.round(exponential * factor)));
}

export function codeSettingsAuthorizationFingerprint(
  service: WorkerEncryptionService,
): string | null {
  const status = service.status();
  const customizationGrant = status.grants.find(
    (grant) => grant.component === "customization-content",
  );
  if (!customizationGrant) return null;
  try {
    return JSON.stringify([
      service.ownerId(),
      service.serverIdentity(),
      status.principalId,
      customizationGrant.keyRevision,
    ]);
  } catch {
    return null;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(normalizeValue(left)) ===
    JSON.stringify(normalizeValue(right))
  );
}

export function mergeCodeSettingsSnapshots(input: {
  base: CodeSettingsJsonObject;
  local: CodeSettingsJsonObject;
  remote: CodeSettingsJsonObject;
}): { merged: CodeSettingsJsonObject | null; conflictCount: number } {
  const merged: Record<string, unknown> = structuredClone(input.remote);
  let conflictCount = 0;
  const keys = new Set([
    ...Object.keys(input.base),
    ...Object.keys(input.local),
    ...Object.keys(input.remote),
  ]);
  for (const key of keys) {
    const baseHas = Object.hasOwn(input.base, key);
    const localHas = Object.hasOwn(input.local, key);
    const remoteHas = Object.hasOwn(input.remote, key);
    const localChanged =
      baseHas !== localHas ||
      (baseHas && localHas && !valuesEqual(input.base[key], input.local[key]));
    const remoteChanged =
      baseHas !== remoteHas ||
      (baseHas &&
        remoteHas &&
        !valuesEqual(input.base[key], input.remote[key]));
    if (!localChanged) continue;
    if (
      remoteChanged &&
      (localHas !== remoteHas ||
        (localHas && !valuesEqual(input.local[key], input.remote[key])))
    ) {
      conflictCount += 1;
      continue;
    }
    if (localHas) merged[key] = input.local[key];
    else delete merged[key];
  }
  if (conflictCount > 0) return { merged: null, conflictCount };
  return {
    merged: settingsObjectSchema.parse(normalizeValue(merged)),
    conflictCount: 0,
  };
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(pathname: string, content: string): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  if (await exists(pathname)) {
    const entry = await lstat(pathname);
    if (entry.isSymbolicLink()) {
      throw new Error("Refusing to replace a symlinked VS Code settings file.");
    }
  }
  const temporary = path.join(
    path.dirname(pathname),
    `.${path.basename(pathname)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, pathname);
    await chmod(pathname, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class CodeSettingsSynchronizer {
  readonly #client: CodeSettingsClient;
  readonly #settingsPath: string;
  readonly #statePath: string;
  readonly #backupPath: string;
  readonly #conflictBackupPath: string;
  readonly #service: WorkerEncryptionService;
  readonly #profileId = "default" as const;
  readonly #debounceMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #retryJitterRatio: number;
  readonly #random: () => number;
  readonly #watchFactory: CodeSettingsWatchFactory;
  #state: PersistedSyncState = emptyState();
  #status: CodeSettingsWorkerStatus;
  #tail: Promise<void> = Promise.resolve();
  #watcher: CodeSettingsWatcher | null = null;
  #watchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #lastAppliedHash: string | null = null;
  #authorizationFingerprint: string | null;
  #authorizationPaused = false;
  #consecutiveRetryFailures = 0;

  constructor(input: {
    authorizationFingerprint: string;
    credential: () => string;
    debounceMs?: number;
    fetch?: typeof fetch;
    maxRetryDelayMs?: number;
    pollIntervalMs?: number;
    random?: () => number;
    retryJitterRatio?: number;
    serverUrl: string;
    service: WorkerEncryptionService;
    settingsPath: string;
    statePath: string;
    watchFactory?: CodeSettingsWatchFactory;
    workerId: string;
  }) {
    this.#settingsPath = input.settingsPath;
    this.#statePath = input.statePath;
    this.#backupPath = path.join(
      path.dirname(input.settingsPath),
      "settings.pre-cantrip-sync.json",
    );
    this.#conflictBackupPath = path.join(
      path.dirname(input.settingsPath),
      "settings.pre-cantrip-conflict.json",
    );
    this.#service = input.service;
    this.#debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxRetryDelayMs = Math.max(
      this.#pollIntervalMs,
      input.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    );
    this.#retryJitterRatio =
      input.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO;
    this.#random = input.random ?? Math.random;
    if (!input.authorizationFingerprint) {
      throw new Error("Code settings authorization fingerprint is required.");
    }
    this.#authorizationFingerprint = input.authorizationFingerprint;
    this.#watchFactory =
      input.watchFactory ??
      ((directory, listener) =>
        watch(directory, { persistent: false }, listener));
    this.#client = new CodeSettingsClient({
      credential: input.credential,
      fetch: input.fetch,
      profileId: this.#profileId,
      serverUrl: input.serverUrl,
      workerId: input.workerId,
    });
    this.#status = this.statusValue("unavailable", null);
  }

  async start(): Promise<void> {
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    this.#state = await this.readState();
    this.startWatcher();
    this.schedulePoll();
  }

  status(): CodeSettingsWorkerStatus {
    return structuredClone(this.#status);
  }

  updateAuthorization(
    fingerprint: string | null,
    options: { forceResume?: boolean } = {},
  ): boolean {
    if (!fingerprint) {
      const changed =
        this.#authorizationFingerprint !== null || !this.#authorizationPaused;
      this.#authorizationFingerprint = null;
      this.#authorizationPaused = true;
      this.#consecutiveRetryFailures = 0;
      this.cancelScheduledNetworkAttempts();
      this.#status = this.statusValue(
        "unavailable",
        "Code settings authorization requires an active customization-content grant.",
      );
      return changed;
    }

    const changed = fingerprint !== this.#authorizationFingerprint;
    this.#authorizationFingerprint = fingerprint;
    if (!changed && !options.forceResume) return false;
    this.#authorizationPaused = false;
    this.#consecutiveRetryFailures = 0;
    this.#status = this.statusValue("unavailable", null);
    this.schedulePoll();
    return true;
  }

  synchronize(input: {
    initializeIfMissing: boolean;
  }): Promise<CodeSettingsWorkerStatus> {
    if (this.#authorizationPaused) return Promise.resolve(this.status());
    return this.enqueue(async () => {
      if (this.#authorizationPaused) return this.status();
      await this.runGuarded(() => this.reconcile(input.initializeIfMissing));
      this.schedulePoll();
      return this.status();
    });
  }

  invalidate(revision: number): Promise<CodeSettingsWorkerStatus> {
    if (this.#state.revision !== null && revision <= this.#state.revision) {
      return Promise.resolve(this.status());
    }
    return this.synchronize({ initializeIfMissing: false });
  }

  resolve(
    resolution: CodeSettingsResolution,
  ): Promise<CodeSettingsWorkerStatus> {
    if (this.#authorizationPaused) return Promise.resolve(this.status());
    return this.enqueue(async () => {
      if (this.#authorizationPaused) return this.status();
      await this.runGuarded(async () => {
        const conflict = this.#state.conflict;
        if (!conflict)
          throw new Error("There is no Code settings conflict to resolve.");
        if (resolution === "accept-canonical") {
          const local = await this.readLocal();
          await this.preserveConflictLocal(local);
          await this.upload(conflict.remote, conflict.remoteRevision, local);
          return;
        }
        const local = await this.readLocal();
        await this.upload(local.settings, conflict.remoteRevision, local);
      });
      this.schedulePoll();
      return this.status();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#watchRetryTimer) clearTimeout(this.#watchRetryTimer);
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#watchRetryTimer = null;
    this.#debounceTimer = null;
    this.#pollTimer = null;
    await this.#tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.resolve(this.status() as T);
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runGuarded(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      this.#consecutiveRetryFailures = 0;
    } catch (error) {
      if (this.isAuthorizationRejection(error)) {
        this.#authorizationPaused = true;
        this.#consecutiveRetryFailures = 0;
        this.cancelScheduledNetworkAttempts();
        this.#status = this.statusValue(
          "unavailable",
          "Code settings authorization is unavailable on Cantrip Server.",
        );
        workerLogger.event(
          "warn",
          "Global Code settings synchronization authorization became unavailable",
          {
            event: "code.settings.authorization-unavailable",
            subsystem: "code-settings",
            operation: "synchronize",
            reasonCode: `http-${error.status}`,
            status: "unavailable",
            error: workerLogError(error),
          },
        );
        return;
      }
      const offline =
        error instanceof CodeSettingsClientError && error.code === "offline";
      const retryableServerFailure =
        error instanceof CodeSettingsClientError &&
        error.code === "rejected" &&
        error.status !== null &&
        error.status >= 500;
      if (offline || retryableServerFailure) {
        this.#consecutiveRetryFailures += 1;
      } else {
        this.#consecutiveRetryFailures = 0;
      }
      const state = this.#state.conflict
        ? "conflict"
        : offline
          ? "offline"
          : "error";
      this.#status = this.statusValue(state, this.publicError(error));
      workerLogger.rateLimited(
        `code-settings-sync:${state}`,
        state === "offline" ? "warn" : "error",
        "Global Code settings synchronization did not complete",
        {
          event: "code.settings.sync-failed",
          subsystem: "code-settings",
          operation: "synchronize",
          reasonCode: state,
          status: state,
          error: workerLogError(error),
        },
      );
    }
  }

  private isAuthorizationRejection(
    error: unknown,
  ): error is CodeSettingsClientError {
    return (
      error instanceof CodeSettingsClientError &&
      error.code === "rejected" &&
      (error.status === 401 || error.status === 403)
    );
  }

  private cancelScheduledNetworkAttempts(): void {
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#pollTimer = null;
    this.#debounceTimer = null;
  }

  private schedulePoll(): void {
    if (this.#closed || this.#authorizationPaused) return;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    const delay = codeSettingsRetryDelay({
      attempt: this.#consecutiveRetryFailures,
      baseDelayMs: this.#pollIntervalMs,
      maxDelayMs: this.#maxRetryDelayMs,
      jitterRatio: this.#retryJitterRatio,
      random: this.#random,
    });
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.synchronize({ initializeIfMissing: false });
    }, delay);
    this.#pollTimer.unref();
  }

  private async reconcile(initializeIfMissing: boolean): Promise<void> {
    this.#status = this.statusValue("synchronizing", null);
    const remoteProfile = await this.#client.get();
    const local = await this.readLocal();
    if (!remoteProfile) {
      if (!initializeIfMissing) {
        this.#status = this.statusValue("uninitialized", null);
        return;
      }
      try {
        await this.upload(local.settings, null, local, true);
      } catch (error) {
        if (!(error instanceof CodeSettingsClientConflictError)) throw error;
        const winner = await this.#client.get();
        if (!winner) throw error;
        await this.reconcileInitializationRace(
          winner,
          await this.openRemote(winner),
          local,
        );
      }
      return;
    }
    const remote = await this.openRemote(remoteProfile);
    await this.reconcileSnapshots(remoteProfile, remote, local, 0);
  }

  private async reconcileInitializationRace(
    remoteProfile: CodeSettingsStoredProfile,
    remote: CodeSettingsJsonObject,
    local: LocalSettingsSnapshot,
  ): Promise<void> {
    const remoteRevision = remoteProfile.record.revision;
    const result = mergeCodeSettingsSnapshots({
      base: {},
      local: local.settings,
      remote,
    });
    if (!result.merged) {
      this.#state.conflict = {
        base: {},
        local: local.settings,
        remote,
        remoteRevision,
        conflictCount: result.conflictCount,
      };
      await this.writeState();
      this.#status = this.statusValue("conflict", null);
      return;
    }
    if (codeSettingsDigest(result.merged) === codeSettingsDigest(remote)) {
      await this.acceptRemote(remote, remoteRevision, local, false);
      return;
    }
    await this.upload(result.merged, remoteRevision, local);
  }

  private async reconcileSnapshots(
    remoteProfile: CodeSettingsStoredProfile,
    remote: CodeSettingsJsonObject,
    local: LocalSettingsSnapshot,
    attempt: number,
  ): Promise<void> {
    const remoteRevision = remoteProfile.record.revision;
    const requiresEncryptionMigration =
      remoteProfile.record.protectedContent.keyRevision !==
      this.#service.componentKey("customization-content").keyRevision;
    if (!this.#state.base || this.#state.revision === null) {
      await this.acceptRemote(
        remote,
        remoteRevision,
        local,
        requiresEncryptionMigration,
      );
      return;
    }
    const localHash = codeSettingsDigest(local.settings);
    const baseHash = this.#state.baseHash!;
    if (remoteRevision === this.#state.revision) {
      if (localHash === baseHash || localHash === this.#lastAppliedHash) {
        if (requiresEncryptionMigration) {
          await this.acceptRemote(remote, remoteRevision, local, true);
        } else {
          this.#status = this.statusValue("ready", null);
        }
        return;
      }
      await this.upload(local.settings, remoteRevision, local);
      return;
    }
    if (localHash === baseHash || localHash === this.#lastAppliedHash) {
      await this.acceptRemote(
        remote,
        remoteRevision,
        local,
        requiresEncryptionMigration,
      );
      return;
    }
    const result = mergeCodeSettingsSnapshots({
      base: this.#state.base,
      local: local.settings,
      remote,
    });
    if (!result.merged) {
      this.#state.conflict = {
        base: this.#state.base,
        local: local.settings,
        remote,
        remoteRevision,
        conflictCount: result.conflictCount,
      };
      await this.writeState();
      this.#status = this.statusValue("conflict", null);
      return;
    }
    if (codeSettingsDigest(result.merged) === codeSettingsDigest(remote)) {
      await this.acceptRemote(
        remote,
        remoteRevision,
        local,
        requiresEncryptionMigration,
      );
      return;
    }
    try {
      await this.upload(result.merged, remoteRevision, local);
    } catch (error) {
      if (!(error instanceof CodeSettingsClientConflictError) || attempt >= 2)
        throw error;
      const newestProfile = await this.#client.get();
      if (!newestProfile) throw error;
      const newest = await this.openRemote(newestProfile);
      const mergedLocal: LocalSettingsSnapshot = {
        ...local,
        settings: result.merged,
      };
      this.#state.base = remote;
      this.#state.baseHash = codeSettingsDigest(remote);
      this.#state.revision = remoteRevision;
      await this.reconcileSnapshots(
        newestProfile,
        newest,
        mergedLocal,
        attempt + 1,
      );
    }
  }

  private async upload(
    settings: CodeSettingsJsonObject,
    expectedRevision: number | null,
    local: LocalSettingsSnapshot,
    initializedFromWorker = false,
  ): Promise<void> {
    const upload = await protectWorkerCodeSettings({
      expectedRevision,
      profileId: this.#profileId,
      service: this.#service,
      settings,
    });
    const stored = await this.#client.put(upload);
    if (
      stored.record.operationId !== upload.record.operationId ||
      stored.record.revision !== upload.record.revision
    ) {
      throw new Error(
        "Cantrip Server returned mismatched Code settings commit metadata.",
      );
    }
    if (codeSettingsDigest(settings) !== codeSettingsDigest(local.settings)) {
      await this.applyRemote(settings, local);
    }
    this.#state.initializedFromWorker ||= initializedFromWorker;
    await this.commitBase(
      settings,
      stored.record.revision,
      initializedFromWorker,
    );
  }

  private async acceptRemote(
    settings: CodeSettingsJsonObject,
    revision: number,
    local: LocalSettingsSnapshot,
    requiresEncryptionMigration: boolean,
  ): Promise<void> {
    await this.applyRemote(settings, local);
    if (requiresEncryptionMigration) {
      await this.upload(settings, revision, { ...local, settings }, false);
      return;
    }
    await this.commitBase(settings, revision, false);
  }

  private async openRemote(
    profile: CodeSettingsStoredProfile,
  ): Promise<CodeSettingsJsonObject> {
    return settingsObjectSchema.parse(
      normalizeValue(
        await openWorkerCodeSettings({ profile, service: this.#service }),
      ),
    );
  }

  private async readLocal(): Promise<LocalSettingsSnapshot> {
    try {
      const entry = await lstat(this.#settingsPath);
      if (entry.isSymbolicLink()) {
        throw new Error("Refusing to read a symlinked VS Code settings file.");
      }
      if (!entry.isFile())
        throw new Error("VS Code settings path is not a file.");
      const raw = await readFile(this.#settingsPath, "utf8");
      return { raw, ...parseAndNormalizeCodeSettings(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { raw: null, reserved: {}, settings: {} };
      }
      throw error;
    }
  }

  private async applyRemote(
    settings: CodeSettingsJsonObject,
    local: LocalSettingsSnapshot,
  ): Promise<void> {
    const current = await this.readLocal();
    if (current.raw !== local.raw) {
      throw new LocalCodeSettingsChangedError();
    }
    if (!this.#state.backupCreated && current.raw !== null) {
      try {
        await copyFile(this.#settingsPath, this.#backupPath, 0x1);
        await chmod(this.#backupPath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const backup = await lstat(this.#backupPath);
        if (backup.isSymbolicLink() || !backup.isFile()) {
          throw new Error(
            "The existing Code settings recovery copy is unsafe.",
          );
        }
      }
      this.#state.backupCreated = true;
    }
    const combined = normalizeValue({ ...settings, ...current.reserved });
    await atomicWrite(
      this.#settingsPath,
      `${JSON.stringify(combined, null, 2)}\n`,
    );
    this.#lastAppliedHash = codeSettingsDigest(settings);
  }

  private async preserveConflictLocal(
    local: LocalSettingsSnapshot,
  ): Promise<void> {
    const current = await this.readLocal();
    if (current.raw !== local.raw) {
      throw new LocalCodeSettingsChangedError();
    }
    if (current.raw !== null) {
      await atomicWrite(this.#conflictBackupPath, current.raw);
    }
  }

  private async commitBase(
    settings: CodeSettingsJsonObject,
    revision: number,
    initializedFromWorker: boolean,
  ): Promise<void> {
    this.#state.base = structuredClone(settings);
    this.#state.baseHash = codeSettingsDigest(settings);
    this.#state.revision = revision;
    this.#state.conflict = null;
    this.#state.initializedFromWorker ||= initializedFromWorker;
    await this.writeState();
    this.#status = this.statusValue("ready", null);
  }

  private statusValue(
    state: CodeSettingsWorkerStatus["state"],
    error: string | null,
  ): CodeSettingsWorkerStatus {
    return codeSettingsWorkerStatusSchema.parse({
      profileId: this.#profileId,
      state,
      revision: this.#state.revision,
      conflictCount:
        state === "conflict" ? (this.#state.conflict?.conflictCount ?? 0) : 0,
      initializedFromWorker: this.#state.initializedFromWorker,
      backupCreated: this.#state.backupCreated,
      lastSynchronizedAt: state === "ready" ? new Date().toISOString() : null,
      error: error ? error.slice(0, 500) : null,
    });
  }

  private publicError(error: unknown): string {
    if (error instanceof CodeSettingsClientError) return error.message;
    if (error instanceof CodeSettingsClientConflictError) return error.message;
    const message = error instanceof Error ? error.message : "";
    if (
      /^(?:VS Code settings|Refusing to|There is no Code settings conflict|Protected endpoint content|Endpoint content encryption|The existing Code settings recovery copy)/u.test(
        message,
      )
    ) {
      return message;
    }
    return "Code settings synchronization failed on this worker.";
  }

  private async readState(): Promise<PersistedSyncState> {
    try {
      const entry = await lstat(this.#statePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("The Code settings checkpoint is unsafe.");
      }
      return persistedStateSchema.parse(
        JSON.parse(await readFile(this.#statePath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw error;
    }
  }

  private writeState(): Promise<void> {
    return atomicWrite(
      this.#statePath,
      `${JSON.stringify(persistedStateSchema.parse(this.#state), null, 2)}\n`,
    );
  }

  private startWatcher(): void {
    if (this.#closed || this.#watcher) return;
    try {
      this.#watcher = this.#watchFactory(
        path.dirname(this.#settingsPath),
        (_event, filename) => {
          if (this.#authorizationPaused) return;
          if (
            filename &&
            filename.toString() !== path.basename(this.#settingsPath)
          )
            return;
          if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
          this.#debounceTimer = setTimeout(() => {
            this.#debounceTimer = null;
            void this.synchronize({ initializeIfMissing: false });
          }, this.#debounceMs);
          this.#debounceTimer.unref();
        },
      );
      this.#watcher.once("error", () => {
        this.#watcher?.close();
        this.#watcher = null;
        this.scheduleWatcherRetry();
      });
    } catch {
      this.scheduleWatcherRetry();
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.#closed || this.#watchRetryTimer) return;
    this.#watchRetryTimer = setTimeout(() => {
      this.#watchRetryTimer = null;
      this.startWatcher();
    }, 5_000);
    this.#watchRetryTimer.unref();
  }
}
