import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { WorkspaceCommandError, type WorkspaceAction } from "@cantrip/protocol";
import type { RepositoryTransaction } from "./repository/database.js";
import * as schema from "./schema.js";

/** The client resolves encrypted paths, but cannot grant project/worker access
 * or migrate a stale mutable Explorer snapshot. Hold actual authority records
 * until the ownership mutation and its operation receipt commit. */
export async function validateWorkspaceDocumentMigration(
  tx: RepositoryTransaction,
  ownerId: string,
  projectId: string,
  action: Extract<
    WorkspaceAction,
    { type: "migrate-explorer-file" | "migrate-code-files" }
  >,
) {
  const [source] =
    action.type === "migrate-code-files"
      ? await tx
          .select()
          .from(schema.codeTabs)
          .where(
            and(
              eq(schema.codeTabs.id, action.codeId),
              eq(schema.codeTabs.projectId, projectId),
            ),
          )
          .for("share")
      : await tx
          .select()
          .from(schema.explorers)
          .where(
            and(
              eq(schema.explorers.id, action.explorerId),
              eq(schema.explorers.projectId, projectId),
            ),
          )
          .for("share");
  if (!source)
    throw new WorkspaceCommandError(
      "missing",
      "Legacy editor is unavailable in this project.",
    );
  if (
    source.activeWorkerId !== action.expectedWorkerId ||
    source.worktreeId !== action.expectedWorktreeId ||
    (action.type === "migrate-explorer-file" &&
      !(
        "protectedState" in source &&
        isDeepStrictEqual(source.protectedState, action.expectedStateProtection)
      ))
  )
    throw new WorkspaceCommandError(
      "invalid",
      "Legacy editor binding changed before migration.",
    );

  const ids =
    action.type === "migrate-code-files"
      ? action.views.map((view) => view.documentId)
      : [
          action.documentId,
          ...action.retainedViews.map((view) => view.documentId),
        ];
  const documents = await tx
    .select({
      id: schema.fileDocuments.id,
      workerId: schema.fileDocuments.workerId,
      worktreeId: schema.fileDocuments.worktreeId,
    })
    .from(schema.fileDocuments)
    .innerJoin(
      schema.projectWorktrees,
      and(
        eq(schema.projectWorktrees.id, schema.fileDocuments.worktreeId),
        eq(schema.projectWorktrees.workerId, schema.fileDocuments.workerId),
        eq(schema.projectWorktrees.lifecycleState, "ready"),
      ),
    )
    .innerJoin(
      schema.projectSources,
      and(
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
        eq(schema.projectSources.projectId, projectId),
        isNull(schema.projectSources.removedAt),
      ),
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
        eq(schema.fileDocuments.projectId, projectId),
        inArray(schema.fileDocuments.id, ids),
      ),
    )
    .for("share");
  if (documents.length !== ids.length)
    throw new WorkspaceCommandError(
      "missing",
      "Migration document is unavailable in this project.",
    );
  if (action.type === "migrate-code-files") return;
  const selected = documents.find(
    (document) => document.id === action.documentId,
  )!;
  if (
    selected.workerId !== source.activeWorkerId ||
    selected.worktreeId !== source.worktreeId
  )
    throw new WorkspaceCommandError(
      "invalid",
      "Migration document does not match the Explorer worktree.",
    );
}
