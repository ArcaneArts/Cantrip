import type {
  WorktreeStatusResult,
  ProjectWorktreeCreate,
} from "@cantrip/protocol";
import {
  projectWorktreeSummarySchema,
  projectWorktreeCreateSchema,
} from "@cantrip/protocol";
import { CantripApiError, post, request } from "@/lib/api-client";
import { getProjectWorktreeWireList } from "./projects";
import { getWorkers } from "./worker-wire";
import {
  resolveWorkerRepositoryMetadata,
  registerWorkerRepositoryMetadata,
} from "./repository-identity";
import { getProtectedWorktreeStatus } from "./repository-operations";

export async function getProjectWorktrees(
  projectId: string,
  options: {
    onStatus?: (worktreeId: string, status: WorktreeStatusResult) => void;
  } = {},
) {
  const worktrees = await getProjectWorktreeWireList(projectId);
  const workers = await getWorkers();
  return Promise.all(
    worktrees.map(async (worktree) => {
      if (worktree.lifecycleState !== "ready") {
        return {
          ...worktree,
          name: worktree.isPrimary ? "Primary" : "Protected worktree",
          path: "Protected path unavailable",
          displayPath: "Protected path unavailable",
          branch: null,
          lockReason: null,
        };
      }
      try {
        if (worktree.rootKind === "folder-root") {
          const resolved = await resolveWorkerRepositoryMetadata({
            workerId: worktree.workerId,
            scopeId: projectId,
            values: { path: worktree.path, displayPath: worktree.displayPath },
          });
          if (
            typeof resolved.values.path !== "string" ||
            typeof resolved.values.displayPath !== "string"
          ) {
            throw new Error("The folder root metadata is unavailable.");
          }
          return projectWorktreeSummarySchema.parse({
            ...worktree,
            name: worktree.isPrimary ? "Primary" : "Folder",
            path: resolved.values.path,
            displayPath: resolved.values.displayPath,
          });
        }
        const status = await getProtectedWorktreeStatus({
          projectId,
          worktreeId: worktree.id,
          target: {
            worktree,
            worker: workers.find(
              ({ workerId }) => workerId === worktree.workerId,
            ),
          },
        });
        options.onStatus?.(worktree.id, status);
        const privateState = status.worktree;
        const pathSegments = privateState.path.split(/[\\/]/u).filter(Boolean);
        return projectWorktreeSummarySchema.parse({
          ...worktree,
          name: worktree.isPrimary
            ? "Primary"
            : (pathSegments.at(-1) ?? "Worktree"),
          path: privateState.path,
          displayPath: privateState.path,
          branch: privateState.branch,
          head: privateState.head,
          detached: privateState.detached,
          locked: privateState.locked,
          lockReason: privateState.lockReason,
        });
      } catch {
        return projectWorktreeSummarySchema.parse({
          ...worktree,
          name: worktree.isPrimary ? "Primary" : "Protected worktree",
          path: "Protected path unavailable",
          displayPath: "Protected path unavailable",
          branch: null,
          lockReason: null,
        });
      }
    }),
  );
}

export async function getProjectWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return getProtectedWorktreeStatus({
    projectId,
    worktreeId,
  });
}

export async function createProjectWorktree(
  projectId: string,
  input: ProjectWorktreeCreate,
) {
  const parsed = projectWorktreeCreateSchema.parse(input);
  const worktrees = await getProjectWorktreeWireList(projectId);
  const workerId =
    worktrees.find(({ id }) => id === parsed.sourceWorktreeId)?.workerId ??
    worktrees.find(({ isPrimary }) => isPrimary)?.workerId ??
    worktrees.find(({ isDefault }) => isDefault)?.workerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: {
      name: parsed.name,
      ...(parsed.mode.type === "detached"
        ? { revision: parsed.mode.revision }
        : {
            branch: parsed.mode.branch,
            ...(parsed.mode.type === "newBranch" && parsed.mode.startPoint
              ? { startPoint: parsed.mode.startPoint }
              : {}),
          }),
    },
  });
  const protectedInput = projectWorktreeCreateSchema.parse({
    name: protectedValues.values.name,
    sourceWorktreeId: parsed.sourceWorktreeId,
    mode:
      parsed.mode.type === "detached"
        ? {
            type: "detached",
            revision: protectedValues.values.revision,
          }
        : parsed.mode.type === "existingBranch"
          ? {
              type: "existingBranch",
              branch: protectedValues.values.branch,
            }
          : {
              type: "newBranch",
              branch: protectedValues.values.branch,
              startPoint: parsed.mode.startPoint
                ? protectedValues.values.startPoint
                : null,
            },
  });
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
      protectedInput,
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    projectWorktreeSummarySchema.parse({
      ...wire,
      name: "Protected worktree",
      path: "Protected path unavailable",
      displayPath: "Protected path unavailable",
      branch: null,
      lockReason: null,
    })
  );
}

export async function reconcileProjectWorktrees(projectId: string) {
  await post(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees/reconcile`,
    {},
  );
  return getProjectWorktrees(projectId);
}

export async function lockProjectWorktree(
  projectId: string,
  worktreeId: string,
  reason: string | null,
) {
  const worktree = (await getProjectWorktreeWireList(projectId)).find(
    ({ id }) => id === worktreeId,
  );
  if (!worktree) throw new CantripApiError("Worktree not found.", 404);
  const protectedReason = reason
    ? await registerWorkerRepositoryMetadata({
        workerId: worktree.workerId,
        scopeId: projectId,
        values: { lockReason: reason },
      })
    : null;
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/lock`,
      { reason: protectedReason?.values.lockReason ?? null },
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    wire
  );
}

export async function unlockProjectWorktree(
  projectId: string,
  worktreeId: string,
) {
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/unlock`,
      {},
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    wire
  );
}

export async function pruneProjectWorktrees(
  projectId: string,
  allowExternal: boolean,
) {
  await post(`/api/projects/${encodeURIComponent(projectId)}/worktrees/prune`, {
    allowExternal,
  });
  return getProjectWorktrees(projectId);
}

export async function removeProjectWorktree(
  projectId: string,
  worktreeId: string,
  input: { allowExternal: boolean; force: boolean },
) {
  const wire = projectWorktreeSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "DELETE", body: JSON.stringify(input) },
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    projectWorktreeSummarySchema.parse({
      ...wire,
      name: "Protected worktree",
      path: "Protected path unavailable",
      displayPath: "Protected path unavailable",
      branch: null,
      lockReason: null,
    })
  );
}
