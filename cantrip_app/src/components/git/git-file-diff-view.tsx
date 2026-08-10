import type { GitFileDiff } from "@cantrip/protocol";

import { GitPartialPatchView } from "./git-partial-patch-view";

export function GitFileDiffView({
  diff,
  error,
  loading,
  onClose,
  path,
  projectId,
  scope,
  worktreeId,
}: {
  diff: GitFileDiff | undefined;
  error: unknown;
  loading: boolean;
  onClose(): void;
  path: string;
  projectId: string;
  scope: "unstaged" | "staged";
  worktreeId: string;
}) {
  return (
    <GitPartialPatchView
      diff={diff}
      error={error}
      loading={loading}
      onClose={onClose}
      path={path}
      projectId={projectId}
      scope={scope}
      worktreeId={worktreeId}
    />
  );
}
