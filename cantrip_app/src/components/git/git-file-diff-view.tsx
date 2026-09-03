import type { GitFileDiff } from "@cantrip/protocol";

import { GitPartialPatchView } from "./git-partial-patch-view";

export function GitFileDiffView({
  diff,
  error,
  loading,
  onClose,
  onContextLinesChange,
  onOpenFile,
  path,
  projectId,
  scope,
  worktreeId,
}: {
  diff: GitFileDiff | undefined;
  error: unknown;
  loading: boolean;
  onClose(): void;
  onContextLinesChange?(contextLines: number): void;
  onOpenFile?(): void;
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
      onContextLinesChange={onContextLinesChange}
      onOpenFile={onOpenFile}
      path={path}
      projectId={projectId}
      scope={scope}
      worktreeId={worktreeId}
    />
  );
}
