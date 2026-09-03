import type {
  GitComparisonMode,
  GitRevisionCandidate,
} from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Binary,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Loader2,
  Search,
  Sparkles,
  Tag,
  Trees,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  generateProjectWorktreeGitDraft,
  getProjectWorktreeComparison,
  getProjectWorktreeRevisionCandidates,
  getProjectWorktreeRevisionDiff,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { commitFileStatusLabel } from "./git-commit-inspector";
import { GitAgentDraftDialog } from "./git-agent-draft-dialog";
import { GitPatchView } from "./git-patch-view";

export function filterRevisionCandidates(
  candidates: GitRevisionCandidate[],
  search: string,
): GitRevisionCandidate[] {
  const query = search.trim().toLowerCase();
  if (!query) return candidates.slice(0, 100);
  return candidates
    .filter((candidate) =>
      `${candidate.name} ${candidate.hash} ${candidate.kind}`
        .toLowerCase()
        .includes(query),
    )
    .slice(0, 100);
}

export function comparisonDirectionLabel(mode: GitComparisonMode): string {
  return mode === "direct"
    ? "A → B · transform A directly into B"
    : "merge-base(A, B) → B · changes introduced on B since the common ancestor";
}

function CandidateIcon({ kind }: { kind: GitRevisionCandidate["kind"] }) {
  if (kind === "tag") return <Tag className="size-3.5" />;
  if (kind === "worktree") return <Trees className="size-3.5" />;
  if (kind === "head") return <GitCommitHorizontal className="size-3.5" />;
  return <GitBranch className="size-3.5" />;
}

function RevisionSelector({
  candidates,
  label,
  onChange,
  value,
}: {
  candidates: GitRevisionCandidate[];
  label: string;
  onChange(revision: string): void;
  value: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<GitRevisionCandidate | null>(null);
  const selected =
    chosen?.revision === value
      ? chosen
      : candidates.find(({ revision }) => revision === value);
  const filtered = useMemo(
    () => filterRevisionCandidates(candidates, search),
    [candidates, search],
  );
  const rawRevision = /^[0-9a-f]{40,64}$/u.test(search.trim())
    ? search.trim()
    : null;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <button
        type="button"
        aria-expanded={open}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg bg-muted/45 px-2.5 text-left text-xs outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => {
          setSearch("");
          setOpen((current) => !current);
        }}
      >
        {selected ? (
          <CandidateIcon kind={selected.kind} />
        ) : (
          <GitCommitHorizontal className="size-3.5" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {selected?.name ?? value?.slice(0, 10) ?? "Choose a revision"}
        </span>
        {value ? (
          <code className="shrink-0 text-[9px] text-muted-foreground">
            {value.slice(0, 8)}
          </code>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-lg border bg-popover shadow-xl">
          <div className="flex h-9 items-center gap-2 border-b px-2">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
                if (event.key === "Enter" && (rawRevision || filtered[0])) {
                  setChosen(rawRevision ? null : filtered[0]!);
                  onChange(rawRevision ?? filtered[0]!.revision);
                  setOpen(false);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              placeholder="Search refs, worktrees, or hashes…"
            />
          </div>
          <div className="max-h-64 overflow-auto p-1">
            {rawRevision &&
            !filtered.some(({ revision }) => revision === rawRevision) ? (
              <button
                type="button"
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted"
                onClick={() => {
                  setChosen(null);
                  onChange(rawRevision);
                  setOpen(false);
                }}
              >
                <GitCommitHorizontal className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  Use commit {rawRevision}
                </span>
              </button>
            ) : null}
            {filtered.length ? (
              filtered.map((candidate, index) => (
                <button
                  key={`${candidate.kind}:${candidate.name}:${index}`}
                  type="button"
                  className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted"
                  onClick={() => {
                    setChosen(candidate);
                    onChange(candidate.revision);
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">
                    <CandidateIcon kind={candidate.kind} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {candidate.name}
                  </span>
                  <span className="shrink-0 text-[9px] capitalize text-muted-foreground">
                    {candidate.kind}
                  </span>
                  {candidate.revision === value ? (
                    <Check className="size-3.5" />
                  ) : null}
                </button>
              ))
            ) : (
              <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                No matching revisions
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function GitComparisonPanel({
  left,
  onClose,
  onLeftChange,
  onOpenFile,
  onRightChange,
  projectId,
  right,
  worktreeId,
}: {
  left: string | null;
  onClose(): void;
  onLeftChange(revision: string): void;
  onOpenFile?(path: string): void;
  onRightChange(revision: string): void;
  projectId: string;
  right: string | null;
  worktreeId: string;
}) {
  const [mode, setMode] = useState<GitComparisonMode>("direct");
  const [diffContextLines, setDiffContextLines] = useState(3);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const refs = useQuery({
    queryFn: () => getProjectWorktreeRevisionCandidates(projectId, worktreeId),
    queryKey: ["worktree-revision-candidates", projectId, worktreeId],
  });
  useEffect(() => {
    if (!refs.data?.length) return;
    const current =
      refs.data.find(
        (candidate) => candidate.kind === "worktree" && candidate.current,
      ) ??
      refs.data.find((candidate) => candidate.kind === "head") ??
      refs.data[0];
    if (!left && current) onLeftChange(current.revision);
  }, [left, onLeftChange, refs.data]);
  useEffect(() => {
    setSelectedPath(null);
    setDiffContextLines(3);
  }, [left, mode, right]);
  const comparison = useQuery({
    enabled: Boolean(left && right),
    queryFn: () =>
      getProjectWorktreeComparison(projectId, worktreeId, left!, right!, mode),
    queryKey: ["worktree-comparison", projectId, worktreeId, left, right, mode],
  });
  const selectedFile = comparison.data?.files.find(
    ({ path }) => path === selectedPath,
  );
  const fileDiff = useQuery({
    enabled: Boolean(comparison.data && selectedFile),
    queryFn: () =>
      getProjectWorktreeRevisionDiff(
        projectId,
        worktreeId,
        comparison.data!.right,
        comparison.data!.diffBase,
        selectedFile!.path,
        diffContextLines,
      ),
    queryKey: [
      "worktree-comparison-diff",
      projectId,
      worktreeId,
      comparison.data?.right,
      comparison.data?.diffBase,
      selectedFile?.path,
      diffContextLines,
    ],
  });
  const candidates = refs.data ?? [];
  const agentReview = useMutation({
    mutationFn: () =>
      generateProjectWorktreeGitDraft(projectId, worktreeId, {
        task: "review-commit-range",
        baseRevision: left,
        headRevision: right,
        instructions: null,
        pullRequestNumber: null,
      }),
  });

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-5xl border-l bg-background shadow-2xl md:relative md:z-auto md:w-[min(68vw,72rem)] md:shadow-none">
      <section
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          selectedPath && "hidden md:flex md:max-w-[32rem]",
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Compare revisions</p>
            <p className="truncate text-[10px] text-muted-foreground">
              Select A and B here or use the A/B controls on graph rows
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={!left || !right || agentReview.isPending}
            onClick={() => {
              setAgentOpen(true);
              agentReview.mutate();
            }}
          >
            <Sparkles className="size-3.5" /> Review range
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={onClose}
          >
            <X className="size-4" />
            <span className="sr-only">Close comparison</span>
          </Button>
        </div>
        <div className="grid gap-3 border-b p-3">
          {refs.isError ? (
            <p className="text-xs text-destructive">
              {refs.error instanceof Error
                ? refs.error.message
                : "Refs could not be loaded."}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <RevisionSelector
              candidates={candidates}
              label="A · base"
              onChange={onLeftChange}
              value={left}
            />
            <button
              type="button"
              className="mb-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              disabled={!left || !right}
              onClick={() => {
                if (!left || !right) return;
                onLeftChange(right);
                onRightChange(left);
              }}
              title="Swap A and B"
            >
              <ArrowLeftRight className="size-3.5" />
              <span className="sr-only">Swap comparison endpoints</span>
            </button>
            <RevisionSelector
              candidates={candidates}
              label="B · target"
              onChange={onRightChange}
              value={right}
            />
          </div>
          <div className="flex rounded-md bg-muted/50 p-px">
            {(["direct", "merge-base"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === mode}
                className={cn(
                  "h-7 flex-1 rounded px-2 text-[10px] text-muted-foreground",
                  candidate === mode &&
                    "bg-background font-medium text-foreground shadow-sm",
                )}
                onClick={() => setMode(candidate)}
              >
                {candidate === "direct" ? "Direct A → B" : "Merge-base … B"}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {comparisonDirectionLabel(mode)}
          </p>
        </div>

        {!left || !right ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            Choose both comparison endpoints. You can also assign A or B from a
            commit row.
          </div>
        ) : comparison.isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : comparison.isError ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-destructive">
            {comparison.error instanceof Error
              ? comparison.error.message
              : "The selected revisions could not be compared."}
          </div>
        ) : comparison.data ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-3 grid grid-cols-3 gap-2 text-center text-[10px]">
              <div className="rounded-lg bg-muted/40 p-2">
                <p className="font-semibold text-foreground">
                  {comparison.data.leftAhead}
                </p>
                <p className="text-muted-foreground">only on A</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2">
                <p className="font-semibold text-foreground">
                  {comparison.data.rightAhead}
                </p>
                <p className="text-muted-foreground">only on B</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2">
                <p className="font-semibold text-foreground">
                  {comparison.data.filesChanged}
                </p>
                <p className="text-muted-foreground">changed files</p>
              </div>
            </div>
            <div className="mb-3 rounded-lg bg-muted/30 px-3 py-2 font-mono text-[9px] text-muted-foreground">
              <p>
                merge base {comparison.data.mergeBase?.slice(0, 12) ?? "none"}
              </p>
              <p>
                diff base {comparison.data.diffBase.slice(0, 12)} →{" "}
                {comparison.data.right.slice(0, 12)}
              </p>
            </div>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              {[
                [
                  "Only on A",
                  comparison.data.leftCommits,
                  comparison.data.leftCommitsTruncated,
                ],
                [
                  "Only on B",
                  comparison.data.rightCommits,
                  comparison.data.rightCommitsTruncated,
                ],
              ].map(([title, commits, truncated]) => (
                <div
                  key={String(title)}
                  className="min-w-0 rounded-lg bg-muted/25 p-2"
                >
                  <p className="mb-1 text-[10px] font-semibold">
                    {String(title)}
                  </p>
                  <div className="max-h-48 overflow-auto">
                    {(commits as typeof comparison.data.leftCommits).map(
                      (commit) => (
                        <div
                          key={commit.hash}
                          className="flex h-6 min-w-0 items-center gap-2 text-[10px]"
                        >
                          <code className="shrink-0 text-muted-foreground">
                            {commit.shortHash}
                          </code>
                          <span className="truncate">{commit.subject}</span>
                        </div>
                      ),
                    )}
                  </div>
                  {truncated ? (
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      Commit range truncated after 100 entries.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
              Changed files
              <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                +{comparison.data.additions}
              </span>
              <span className="font-mono text-[10px] text-red-600 dark:text-red-400">
                −{comparison.data.deletions}
              </span>
            </div>
            {comparison.data.filesTruncated ? (
              <p className="mb-2 text-[10px] text-amber-600 dark:text-amber-400">
                File list truncated.
              </p>
            ) : null}
            <div className="grid gap-0.5">
              {comparison.data.files.map((file) => (
                <button
                  key={`${file.originalPath ?? ""}:${file.path}`}
                  type="button"
                  data-high-contrast-row
                  className="grid min-h-8 grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted/55"
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {file.binary ? (
                      <Binary className="size-3.5" />
                    ) : (
                      <File className="size-3.5" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px]">
                        {file.path}
                      </span>
                      <span className="block truncate text-[9px] text-muted-foreground">
                        {commitFileStatusLabel(file.status)}
                        {file.originalPath ? ` from ${file.originalPath}` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2 font-mono text-[10px]">
                    {file.additions === null ? null : (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions === null ? null : (
                      <span className="text-red-600 dark:text-red-400">
                        −{file.deletions}
                      </span>
                    )}
                    <ChevronRight className="size-3" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      {selectedPath ? (
        <GitPatchView
          error={fileDiff.error}
          loading={fileDiff.isLoading}
          newFile={fileDiff.data?.newFile}
          newLabel={`B · ${comparison.data?.right.slice(0, 10) ?? "target"}`}
          oldLabel={
            mode === "direct"
              ? `A · ${comparison.data?.left.slice(0, 10) ?? "base"}`
              : `Merge base · ${comparison.data?.diffBase.slice(0, 10) ?? "base"}`
          }
          onClose={() => setSelectedPath(null)}
          onContextLinesChange={setDiffContextLines}
          onOpenFile={
            onOpenFile && selectedFile?.status !== "deleted"
              ? () => onOpenFile(selectedPath)
              : undefined
          }
          oldFile={fileDiff.data?.oldFile}
          originalPath={selectedFile?.originalPath}
          patch={fileDiff.data?.patch}
          path={selectedPath}
          subtitle={comparisonDirectionLabel(mode)}
          truncated={fileDiff.data?.truncated ?? false}
          binary={fileDiff.data?.binary ?? selectedFile?.binary}
        />
      ) : null}
      <GitAgentDraftDialog
        draft={agentReview.data ?? null}
        error={
          agentReview.error instanceof Error ? agentReview.error.message : null
        }
        loading={agentReview.isPending}
        onOpenChange={setAgentOpen}
        onRegenerate={() => agentReview.mutate()}
        open={agentOpen}
        task="review-commit-range"
      />
    </aside>
  );
}
