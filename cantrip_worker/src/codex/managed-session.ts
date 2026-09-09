import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  NativeReplacementSettings,
  PrepareManagedThreadOptions,
} from "./app-server.js";
import type { CodexRuntime } from "./runtime.js";

/** Authenticated routing identity, independent of a view or active turn. */
export interface ManagedSessionIdentity {
  serverId: string;
  ownerId: string;
  workerId: string;
  chatId: string;
  placementId: string;
  projectId: string | null;
  contextKind: "project" | "standalone";
}

const associationSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    identity: z.string().regex(/^[a-f0-9]{64}$/u),
    threadId: z.string().min(1),
    prepared: z.boolean().default(false),
    replacementOf: z.string().min(1).optional(),
  })
  .strict();

type Association = z.infer<typeof associationSchema>;

export interface ManagedSessionPreparation {
  identity: ManagedSessionIdentity;
  runtime: Pick<CodexRuntime, "prepareManagedThread">;
  configuration: Omit<PrepareManagedThreadOptions, "onThreadIdentified">;
  /** Read the actual source only when a replacement still needs configuration. */
  captureReplacementSettings?: () => Promise<NativeReplacementSettings>;
  /** The server can acknowledge its canonical association before attachment. */
  onThreadIdentified?: (threadId: string) => Promise<void>;
  /** Completes the canonical handoff after full preparation, while this chat remains serialized. */
  onPrepared?: (threadId: string) => Promise<void>;
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Serializes preparation, never model execution. The worker journal retains an
 * identified thread if later MCP/configuration or server persistence fails. It
 * is a recovery aid, not a replacement for the server's canonical chat routing.
 * No credentials, prompts, or full configuration are written to this journal.
 */
export class ManagedSessionCoordinator {
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly identified = new Map<string, Association>();

  constructor(private readonly directory: string) {}

  prepare(input: ManagedSessionPreparation): Promise<{ threadId: string }> {
    return this.enqueue(input);
  }

  /** Explicit recovery from a rejected native thread, without submitting model input. */
  replace(
    input: ManagedSessionPreparation,
    expectedThreadId: string,
  ): Promise<{ threadId: string }> {
    if (!expectedThreadId)
      return Promise.reject(
        new Error(
          "A replacement requires the previous native thread identity.",
        ),
      );
    return this.enqueue(input, expectedThreadId);
  }

  private enqueue(
    input: ManagedSessionPreparation,
    replacementOf?: string,
  ): Promise<{ threadId: string }> {
    const key = digest([
      input.identity.serverId,
      input.identity.ownerId,
      input.identity.workerId,
      input.identity.chatId,
    ]);
    const preceding = this.preparations.get(key) ?? Promise.resolve();
    const result = preceding.then(() =>
      this.prepareSerialized(key, input, replacementOf),
    );
    const settled = result.then(
      () => {},
      () => {},
    );
    this.preparations.set(key, settled);
    void settled.then(() => {
      if (this.preparations.get(key) === settled) this.preparations.delete(key);
    });
    return result;
  }

  private async prepareSerialized(
    key: string,
    input: ManagedSessionPreparation,
    replacementOf?: string,
  ): Promise<{ threadId: string }> {
    const { configuration, identity } = input;
    const { provider } = configuration;
    const associationScope = [
      identity.placementId,
      identity.projectId,
      identity.contextKind,
      configuration.cwd,
      configuration.executionProfile,
    ];
    const providerScope = [
      provider.id,
      provider.kind,
      provider.accountId ?? null,
      provider.credentialHomeKey ?? null,
    ];
    const fingerprint = digest([...associationScope, ...providerScope]);
    const previous = this.identified.get(key) ?? (await this.read(key));
    // Migrate an old journal only when its complete old route/account scope is
    // known. A canonical server thread remains authoritative on either version.
    const matchesPrevious =
      previous?.identity ===
      (previous?.version === 1
        ? digest([
            ...associationScope,
            configuration.model.routeId,
            ...providerScope,
          ])
        : fingerprint);
    let threadId =
      configuration.threadId ?? (matchesPrevious ? previous.threadId : null);
    if (replacementOf) {
      const matches = matchesPrevious;
      const resumingReplacement =
        matches && previous.replacementOf === replacementOf;
      if (
        (configuration.threadId &&
          configuration.threadId !== replacementOf &&
          !(
            resumingReplacement && configuration.threadId === previous.threadId
          )) ||
        (previous &&
          (!matches ||
            (previous.threadId !== replacementOf && !resumingReplacement))) ||
        (!previous && configuration.threadId !== replacementOf)
      )
        throw new Error(
          "The managed thread association changed before replacement.",
        );
      threadId = resumingReplacement ? previous.threadId : null;
    }
    const retainedReplacement =
      replacementOf ??
      (matchesPrevious && previous.threadId === threadId
        ? previous.replacementOf
        : undefined);
    const recoveringIncomplete =
      !configuration.threadId && matchesPrevious && !previous.prepared;
    const intent = replacementOf
      ? threadId && previous?.prepared
        ? "preserve"
        : "configure"
      : threadId && !recoveringIncomplete
        ? configuration.intent
        : "configure";
    // A prepared replacement may already have console-selected settings of its
    // own. Retrying only its handoff must neither read the old Core nor restore
    // an older capture. An incomplete replacement captures the live source anew.
    const replacementSettings =
      replacementOf && intent === "configure"
        ? input.captureReplacementSettings
          ? await input.captureReplacementSettings()
          : configuration.replacementSettings
        : undefined;
    const result = await input.runtime.prepareManagedThread({
      ...configuration,
      ...(replacementOf ? { replacementSettings } : {}),
      threadId,
      // An unbound session needs complete configuration even when the caller
      // arrived by opening a view. Subsequent view attachment preserves it.
      intent,
      onThreadIdentified: async (identifiedThreadId) => {
        if (replacementOf && identifiedThreadId === replacementOf)
          throw new Error(
            "Native replacement returned the rejected thread identity.",
          );
        const association: Association = {
          version: 2,
          identity: fingerprint,
          threadId: identifiedThreadId,
          ...(retainedReplacement
            ? { replacementOf: retainedReplacement }
            : {}),
          prepared:
            intent === "preserve" &&
            previous?.threadId === identifiedThreadId &&
            previous.prepared,
        };
        // Retain the actual identity even when the durable write itself fails;
        // a retry in this process must not create another native conversation.
        this.identified.set(key, association);
        await this.write(key, association);
        await input.onThreadIdentified?.(identifiedThreadId);
      },
    });
    const completed: Association = {
      version: 2,
      identity: fingerprint,
      threadId: result.threadId,
      prepared: true,
      ...(retainedReplacement ? { replacementOf: retainedReplacement } : {}),
    };
    this.identified.set(key, completed);
    await this.write(key, completed);
    await input.onPrepared?.(result.threadId);
    return result;
  }

  private async read(key: string): Promise<Association | null> {
    let content: string;
    try {
      content = await readFile(
        path.join(this.directory, `${key}.json`),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return associationSchema.parse(JSON.parse(content));
  }

  private async write(key: string, association: Association): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${key}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(association), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
