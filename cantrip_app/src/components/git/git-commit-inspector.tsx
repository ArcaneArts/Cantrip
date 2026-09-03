import type {
  GitCommitDetail,
  GitCommitFile,
  GitHistoryFilter,
  GitSignature,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
  Binary,
  ChevronRight,
  CircleAlert,
  File,
  FilePlus2,
  FileX2,
  Filter,
  GitBranch,
  GitCommitHorizontal,
  KeyRound,
  Loader2,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  getProjectWorktreeCommit,
  getProjectWorktreeCommitSignature,
  getProjectWorktreeRevisionDiff,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";
import { GitCommitActionsDropdown } from "./git-commit-actions-menu";
import type { CommitActionRequest } from "./git-commit-action-dialog";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
});

export function commitFileStatusLabel(status: GitCommitFile["status"]): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "type-changed":
      return "Type changed";
    case "unmerged":
      return "Unmerged";
    case "modified":
      return "Modified";
    default:
      return "Changed";
  }
}

export function signatureLabel(signature: GitSignature): string {
  const format = signature.format
    ? `${signature.format === "x509" ? "X.509" : signature.format.toUpperCase()} `
    : "";
  switch (signature.status) {
    case "valid":
      return signature.signer
        ? `Verified ${format}signature from ${signature.signer}`
        : `Verified ${format}signature`;
    case "valid-unknown":
      return `Valid ${format}signature from an untrusted key`;
    case "invalid":
      return `Invalid ${format}signature`;
    case "expired":
      return `${format}signature or signing key expired`;
    case "revoked":
      return `${format}signing key revoked`;
    case "unverifiable":
      return `${format}signature could not be verified`;
    default:
      return "Unsigned commit";
  }
}

export function signatureVerificationLabel(
  signature: GitSignature,
): string | null {
  switch (signature.verification) {
    case "missing-key":
      return "The verification key is unavailable on this worker.";
    case "missing-config":
      return "SSH allowed-signers verification is not configured on this worker.";
    case "missing-tool":
      return "The required signature verification tool is not installed on this worker.";
    case "error":
      return "Git could not complete signature verification on this worker.";
    default:
      return null;
  }
}

function SignatureSummary({ signature }: { signature: GitSignature }) {
  const verified = signature.status === "valid";
  const Icon = verified
    ? BadgeCheck
    : signature.status === "unsigned"
      ? ShieldQuestion
      : CircleAlert;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg bg-muted/45 px-3 py-2 text-[11px]",
        verified && "text-emerald-700 dark:text-emerald-300",
        !verified &&
          signature.status !== "unsigned" &&
          "text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p>{signatureLabel(signature)}</p>
        {signatureVerificationLabel(signature) ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {signatureVerificationLabel(signature)}
          </p>
        ) : null}
        {signature.key || signature.fingerprint ? (
          <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
            <KeyRound className="size-3 shrink-0" />
            {signature.fingerprint ?? signature.key}
          </p>
        ) : null}
        {signature.verificationMessage ? (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[9px] text-muted-foreground">
            {signature.verificationMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PersonSummary({
  date,
  email,
  label,
  name,
  onFilter,
}: {
  date: string;
  email: string;
  label: string;
  name: string;
  onFilter?(): void;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-xs font-medium" title={`${name} <${email}>`}>
        {onFilter ? (
          <button
            type="button"
            className="hover:underline"
            onClick={onFilter}
            title={`Filter History by ${name}`}
          >
            {name}
          </button>
        ) : (
          name
        )}{" "}
        <span className="font-normal text-muted-foreground">{email}</span>
      </p>
      <p className="text-[10px] text-muted-foreground">
        {dateFormatter.format(new Date(date))}
      </p>
    </div>
  );
}

function FileIcon({ file }: { file: GitCommitFile }) {
  if (file.binary) return <Binary className="size-3.5" />;
  if (file.status === "added") return <FilePlus2 className="size-3.5" />;
  if (file.status === "deleted") return <FileX2 className="size-3.5" />;
  return <File className="size-3.5" />;
}

function CommitOverview({
  commit,
  onNavigate,
  onFilter,
  onParentChange,
  parentIndex,
  selectedPath,
  setSelectedPath,
  signature,
  signatureError,
  signatureLoading,
}: {
  commit: GitCommitDetail;
  onNavigate(revision: string): void;
  onFilter(filters: Partial<GitHistoryFilter>): void;
  onParentChange(index: number): void;
  parentIndex: number;
  selectedPath: string | null;
  setSelectedPath(path: string): void;
  signature: GitSignature | null;
  signatureError: Error | null;
  signatureLoading: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid gap-4 p-4">
        {commit.refs.length ? (
          <div className="flex flex-wrap gap-1">
            {commit.refs.map((gitRef) => {
              const content = (
                <>
                  <GitBranch className="size-3" /> {gitRef.name}
                </>
              );
              return gitRef.kind === "head" ? (
                <span
                  key={`${gitRef.kind}:${gitRef.name}`}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
                >
                  {content}
                </span>
              ) : (
                <button
                  type="button"
                  key={`${gitRef.kind}:${gitRef.name}`}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/80"
                  onClick={() =>
                    onFilter(
                      gitRef.kind === "tag"
                        ? { tag: gitRef.name, branch: null }
                        : { branch: gitRef.name, tag: null },
                    )
                  }
                  title={`Filter History by ${gitRef.kind} ${gitRef.name}`}
                >
                  {content}
                </button>
              );
            })}
          </div>
        ) : null}

        <div>
          <h2 className="text-sm font-semibold">{commit.subject}</h2>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/35 p-3 font-sans text-xs leading-5">
            {commit.message}
          </pre>
          {commit.messageTruncated ? (
            <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
              Message truncated after one million characters.
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <PersonSummary
            label="Author"
            {...commit.author}
            onFilter={() => onFilter({ author: commit.author.name })}
          />
          <PersonSummary label="Committer" {...commit.committer} />
        </div>
        {signature ? (
          <SignatureSummary signature={signature} />
        ) : signatureLoading ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/45 px-3 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Verifying commit signature in the background…
          </div>
        ) : signatureError ? (
          <div className="rounded-lg bg-muted/45 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            Signature verification could not be loaded: {signatureError.message}
          </div>
        ) : null}

        <div className="grid gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Revision navigation
          </p>
          {commit.parents.length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] text-muted-foreground">
                {commit.parents.length > 1 ? "Parents" : "Parent"}
              </span>
              {commit.parents.map((parent, index) => (
                <button
                  key={parent}
                  type="button"
                  className={cn(
                    "rounded bg-muted px-1.5 py-1 font-mono text-[10px] hover:bg-muted/80",
                    index === parentIndex && "ring-1 ring-ring",
                  )}
                  onClick={() =>
                    index === parentIndex
                      ? onNavigate(parent)
                      : onParentChange(index)
                  }
                  title={
                    index === parentIndex
                      ? `Open parent ${parent}`
                      : `Compare against parent ${index + 1}`
                  }
                >
                  {parent.slice(0, 10)}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              Root commit — compared with the empty tree
            </span>
          )}
          {commit.children.length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] text-muted-foreground">
                {commit.children.length > 1 ? "Children" : "Child"}
              </span>
              {commit.children.map((child) => (
                <button
                  key={child}
                  type="button"
                  className="rounded bg-muted px-1.5 py-1 font-mono text-[10px] hover:bg-muted/80"
                  onClick={() => onNavigate(child)}
                >
                  {child.slice(0, 10)}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-semibold">
              {commit.filesChanged} changed{" "}
              {commit.filesChanged === 1 ? "file" : "files"}
            </p>
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
              +{commit.additions}
            </span>
            <span className="text-[10px] text-red-600 dark:text-red-400">
              −{commit.deletions}
            </span>
          </div>
          {commit.filesTruncated ? (
            <p className="mb-2 text-[10px] text-amber-600 dark:text-amber-400">
              File list truncated for this unusually large commit.
            </p>
          ) : null}
          <div className="grid gap-0.5">
            {commit.files.map((file) => (
              <div
                key={`${file.originalPath ?? ""}:${file.path}`}
                data-high-contrast-row
                className={cn(
                  "grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-md px-1 text-left text-xs hover:bg-muted/55",
                  selectedPath === file.path && "bg-muted",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left"
                  onClick={() => setSelectedPath(file.path)}
                  title={`Open ${file.path} patch`}
                >
                  <span className="shrink-0 text-muted-foreground">
                    <FileIcon file={file} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px]">
                      {file.path}
                    </span>
                    <span className="block truncate text-[9px] text-muted-foreground">
                      {commitFileStatusLabel(file.status)}
                      {file.originalPath ? ` from ${file.originalPath}` : ""}
                      {file.binary ? " · binary" : ""}
                    </span>
                  </span>
                </button>
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
                  <button
                    type="button"
                    className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onFilter({ path: file.path })}
                    title={`Filter History to ${file.path}`}
                  >
                    <Filter className="size-3" />
                    <span className="sr-only">
                      Filter History to {file.path}
                    </span>
                  </button>
                  <ChevronRight className="size-3 text-muted-foreground" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GitCommitInspector({
  currentHead,
  githubUrl,
  onAction,
  onClose,
  onNavigate,
  onFilter,
  onOpenFile,
  onViewInGraph,
  projectId,
  revision,
  worktreeId,
}: {
  currentHead: string | null;
  onAction(request: CommitActionRequest): void;
  onClose(): void;
  onNavigate(revision: string): void;
  onFilter(filters: Partial<GitHistoryFilter>): void;
  onOpenFile?(path: string): void;
  onViewInGraph?(revision: string): void;
  githubUrl?: string | null;
  projectId: string;
  revision: string;
  worktreeId: string;
}) {
  const [parentIndex, setParentIndex] = useState(0);
  const [diffContextLines, setDiffContextLines] = useState(3);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => {
    setParentIndex(0);
    setSelectedPath(null);
    setDiffContextLines(3);
  }, [revision, worktreeId]);
  const detail = useQuery({
    queryFn: () =>
      getProjectWorktreeCommit(projectId, worktreeId, revision, parentIndex),
    queryKey: ["worktree-commit", projectId, worktreeId, revision, parentIndex],
  });
  const signature = useQuery({
    enabled: Boolean(detail.data?.hash),
    queryFn: () =>
      getProjectWorktreeCommitSignature(
        projectId,
        worktreeId,
        detail.data!.hash,
      ),
    queryKey: [
      "worktree-commit-signature",
      projectId,
      worktreeId,
      detail.data?.hash,
    ],
    staleTime: 10 * 60_000,
  });
  const selectedFile = useMemo(
    () => detail.data?.files.find(({ path }) => path === selectedPath),
    [detail.data?.files, selectedPath],
  );
  const fileDiff = useQuery({
    enabled: Boolean(detail.data && selectedFile),
    queryFn: () =>
      getProjectWorktreeRevisionDiff(
        projectId,
        worktreeId,
        detail.data!.hash,
        detail.data!.baseHash,
        selectedFile!.path,
        diffContextLines,
      ),
    queryKey: [
      "worktree-revision-diff",
      projectId,
      worktreeId,
      detail.data?.hash,
      detail.data?.baseHash,
      selectedFile?.path,
      diffContextLines,
    ],
  });

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-4xl border-l bg-background shadow-2xl md:relative md:z-auto md:w-[min(58vw,64rem)] md:shadow-none">
      <section
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          selectedPath && "hidden md:flex md:max-w-[26rem]",
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <GitCommitHorizontal className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">
              {detail.data?.subject ?? "Commit details"}
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {detail.data?.hash ?? revision}
            </p>
          </div>
          {detail.data ? (
            <GitCommitActionsDropdown
              githubUrl={githubUrl}
              target={{
                hash: detail.data.hash,
                shortHash: detail.data.shortHash,
                subject: detail.data.subject,
                parents: detail.data.parents,
                isHead: detail.data.hash === currentHead,
              }}
              onAction={onAction}
              onViewInGraph={onViewInGraph}
            />
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={onClose}
            title="Close commit inspector"
          >
            <X className="size-4" />
            <span className="sr-only">Close commit inspector</span>
          </Button>
        </div>
        {detail.isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : detail.isError ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-destructive">
            {detail.error instanceof Error
              ? detail.error.message
              : "Commit details could not be loaded."}
          </div>
        ) : detail.data ? (
          <CommitOverview
            commit={detail.data}
            onNavigate={onNavigate}
            onFilter={onFilter}
            onParentChange={(index) => {
              setParentIndex(index);
              setSelectedPath(null);
            }}
            parentIndex={parentIndex}
            selectedPath={selectedPath}
            setSelectedPath={setSelectedPath}
            signature={signature.data ?? detail.data.signature}
            signatureError={signature.error}
            signatureLoading={signature.isLoading}
          />
        ) : null}
      </section>
      {selectedPath ? (
        <GitPatchView
          error={fileDiff.error}
          loading={fileDiff.isLoading}
          newFile={fileDiff.data?.newFile}
          newLabel={detail.data?.shortHash ?? "Commit"}
          oldLabel={detail.data?.baseHash?.slice(0, 10) ?? "Empty tree"}
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
          subtitle={`${commitFileStatusLabel(selectedFile?.status ?? "unknown")} · revision patch`}
          truncated={fileDiff.data?.truncated ?? false}
          binary={fileDiff.data?.binary ?? selectedFile?.binary}
        />
      ) : null}
    </aside>
  );
}
