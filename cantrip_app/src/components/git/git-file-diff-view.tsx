import type { GitFileDiff } from "@cantrip/protocol";

import { GitPatchView } from "./git-patch-view";

export function GitFileDiffView({
  diff,
  error,
  loading,
  onClose,
  path,
  scope,
}: {
  diff: GitFileDiff | undefined;
  error: unknown;
  loading: boolean;
  onClose(): void;
  path: string;
  scope: "unstaged" | "staged";
}) {
  return (
    <GitPatchView
      error={error}
      loading={loading}
      newLabel={scope === "staged" ? "Staged" : "Working copy"}
      oldLabel={scope === "staged" ? "HEAD" : "Index"}
      onClose={onClose}
      patch={diff?.patch}
      path={path}
      subtitle={`${scope} changes · side-by-side diff`}
      truncated={diff?.truncated ?? false}
    />
  );
}
