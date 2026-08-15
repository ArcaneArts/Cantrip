import type {
  ChatImportJobSummary,
  ExternalChatSource,
  ExternalChatThreadMetadata,
  ProjectExternalChatDiscovery,
  ProjectWorktreeSummary,
  SettingsBundle,
} from "@cantrip/protocol";

export const activeImportStates = new Set<ChatImportJobSummary["state"]>([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
]);

export interface ExternalChatImportCandidate {
  existingJob: ChatImportJobSummary | null;
  key: string;
  source: ExternalChatSource;
  sourceWorkerId: string;
  sourceWorkerName: string;
  thread: ExternalChatThreadMetadata;
}

export function externalChatSourceIdentity(
  workerId: string,
  sourceId: string,
  sourceThreadId: string,
): string {
  return `${workerId}\0${sourceId}\0${sourceThreadId}`;
}

export function externalChatImportCandidates(
  discovery: ProjectExternalChatDiscovery | undefined,
  jobs: ChatImportJobSummary[] = [],
): ExternalChatImportCandidate[] {
  if (!discovery) return [];
  const jobsBySource = new Map(
    jobs.map((job) => [
      externalChatSourceIdentity(
        job.sourceWorkerId,
        job.sourceId,
        job.sourceThreadId,
      ),
      job,
    ]),
  );
  return discovery.workers
    .flatMap((worker) =>
      worker.sources.flatMap((source) =>
        source.threads.map((thread) => {
          const key = externalChatSourceIdentity(
            worker.workerId,
            source.sourceId,
            thread.sourceThreadId,
          );
          return {
            existingJob: jobsBySource.get(key) ?? null,
            key,
            source,
            sourceWorkerId: worker.workerId,
            sourceWorkerName: worker.workerName,
            thread,
          } satisfies ExternalChatImportCandidate;
        }),
      ),
    )
    .sort(
      (left, right) =>
        right.thread.updatedAt.localeCompare(left.thread.updatedAt) ||
        left.thread.title.localeCompare(right.thread.title) ||
        left.key.localeCompare(right.key),
    );
}

export function filterExternalChatImportCandidates(
  candidates: ExternalChatImportCandidate[],
  query: string,
): ExternalChatImportCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return candidates;
  return candidates.filter(({ source, sourceWorkerName, thread }) =>
    [
      source.name,
      sourceWorkerName,
      thread.title,
      thread.preview,
      thread.cwd,
      thread.modelProvider,
      thread.git?.branch,
      thread.git?.originUrl,
    ].some((value) => value?.toLowerCase().includes(normalized)),
  );
}

export function selectableExternalChatCandidateKeys(
  candidates: ExternalChatImportCandidate[],
): string[] {
  return candidates
    .filter(({ existingJob }) => existingJob === null)
    .slice(0, 50)
    .map(({ key }) => key);
}

export function chatImportIdempotencyKey(
  candidate: ExternalChatImportCandidate,
): string {
  return [
    "codex",
    candidate.sourceWorkerId.slice(0, 60),
    candidate.source.sourceId.slice(0, 32),
    candidate.thread.sourceThreadId.slice(0, 80),
  ].join(":");
}

export function summarizeChatImportJobs(jobs: ChatImportJobSummary[]) {
  return {
    active: jobs.filter(({ state }) => activeImportStates.has(state)).length,
    failed: jobs.filter(({ state }) =>
      ["blocked", "failed", "cancelled"].includes(state),
    ).length,
    succeeded: jobs.filter(({ state }) => state === "succeeded").length,
  };
}

export function importStateLabel(job: ChatImportJobSummary): string {
  switch (job.state) {
    case "queued":
      return "Queued";
    case "reading":
      return "Reading history";
    case "importing":
      return "Saving history";
    case "awaiting-hydration":
      return "Waiting to resume";
    case "hydrating":
      return "Preparing resumable chat";
    case "succeeded":
      return "Ready";
    case "blocked":
      return "Needs attention";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function mergeChatImportJobs(
  current: ChatImportJobSummary[] | undefined,
  updated: ChatImportJobSummary[],
): ChatImportJobSummary[] {
  const ids = new Set(updated.map(({ id }) => id));
  return [...(current ?? []).filter(({ id }) => !ids.has(id)), ...updated];
}

export function readyChatImportModels(settings: SettingsBundle | undefined) {
  return (settings?.models ?? []).filter((model) =>
    model.routes.some(({ enabled }) => enabled),
  );
}

export function externalChatWorktreeLabel(
  worktree: ProjectWorktreeSummary,
  workersById: ReadonlyMap<string, string>,
): string {
  return `${worktree.name} · ${workersById.get(worktree.workerId) ?? worktree.workerId}`;
}
