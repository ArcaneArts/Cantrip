import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { encodeBase64Url } from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import { REPOSITORY_METADATA_FIELDS } from "@cantrip/protocol/repository-operation";

const routingTokenPattern = /^ctrr_[A-Za-z0-9_-]{43}$/u;

interface RoutingRegistryFile {
  version: 1;
  records: Array<{ field: string; token: string; value: string }>;
}

const protectedResultTypes = new Set([
  "project.clone",
  "project.folder.materialize",
  "project.folder-conversion.preflight",
  "project.folder-conversion.execute",
  "project.replica.provision",
  "project.replica.synchronize",
  "project.replica.remove",
  "worktree.list",
  "worktree.reconcile",
  "worktree.create",
  "worktree.remove",
  "worktree.lock",
  "worktree.unlock",
  "worktree.prune",
  "worktree.status",
  "project.run-setup.start",
  "project.run-setup.status",
]);

const privateResultFields = new Set<string>(REPOSITORY_METADATA_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRoutingRegistryFile(value: unknown): RoutingRegistryFile {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.records) ||
    Object.keys(value).some((key) => key !== "version" && key !== "records")
  ) {
    throw new Error("Invalid repository routing registry.");
  }
  const records = value.records.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.field !== "string" ||
      !privateResultFields.has(record.field) ||
      typeof record.token !== "string" ||
      !routingTokenPattern.test(record.token) ||
      typeof record.value !== "string" ||
      record.value.length < 1 ||
      record.value.length > 32_768 ||
      Object.keys(record).some(
        (key) => key !== "field" && key !== "token" && key !== "value",
      )
    ) {
      throw new Error("Invalid repository routing record.");
    }
    return { field: record.field, token: record.token, value: record.value };
  });
  return { version: 1, records };
}

export class WorkerRoutingRegistry {
  readonly #path: string;
  readonly #records = new Map<string, { field: string; value: string }>();
  readonly #tokens = new Map<string, string>();
  #loadPromise: Promise<void> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#path = path.resolve(dataDirectory, "repository-routing.json");
  }

  async resolveCommand(command: WorkerCommand): Promise<WorkerCommand> {
    await this.#load();
    return this.#resolveValue(command) as WorkerCommand;
  }

  async protectResult(type: string, result: unknown): Promise<unknown> {
    if (!protectedResultTypes.has(type)) return result;
    await this.#load();
    const protectedResult = this.#protectValue(result);
    await this.#persist();
    return protectedResult;
  }

  protectError(type: string, error: unknown): unknown {
    if (!protectedResultTypes.has(type)) return error;
    return new Error("Protected repository operation failed on the worker.");
  }

  async resolveToken(value: string): Promise<string> {
    await this.#load();
    return this.#resolveString(value);
  }

  async protectMetadata(
    values: Record<string, string | string[] | null>,
  ): Promise<Record<string, string | string[] | null>> {
    if (Object.keys(values).some((field) => !privateResultFields.has(field))) {
      throw new Error("Unsupported repository metadata field.");
    }
    await this.#load();
    const protectedValues = this.#protectValue(values) as Record<
      string,
      string | string[] | null
    >;
    await this.#persist();
    return protectedValues;
  }

  async resolveMetadata(
    values: Record<string, string | string[] | null>,
  ): Promise<Record<string, string | string[] | null>> {
    if (Object.keys(values).some((field) => !privateResultFields.has(field))) {
      throw new Error("Unsupported repository metadata field.");
    }
    await this.#load();
    return this.#resolveValue(values) as Record<
      string,
      string | string[] | null
    >;
  }

  #protectValue(value: unknown, field?: string): unknown {
    if (typeof value === "string" && field && privateResultFields.has(field)) {
      return this.#token(field, value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.#protectValue(item, field));
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        this.#protectValue(item, key),
      ]),
    );
  }

  #resolveValue(value: unknown): unknown {
    if (typeof value === "string") return this.#resolveString(value);
    if (Array.isArray(value))
      return value.map((item) => this.#resolveValue(item));
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        this.#resolveValue(item),
      ]),
    );
  }

  #resolveString(value: string): string {
    const direct = this.#records.get(value);
    if (direct) return direct.value;
    const headPrefix = "refs/heads/";
    if (value.startsWith(headPrefix)) {
      const resolved = this.#records.get(value.slice(headPrefix.length));
      if (resolved) return `${headPrefix}${resolved.value}`;
    }
    return value;
  }

  #token(field: string, value: string): string {
    const reverseKey = `${field}\u0000${value}`;
    const existing = this.#tokens.get(reverseKey);
    if (existing) return existing;
    let token: string;
    do {
      token = `ctrr_${encodeBase64Url(randomBytes(32))}`;
    } while (this.#records.has(token));
    if (!routingTokenPattern.test(token)) {
      throw new Error("Could not create a repository routing token.");
    }
    this.#records.set(token, { field, value });
    this.#tokens.set(reverseKey, token);
    return token;
  }

  async #load(): Promise<void> {
    this.#loadPromise ??= this.#readStoredRecords();
    return this.#loadPromise;
  }

  async #readStoredRecords(): Promise<void> {
    try {
      const stored = parseRoutingRegistryFile(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
      for (const { field, token, value } of stored.records) {
        const reverseKey = `${field}\u0000${value}`;
        if (this.#records.has(token) || this.#tokens.has(reverseKey)) {
          throw new Error("Duplicate repository routing record.");
        }
        this.#records.set(token, { field, value });
        this.#tokens.set(reverseKey, token);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw new Error("The worker repository routing registry is invalid.");
    }
  }

  async #persist(): Promise<void> {
    const write = this.#writeQueue.then(
      () => this.#writeSnapshot(),
      () => this.#writeSnapshot(),
    );
    this.#writeQueue = write;
    await write;
  }

  async #writeSnapshot(): Promise<void> {
    await mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const records = [...this.#records].map(([token, { field, value }]) => ({
      field,
      token,
      value,
    }));
    await writeFile(temporary, `${JSON.stringify({ version: 1, records })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}
