import type {
  ProjectWorkspaceSummary,
  WorkspaceRepositoryCandidateSummary,
  WorkspaceRepositoryDiscoverySnapshot,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderGit2, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getWorkspaceRepositoryDiscovery,
  resolveWorkerRepositoryMetadata,
  startWorkspaceRepositoryDiscovery,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export interface ResolvedWorkspaceRepositoryCandidate {
  candidate: WorkspaceRepositoryCandidateSummary;
  displayPath: string | null;
  originUrl: string | null;
  github: {
    nameWithOwner: string | null;
    repositoryId: string | null;
    url: string | null;
  } | null;
}

function resolvedString(
  values: Record<string, string | string[] | null>,
  key: string,
): string | null {
  const value = values[key];
  return typeof value === "string" ? value : null;
}

export async function resolveWorkspaceRepositoryCandidate(
  candidate: WorkspaceRepositoryCandidateSummary,
): Promise<ResolvedWorkspaceRepositoryCandidate> {
  const github = candidate.github;
  const values = {
    displayPath: candidate.displayHandle,
    ...(candidate.originUrlHandle
      ? { originUrl: candidate.originUrlHandle }
      : {}),
    ...(github
      ? {
          repositoryId: github.repositoryId,
          nameWithOwner: github.nameWithOwner,
          url: github.url,
        }
      : {}),
  };
  const resolved = await resolveWorkerRepositoryMetadata({
    scopeId: candidate.workspaceId,
    workerId: candidate.workerId,
    values,
  });
  return {
    candidate,
    displayPath: resolvedString(resolved.values, "displayPath"),
    originUrl: resolvedString(resolved.values, "originUrl"),
    github: github
      ? {
          repositoryId: resolvedString(resolved.values, "repositoryId"),
          nameWithOwner: resolvedString(resolved.values, "nameWithOwner"),
          url: resolvedString(resolved.values, "url"),
        }
      : null,
  };
}

function classificationLabel(
  classification: WorkspaceRepositoryCandidateSummary["classification"],
): string {
  switch (classification) {
    case "github-accessible":
      return "GitHub accessible";
    case "github-unavailable":
      return "Local Git · GitHub unavailable";
    case "local-git":
      return "Local Git";
    case "unclassified":
      return "Classifying";
  }
}

function diagnosticLabel(
  code: WorkspaceRepositoryCandidateSummary["diagnosticCode"],
): string | null {
  switch (code) {
    case "origin-invalid":
      return "The Git origin is not a supported GitHub repository URL.";
    case "origin-unavailable":
      return "The Git origin could not be read.";
    case "github-cli-unavailable":
      return "GitHub CLI is unavailable on this worker.";
    case "github-api-unavailable":
      return "GitHub could not verify access with the worker credential.";
    case "github-api-invalid":
      return "GitHub returned an invalid repository identity.";
    case "github-identity-mismatch":
      return "GitHub returned a different repository than the Git origin.";
    case null:
      return null;
  }
}

function discoveryError(
  snapshot: WorkspaceRepositoryDiscoverySnapshot,
): string {
  switch (snapshot.job.error?.code) {
    case "worker-offline":
      return "The home worker is offline. Discovery resumes when it reconnects.";
    case "capability-missing":
      return "This worker does not support attached-workspace discovery.";
    case "root-unavailable":
      return "The attached workspace root is no longer available on its worker.";
    case "discovery-failed":
      return "The worker could not scan this workspace.";
    default:
      return "Repository discovery did not complete.";
  }
}

function progressDescription(
  snapshot: WorkspaceRepositoryDiscoverySnapshot,
): string {
  const counts = snapshot.progress?.counts ?? snapshot.job.counts;
  if (!counts) return "Preparing the worker scan…";
  return `${counts.scannedDirectories.toLocaleString()} directories scanned · ${counts.candidates.toLocaleString()} repositories found`;
}

function CandidateRow({
  resolved,
}: {
  resolved: ResolvedWorkspaceRepositoryCandidate;
}) {
  const { candidate } = resolved;
  const diagnostic = diagnosticLabel(candidate.diagnosticCode);
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="flex min-w-0 gap-3">
        <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p
            className="truncate font-mono text-xs font-medium"
            title={resolved.displayPath ?? undefined}
          >
            {resolved.displayPath ?? "Protected path unavailable"}
          </p>
          {resolved.github?.nameWithOwner ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {resolved.github.nameWithOwner}
            </p>
          ) : resolved.originUrl ? (
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={resolved.originUrl}
            >
              {resolved.originUrl}
            </p>
          ) : null}
          {diagnostic ? (
            <p className="mt-1 text-xs text-muted-foreground">{diagnostic}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 sm:justify-end">
        <Badge
          variant={
            candidate.classification === "github-accessible"
              ? "secondary"
              : "outline"
          }
        >
          {classificationLabel(candidate.classification)}
        </Badge>
        {candidate.importState !== "pending" ? (
          <Badge variant="outline">{candidate.importState}</Badge>
        ) : null}
      </div>
    </li>
  );
}

export function WorkspaceRepositoryDiscoveryReview({
  open,
  onOpenChange,
  workspace,
  workerOnline,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  workspace: ProjectWorkspaceSummary | null;
  workerOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceId = workspace?.id ?? "";
  const discovery = useQuery({
    enabled: open && workspace?.storage.kind === "attached",
    queryFn: () => getWorkspaceRepositoryDiscovery(workspaceId),
    queryKey: ["workspace-repository-discovery", workspaceId],
    retry: false,
  });
  const snapshot = discovery.data;
  const metadataKey = snapshot
    ? [
        "workspace-repository-discovery-metadata",
        workspaceId,
        snapshot.job.id,
        snapshot.job.stateRevision,
      ]
    : ["workspace-repository-discovery-metadata", workspaceId];
  const metadata = useQuery({
    enabled:
      open &&
      workerOnline &&
      snapshot?.job.state === "succeeded" &&
      snapshot.candidates.length > 0,
    queryFn: () =>
      Promise.all(
        snapshot!.candidates.map(resolveWorkspaceRepositoryCandidate),
      ),
    queryKey: metadataKey,
    retry: false,
    staleTime: Infinity,
  });
  const rescan = useMutation({
    mutationFn: () =>
      startWorkspaceRepositoryDiscovery(workspaceId, {
        expectedStateRevision: snapshot?.job.stateRevision,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        ["workspace-repository-discovery", workspaceId],
        next,
      );
    },
  });
  const candidates =
    metadata.data ??
    snapshot?.candidates.map((candidate) => ({
      candidate,
      displayPath: null,
      originUrl: null,
      github: null,
    })) ??
    [];
  const busy =
    snapshot?.job.state === "queued" || snapshot?.job.state === "running";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90svh,850px)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {workspace ? `${workspace.name} repositories` : "Repositories"}
          </DialogTitle>
          <DialogDescription>
            Review Git repositories found in this attached workspace. Nothing is
            imported until you explicitly select it.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-40 flex-1 overflow-y-auto rounded-lg border">
          {discovery.isLoading ? (
            <div className="grid min-h-40 place-items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading repository discovery…
            </div>
          ) : discovery.isError ? (
            <div className="grid min-h-40 place-items-center px-6 text-center text-sm text-destructive">
              {errorMessage(
                discovery.error,
                "Repository discovery is unavailable.",
              )}
            </div>
          ) : snapshot && busy ? (
            <div className="grid min-h-40 place-items-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <div>
                <p className="font-medium text-foreground">
                  {snapshot.job.state === "queued"
                    ? "Waiting for the worker…"
                    : "Scanning workspace…"}
                </p>
                <p className="mt-1 text-xs">{progressDescription(snapshot)}</p>
              </div>
            </div>
          ) : snapshot &&
            (snapshot.job.state === "blocked" ||
              snapshot.job.state === "failed") ? (
            <div className="grid min-h-40 place-items-center gap-2 px-6 text-center">
              <AlertTriangle className="size-5 text-destructive" />
              <div>
                <p className="text-sm font-medium">Discovery unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {discoveryError(snapshot)}
                </p>
              </div>
            </div>
          ) : snapshot && candidates.length ? (
            <ul className="divide-y">
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.candidate.id}
                  resolved={candidate}
                />
              ))}
            </ul>
          ) : snapshot ? (
            <div className="grid min-h-40 place-items-center px-6 text-center">
              <div>
                <p className="text-sm font-medium">No Git repositories found</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The scan searched the workspace root through depth{" "}
                  {snapshot.job.depth}.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {snapshot?.job.state === "succeeded" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{snapshot.candidates.length} repositories found</span>
            {snapshot.job.counts?.collapsedRepositories ? (
              <span>
                {snapshot.job.counts.collapsedRepositories} nested checkouts
                collapsed
              </span>
            ) : null}
            {snapshot.job.truncated ? (
              <span className="text-destructive">
                Results reached the bounded scan limit.
              </span>
            ) : null}
            {metadata.isError ? (
              <span>
                Protected repository details are temporarily unavailable.
              </span>
            ) : null}
            {!workerOnline ? (
              <span>Connect the home worker to reveal protected paths.</span>
            ) : null}
          </div>
        ) : null}

        {rescan.isError ? (
          <p className="text-sm text-destructive">
            {errorMessage(rescan.error, "Could not start another scan.")}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={!workspace || busy || !workerOnline}
            onClick={() => rescan.mutate()}
            pending={rescan.isPending}
            pendingLabel="Starting scan…"
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" /> Rescan
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
