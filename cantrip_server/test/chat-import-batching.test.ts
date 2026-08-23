import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  externalChatTranscriptSchema,
  unprobedCodexRuntimeReport,
  type ChatMessageCreate,
  type ChatMessageOpaqueContent,
  type ExternalChatTranscript,
} from "@cantrip/protocol";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  CHAT_IMPORT_INSERT_BATCH_SIZE,
  ChatImportJobRepository,
  chatImportAttachmentId,
  type ImportedChatAttachment,
} from "../src/db/chat-import-jobs.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedAttachmentMetadataFixture } from "./protected-attachment-fixture.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const workerId = "chat-import-batch-worker";

interface ImportHarness {
  client: PGlite;
  database: ReturnType<typeof drizzle<typeof schema>>;
  importJobs: ChatImportJobRepository;
  projectId: string;
  projectReplicaId: string;
  repository: ServerRepository;
  statements: string[];
  worktreeId: string;
  worktreePath: string;
}

interface PreparedImport {
  commandId: string;
  importedAttachments: ImportedChatAttachment[];
  jobId: string;
  transcript: ExternalChatTranscript;
  attempt: number;
}

async function createHarness(
  insertBatchSize = CHAT_IMPORT_INSERT_BATCH_SIZE,
): Promise<ImportHarness> {
  const client = new PGlite();
  const statements: string[] = [];
  const database = drizzle(client, {
    schema,
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 17) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.policies.ensureOwnerState(LOCAL_USER_ID);
  await repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name: "Chat import batch worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.149.0",
    codexRuntime: unprobedCodexRuntimeReport,
    externalCodexHistory: true,
    startedAt: "2026-08-15T00:00:00.000Z",
  });
  const project = await repository.createGithubProject(LOCAL_USER_ID, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "chat-import-batching",
    repositoryId: "chat-import-batching",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  const worktreePath = `/tmp/${project.id}/Cantrip`;
  await repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    workerId,
    {
      path: worktreePath,
      displayPath: worktreePath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const worktree = (
    await repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
  )[0]!;
  return {
    client,
    database,
    importJobs: new ChatImportJobRepository(database, insertBatchSize),
    projectId: project.id,
    projectReplicaId: worktree.projectSourceId,
    repository,
    statements,
    worktreeId: worktree.id,
    worktreePath,
  };
}

function protectImportedMessages(
  messages: Array<ChatMessageCreate & { id: string; idempotencyKey: string }>,
  duplicateAt: number | null = null,
): ChatMessageOpaqueContent[] {
  return messages.map((message, index) => ({
    id:
      duplicateAt !== null && index === duplicateAt
        ? messages[0]!.id
        : message.id,
    classification: {
      role: message.role,
      mode: message.mode ?? "default",
      attachmentIds: message.content.flatMap((item) =>
        item.type === "attachment" ? [item.attachment.id] : [],
      ),
    },
    protectedContent: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: Buffer.from(
          `opaque:${message.id}`.padEnd(32, "x"),
        ).toString("base64url"),
      },
    },
    reasoningEffort: message.reasoningEffort ?? null,
    idempotencyKey: message.idempotencyKey,
  }));
}

async function prepareImport(
  harness: ImportHarness,
  label: string,
  messageCount: number,
  attachmentCount: number,
): Promise<PreparedImport> {
  const sourceId = "a".repeat(64);
  const sourceThreadId = `batch-${label}`;
  const created = await harness.importJobs.create(
    LOCAL_USER_ID,
    harness.projectId,
    {
      sourceKind: "chatgpt-codex",
      sourceWorkerId: workerId,
      sourceId,
      sourceThreadId,
      targetPlacement: {
        projectId: harness.projectId,
        workerId,
        projectReplicaId: harness.projectReplicaId,
        worktreeId: harness.worktreeId,
        surface: null,
      },
      modelId: null,
      modelRouteId: null,
      providerAccountId: null,
      permissionProfileId: null,
      planMode: "default",
      idempotencyKey: `batch-${label}`,
    },
  );
  const claimed = await harness.importJobs.claimNext();
  expect(claimed?.job.id).toBe(created.id);
  const importing = await harness.importJobs.markImporting(
    created.id,
    claimed!.commandId,
    claimed!.job.attempt,
  );
  const attachments = Array.from({ length: attachmentCount }, (_, index) => {
    const sourceAttachmentId = index.toString(16).padStart(64, "0");
    const id = chatImportAttachmentId(created.id, sourceAttachmentId);
    return {
      id,
      sourceAttachmentId,
      itemId: `item-${index}`,
      sizeBytes: index % 2 === 0 ? index + 1 : 0,
      status: index % 2 === 0 ? ("available" as const) : ("missing" as const),
      protectedMetadata: protectedAttachmentMetadataFixture(`batch-${index}`),
    };
  });
  const transcript = externalChatTranscriptSchema.parse({
    sourceId,
    sourceThreadId,
    titleProtection: protectedChatFields(created.id).titleProtection,
    metadata: {
      sourceThreadId,
      preview: `Import ${messageCount} messages`,
      cwd: harness.worktreePath,
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:00.000Z",
      source: "vscode",
      status: "not-loaded",
      modelProvider: "openai",
      cliVersion: "0.149.0",
      git: null,
      match: {
        kind: "worktree-path",
        projectReplicaId: harness.projectReplicaId,
        worktreeId: harness.worktreeId,
      },
    },
    sync: {
      threadId: sourceThreadId,
      status: "idle",
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1_786_800_000,
          completedAt: 1_786_800_010,
          durationMs: 10_000,
          items: Array.from({ length: messageCount }, (_, index) => ({
            type: "userMessage" as const,
            id: `item-${index}`,
            text: `Imported message ${index}`,
            externalAttachmentIds:
              index < attachments.length ? [attachments[index]!.id] : [],
          })),
        },
      ],
    },
    attachments,
  });
  return {
    attempt: importing.attempt,
    commandId: claimed!.commandId,
    importedAttachments: transcript.attachments.map((descriptor) => ({
      descriptor,
      id: descriptor.id,
    })),
    jobId: created.id,
    transcript,
  };
}

async function completeImport(
  harness: ImportHarness,
  prepared: PreparedImport,
  duplicateAt: number | null = null,
) {
  return harness.importJobs.completeCanonicalImport(
    prepared.jobId,
    prepared.commandId,
    prepared.attempt,
    prepared.transcript,
    prepared.importedAttachments,
    async (messages) => protectImportedMessages(messages, duplicateAt),
  );
}

function statementsFor(statements: readonly string[], table: string) {
  return statements.filter((query) =>
    query.startsWith(`insert into "${table}"`),
  );
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

async function walBytes(client: PGlite): Promise<number | null> {
  try {
    const result = await client.query<{ bytes: string }>(
      "select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text as bytes",
    );
    return Number(result.rows[0]?.bytes ?? 0);
  } catch {
    return null;
  }
}

describe.sequential("chat import batching", () => {
  it("chunks messages and bulk-inserts attachments and replicas", async () => {
    const harness = await createHarness();
    try {
      const prepared = await prepareImport(harness, "query-count", 1_001, 20);
      harness.statements.length = 0;
      const completed = await completeImport(harness, prepared);
      expect(completed).toMatchObject({
        attachmentCount: 20,
        attachmentWarningCount: 10,
        state: "awaiting-hydration",
      });

      expect(
        statementsFor(harness.statements, "chat_attachments"),
      ).toHaveLength(1);
      expect(
        statementsFor(harness.statements, "chat_attachment_replicas"),
      ).toHaveLength(1);
      expect(statementsFor(harness.statements, "chat_messages")).toHaveLength(
        3,
      );

      const messages = await harness.database
        .select({ idempotencyKey: schema.chatMessages.idempotencyKey })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, prepared.jobId))
        .orderBy(asc(schema.chatMessages.sequence));
      expect(messages).toHaveLength(1_001);
      expect(messages[0]?.idempotencyKey).toBe("codex-import:turn:item-0");
      expect(messages.at(-1)?.idempotencyKey).toBe(
        "codex-import:turn:item-1000",
      );
    } finally {
      await harness.client.close();
    }
  }, 30_000);

  it("rolls back earlier chunks when a later chunk fails", async () => {
    const harness = await createHarness();
    try {
      const prepared = await prepareImport(harness, "rollback", 501, 2);
      await expect(completeImport(harness, prepared, 500)).rejects.toThrow();

      expect(
        await harness.database
          .select({ id: schema.chats.id })
          .from(schema.chats)
          .where(eq(schema.chats.id, prepared.jobId)),
      ).toEqual([]);
      expect(
        await harness.database
          .select({ id: schema.chatMessages.id })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, prepared.jobId)),
      ).toEqual([]);
      expect(
        await harness.database
          .select({ id: schema.chatAttachments.id })
          .from(schema.chatAttachments)
          .where(eq(schema.chatAttachments.chatId, prepared.jobId)),
      ).toEqual([]);
      expect(
        await harness.importJobs.get(LOCAL_USER_ID, prepared.jobId),
      ).toMatchObject({ chatId: null, state: "importing" });
    } finally {
      await harness.client.close();
    }
  }, 30_000);

  it.skipIf(process.env.CANTRIP_BENCHMARK_CHAT_IMPORTS !== "1")(
    "benchmarks 100, 1K, and 10K-message imports",
    async () => {
      const counts = [100, 1_000, 10_000];
      const iterations = 5;
      const metrics: Array<Record<string, number | string | null>> = [];
      for (const strategy of [
        { batchSize: 1, name: "row-at-a-time" },
        { batchSize: CHAT_IMPORT_INSERT_BATCH_SIZE, name: "chunked" },
      ]) {
        const harness = await createHarness(strategy.batchSize);
        try {
          const preparedByCount = new Map<number, PreparedImport[]>();
          for (const count of counts) {
            const preparedImports: PreparedImport[] = [];
            for (let iteration = 0; iteration < iterations; iteration += 1) {
              preparedImports.push(
                await prepareImport(
                  harness,
                  `benchmark-${strategy.name}-${count}-${iteration}`,
                  count,
                  20,
                ),
              );
            }
            preparedByCount.set(count, preparedImports);
          }
          for (const count of counts) {
            const durations: number[] = [];
            const heapDeltas: number[] = [];
            const walDeltas: number[] = [];
            let attachmentInsertQueries = 0;
            let messageInsertQueries = 0;
            let replicaInsertQueries = 0;
            let statementCount = 0;
            for (const prepared of preparedByCount.get(count)!) {
              harness.statements.length = 0;
              const heapBefore = process.memoryUsage().heapUsed;
              const walBefore = await walBytes(harness.client);
              const startedAt = performance.now();
              await completeImport(harness, prepared);
              durations.push(performance.now() - startedAt);
              heapDeltas.push(process.memoryUsage().heapUsed - heapBefore);
              const walAfter = await walBytes(harness.client);
              if (walBefore !== null && walAfter !== null) {
                walDeltas.push(walAfter - walBefore);
              }
              const completeStatements = [...harness.statements];
              attachmentInsertQueries = statementsFor(
                completeStatements,
                "chat_attachments",
              ).length;
              messageInsertQueries = statementsFor(
                completeStatements,
                "chat_messages",
              ).length;
              replicaInsertQueries = statementsFor(
                completeStatements,
                "chat_attachment_replicas",
              ).length;
              statementCount = completeStatements.length;
              const [rows, attachments, replicas] = await Promise.all([
                harness.database
                  .select({ id: schema.chatMessages.id })
                  .from(schema.chatMessages)
                  .where(eq(schema.chatMessages.chatId, prepared.jobId)),
                harness.database
                  .select({ id: schema.chatAttachments.id })
                  .from(schema.chatAttachments)
                  .where(eq(schema.chatAttachments.chatId, prepared.jobId)),
                harness.database
                  .select({ id: schema.chatAttachmentReplicas.attachmentId })
                  .from(schema.chatAttachmentReplicas)
                  .innerJoin(
                    schema.chatAttachments,
                    eq(
                      schema.chatAttachments.id,
                      schema.chatAttachmentReplicas.attachmentId,
                    ),
                  )
                  .where(eq(schema.chatAttachments.chatId, prepared.jobId)),
              ]);
              expect(rows).toHaveLength(count);
              expect(attachments).toHaveLength(20);
              expect(replicas).toHaveLength(10);
            }
            metrics.push({
              attachmentInsertQueries,
              batchSize: strategy.batchSize,
              heapDeltaMedianBytes: percentile(heapDeltas, 0.5),
              messageCount: count,
              messageInsertQueries,
              p50Ms: percentile(durations, 0.5),
              p95Ms: percentile(durations, 0.95),
              replicaInsertQueries,
              statementCount,
              strategy: strategy.name,
              walBytesMedian:
                walDeltas.length === 0 ? null : percentile(walDeltas, 0.5),
            });
          }
        } finally {
          await harness.client.close();
        }
      }
      console.info("Chat import benchmark metrics", { iterations, metrics });
    },
    180_000,
  );
});
