import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  standaloneChatIdentitySchema,
  standaloneChatScratchArchiveResultSchema,
  standaloneChatScratchDeleteResultSchema,
  standaloneChatScratchProvisionResultSchema,
  standaloneChatScratchReconciliationResultSchema,
  standaloneChatScratchReconciliationTargetSchema,
  standaloneChatScratchResolveResultSchema,
  type StandaloneChatScratchArchiveResult,
  type StandaloneChatScratchDeleteResult,
  type StandaloneChatScratchProvisionResult,
  type StandaloneChatScratchReconciliationResult,
  type StandaloneChatScratchReconciliationTarget,
  type StandaloneChatScratchResolveResult,
} from "@cantrip/protocol";

interface ScratchRecord {
  rootId: string;
  chatId: string;
  archivedAt: string | null;
  archiveExpiresAt: string | null;
}

interface ScratchRegistryFile {
  version: 1;
  roots: ScratchRecord[];
}

async function directoryEntry(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function canonicalIdentity(value: string, name: string): string {
  const parsed = standaloneChatIdentitySchema.parse(value);
  if (parsed !== value) {
    throw new Error(`${name} must be a canonical lowercase UUID.`);
  }
  return parsed;
}

function parseRegistry(value: unknown): ScratchRegistryFile {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { roots?: unknown }).roots) ||
    Object.keys(value).some((key) => key !== "version" && key !== "roots")
  ) {
    throw new Error("Invalid standalone Chat scratch registry.");
  }
  const seenRootIds = new Set<string>();
  const seenChatIds = new Set<string>();
  const roots = (value as { roots: unknown[] }).roots.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid standalone Chat scratch registry record.");
    }
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) =>
          key !== "rootId" &&
          key !== "chatId" &&
          key !== "archivedAt" &&
          key !== "archiveExpiresAt",
      ) ||
      typeof record.rootId !== "string" ||
      typeof record.chatId !== "string" ||
      !(record.archivedAt === null || typeof record.archivedAt === "string") ||
      !(
        record.archiveExpiresAt === null ||
        typeof record.archiveExpiresAt === "string"
      )
    ) {
      throw new Error("Invalid standalone Chat scratch registry record.");
    }
    const rootId = canonicalIdentity(record.rootId, "Scratch root identity");
    const chatId = canonicalIdentity(record.chatId, "Chat identity");
    const parsed = standaloneChatScratchArchiveResultSchema.parse({
      rootId,
      chatId,
      archivedAt: record.archivedAt,
      archiveExpiresAt: record.archiveExpiresAt,
    });
    if (seenRootIds.has(rootId) || seenChatIds.has(chatId)) {
      throw new Error("Duplicate standalone Chat scratch registry identity.");
    }
    seenRootIds.add(rootId);
    seenChatIds.add(chatId);
    return parsed;
  });
  return { version: 1, roots };
}

export function deriveChatScratchLocation(
  dataDirectory: string,
  chatId: string,
): { displayPath: string; root: string; target: string } {
  const canonicalChatId = canonicalIdentity(chatId, "Chat identity");
  const root = path.resolve(dataDirectory, "chat-scratch");
  const target = path.join(root, canonicalChatId);
  if (path.dirname(target) !== root) {
    throw new Error("Standalone Chat scratch target escaped its storage root.");
  }
  return {
    displayPath: path.join("chat-scratch", canonicalChatId),
    root,
    target,
  };
}

export class ChatScratchManager {
  readonly #dataDirectory: string;
  readonly #registryPath: string;
  #records: Map<string, ScratchRecord> | undefined;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#registryPath = path.join(
      this.#dataDirectory,
      "chat-scratch-registry.json",
    );
  }

  async provision(input: {
    jobId: string;
    attempt: number;
    rootId: string;
    chatId: string;
  }): Promise<StandaloneChatScratchProvisionResult> {
    return this.#mutate(async () => {
      const jobId = canonicalIdentity(input.jobId, "Scratch job identity");
      const rootId = canonicalIdentity(input.rootId, "Scratch root identity");
      const chatId = canonicalIdentity(input.chatId, "Chat identity");
      const records = await this.#load();
      const existing = records.get(rootId);
      const chatRecord = [...records.values()].find(
        (record) => record.chatId === chatId,
      );
      if (
        (existing && existing.chatId !== chatId) ||
        (chatRecord && chatRecord.rootId !== rootId)
      ) {
        throw new Error(
          "Standalone Chat scratch identity conflicts with its registry.",
        );
      }
      const location = await this.#verifiedLocation(chatId);
      const entry = await directoryEntry(location.target);
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw new Error(
          "Standalone Chat scratch target is not a safe directory.",
        );
      }
      if (entry && !existing) {
        throw new Error(
          "Unregistered standalone Chat scratch target already exists.",
        );
      }
      if (!entry) {
        await mkdir(location.target, { mode: 0o700 });
        await chmod(location.target, 0o700).catch((error: unknown) => {
          if (process.platform !== "win32") throw error;
        });
      }
      const canonicalTarget = await this.#canonicalTarget(location);
      records.set(rootId, {
        rootId,
        chatId,
        archivedAt: existing?.archivedAt ?? null,
        archiveExpiresAt: existing?.archiveExpiresAt ?? null,
      });
      await this.#persist(records);
      return standaloneChatScratchProvisionResultSchema.parse({
        status: "ready",
        jobId,
        attempt: input.attempt,
        rootId,
        chatId,
        path: canonicalTarget,
        displayPath: location.displayPath,
        reused: Boolean(entry),
      });
    });
  }

  async resolve(input: {
    rootId: string;
    chatId: string;
  }): Promise<StandaloneChatScratchResolveResult> {
    const rootId = canonicalIdentity(input.rootId, "Scratch root identity");
    const chatId = canonicalIdentity(input.chatId, "Chat identity");
    const records = await this.#load();
    this.#assertRecord(records, rootId, chatId);
    const location = await this.#verifiedLocation(chatId);
    return standaloneChatScratchResolveResultSchema.parse({
      rootId,
      chatId,
      path: await this.#canonicalTarget(location),
      displayPath: location.displayPath,
    });
  }

  async archive(input: {
    rootId: string;
    chatId: string;
    archivedAt: string;
    archiveExpiresAt: string;
  }): Promise<StandaloneChatScratchArchiveResult> {
    return this.#setArchive(input);
  }

  async restore(input: {
    rootId: string;
    chatId: string;
  }): Promise<StandaloneChatScratchArchiveResult> {
    return this.#setArchive({
      ...input,
      archivedAt: null,
      archiveExpiresAt: null,
    });
  }

  async delete(input: {
    jobId: string;
    attempt: number;
    rootId: string;
    chatId: string;
  }): Promise<StandaloneChatScratchDeleteResult> {
    return this.#mutate(async () => {
      const jobId = canonicalIdentity(input.jobId, "Scratch job identity");
      const rootId = canonicalIdentity(input.rootId, "Scratch root identity");
      const chatId = canonicalIdentity(input.chatId, "Chat identity");
      const records = await this.#load();
      const record = records.get(rootId);
      const location = await this.#verifiedLocation(chatId);
      const entry = await directoryEntry(location.target);
      if (!record) {
        if (entry) {
          throw new Error(
            "Refusing to delete an unregistered Chat scratch target.",
          );
        }
        return standaloneChatScratchDeleteResultSchema.parse({
          jobId,
          attempt: input.attempt,
          rootId,
          chatId,
          deleted: false,
        });
      }
      this.#assertRecord(records, rootId, chatId);
      if (entry) {
        await this.#canonicalTarget(location);
        await rm(location.target, { recursive: true, force: false });
      }
      records.delete(rootId);
      await this.#persist(records);
      return standaloneChatScratchDeleteResultSchema.parse({
        jobId,
        attempt: input.attempt,
        rootId,
        chatId,
        deleted: Boolean(entry),
      });
    });
  }

  async reconcile(
    targets: StandaloneChatScratchReconciliationTarget[],
    now = new Date(),
  ): Promise<StandaloneChatScratchReconciliationResult> {
    return this.#mutate(async () => {
      const records = await this.#load();
      const retainedRootIds: string[] = [];
      const missingRootIds: string[] = [];
      const dueRootIds: string[] = [];
      const authoritative = new Set<string>();
      for (const raw of targets) {
        const target =
          standaloneChatScratchReconciliationTargetSchema.parse(raw);
        authoritative.add(target.rootId);
        const record = records.get(target.rootId);
        if (!record || record.chatId !== target.chatId) {
          missingRootIds.push(target.rootId);
          continue;
        }
        const location = await this.#verifiedLocation(target.chatId);
        const entry = await directoryEntry(location.target);
        if (!entry) {
          missingRootIds.push(target.rootId);
          continue;
        }
        await this.#canonicalTarget(location);
        record.archivedAt = target.archivedAt;
        record.archiveExpiresAt = target.archiveExpiresAt;
        retainedRootIds.push(target.rootId);
        if (
          target.archiveExpiresAt &&
          Date.parse(target.archiveExpiresAt) <= now.getTime()
        ) {
          dueRootIds.push(target.rootId);
        }
      }
      await this.#persist(records);
      return standaloneChatScratchReconciliationResultSchema.parse({
        retainedRootIds: retainedRootIds.sort(),
        missingRootIds: missingRootIds.sort(),
        orphanedRootIds: [...records.keys()]
          .filter((rootId) => !authoritative.has(rootId))
          .sort(),
        dueRootIds: dueRootIds.sort(),
      });
    });
  }

  async #setArchive(input: {
    rootId: string;
    chatId: string;
    archivedAt: string | null;
    archiveExpiresAt: string | null;
  }): Promise<StandaloneChatScratchArchiveResult> {
    return this.#mutate(async () => {
      const parsed = standaloneChatScratchArchiveResultSchema.parse({
        rootId: canonicalIdentity(input.rootId, "Scratch root identity"),
        chatId: canonicalIdentity(input.chatId, "Chat identity"),
        archivedAt: input.archivedAt,
        archiveExpiresAt: input.archiveExpiresAt,
      });
      if (
        (parsed.archivedAt === null) !== (parsed.archiveExpiresAt === null) ||
        (parsed.archivedAt &&
          parsed.archiveExpiresAt &&
          Date.parse(parsed.archiveExpiresAt) <= Date.parse(parsed.archivedAt))
      ) {
        throw new Error("Standalone Chat archive deadline is invalid.");
      }
      const records = await this.#load();
      const record = this.#assertRecord(records, parsed.rootId, parsed.chatId);
      await this.#canonicalTarget(await this.#verifiedLocation(parsed.chatId));
      record.archivedAt = parsed.archivedAt;
      record.archiveExpiresAt = parsed.archiveExpiresAt;
      await this.#persist(records);
      return parsed;
    });
  }

  #assertRecord(
    records: Map<string, ScratchRecord>,
    rootId: string,
    chatId: string,
  ): ScratchRecord {
    const record = records.get(rootId);
    if (!record || record.chatId !== chatId) {
      throw new Error("Standalone Chat scratch identity is not registered.");
    }
    return record;
  }

  async #canonicalRoot(): Promise<string> {
    const root = path.resolve(this.#dataDirectory, "chat-scratch");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch((error: unknown) => {
      if (process.platform !== "win32") throw error;
    });
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Standalone Chat scratch root is not a safe directory.");
    }
    return realpath(root);
  }

  async #verifiedLocation(chatId: string): Promise<{
    canonicalRoot: string;
    displayPath: string;
    root: string;
    target: string;
  }> {
    const location = deriveChatScratchLocation(this.#dataDirectory, chatId);
    return { canonicalRoot: await this.#canonicalRoot(), ...location };
  }

  async #canonicalTarget(location: {
    canonicalRoot: string;
    target: string;
  }): Promise<string> {
    const entry = await lstat(location.target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        "Standalone Chat scratch target is not a safe directory.",
      );
    }
    const canonicalTarget = await realpath(location.target);
    if (path.dirname(canonicalTarget) !== location.canonicalRoot) {
      throw new Error(
        "Standalone Chat scratch target escaped its storage root.",
      );
    }
    return canonicalTarget;
  }

  async #load(): Promise<Map<string, ScratchRecord>> {
    if (this.#records) return this.#records;
    try {
      const registry = parseRegistry(
        JSON.parse(await readFile(this.#registryPath, "utf8")),
      );
      this.#records = new Map(
        registry.roots.map((record) => [record.rootId, { ...record }]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#records = new Map();
    }
    return this.#records;
  }

  async #persist(records: Map<string, ScratchRecord>): Promise<void> {
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#registryPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          version: 1,
          roots: [...records.values()].sort((left, right) =>
            left.rootId.localeCompare(right.rootId),
          ),
        } satisfies ScratchRegistryFile,
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#registryPath);
    await chmod(this.#registryPath, 0o600).catch((error: unknown) => {
      if (process.platform !== "win32") throw error;
    });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationQueue;
    let release!: () => void;
    this.#mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
