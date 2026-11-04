import { isDeepStrictEqual } from "node:util";
import {
  fileDocumentCreateSchema,
  fileDocumentWireSummarySchema,
  type FileDocumentCreate,
  type FileDocumentWireSummary,
} from "@cantrip/protocol";
import { and, asc, eq, isNull, isNotNull, or } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsFileRepository } from "./cantrip-os-files.js";
import { CantripOsChatRepository } from "./cantrip-os-chats.js";

export class FileDocumentConflictError extends Error {}

function summary(row: typeof schema.fileDocuments.$inferSelect) {
  return fileDocumentWireSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    workerId: row.workerId,
    worktreeId: row.worktreeId,
    ...(row.cantripOsBindingId
      ? {
          cantripOsBindingId: row.cantripOsBindingId,
          cantripOsRuntimeGeneration: row.osRuntimeGeneration!,
        }
      : {}),
    stateProtection: row.protectedState,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Immutable document locations; placement and editor state live elsewhere. */
export class FileDocumentRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async list(
    ownerId: string,
    projectId: string,
  ): Promise<FileDocumentWireSummary[]> {
    const rows = await this.database
      .select({ document: schema.fileDocuments })
      .from(schema.fileDocuments)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.fileDocuments.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.fileDocuments.projectId, projectId))
      .orderBy(
        asc(schema.fileDocuments.createdAt),
        asc(schema.fileDocuments.id),
      );
    return rows.map(({ document }) => summary(document));
  }

  async get(
    ownerId: string,
    id: string,
  ): Promise<FileDocumentWireSummary | null> {
    const rows = await this.database
      .select({ document: schema.fileDocuments })
      .from(schema.fileDocuments)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.fileDocuments.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.fileDocuments.id, id));
    return rows[0] ? summary(rows[0].document) : null;
  }

  async create(ownerId: string, projectId: string, input: FileDocumentCreate) {
    const parsed = fileDocumentCreateSchema.parse(input);
    return this.database.transaction(async (transaction) => {
      // Lock the actual authority records until insertion completes; a removed
      // source or concurrent checkout mutation cannot invalidate this binding.
      const osTarget = parsed.cantripOsBindingId
        ? await new CantripOsChatRepository(
            transaction as RepositoryDatabase,
          ).select(ownerId, projectId, parsed.cantripOsBindingId)
        : null;
      if (osTarget && osTarget.worktree.id !== parsed.worktreeId)
        throw new FileDocumentConflictError("File source and worktree differ.");
      const osCapture = parsed.cantripOsBindingId
        ? await new CantripOsFileRepository(
            transaction as RepositoryDatabase,
          ).capture(
            ownerId,
            projectId,
            parsed.worktreeId,
            parsed.cantripOsBindingId,
            parsed.cantripOsRuntimeGeneration,
          )
        : {};
      const targets = osTarget
        ? [{ workerId: osTarget.workerId }]
        : await transaction
            .select({ workerId: schema.projectWorktrees.workerId })
            .from(schema.projectWorktrees)
            .innerJoin(
              schema.projectSources,
              eq(
                schema.projectSources.id,
                schema.projectWorktrees.projectSourceId,
              ),
            )
            .innerJoin(
              schema.projects,
              eq(schema.projects.id, schema.projectSources.projectId),
            )
            .innerJoin(
              schema.workers,
              eq(schema.workers.id, schema.projectWorktrees.workerId),
            )
            .where(
              and(
                eq(schema.projects.ownerId, ownerId),
                eq(schema.workers.ownerId, ownerId),
                isNull(schema.workers.unlinkedAt),
                eq(schema.projects.id, projectId),
                eq(schema.projectWorktrees.id, parsed.worktreeId),
                eq(schema.projectWorktrees.lifecycleState, "ready"),
                isNull(schema.projectSources.removedAt),
              ),
            )
            .for("update");
      const target = targets[0];
      if (!target) return null;
      const inserted = await transaction
        .insert(schema.fileDocuments)
        .values({
          ...osCapture,
          id: parsed.id,
          projectId,
          workerId: target.workerId,
          worktreeId: parsed.worktreeId,
          protectedState: parsed.stateProtection,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return summary(inserted[0]);

      // Exact retries are idempotent. Reusing an ID must never relocate a
      // document or expose a document belonging to another project/account.
      const existing = await transaction
        .select()
        .from(schema.fileDocuments)
        .where(
          and(
            eq(schema.fileDocuments.id, parsed.id),
            eq(schema.fileDocuments.projectId, projectId),
          ),
        );
      const row = existing[0];
      if (
        !row ||
        row.cantripOsBindingId !== (parsed.cantripOsBindingId ?? null) ||
        row.osRuntimeGeneration !==
          (parsed.cantripOsRuntimeGeneration ?? null) ||
        row.workerId !== target.workerId ||
        row.worktreeId !== parsed.worktreeId ||
        !isDeepStrictEqual(row.protectedState, parsed.stateProtection)
      ) {
        throw new FileDocumentConflictError(
          "File document identity already exists with a different binding.",
        );
      }
      return summary(row);
    });
  }

  async executionContext(ownerId: string, id: string) {
    const rows = await this.database
      .select({
        document: schema.fileDocuments,
        worktree: schema.projectWorktrees,
      })
      .from(schema.fileDocuments)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.fileDocuments.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.fileDocuments.worktreeId),
          eq(schema.projectWorktrees.workerId, schema.fileDocuments.workerId),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
        ),
      )
      .innerJoin(
        schema.projectSourceIdentities,
        and(
          eq(
            schema.projectSourceIdentities.id,
            schema.projectWorktrees.projectSourceId,
          ),
          eq(
            schema.projectSourceIdentities.projectId,
            schema.fileDocuments.projectId,
          ),
        ),
      )
      .leftJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.fileDocuments.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.fileDocuments.id, id),
          or(
            eq(schema.projectWorktrees.locationKind, "cantrip-os"),
            and(
              isNotNull(schema.projectSources.id),
              isNull(schema.projectSources.removedAt),
            ),
          ),
        ),
      );
    const row = rows[0];
    return row
      ? {
          ...summary(row.document),
          root: await new CantripOsFileRepository(this.database).root(
            ownerId,
            row.document.projectId,
            row.worktree,
            row.document,
          ),
        }
      : null;
  }
}
