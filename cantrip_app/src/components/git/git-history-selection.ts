import type { GitCommit, GitMergeRebaseAction } from "@cantrip/protocol";

export function selectedHistoryCommits(
  commits: readonly GitCommit[],
  revisions: ReadonlySet<string>,
): GitCommit[] {
  return commits.filter(({ hash }) => revisions.has(hash)).reverse();
}

export function comparisonForSelectedCommits(
  commits: readonly GitCommit[],
  revisions: ReadonlySet<string>,
): { left: string; right: string } | null {
  const selected = selectedHistoryCommits(commits, revisions);
  return selected.length === 2
    ? { left: selected[0]!.hash, right: selected[1]!.hash }
    : null;
}

export function squashActionForSelectedCommits(
  commits: readonly GitCommit[],
  revisions: ReadonlySet<string>,
  head: string | null,
): GitMergeRebaseAction | null {
  const selected = selectedHistoryCommits(commits, revisions);
  if (selected.length < 2 || !head) return null;
  const oldest = selected[0]!;
  const newest = selected.at(-1)!;
  if (!oldest.parents[0] || newest.hash !== head) return null;
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index]!.parents[0] !== selected[index - 1]!.hash) return null;
  }
  return {
    type: "interactiveRebase",
    upstreamRef: oldest.parents[0],
    todo: selected.map((commit, index) => ({
      action: index === 0 ? "pick" : "squash",
      revision: commit.hash,
      message: null,
    })),
  };
}
