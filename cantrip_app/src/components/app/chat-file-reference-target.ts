import type { ProjectSummary, ProjectWorktreeSummary } from "@cantrip/protocol";

import { projectFilePath } from "@/components/chat/markdown-file-link";

interface ChatFileReferenceTarget {
  path: string;
  worktreeId: string;
}

export async function resolveChatFileReferenceTarget({
  reference,
  projectId,
  activeWorktreeId,
  messageWorktreeId,
  source,
  worktrees,
  refreshWorktrees,
}: {
  reference: string;
  projectId: string;
  activeWorktreeId: string;
  messageWorktreeId?: string | null;
  source: ProjectSummary["source"];
  worktrees: readonly ProjectWorktreeSummary[];
  refreshWorktrees(): Promise<readonly ProjectWorktreeSummary[]>;
}): Promise<ChatFileReferenceTarget | null> {
  const preferredWorktreeId = messageWorktreeId ?? activeWorktreeId;
  const relative = projectFilePath(reference, null);
  if (relative) {
    // The worker validates the recorded checkout ID, including removed checkouts.
    // Never silently redirect a historical message to the chat's current lane.
    return { path: relative, worktreeId: preferredWorktreeId };
  }

  const match = (
    candidates: readonly ProjectWorktreeSummary[],
  ): ChatFileReferenceTarget | null => {
    const matches = candidates
      .filter((worktree) => worktree.projectId === projectId)
      .flatMap((worktree) => {
        const roots = [worktree.path, worktree.displayPath];
        if (
          source &&
          worktree.isPrimary &&
          worktree.projectSourceId === source.id &&
          worktree.workerId === source.workerId
        ) {
          roots.push(source.path, source.displayPath);
        }
        return roots.flatMap((root) => {
          if (!root || root === "Protected path unavailable") return [];
          const path = projectFilePath(reference, root);
          return path
            ? [
                {
                  path,
                  worktreeId: worktree.id,
                  rootLength: root.replaceAll("\\", "/").replace(/\/+$/, "")
                    .length,
                },
              ]
            : [];
        });
      })
      .sort((left, right) => right.rootLength - left.rootLength);
    const mostSpecific = matches.filter(
      (candidate) => candidate.rootLength === matches[0]?.rootLength,
    );
    const preferred =
      mostSpecific.find(
        (candidate) => candidate.worktreeId === preferredWorktreeId,
      ) ??
      mostSpecific.find(
        (candidate) => candidate.worktreeId === activeWorktreeId,
      );
    const selected =
      preferred ??
      (new Set(mostSpecific.map((candidate) => candidate.worktreeId)).size === 1
        ? mostSpecific[0]
        : null);
    return selected
      ? { path: selected.path, worktreeId: selected.worktreeId }
      : null;
  };

  // Paths may be protected, stale, or absent from the chat's cached inventory.
  // Hydrate all registered checkouts, not just the currently active checkout.
  return match(worktrees) ?? match(await refreshWorktrees());
}
