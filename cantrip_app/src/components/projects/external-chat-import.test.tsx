import type {
  ChatImportJobSummary,
  ProjectExternalChatDiscovery,
  ProjectSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExternalChatImportSettings } from "./external-chat-import";
import {
  chatImportIdempotencyKey,
  externalChatImportCandidates,
  filterExternalChatImportCandidates,
  selectableExternalChatCandidateKeys,
  summarizeChatImportJobs,
} from "./external-chat-import-model";
import {
  ExternalChatCandidateRow,
  ImportJobRow,
} from "./external-chat-import-rows";

const now = "2026-08-15T12:00:00.000Z";
const project = {
  id: "project-one",
  name: "Cantrip",
  position: 0,
  originKind: "github",
  capabilities: {
    git: true,
    github: true,
    worktrees: true,
    replicas: true,
    relocation: true,
  },
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  github: null,
  source: {
    id: "replica-one",
    sourceKind: "git",
    workerId: "worker-one",
    path: "/workspace/Cantrip",
    displayPath: "~/Cantrip",
    placementMode: "managed",
    ownershipKind: "cantrip",
    requestedPath: null,
    linkPath: null,
  },
  replicas: [],
  createdAt: now,
  updatedAt: now,
} satisfies ProjectSummary;
const worktree = {
  id: "worktree-one",
  projectSourceId: "replica-one",
  projectId: project.id,
  rootKind: "git-worktree",
  workerId: "worker-one",
  name: "Primary",
  path: "/workspace/Cantrip",
  displayPath: "~/Cantrip",
  isPrimary: true,
  isDefault: true,
  origin: "user",
  lifecycleState: "ready",
  branch: "main",
  head: "a".repeat(40),
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
} satisfies ProjectWorktreeSummary;

function importJob(
  overrides: Partial<ChatImportJobSummary> = {},
): ChatImportJobSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    projectId: project.id,
    chatId: "chat-one",
    sourceKind: "chatgpt-codex",
    sourceWorkerId: "worker-one",
    sourceId: "a".repeat(64),
    sourceThreadId: "thread-one",
    targetPlacement: {
      projectId: project.id,
      workerId: "worker-one",
      projectReplicaId: "replica-one",
      worktreeId: worktree.id,
      surface: null,
    },
    managedThreadId: "managed-one",
    targetModelRouteId: null,
    targetProviderAccountId: null,
    state: "succeeded",
    stateRevision: 5,
    idempotencyKey: "import-one",
    attempt: 1,
    progress: {
      stage: "succeeded",
      percent: 100,
      updatedAt: now,
    },
    error: null,
    sourceMetadata: null,
    attachmentCount: 0,
    attachmentWarningCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

const discovery = {
  projectId: project.id,
  observedAt: now,
  partial: false,
  truncated: false,
  workers: [
    {
      workerId: "worker-one",
      workerName: "Studio Mac",
      platform: "darwin",
      status: "ok",
      error: null,
      sources: [
        {
          kind: "chatgpt-codex",
          sourceId: "a".repeat(64),
          name: "ChatGPT Codex",
          platform: "darwin",
          homeLabel: "~/.codex",
          availability: "available",
          message: null,
          runtimeVersion: "0.149.0",
          truncated: false,
          threads: [
            {
              sourceThreadId: "thread-one",
              title: "Build the importer",
              preview: "Continue the settings experience",
              cwd: "/workspace/Cantrip",
              createdAt: now,
              updatedAt: now,
              archived: false,
              source: "vscode",
              status: "not-loaded",
              modelProvider: "openai",
              cliVersion: "0.149.0",
              git: {
                branch: "main",
                sha: "a".repeat(40),
                originUrl: "https://github.com/ArcaneArts/Cantrip.git",
              },
              match: {
                kind: "worktree-path",
                projectReplicaId: "replica-one",
                worktreeId: worktree.id,
              },
              existingImport: null,
            },
            {
              sourceThreadId: "thread-two",
              title: "Windows packaging",
              preview: "Repair the native package",
              cwd: "C:\\src\\Cantrip",
              createdAt: now,
              updatedAt: "2026-08-14T12:00:00.000Z",
              archived: true,
              source: "cli",
              status: "not-loaded",
              modelProvider: "openai",
              cliVersion: "0.149.0",
              git: null,
              match: {
                kind: "git-origin",
                projectReplicaId: "replica-one",
                worktreeId: null,
              },
              existingImport: null,
            },
          ],
        },
      ],
    },
  ],
} satisfies ProjectExternalChatDiscovery;

describe("external Codex chat import settings", () => {
  it("joins already-imported state and searches all visible metadata", () => {
    const candidates = externalChatImportCandidates(discovery, [importJob()]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      sourceWorkerName: "Studio Mac",
      existingJob: { state: "succeeded" },
      thread: { title: "Build the importer" },
    });
    expect(filterExternalChatImportCandidates(candidates, "windows")).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ sourceThreadId: "thread-two" }),
      }),
    ]);
    expect(
      filterExternalChatImportCandidates(candidates, "studio mac"),
    ).toHaveLength(2);
    expect(selectableExternalChatCandidateKeys(candidates)).toEqual([
      candidates[1]!.key,
    ]);
    expect(chatImportIdempotencyKey(candidates[1]!)).toMatch(/^codex:/u);
    expect(chatImportIdempotencyKey(candidates[1]!).length).toBeLessThanOrEqual(
      200,
    );

    const importedElsewhere: ProjectExternalChatDiscovery =
      structuredClone(discovery);
    importedElsewhere.workers[0]!.sources[0]!.threads[1]!.existingImport = {
      jobId: "00000000-0000-4000-8000-000000000009",
      projectId: "project-two",
      chatId: "chat-two",
      state: "succeeded",
    };
    const crossProjectCandidates = externalChatImportCandidates(
      importedElsewhere,
      [importJob()],
    );
    expect(selectableExternalChatCandidateKeys(crossProjectCandidates)).toEqual(
      [],
    );
    expect(
      renderToStaticMarkup(
        <ExternalChatCandidateRow
          candidate={crossProjectCandidates[1]!}
          checked={false}
          disabled
          matchedWorktreeLabel="Matched by Git origin"
          onCheckedChange={vi.fn()}
        />,
      ),
    ).toContain("Imported to the selected project");
  });

  it("summarizes live progress and exposes retry and navigation actions", () => {
    const active = importJob({
      id: "00000000-0000-4000-8000-000000000003",
      chatId: "chat-active",
      state: "hydrating",
      managedThreadId: null,
      completedAt: null,
      progress: {
        stage: "hydrating",
        percent: 80,
        updatedAt: now,
      },
    });
    const blocked = importJob({
      id: "00000000-0000-4000-8000-000000000002",
      state: "blocked",
      managedThreadId: null,
      error: {
        code: "worker-offline",
        retryable: true,
      },
      progress: {
        stage: "blocked",
        percent: 75,
        updatedAt: now,
      },
    });
    expect(summarizeChatImportJobs([importJob(), blocked, active])).toEqual({
      active: 1,
      failed: 1,
      succeeded: 1,
    });
    const markup = renderToStaticMarkup(
      <ImportJobRow
        job={blocked}
        pendingRetry={false}
        onOpenChat={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(markup).toContain("Open transcript");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Imported with limitations");
    expect(markup).toContain(
      "Transcript history was preserved and can be opened.",
    );
    expect(markup).not.toContain("The destination worker is offline.");
    const activeMarkup = renderToStaticMarkup(
      <ImportJobRow
        job={active}
        pendingRetry={false}
        onOpenChat={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(activeMarkup).toContain("Preparing resumable chat");
    expect(activeMarkup).toContain("width:80%");
    expect(activeMarkup).toContain("Open transcript");
    const readyMarkup = renderToStaticMarkup(
      <ImportJobRow
        job={importJob()}
        pendingRetry={false}
        onOpenChat={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(readyMarkup).toContain("Open chat");
  });

  it("gates discovery to desktop and renders the found card from metadata", () => {
    const render = (desktopRuntime: boolean) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(
        ["external-chat-history", project.id, false],
        discovery,
      );
      queryClient.setQueryData(["chat-import-jobs", project.id], [importJob()]);
      return renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <ExternalChatImportSettings
            desktopRuntime={desktopRuntime}
            project={project}
            workers={[{ name: "Studio Mac", workerId: "worker-one" }]}
            worktrees={[worktree]}
            onOpenChat={vi.fn()}
          />
        </QueryClientProvider>,
      );
    };

    expect(render(false)).toBe("");
    const markup = render(true);
    expect(markup).toContain("ChatGPT Codex found");
    expect(markup).toContain("2 chats match this project");
    expect(markup).toContain("1 imported");
    expect(markup).toContain("Import chats");
  });
});
