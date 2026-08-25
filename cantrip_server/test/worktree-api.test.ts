import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cantripCliCommandResultSchema,
  appLiveServerMessageSchema,
  chatPauseStateSchema,
  chatSummarySchema,
  chatMessageListSchema,
  chatMessageWireListSchema,
  encryptedChatTurnCreateSchema,
  codeProtectedAttachmentIntentSchema,
  codeSessionListSchema,
  codeSessionSummarySchema,
  codeTabSummarySchema,
  codeTabWireSummarySchema,
  explorerSummarySchema,
  explorerWireSummarySchema,
  gitActionResultSchema,
  gitBranchActionPreviewSchema,
  gitBranchListSchema,
  gitBranchMutationResultSchema,
  gitCommitDetailSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitConflictDetailSchema,
  gitConflictListSchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionResultSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationResponseSchema,
  gitComparisonSchema,
  gitFileDiffSchema,
  gitForcePushPreviewSchema,
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
  gitHistorySchema,
  gitLfsActionPreviewSchema,
  gitLfsMutationResultSchema,
  gitLfsStatusSchema,
  gitPartialPatchPreviewSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateListSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteListSchema,
  gitRemoteMutationResultSchema,
  gitStashActionPreviewSchema,
  gitStashFileDiffSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleListSchema,
  gitSubmoduleMutationResultSchema,
  gitTagActionPreviewSchema,
  gitTagDetailSchema,
  gitTagListSchema,
  gitTagMutationResultSchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  projectViewSummarySchema,
  projectWorktreeListSchema,
  projectWorktreeSummarySchema,
  queuedPromptSchema,
  standaloneChatShareAttachmentWireSchema,
  standaloneChatWireSummarySchema,
  terminalSummarySchema,
  terminalWireSummarySchema,
  unprobedCodexRuntimeReport,
  worktreeStatusResultSchema,
  type WorkerWorktreeSummary,
  type WorkerCommand,
  type GitManagedOperationContext,
  type ThreadGoal,
  type AppLiveServerMessage,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import { CodeTunnelBroker } from "../src/code/tunnel.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { DirectAttachmentCoordinator } from "../src/direct-attachments/coordinator.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedDisplayLabelFields,
  protectedExplorerFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worktree-api-"),
);
const primaryPath = path.join(dataDirectory, "repositories", "Cantrip");
const externalPath = path.join(dataDirectory, "external", "review");
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

let connected = true;
let activeCreates = 0;
let maximumConcurrentCreates = 0;
let activeGitMutations = 0;
let maximumConcurrentGitMutations = 0;
let activeRepositoryOperations = 0;
let maximumConcurrentRepositoryOperations = 0;
let repositoryOperationDelayMs = 0;
const gitActionPaths: string[] = [];
const gitDiffCommands: Array<Extract<WorkerCommand, { type: "git.diff" }>> = [];
const repositoryOperationCommands: Array<
  Extract<WorkerCommand, { type: "repository.operation" }>
> = [];
const runConfigurationDefinitionCommands: Array<
  Extract<
    WorkerCommand,
    { type: "project.run-configuration-definitions.write" }
  >
> = [];
const runConfigurationStopCommands: Array<
  Extract<WorkerCommand, { type: "project.run-configuration-runtime.stop" }>
> = [];
const gitPatchPreviewCommands: Array<
  Extract<WorkerCommand, { type: "git.patch.preview" }>
> = [];
const gitPatchApplyCommands: Array<
  Extract<WorkerCommand, { type: "git.patch.apply" }>
> = [];
const gitStashCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.stash.list"
        | "git.stash.create"
        | "git.stash.diff"
        | "git.stash.action.preview"
        | "git.stash.action.apply";
    }
  >
> = [];
const gitBranchCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.branch.list"
        | "git.branch.action.preview"
        | "git.branch.action.apply";
    }
  >
> = [];
const gitRemoteCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.remote.list"
        | "git.remote.action.preview"
        | "git.remote.action.apply";
    }
  >
> = [];
const gitSubmoduleCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.submodule.list"
        | "git.submodule.action.preview"
        | "git.submodule.action.apply";
    }
  >
> = [];
const gitLfsCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        "git.lfs.status" | "git.lfs.action.preview" | "git.lfs.action.apply";
    }
  >
> = [];
const gitTagCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.tag.list"
        | "git.tag.get"
        | "git.tag.action.preview"
        | "git.tag.action.apply";
    }
  >
> = [];
const githubReleaseCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        "github.releases.list" | "github.release.get" | "github.release.create";
    }
  >
> = [];
const gitHistoryCommands: Array<
  Extract<WorkerCommand, { type: "git.history" }>
> = [];
const gitGraphCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        "git.graph.commit-overlay" | "git.graph.metrics" | "git.graph.snapshot";
    }
  >
> = [];
const gitCommitCommands: Array<
  Extract<WorkerCommand, { type: "git.commit.get" }>
> = [];
const gitCommitSignatureCommands: Array<
  Extract<WorkerCommand, { type: "git.commit.signature.get" }>
> = [];
const gitCommitActionCommands: Array<
  Extract<
    WorkerCommand,
    { type: "git.commit.action.preview" | "git.commit.action.apply" }
  >
> = [];
const gitManagedOperationCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.operation.preview"
        | "git.operation.start"
        | "git.operation.inspect"
        | "git.operation.control";
    }
  >
> = [];
const gitForcePushCommands: Array<
  Extract<
    WorkerCommand,
    { type: "git.force-push.preview" | "git.force-push.apply" }
  >
> = [];
const gitConflictCommands: Array<
  Extract<
    WorkerCommand,
    {
      type:
        | "git.conflicts.list"
        | "git.conflicts.get"
        | "git.conflicts.preview"
        | "git.conflicts.apply";
    }
  >
> = [];
let managedOperationState:
  "conflicted" | "awaiting-user-action" | "completed" | "aborted" =
  "conflicted";
let stashActionConflicts = false;
const gitRevisionDiffCommands: Array<
  Extract<WorkerCommand, { type: "git.revision.diff" }>
> = [];
const gitCompareCommands: Array<
  Extract<WorkerCommand, { type: "git.compare" }>
> = [];
const gitRefsCommands: Array<
  Extract<WorkerCommand, { type: "git.refs.list" }>
> = [];
const chatTurnCommands: Array<Extract<WorkerCommand, { type: "chat.turn" }>> =
  [];
const standaloneChatTurnCommands: Array<
  Extract<WorkerCommand, { type: "chat.turn" }>
> = [];
const standaloneChatFileOperationCommands: Array<
  Extract<WorkerCommand, { type: "chat.scratch.files.operation" }>
> = [];
const chatPauseCommands: Array<
  Extract<WorkerCommand, { type: "chat.pause.set" }> & {
    timeoutMs: number | null | undefined;
  }
> = [];
const codeEditorBuild = {
  version: "1.109.5",
  upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
  patchset: 1,
  fingerprint: "a".repeat(64),
};
function protectedTunnelRecord(operationId: string) {
  return {
    operationId,
    revision: 1,
    protectedContent: {
      formatVersion: 1,
      domain: "tunnel-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}
const codeOpenCommands: Array<Extract<WorkerCommand, { type: "code.open" }>> =
  [];
const codeStopSessionIds: string[] = [];
const codeStopCommands: Array<Extract<WorkerCommand, { type: "code.stop" }>> =
  [];
const codeStopTimeouts: Array<number | null | undefined> = [];
const codeSessionIncarnationId = "755f30a1-866d-4969-aa91-6e0f28676753";
const codeStatusSessionIds: string[] = [];
const codeEndpointRevokedTunnelIds: string[] = [];
const directPrepareCapabilityIds: string[] = [];
const directRevokeCapabilityIds: string[] = [];
const projectShareOpenIds: string[] = [];
const projectShareOpenCommands: Array<
  Extract<WorkerCommand, { type: "project.share.open" }>
> = [];
const projectShareCloseIds: string[] = [];
const terminalOpenCommands: Array<
  Extract<WorkerCommand, { type: "terminal.open" }>
> = [];
const terminalCloseIds: string[] = [];
let heldCodeOpen: { release: Promise<void>; started(): void } | undefined;
let heldTerminalOpen: { release: Promise<void>; started(): void } | undefined;

function holdNextProtectedAttachmentCreation(): {
  release(): void;
  restore(): void;
  started: Promise<void>;
} {
  const originalCreate = CodeTunnelBroker.prototype.createProtectedAttachment;
  let signalStarted!: () => void;
  let releaseCreation!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const creationRelease = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  const spy = vi
    .spyOn(CodeTunnelBroker.prototype, "createProtectedAttachment")
    .mockImplementationOnce(async function (input) {
      const attachment = await originalCreate.call(this, input);
      signalStarted();
      await creationRelease;
      return attachment;
    });
  return {
    release: releaseCreation,
    restore: () => spy.mockRestore(),
    started,
  };
}
let activeChatGoal: ThreadGoal | null = null;
let cliInvocation: {
  arguments: Record<string, unknown>;
  command: "worktree.switch";
} | null = null;
let workerWorktrees: WorkerWorktreeSummary[] = [
  {
    path: primaryPath,
    head: "1111111111111111111111111111111111111111",
    branch: "main",
    detached: false,
    isPrimary: true,
    managed: true,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  },
];

function inventory() {
  return {
    sourcePath: primaryPath,
    primaryPath,
    gitCommonDir: path.join(primaryPath, ".git"),
    managedRoot: path.join(dataDirectory, "worktrees", "fingerprint"),
    repositoryFingerprint: "a".repeat(64),
    worktrees: workerWorktrees.map((worktree) => ({ ...worktree })),
  };
}

function status(branch = "main") {
  return {
    branch,
    head: "1111111111111111111111111111111111111111",
    upstream: branch === "main" ? "origin/main" : null,
    ahead: 0,
    behind: 0,
    files: [],
    branches: [
      {
        name: branch,
        kind: "local" as const,
        current: true,
        hash: "1111111111111111111111111111111111111111",
        upstream: branch === "main" ? "origin/main" : null,
      },
    ],
  };
}

function protectedStandaloneTurn(
  modelId: string,
  mode: "default" | "plan" = "default",
) {
  const idempotencyKey = `standalone-turn-${randomUUID()}`;
  const protectedContent = {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  };
  const message = {
    id: randomUUID(),
    classification: {
      role: "user" as const,
      mode,
      attachmentIds: [] as string[],
    },
    protectedContent,
    reasoningEffort: null,
    idempotencyKey,
  };
  return encryptedChatTurnCreateSchema.parse({
    message,
    modelId,
    queuedPrompt: {
      id: randomUUID(),
      classification: { mode, attachmentIds: [] },
      protectedContent,
      modelId,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
      worktreeId: null,
      frozen: false,
      idempotencyKey,
      pendingMessage: message,
    },
  });
}

const stashFixture = {
  ref: "stash@{0}",
  hash: "9".repeat(40),
  shortHash: "9".repeat(8),
  message: "Review work",
  createdAt: "2026-08-10T12:00:00.000Z",
  baseHash: "1".repeat(40),
  files: [
    {
      path: "src/app.ts",
      additions: 1,
      deletions: 1,
      binary: false,
    },
  ],
  filesChanged: 1,
  filesTruncated: false,
  additions: 1,
  deletions: 1,
  includesUntracked: false,
};

const branchFixture = {
  name: "main",
  fullRef: "refs/heads/main",
  kind: "local" as const,
  current: true,
  hash: "1".repeat(40),
  upstream: "origin/main",
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  mergedIntoHead: true,
  remoteName: "origin",
  remoteAvailable: true,
  trackingLocalBranches: [],
  worktree: { label: "Cantrip", current: true },
  lastCommit: {
    hash: "1".repeat(40),
    shortHash: "1".repeat(8),
    subject: "Initial",
    authorName: "Cantrip",
    authoredAt: "2026-08-10T12:00:00.000Z",
  },
};

function branchList() {
  return {
    currentBranch: "main",
    head: "1".repeat(40),
    detached: false,
    defaultRemote: "origin",
    remotes: ["origin"],
    pullStrategy: {
      mode: "fast-forward-only" as const,
      description: "Cantrip pulls with --ff-only.",
    },
    branches: [branchFixture],
    truncated: false,
    generatedAt: "2026-08-10T12:00:00.000Z",
  };
}

const managedOperationAction = {
  type: "rebase" as const,
  sourceRef: "origin/main",
};
const managedOperationContext = {
  type: "rebase" as const,
  originalHead: "1".repeat(40),
  sourceRef: "origin/main",
  sourceRevision: "2".repeat(40),
  targetRef: "refs/heads/main",
  targetRevision: "1".repeat(40),
  pendingCommits: ["3".repeat(40)],
  totalSteps: 1,
  checkpointRef: "refs/cantrip/checkpoints/rebase-test",
};
const submoduleFixture = {
  name: "library",
  path: "modules/library",
  url: "https://github.com/ArcaneArts/library.git",
  branch: "main",
  expectedHash: "5".repeat(40),
  currentHash: null,
  initialized: false,
  dirty: false,
  nested: false,
  state: "uninitialized" as const,
};
const lfsStatusFixture = {
  available: true,
  version: "git-lfs/3.7.0",
  message: null,
  patterns: [{ pattern: "*.bin", source: ".gitattributes" }],
  files: [
    {
      path: "asset.bin",
      oid: "6".repeat(64),
      size: 42,
      checkedOut: true,
      downloaded: true,
      status: null,
    },
  ],
  filesTruncated: false,
  missingObjects: 0,
  pendingPaths: [],
  locks: [],
  locksTruncated: false,
  locksCached: true,
  lockError: null,
  generatedAt: "2026-08-10T12:00:00.000Z",
};

function managedWorkerState(
  context: GitManagedOperationContext = managedOperationContext,
) {
  const terminal = ["completed", "aborted"].includes(managedOperationState);
  return {
    ...context,
    state: managedOperationState,
    currentHead: terminal ? "4".repeat(40) : "1".repeat(40),
    currentStep: terminal ? 1 : 1,
    pendingCommits: terminal ? [] : context.pendingCommits,
    conflictedPaths:
      managedOperationState === "conflicted" ? ["src/app.ts"] : [],
    output:
      managedOperationState === "conflicted"
        ? "CONFLICT in src/app.ts"
        : managedOperationState,
    pausedAction:
      managedOperationState === "awaiting-user-action" &&
      context.checkpointRef?.includes("/rewrite-")
        ? ("edit" as const)
        : null,
    status: {
      ...status(),
      head: terminal ? "4".repeat(40) : "1".repeat(40),
      files:
        managedOperationState === "conflicted"
          ? [
              {
                path: "src/app.ts",
                originalPath: null,
                indexStatus: "U",
                worktreeStatus: "U",
                staged: true,
                unstaged: true,
              },
            ]
          : [],
    },
  };
}

const remoteFixture = {
  name: "origin",
  fetchUrl: "https://github.com/ArcaneArts/Cantrip.git",
  fetchUrlRedacted: false,
  pushUrl: "git@github.com:ArcaneArts/Cantrip.git",
  pushUrlRedacted: false,
  defaultFetch: true,
  defaultPush: true,
};

function remoteList() {
  return {
    remotes: [remoteFixture],
    generatedAt: "2026-08-10T12:00:00.000Z",
  };
}

const tagFixture = {
  name: "v1.0.0",
  hash: "2".repeat(40),
  targetHash: "1".repeat(40),
  targetType: "commit" as const,
  annotated: true,
  subject: "Cantrip 1.0.0",
  taggerName: "Cantrip",
  createdAt: "2026-08-10T12:00:00.000Z",
  signature: {
    status: "valid" as const,
    signer: "Cantrip <test@cantrip.art>",
    key: "ABC123",
    fingerprint: "DEF456",
    format: "ssh" as const,
    verification: "available" as const,
    verificationMessage: "Good SSH signature",
  },
  publishedRemotes: ["origin"],
};

function tagList() {
  return {
    tags: [tagFixture],
    truncated: false,
    remoteChecks: [{ remote: "origin", available: true, error: null }],
    generatedAt: "2026-08-10T12:00:00.000Z",
  };
}

const releaseFixture = {
  id: 42,
  tagName: "v1.0.0",
  name: "Cantrip 1.0.0",
  body: "Release notes",
  url: "https://github.com/ArcaneArts/Cantrip/releases/tag/v1.0.0",
  author: "cantrip-bot",
  draft: false,
  prerelease: false,
  createdAt: "2026-08-10T12:00:00.000Z",
  publishedAt: "2026-08-10T12:01:00.000Z",
};

async function completeGitMutation(output: string) {
  activeGitMutations += 1;
  maximumConcurrentGitMutations = Math.max(
    maximumConcurrentGitMutations,
    activeGitMutations,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeGitMutations -= 1;
  return { status: status(), output };
}

async function completeStashMutation<T>(result: T): Promise<T> {
  activeGitMutations += 1;
  maximumConcurrentGitMutations = Math.max(
    maximumConcurrentGitMutations,
    activeGitMutations,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeGitMutations -= 1;
  return result;
}

const workerBridge = {
  attach() {},
  close() {},
  isConnected() {
    return connected;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command, options) {
    if (!connected) throw new WorkerUnavailableError("Worker is offline.");
    switch (command.type) {
      case "repository.operation":
        repositoryOperationCommands.push(command);
        activeRepositoryOperations += 1;
        maximumConcurrentRepositoryOperations = Math.max(
          maximumConcurrentRepositoryOperations,
          activeRepositoryOperations,
        );
        try {
          if (repositoryOperationDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, repositoryOperationDelayMs),
            );
          }
          return {
            operationId: command.operationId,
            protectedResponse: command.protectedRequest,
          };
        } finally {
          activeRepositoryOperations -= 1;
        }
      case "worktree.list":
      case "worktree.reconcile":
        return inventory();
      case "project.run-configuration-definitions.write":
        runConfigurationDefinitionCommands.push(command);
        return {
          operation: "write",
          operationId: command.operationId,
          projectId: command.projectId,
          result: {
            outcome: "created",
            entry: {
              relativePath: `.cantrip/run-configurations/${command.request.document.id}.json`,
              revision: "c".repeat(64),
              id: command.request.document.id,
              status: "ready",
              document: command.request.document,
              diagnostics: [],
            },
          },
        };
      case "project.run-configuration-runtime.stop":
        runConfigurationStopCommands.push(command);
        return {
          outcome: "accepted",
          observation: {
            ...command.identity,
            state: "idle",
            startedAt: "2026-08-24T02:00:00.000Z",
            endedAt: "2026-08-24T02:01:00.000Z",
            exitCode: null,
            signal: "SIGTERM",
            failure: null,
          },
        };
      case "worktree.create": {
        activeCreates += 1;
        maximumConcurrentCreates = Math.max(
          maximumConcurrentCreates,
          activeCreates,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const branch =
          command.mode.type === "detached" ? null : command.mode.branch;
        const worktree: WorkerWorktreeSummary = {
          path: path.join(
            dataDirectory,
            "worktrees",
            `${command.name}-${command.worktreeId}`,
          ),
          head: "2222222222222222222222222222222222222222",
          branch,
          detached: command.mode.type === "detached",
          isPrimary: false,
          managed: true,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        };
        workerWorktrees.push(worktree);
        activeCreates -= 1;
        return { created: true, worktree, inventory: inventory() };
      }
      case "worktree.lock":
      case "worktree.unlock": {
        const worktree = workerWorktrees.find(
          (item) => item.path === command.worktreePath,
        );
        if (!worktree) throw new Error("Worktree not found.");
        worktree.locked = command.type === "worktree.lock";
        worktree.lockReason =
          command.type === "worktree.lock" ? command.reason : null;
        return { worktree: { ...worktree }, inventory: inventory() };
      }
      case "worktree.remove": {
        const index = workerWorktrees.findIndex(
          (item) => item.path === command.worktreePath,
        );
        if (index < 0) throw new Error("Worktree not found.");
        workerWorktrees.splice(index, 1);
        return { removedPath: command.worktreePath, inventory: inventory() };
      }
      case "worktree.prune":
        return { prunedPaths: [], inventory: inventory() };
      case "worktree.status": {
        const worktree = workerWorktrees.find(
          (item) => item.path === command.worktreePath,
        );
        if (!worktree) throw new Error("Worktree not found.");
        return { worktree, status: status(worktree.branch ?? "HEAD") };
      }
      case "git.history":
        gitHistoryCommands.push(command);
        return {
          branch: "main",
          head: "1111111111111111111111111111111111111111",
          totalCount: 1,
          commits: [
            {
              hash: "1111111111111111111111111111111111111111",
              shortHash: "1111111",
              parents: [],
              subject: "Initial commit",
              authorName: "Cantrip",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-08T12:00:00.000Z",
              refs: [{ name: "HEAD", kind: "head", current: true }],
              isHead: true,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.graph.snapshot":
        gitGraphCommands.push(command);
        return {
          analyzerVersion: 1,
          revision: "1".repeat(40),
          branch: "main",
          rootPath: command.rootPath,
          rootId: "directory:.",
          totalNodes: 2,
          truncated: false,
          analyzedAt: "2026-08-19T12:00:00.000Z",
          analysis: {
            structure: "ready",
            lines: "pending",
            history: "pending",
            blame: "deferred",
          },
          nodes: [
            {
              id: "directory:.",
              path: null,
              parentId: null,
              name: "Cantrip",
              kind: "directory",
              objectId: "2".repeat(40),
              byteSize: 12,
              extension: null,
              language: null,
            },
            {
              id: "file:README.md",
              path: "README.md",
              parentId: "directory:.",
              name: "README.md",
              kind: "file",
              objectId: "3".repeat(40),
              byteSize: 12,
              extension: "md",
              language: "Markdown",
            },
          ],
        };
      case "git.graph.metrics":
        gitGraphCommands.push(command);
        return {
          analyzerVersion: 1,
          revision: "1".repeat(40),
          rootPath: command.rootPath,
          historyScope: "current-branch",
          renameAware: false,
          analyzedAt: "2026-08-19T12:00:01.000Z",
          analysis: {
            structure: "ready",
            lines: "ready",
            history: "ready",
            blame: "deferred",
          },
          nodes: [
            {
              nodeId: "directory:.",
              path: null,
              lineCount: 1,
              binary: false,
              commitTouches: 1,
              additions: 1,
              deletions: 0,
              churn: 1,
              binaryCommitTouches: 0,
              firstChangedAt: "2026-08-19T12:00:00.000Z",
              lastChangedAt: "2026-08-19T12:00:00.000Z",
              dominantAuthorName: null,
              dominantAuthorEmail: null,
              dominantAuthorShare: null,
              averageBlameAgeDays: null,
            },
            {
              nodeId: "file:README.md",
              path: "README.md",
              lineCount: 1,
              binary: false,
              commitTouches: 1,
              additions: 1,
              deletions: 0,
              churn: 1,
              binaryCommitTouches: 0,
              firstChangedAt: "2026-08-19T12:00:00.000Z",
              lastChangedAt: "2026-08-19T12:00:00.000Z",
              dominantAuthorName: null,
              dominantAuthorEmail: null,
              dominantAuthorShare: null,
              averageBlameAgeDays: null,
            },
          ],
        };
      case "git.graph.commit-overlay":
        gitGraphCommands.push(command);
        return {
          revision: command.revision,
          baseRevision: "0".repeat(40),
          rootPath: command.rootPath,
          nodes: [
            {
              path: "README.md",
              originalPath: null,
              status: "modified",
              additions: 4,
              deletions: 2,
              weight: 6,
              binary: false,
              ghost: false,
            },
          ],
          filesChanged: 1,
          additions: 4,
          deletions: 2,
          truncated: false,
        };
      case "git.commit.get":
        gitCommitCommands.push(command);
        return {
          hash: command.revision,
          shortHash: command.revision.slice(0, 8),
          subject: "Initial commit",
          message: "Initial commit\n\nCommit inspector fixture.",
          messageTruncated: false,
          parents: [],
          children: [],
          parentIndex: null,
          baseHash: null,
          author: {
            name: "Cantrip",
            email: "test@cantrip.art",
            date: "2026-08-08T12:00:00.000Z",
          },
          committer: {
            name: "Cantrip",
            email: "test@cantrip.art",
            date: "2026-08-08T12:00:00.000Z",
          },
          signature: {
            status: "unsigned",
            signer: null,
            key: null,
            fingerprint: null,
            format: null,
            verification: "not-applicable",
            verificationMessage: null,
          },
          refs: [{ name: "HEAD", kind: "head", current: true }],
          files: [
            {
              path: "src/app.ts",
              originalPath: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              binary: false,
            },
          ],
          filesTruncated: false,
          filesChanged: 1,
          additions: 1,
          deletions: 1,
        };
      case "git.commit.signature.get":
        gitCommitSignatureCommands.push(command);
        return {
          status: "valid",
          signer: "Cantrip Test",
          key: "test-key",
          fingerprint: "test-fingerprint",
          format: "gpg",
          verification: "available",
          verificationMessage: "Good signature",
        };
      case "git.commit.action.preview": {
        gitCommitActionCommands.push(command);
        const revisions =
          command.action.type === "cherryPick"
            ? command.action.selection.type === "commits"
              ? command.action.selection.revisions
              : [
                  command.action.selection.fromRevision,
                  command.action.selection.toRevision,
                ]
            : command.action.type === "amend"
              ? ["1".repeat(40)]
              : [command.action.revision];
        return completeStashMutation({
          action: command.action,
          token: "c".repeat(64),
          destructive:
            command.action.type === "revert" || command.action.type === "amend",
          summary: "Review commit action.",
          warnings: [],
          resolvedRevisions: revisions,
          commits: revisions.map((revision) => ({
            hash: revision,
            shortHash: revision.slice(0, 8),
            subject: "Selected commit",
            authorName: "Cantrip",
            authoredAt: "2026-08-10T12:00:00.000Z",
          })),
          files: [],
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          patchTruncated: false,
          wouldConflict: false,
          checkpointRef:
            command.action.type === "amend"
              ? "refs/cantrip/checkpoints/amend-test"
              : null,
        });
      }
      case "git.commit.action.apply": {
        gitCommitActionCommands.push(command);
        const revisions =
          command.action.type === "cherryPick"
            ? command.action.selection.type === "commits"
              ? command.action.selection.revisions
              : [
                  command.action.selection.fromRevision,
                  command.action.selection.toRevision,
                ]
            : command.action.type === "amend"
              ? ["1".repeat(40)]
              : [command.action.revision];
        return completeStashMutation({
          output: "commit action complete",
          status: status(),
          headBefore: "1".repeat(40),
          headAfter: "2".repeat(40),
          checkpointRef:
            command.action.type === "amend"
              ? "refs/cantrip/checkpoints/amend-test"
              : null,
          operation:
            command.action.type === "cherryPick" ||
            command.action.type === "revert"
              ? {
                  type:
                    command.action.type === "cherryPick"
                      ? "cherry-pick"
                      : "revert",
                  state: "completed",
                  originalHead: "1".repeat(40),
                  currentHead: "2".repeat(40),
                  sourceRevisions: revisions,
                  currentStep: revisions.length,
                  totalSteps: revisions.length,
                  conflictedPaths: [],
                }
              : null,
        });
      }
      case "git.operation.preview": {
        gitManagedOperationCommands.push(command);
        const operationSourceRef =
          command.action.type === "interactiveRebase"
            ? command.action.upstreamRef
            : command.action.type === "bisect"
              ? command.action.goodRef
              : command.action.sourceRef;
        const operationType =
          command.action.type === "merge"
            ? "merge"
            : command.action.type === "bisect"
              ? "bisect"
              : "rebase";
        const operationContext: GitManagedOperationContext =
          command.action.type === "bisect"
            ? {
                type: "bisect",
                originalHead: "1".repeat(40),
                sourceRef: command.action.goodRef,
                sourceRevision: "2".repeat(40),
                targetRef: command.action.badRef,
                targetRevision: "4".repeat(40),
                pendingCommits: ["3".repeat(40)],
                totalSteps: 1,
                checkpointRef: "refs/cantrip/checkpoints/bisect-test",
              }
            : {
                ...managedOperationContext,
                type: operationType,
                sourceRef: operationSourceRef,
                checkpointRef:
                  command.action.type === "interactiveRebase"
                    ? "refs/cantrip/checkpoints/rewrite-test"
                    : command.action.type === "rebase"
                      ? managedOperationContext.checkpointRef
                      : null,
              };
        return completeStashMutation({
          action: command.action,
          token: "d".repeat(64),
          destructive: command.action.type !== "merge",
          summary: "Review managed Git operation.",
          warnings: [],
          context: operationContext,
          commits: [
            {
              hash: "3".repeat(40),
              shortHash: "3".repeat(8),
              subject: "Pending commit",
              authorName: "Cantrip",
              authoredAt: "2026-08-10T12:00:00.000Z",
            },
          ],
          files: [
            {
              path: "src/app.ts",
              originalPath: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              binary: false,
            },
          ],
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          patchTruncated: false,
          wouldConflict: true,
          todo:
            command.action.type === "interactiveRebase"
              ? command.action.todo
              : [],
          todoText:
            command.action.type === "interactiveRebase"
              ? command.action.todo
                  .map(
                    (item) => `${item.action} ${item.revision} Pending commit`,
                  )
                  .join("\n")
              : "",
        });
      }
      case "git.operation.start": {
        gitManagedOperationCommands.push(command);
        managedOperationState =
          command.action.type === "interactiveRebase" ||
          command.action.type === "bisect"
            ? "awaiting-user-action"
            : "conflicted";
        const startContext =
          command.action.type === "interactiveRebase"
            ? {
                ...managedOperationContext,
                sourceRef: command.action.upstreamRef,
                checkpointRef: "refs/cantrip/checkpoints/rewrite-test",
              }
            : command.action.type === "bisect"
              ? {
                  type: "bisect" as const,
                  originalHead: "1".repeat(40),
                  sourceRef: command.action.goodRef,
                  sourceRevision: "2".repeat(40),
                  targetRef: command.action.badRef,
                  targetRevision: "4".repeat(40),
                  pendingCommits: ["3".repeat(40)],
                  totalSteps: 1,
                  checkpointRef: "refs/cantrip/checkpoints/bisect-test",
                }
              : managedOperationContext;
        return completeStashMutation(managedWorkerState(startContext));
      }
      case "git.operation.inspect":
        gitManagedOperationCommands.push(command);
        return managedWorkerState(command.context);
      case "git.operation.control":
        gitManagedOperationCommands.push(command);
        managedOperationState =
          command.context.type === "bisect"
            ? command.action === "abort"
              ? "aborted"
              : command.action === "reset"
                ? "completed"
                : "awaiting-user-action"
            : command.action === "abort"
              ? "aborted"
              : "completed";
        return completeStashMutation(managedWorkerState(command.context));
      case "git.operation.amend":
        gitManagedOperationCommands.push(command);
        managedOperationState = "completed";
        return completeStashMutation(managedWorkerState(command.context));
      case "git.conflicts.list":
        gitConflictCommands.push(command);
        return {
          files:
            managedOperationState === "conflicted"
              ? [
                  {
                    path: "src/app.ts",
                    code: "UU",
                    kind: "both-modified",
                    baseAvailable: true,
                    oursAvailable: true,
                    theirsAvailable: true,
                  },
                ]
              : [],
          truncated: false,
        };
      case "git.conflicts.get": {
        gitConflictCommands.push(command);
        const stage = {
          available: true,
          oid: "1".repeat(40),
          mode: "100644",
          size: 5,
          binary: false,
          content: "ours\n",
          truncated: false,
        };
        return {
          path: command.path,
          code: "UU",
          kind: "both-modified",
          baseAvailable: true,
          oursAvailable: true,
          theirsAvailable: true,
          base: stage,
          ours: stage,
          theirs: { ...stage, oid: "2".repeat(40), content: "theirs\n" },
          result: {
            exists: true,
            oid: "3".repeat(40),
            size: 42,
            binary: false,
            content: "<<<<<<< ours\n=======\n>>>>>>> theirs\n",
            truncated: false,
          },
        };
      }
      case "git.conflicts.preview":
        gitConflictCommands.push(command);
        return {
          request: command.request,
          token: "e".repeat(64),
          resultDeleted: false,
          resultBinary: false,
          resultContent: command.request.content ?? "ours\n",
          warnings: [],
        };
      case "git.conflicts.apply":
        gitConflictCommands.push(command);
        managedOperationState = "awaiting-user-action";
        return {
          path: command.request.path,
          resolved: true,
          remainingPaths: [],
          status: {
            ...status(),
            files: [
              {
                path: command.request.path,
                originalPath: null,
                indexStatus: "M",
                worktreeStatus: " ",
                staged: true,
                unstaged: false,
              },
            ],
          },
        };
      case "git.refs.list":
        gitRefsCommands.push(command);
        return [
          {
            revision: "1".repeat(40),
            hash: "1".repeat(40),
            shortHash: "1".repeat(10),
            name: "main",
            kind: "local",
            current: true,
            worktreeId: null,
            worktreeName: null,
          },
        ];
      case "git.compare":
        gitCompareCommands.push(command);
        return {
          mode: command.mode,
          left: command.left,
          right: command.right,
          mergeBase: command.left,
          diffBase: command.mode === "direct" ? command.left : command.left,
          leftAhead: 0,
          rightAhead: 1,
          leftCommits: [],
          rightCommits: [
            {
              hash: command.right,
              shortHash: command.right.slice(0, 8),
              subject: "Compared change",
              authorName: "Cantrip",
              authoredAt: "2026-08-08T12:00:00.000Z",
            },
          ],
          leftCommitsTruncated: false,
          rightCommitsTruncated: false,
          files: [],
          filesTruncated: false,
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        };
      case "git.revision.diff":
        gitRevisionDiffCommands.push(command);
        return {
          revision: command.revision,
          baseRevision: command.baseRevision,
          path: command.path,
          originalPath: null,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
          binary: false,
        };
      case "git.action":
        gitActionPaths.push(command.cwd);
        return completeGitMutation("done");
      case "git.force-push.preview":
        gitForcePushCommands.push(command);
        return {
          token: "f".repeat(64),
          destructive: true,
          summary: "Replace origin/main with main using force-with-lease.",
          warnings: ["The lease is exact."],
          remote: "origin",
          localBranch: "main",
          remoteBranch: "main",
          localHead: "4".repeat(40),
          expectedRemoteHead: "3".repeat(40),
          localCommits: [],
          localCommitCount: 1,
          localCommitsTruncated: false,
          remoteCommits: [],
          remoteCommitCount: 1,
          remoteCommitsTruncated: false,
        };
      case "git.force-push.apply":
        gitForcePushCommands.push(command);
        return completeGitMutation("forced with lease");
      case "git.diff":
        gitDiffCommands.push(command);
        return {
          path: command.path,
          scope: command.scope,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        };
      case "git.patch.preview":
        gitPatchPreviewCommands.push(command);
        return {
          operation: command.request.operation,
          path: command.request.path,
          scope:
            command.request.operation === "unstage" ? "staged" : "unstaged",
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          token: "a".repeat(64),
          selectedHunks: command.request.hunks.length,
          selectedLines: 2,
          warnings: [],
        };
      case "git.patch.apply":
        gitPatchApplyCommands.push(command);
        return completeGitMutation("applied");
      case "git.stash.list":
        gitStashCommands.push(command);
        return { stashes: [stashFixture], truncated: false };
      case "git.stash.create":
        gitStashCommands.push(command);
        return completeStashMutation({
          output: "saved",
          status: status(),
          stash: { ...stashFixture, message: command.request.message },
          conflictedPaths: [],
        });
      case "git.stash.diff":
        gitStashCommands.push(command);
        return {
          hash: command.hash,
          path: command.path,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
          binary: false,
        };
      case "git.stash.action.preview":
        gitStashCommands.push(command);
        return {
          action: command.action,
          stashes: [stashFixture],
          destructive: command.action.type !== "apply",
          token: "e".repeat(64),
          warnings: [],
        };
      case "git.stash.action.apply":
        gitStashCommands.push(command);
        return completeStashMutation({
          output: "stash action complete",
          status: stashActionConflicts
            ? {
                ...status(),
                files: [
                  {
                    path: "src/app.ts",
                    originalPath: null,
                    indexStatus: "U",
                    worktreeStatus: "U",
                    staged: true,
                    unstaged: true,
                  },
                ],
              }
            : status(),
          stash: command.action.type === "apply" ? stashFixture : null,
          conflictedPaths: stashActionConflicts ? ["src/app.ts"] : [],
          operation: stashActionConflicts
            ? {
                type: "stash",
                state: "conflicted",
                originalHead: "1".repeat(40),
                currentHead: "1".repeat(40),
                sourceRef: `pop:${stashFixture.ref}`,
                sourceRevision: stashFixture.hash,
                targetRef: "refs/heads/main",
                targetRevision: "1".repeat(40),
                pendingCommits: [stashFixture.hash],
                currentStep: 1,
                totalSteps: 1,
                checkpointRef: "refs/cantrip/checkpoints/stash-test-clean",
                conflictedPaths: ["src/app.ts"],
              }
            : null,
        });
      case "git.branch.list":
        gitBranchCommands.push(command);
        return branchList();
      case "git.branch.action.preview":
        gitBranchCommands.push(command);
        return {
          action: command.action,
          token: "f".repeat(64),
          destructive:
            command.action.type === "deleteLocal" ||
            command.action.type === "deleteRemote" ||
            (command.action.type === "fetch" && command.action.prune),
          summary: "Review branch action.",
          warnings: [],
          branch: "name" in command.action ? branchFixture : null,
        };
      case "git.branch.action.apply":
        gitBranchCommands.push(command);
        return completeStashMutation({
          output: "branch action complete",
          status: status(),
          branches: branchList(),
        });
      case "git.remote.list":
        gitRemoteCommands.push(command);
        return remoteList();
      case "git.remote.action.preview":
        gitRemoteCommands.push(command);
        return {
          action: command.action,
          token: "a".repeat(64),
          destructive:
            command.action.type === "remove" ||
            (command.action.type === "fetch" && command.action.prune),
          summary: "Review remote action.",
          warnings: [],
          remote:
            "name" in command.action && command.action.name === "origin"
              ? remoteFixture
              : null,
        };
      case "git.remote.action.apply":
        gitRemoteCommands.push(command);
        return completeStashMutation({
          output: "remote action complete",
          status: status(),
          remotes: remoteList(),
        });
      case "git.submodule.list":
        gitSubmoduleCommands.push(command);
        return {
          submodules: [submoduleFixture],
          truncated: false,
          generatedAt: "2026-08-10T12:00:00.000Z",
        };
      case "git.submodule.action.preview":
        gitSubmoduleCommands.push(command);
        return {
          action: command.action,
          token: "9".repeat(64),
          destructive: command.action.type === "deinitialize",
          summary: "Review submodule action.",
          warnings: [],
          targets: [submoduleFixture],
        };
      case "git.submodule.action.apply":
        gitSubmoduleCommands.push(command);
        return completeStashMutation({
          output: "submodule action complete",
          status: status(),
          submodules: {
            submodules: [
              {
                ...submoduleFixture,
                currentHash: submoduleFixture.expectedHash,
                initialized: true,
                state: "clean" as const,
              },
            ],
            truncated: false,
            generatedAt: "2026-08-10T12:00:00.000Z",
          },
        });
      case "git.lfs.status":
        gitLfsCommands.push(command);
        return lfsStatusFixture;
      case "git.lfs.action.preview":
        gitLfsCommands.push(command);
        return {
          action: command.action,
          token: "8".repeat(64),
          destructive:
            command.action.type === "prune" ||
            command.action.type === "untrack",
          summary: "Review Git LFS action.",
          warnings: [],
          status: lfsStatusFixture,
        };
      case "git.lfs.action.apply":
        gitLfsCommands.push(command);
        return completeStashMutation({
          output: "Git LFS action complete",
          status: status(),
          lfs: lfsStatusFixture,
        });
      case "git.tag.list":
        gitTagCommands.push(command);
        return tagList();
      case "git.tag.get":
        gitTagCommands.push(command);
        return {
          ...tagFixture,
          name: command.name,
          message: "Cantrip 1.0.0\n\nSigned release.",
          messageTruncated: false,
        };
      case "git.tag.action.preview":
        gitTagCommands.push(command);
        return {
          action: command.action,
          token: "b".repeat(64),
          destructive:
            command.action.type === "deleteLocal" ||
            command.action.type === "deleteRemote",
          summary: "Review tag action.",
          warnings: [],
          tag:
            "name" in command.action && command.action.name === tagFixture.name
              ? tagFixture
              : null,
        };
      case "git.tag.action.apply":
        gitTagCommands.push(command);
        return completeStashMutation({
          output: "tag action complete",
          status: status(),
          tags: tagList(),
        });
      case "github.releases.list":
        githubReleaseCommands.push(command);
        return { releases: [releaseFixture], truncated: false };
      case "github.release.get":
        githubReleaseCommands.push(command);
        return { ...releaseFixture, id: command.releaseId };
      case "github.release.create":
        githubReleaseCommands.push(command);
        return completeStashMutation({
          ...releaseFixture,
          name: command.request.name,
          tagName: command.request.tagName,
          body: command.request.body,
          draft: command.request.draft,
          prerelease: command.request.prerelease,
        });
      case "code.probe":
        return {
          capabilities: {
            available: true,
            version: codeEditorBuild.version,
            upstreamRevision: codeEditorBuild.upstreamRevision,
            patchset: codeEditorBuild.patchset,
            transport: "web-proxy",
            maxSessions: 4,
            reason: null,
          },
          editorBuild: codeEditorBuild,
        };
      case "code.open":
        codeOpenCommands.push(command);
        if (heldCodeOpen) {
          const held = heldCodeOpen;
          held.started();
          await held.release;
        }
        return {
          sessionId: command.sessionId,
          sessionIncarnationId: codeSessionIncarnationId,
          status: "running",
          editorBuild: codeEditorBuild,
          processInstanceId: "code-process-1",
          bridgeConnected: true,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: "2026-08-08T12:00:00.000Z",
          lastActivityAt: "2026-08-08T12:01:00.000Z",
          lastError: null,
        };
      case "code.status":
        codeStatusSessionIds.push(command.sessionId);
        return {
          sessionId: command.sessionId,
          sessionIncarnationId: codeSessionIncarnationId,
          status: "running",
          editorBuild: codeEditorBuild,
          processInstanceId: "code-process-1",
          bridgeConnected: true,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: "2026-08-08T12:00:00.000Z",
          lastActivityAt: "2026-08-08T12:01:00.000Z",
          lastError: null,
        };
      case "code.stop":
        codeStopCommands.push(command);
        codeStopTimeouts.push(options?.timeoutMs);
        codeStopSessionIds.push(command.sessionId);
        return {
          sessionId: command.sessionId,
          sessionIncarnationId: codeSessionIncarnationId,
          status: "stopped",
          editorBuild: codeEditorBuild,
          processInstanceId: null,
          bridgeConnected: false,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: null,
          lastActivityAt: "2026-08-08T12:02:00.000Z",
          lastError: null,
        };
      case "code.endpoint.revoke":
        codeEndpointRevokedTunnelIds.push(command.tunnelId);
        return { revoked: true };
      case "direct.capability.prepare":
        directPrepareCapabilityIds.push(command.binding.capabilityId);
        return { accepted: true, capabilityId: command.binding.capabilityId };
      case "direct.capability.revoke":
        directRevokeCapabilityIds.push(command.capabilityId);
        return { revoked: true };
      case "project.share.open":
        projectShareOpenIds.push(command.shareId);
        projectShareOpenCommands.push(command);
        return { accepted: true, shareId: command.shareId };
      case "project.share.close":
        projectShareCloseIds.push(command.shareId);
        return { accepted: true };
      case "terminal.open":
        terminalOpenCommands.push(command);
        if (heldTerminalOpen) {
          const held = heldTerminalOpen;
          held.started();
          await held.release;
        }
        options?.onEvent?.({ type: "terminal.ready" });
        return { status: "detached" };
      case "terminal.detach":
        return { accepted: true };
      case "terminal.close":
        terminalCloseIds.push(command.terminalId);
        return { accepted: true };
      case "code.prepareAgentTurn":
        return { prepared: true, sessions: [] };
      case "code.agentTurnState":
        return { notifiedSessions: 0, refreshed: [], conflicts: [] };
      case "chat.scratch.provision":
        return {
          status: "ready",
          jobId: command.jobId,
          attempt: command.attempt,
          rootId: command.rootId,
          chatId: command.chatId,
          path: `ctrr_${"a".repeat(43)}`,
          displayPath: `ctrr_${"b".repeat(43)}`,
          reused: false,
        };
      case "chat.scratch.reconcile":
        return {
          retainedRootIds: command.roots.map(({ rootId }) => rootId),
          missingRootIds: [],
          orphanedRootIds: [],
          dueRootIds: [],
        };
      case "chat.scratch.files.operation":
        standaloneChatFileOperationCommands.push(command);
        return {
          operationId: command.operationId,
          sequence: command.sequence,
          protectedResponse: command.protectedRequest,
        };
      case "chat.scratch.archive":
        return {
          rootId: command.rootId,
          chatId: command.chatId,
          archivedAt: command.archivedAt,
          archiveExpiresAt: command.archiveExpiresAt,
        };
      case "chat.scratch.restore":
        return {
          rootId: command.rootId,
          chatId: command.chatId,
          archivedAt: null,
          archiveExpiresAt: null,
        };
      case "chat.plan.set":
        return {
          mode: command.mode,
          threadId: command.threadId ?? `thread-${command.cwd}`,
        };
      case "chat.thread.ensure":
        return {
          threadId: command.threadId ?? `thread-${command.cwd}`,
        };
      case "chat.pause.set":
        chatPauseCommands.push({ ...command, timeoutMs: options?.timeoutMs });
        return { paused: command.paused };
      case "chat.message.protect":
        return {
          id: command.message.id,
          classification: {
            role: command.message.role,
            mode: command.message.mode ?? "default",
            attachmentIds: [],
          },
          protectedContent: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
            },
          },
          reasoningEffort: command.message.reasoningEffort ?? null,
          idempotencyKey: command.message.idempotencyKey,
        };
      case "chat.messages.reprotect":
        return command.messages.map(({ source, id, idempotencyKey }) => ({
          id,
          classification: {
            role: source.role,
            mode: source.mode,
            attachmentIds: source.attachmentIds,
          },
          protectedContent: source.protectedContent,
          reasoningEffort: source.reasoningEffort,
          idempotencyKey,
        }));
      case "chat.goal.get":
        return { goal: activeChatGoal };
      case "chat.turn":
        chatTurnCommands.push(command);
        if (command.executionProfile === "standalone-chat") {
          standaloneChatTurnCommands.push(command);
          if (command.resultMode.kind !== "chat-message-encrypted") {
            throw new Error(
              "Standalone Chat did not request an encrypted result.",
            );
          }
          return {
            threadId: `thread-${command.scratchRootId}`,
            text: "",
            status: "completed",
            structuredResult: {
              message: {
                ...command.protectedPrompt,
                id: command.resultMode.messageId,
                classification: {
                  role: "assistant",
                  mode: "default",
                  attachmentIds: [],
                },
                idempotencyKey: command.resultMode.idempotencyKey,
              },
            },
          };
        }
        if (
          command.prompt.startsWith("Continue working toward the active goal")
        ) {
          activeChatGoal = activeChatGoal
            ? { ...activeChatGoal, status: "paused" }
            : null;
        }
        if (cliInvocation) {
          const invocation = cliInvocation;
          cliInvocation = null;
          const callId = `call-${chatTurnCommands.length}`;
          const toolResponse = await app.inject({
            method: "POST",
            url: "/api/internal/cli",
            headers: { authorization: `Bearer ${config.workerToken}` },
            payload: {
              arguments: invocation.arguments,
              chatContext: {
                chatId: command.chatId,
                executionLaneId: command.executionLaneId,
              },
              command: invocation.command,
              context: {
                codexThreadId: command.threadId,
                cwd: command.cwd,
                terminalId: null,
              },
              requestId: callId,
              workerId: "test-worker",
            },
          });
          if (toolResponse.statusCode !== 200) {
            throw new Error(String(toolResponse.json().error));
          }
          const toolResult = cantripCliCommandResultSchema.parse(
            toolResponse.json(),
          );
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "worktree",
              id: `worktree-tool:${callId}`,
              operation: invocation.command,
              status: "completed",
              summary: toolResult.summary,
              worktreeId: toolResult.worktreeId,
            },
          });
        }
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: `command-${chatTurnCommands.length}`,
            command: "pwd",
            cwd: command.cwd,
            status: "completed",
            exitCode: 0,
            output: command.cwd,
          },
        });
        return {
          threadId: `thread-${command.worktreeId}`,
          text: "Completed in the selected worktree.",
          status: "completed",
        };
      default:
        throw new Error(`Unexpected command: ${command.type}`);
    }
  },
} satisfies WorkerCommandBus;

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let primaryId: string;
let managedIds: string[] = [];
let routedChatId: string;
let routedTerminalId: string;
let linkedConsoleId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  const recordedWorker = await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: true,
      version: "1.109.5",
      upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    directBroker: {
      available: true,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: 43123,
      instanceId: randomUUID(),
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
    standaloneChat: {
      protocolVersion: 1,
      scratch: {
        provision: true,
        resolve: true,
        archive: true,
        restore: true,
        remove: true,
        reconcile: true,
        routingHandles: true,
      },
      files: {
        list: true,
        read: true,
        write: true,
        remove: true,
        download: true,
        archive: true,
        networkShare: true,
      },
    },
    startedAt: new Date().toISOString(),
  });
  expect(recordedWorker.code.available).toBe(true);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    repositoryId: "repo-1",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "test-worker",
    {
      path: primaryPath,
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  primaryId = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  )[0]!.id;
  app = await buildApp({
    config,
    database,
    logger: false,
    workerBridge,
  });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("server worktree control plane", () => {
  it("runs standalone Chats through a scratch-root-only runtime profile", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: protectedChatFields(),
    });
    expect(create.statusCode, create.body).toBe(202);
    const chat = standaloneChatWireSummarySchema.parse(create.json());

    await expect
      .poll(async () => {
        const context = await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        );
        return context?.contextKind === "standalone" ? context : null;
      })
      .toMatchObject({ contextKind: "standalone", status: "idle" });
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(context?.contextKind).toBe("standalone");
    if (context?.contextKind !== "standalone" || !context.modelId) {
      throw new Error("Standalone Chat execution context was not ready.");
    }

    const liveEvents: AppLiveServerMessage[] = [];
    let liveClient: WebSocket | null = null;
    const liveSocket = await app.injectWS(
      "/api/live",
      { headers: { origin: config.appOrigins[0] } },
      {
        onInit(client) {
          liveClient = client;
          client.on("message", (data) => {
            liveEvents.push(
              appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
            );
          });
        },
      },
    );
    if (!liveClient) throw new Error("Standalone live socket did not open.");
    liveClient.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: {
          id: "standalone-lifecycle",
          name: "Standalone lifecycle test",
          version: "1",
        },
        resume: null,
      }),
    );
    await vi.waitFor(() =>
      expect(liveEvents.at(-1)).toMatchObject({ type: "ready" }),
    );
    liveClient.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "standalone-list",
        scopes: [{ kind: "current-user" }],
      }),
    );
    await vi.waitFor(() =>
      expect(liveEvents.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "standalone-list",
      }),
    );
    const pauseEventStart = liveEvents.length;

    const paused = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/pause`,
      payload: { paused: true },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(chatPauseStateSchema.parse(paused.json())).toEqual({ paused: true });
    await vi.waitFor(() =>
      expect(
        liveEvents
          .slice(pauseEventStart)
          .some(
            (event) =>
              event.type === "event" &&
              event.resource === "chat" &&
              event.entityId === chat.id &&
              event.scope.kind === "current-user",
          ),
      ).toBe(true),
    );
    expect(
      (
        (
          await app.inject({
            method: "GET",
            url: "/api/chats?context=standalone",
          })
        ).json() as Array<{ automationPaused: boolean; id: string }>
      ).find(({ id }) => id === chat.id),
    ).toMatchObject({ automationPaused: true });
    await expect(
      database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).resolves.toMatchObject({
      automationPaused: true,
      contextKind: "standalone",
    });
    const resumed = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/pause`,
      payload: { paused: false },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(chatPauseStateSchema.parse(resumed.json())).toEqual({
      paused: false,
    });
    liveSocket.terminate();

    const forbiddenSync = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/sync`,
      payload: {},
    });
    expect(forbiddenSync.statusCode, forbiddenSync.body).toBe(409);
    expect(forbiddenSync.json().error).toContain("IDE-only");

    const fileOperationId = randomUUID();
    const fileOperation = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/files/operation`,
      payload: {
        intent: "list",
        operationId: fileOperationId,
        sequence: 0,
        protectedRequest: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    });
    expect(fileOperation.statusCode, fileOperation.body).toBe(200);
    expect(fileOperation.json()).toMatchObject({
      operationId: fileOperationId,
      sequence: 0,
    });
    expect(standaloneChatFileOperationCommands.at(-1)).toMatchObject({
      type: "chat.scratch.files.operation",
      chatId: chat.id,
      rootId: context.scratchRootId,
      root: context.cwd,
      intent: "list",
      operationId: fileOperationId,
      sequence: 0,
    });

    const before = standaloneChatTurnCommands.length;
    const allTurnsBefore = chatTurnCommands.length;
    const started = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: protectedStandaloneTurn(context.modelId),
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ status: "started" });
    await expect
      .poll(() => chatTurnCommands.length, { timeout: 4_000 })
      .toBe(allTurnsBefore + 1);
    expect(
      chatTurnCommands.at(-1),
      JSON.stringify(chatTurnCommands.at(-1)),
    ).toMatchObject({ executionProfile: "standalone-chat" });
    expect(standaloneChatTurnCommands.length).toBe(before + 1);
    await expect
      .poll(async () => {
        const current = await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        );
        return current?.status;
      })
      .toBe("idle");

    const command = standaloneChatTurnCommands.at(-1)!;
    expect(command).toMatchObject({
      executionProfile: "standalone-chat",
      contextKind: "standalone",
      chatId: chat.id,
      cwd: `ctrr_${"a".repeat(43)}`,
      worktreeId: null,
      scratchRootId: context.scratchRootId,
      rootKind: null,
      isPrimary: true,
      worktreeMode: null,
      worktreePolicy: null,
      policyProjectId: null,
      policies: { policies: [] },
      mcpServers: [],
      skillNames: [],
      subagentDefaults: null,
      planMode: "default",
      automationPaused: false,
    });
    expect(command).not.toHaveProperty("subagentProtocolVersion");

    const messages = chatMessageWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    ).messages;
    expect(messages).toHaveLength(2);
    expect(
      messages.every(
        (message) =>
          message.contextKind === "standalone" &&
          message.worktreeId === null &&
          message.scratchRootId === context.scratchRootId,
      ),
    ).toBe(true);

    await database.repository.setChatPermissionProfile(
      LOCAL_USER_ID,
      chat.id,
      ":read-only",
    );
    const forkFields = protectedChatFields();
    const forkResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/fork`,
      payload: forkFields,
    });
    expect(forkResponse.statusCode, forkResponse.body).toBe(202);
    const fork = standaloneChatWireSummarySchema.parse(forkResponse.json());
    expect(fork).toMatchObject({
      contextKind: "standalone",
      modelId: context.modelId,
      reasoningEffort: context.reasoningEffort,
      permissionProfileId: ":read-only",
    });
    expect(fork.activeScratchRootId).not.toBe(chat.activeScratchRootId);
    await expect
      .poll(async () => {
        const forkContext = await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          fork.id,
        );
        return forkContext?.status;
      })
      .toBe("idle");
    const forkMessages = chatMessageWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${fork.id}/messages`,
        })
      ).json(),
    ).messages;
    expect(forkMessages).toHaveLength(messages.length);
    expect(
      forkMessages.every(
        (message) =>
          message.contextKind === "standalone" &&
          message.scratchRootId === fork.activeScratchRootId,
      ),
    ).toBe(true);

    connected = false;
    try {
      const offlineSend = await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: protectedStandaloneTurn(context.modelId),
      });
      expect(offlineSend.statusCode, offlineSend.body).toBe(503);
      expect(offlineSend.json()).toMatchObject({
        code: "standalone-worker-offline",
      });
    } finally {
      connected = true;
    }

    const forbiddenMode = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: protectedStandaloneTurn(context.modelId, "plan"),
    });
    expect(forbiddenMode.statusCode, forbiddenMode.body).toBe(400);
    expect(forbiddenMode.json().error).toContain("default-mode");

    const forbiddenGoal = await app.inject({
      method: "GET",
      url: `/api/chats/${chat.id}/goal`,
    });
    expect(forbiddenGoal.statusCode, forbiddenGoal.body).toBe(409);

    const shareId = randomUUID();
    const shareResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/network-shares`,
      payload: {
        tunnelId: shareId,
        workerId: context.workerId,
        protectedRecord: protectedTunnelRecord(shareId),
      },
    });
    expect(shareResponse.statusCode, shareResponse.body).toBe(201);
    expect(
      standaloneChatShareAttachmentWireSchema.parse(shareResponse.json()),
    ).toMatchObject({
      attachmentId: shareId,
      chatId: chat.id,
      protocol: "webdav",
      tunnelId: shareId,
    });
    expect(projectShareOpenCommands.at(-1)?.standaloneRoot).toEqual({
      chatId: chat.id,
      rootId: context.scratchRootId,
    });
    const shareCloseCount = projectShareCloseIds.length;

    const archive = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
    });
    expect(archive.statusCode, archive.body).toBe(204);
    expect(projectShareCloseIds.slice(shareCloseCount)).toEqual([shareId]);
    const archived = await app.inject({
      method: "GET",
      url: "/api/chats/archived?context=standalone",
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: chat.id })]),
    );

    const restored = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/restore`,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({
      id: chat.id,
      contextKind: "standalone",
    });
  });

  it("relays protected repository operations without inspecting content", async () => {
    const protectedRequest = {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const operationId = "11111111-1111-4111-8111-111111111111";
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${primaryId}/repository-operation`,
      payload: { operationId, protectedRequest, access: "read" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operationId,
      protectedResponse: protectedRequest,
      agentExecution: null,
    });
    expect(repositoryOperationCommands.at(-1)).toMatchObject({
      type: "repository.operation",
      projectId,
      worktreeId: primaryId,
      operationId,
      protectedRequest,
      access: "read",
    });
    expect(JSON.stringify(repositoryOperationCommands.at(-1))).not.toContain(
      "private/roadmap.md",
    );

    const workerResponse = await app.inject({
      method: "POST",
      url: "/api/workers/test-worker/repository-operation",
      payload: {
        scopeId: projectId,
        operationId,
        protectedRequest,
      },
    });
    expect(workerResponse.statusCode).toBe(200);
    expect(workerResponse.json()).toEqual({
      operationId,
      protectedResponse: protectedRequest,
      agentExecution: null,
    });
    expect(repositoryOperationCommands.at(-1)).toMatchObject({
      type: "repository.operation",
      projectId,
      worktreeId: "test-worker",
      cwd: ".",
      sourcePath: ".",
      repository: null,
    });
  });

  it("keeps protected reads serialized with project mutations", async () => {
    const protectedRequest = {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const invoke = (operationId: string, access: "read" | "write") =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${primaryId}/repository-operation`,
        payload: { operationId, protectedRequest, access },
      });

    repositoryOperationDelayMs = 20;
    maximumConcurrentRepositoryOperations = 0;
    try {
      const reads = await Promise.all([
        invoke("21111111-1111-4111-8111-111111111111", "read"),
        invoke("21111111-1111-4111-8111-111111111112", "read"),
      ]);
      expect(reads.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      expect(maximumConcurrentRepositoryOperations).toBe(1);

      maximumConcurrentRepositoryOperations = 0;
      const writes = await Promise.all([
        invoke("31111111-1111-4111-8111-111111111111", "write"),
        invoke("31111111-1111-4111-8111-111111111112", "write"),
      ]);
      expect(writes.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      expect(maximumConcurrentRepositoryOperations).toBe(1);
    } finally {
      repositoryOperationDelayMs = 0;
    }
  });

  it("fails closed on legacy plaintext repository routes", async () => {
    const gitResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${primaryId}/git/operations/preview`,
      payload: { type: "merge", sourceRef: "private/feature-name" },
    });
    const statusResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${primaryId}/status`,
    });
    const catalogResponse = await app.inject({
      method: "GET",
      url: "/api/github/repositories",
    });
    const checkoutResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${primaryId}/github/pull-requests/12/checkout`,
    });

    for (const response of [
      gitResponse,
      statusResponse,
      catalogResponse,
      checkoutResponse,
    ]) {
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        error:
          "This plaintext repository route was removed. Use the protected repository operation endpoint.",
      });
    }
  });

  it("renders durable Primary metadata and reconciles external worktrees", async () => {
    const initial = projectWorktreeListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/worktrees`,
        })
      ).json(),
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      id: primaryId,
      isPrimary: true,
      origin: "cantrip",
    });
    const policyResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/worktree-policy`,
      payload: { policy: "required-for-writes" },
    });
    expect(policyResponse.json()).toMatchObject({
      id: projectId,
      worktreePolicy: "required-for-writes",
    });

    workerWorktrees.push({
      path: externalPath,
      head: "3333333333333333333333333333333333333333",
      branch: "review",
      detached: false,
      isPrimary: false,
      managed: false,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/reconcile`,
    });
    expect(response.statusCode).toBe(200);
    const reconciled = projectWorktreeListSchema.parse(response.json());
    expect(reconciled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: primaryId, branch: "main" }),
        expect.objectContaining({
          path: externalPath,
          branch: "review",
          origin: "external",
        }),
      ]),
    );
  });

  it("serializes concurrent creates and keeps each server identity", async () => {
    const responses = await Promise.all(
      ["agent-one", "agent-two"].map((branch) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/worktrees`,
          payload: {
            name: branch,
            mode: { type: "newBranch", branch, startPoint: "main" },
          },
        }),
      ),
    );
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    const created = responses.map((response) =>
      projectWorktreeSummarySchema.parse(response.json()),
    );
    managedIds = created.map(({ id }) => id);
    expect(new Set(managedIds).size).toBe(2);
    expect(created.every(({ origin }) => origin === "user")).toBe(true);
    expect(maximumConcurrentCreates).toBe(1);
  });

  it("keeps project-shared Run definition writes on Primary", async () => {
    const secondary = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === managedIds[0])!;
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeId: primaryId,
        worktreeMode: "pinned",
      },
    );
    expect(chat).not.toBeNull();
    const execution = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat!.id,
      "agent",
      "Verify CLI context safety",
    );
    expect(execution?.executionLaneId).toBeTruthy();
    const commandCount = runConfigurationDefinitionCommands.length;
    const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
    const payload = {
      arguments: {
        document: {
          schema: "cantrip.run-configuration",
          version: 1,
          id: configurationId,
          name: "Secondary environment",
          provider: "shell",
          target: { kind: "command", command: "pnpm dev" },
        },
      },
      chatContext: {
        chatId: chat!.id,
        executionLaneId: execution!.executionLaneId,
      },
      command: "run.create",
      context: {
        codexThreadId: null,
        cwd: secondary.path,
        selection: "auto",
        terminalId: null,
      },
      requestId: "run-config-context-mismatch",
      workerId: "test-worker",
    };
    const mismatched = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload,
    });
    expect(mismatched.statusCode, mismatched.body).toBe(409);
    expect(mismatched.json()).toMatchObject({
      code: "conflict",
      error: expect.stringContaining("--context lane or --context cwd"),
    });
    expect(runConfigurationDefinitionCommands).toHaveLength(commandCount);

    const explicitCwd = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        ...payload,
        context: { ...payload.context, selection: "cwd" },
        requestId: crypto.randomUUID(),
      },
    });
    expect(explicitCwd.statusCode, explicitCwd.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(explicitCwd.json()),
    ).toMatchObject({
      mutated: true,
      summary: expect.stringContaining(`Created Run configuration`),
      worktreeId: primaryId,
    });
    expect(runConfigurationDefinitionCommands.slice(commandCount)).toEqual([
      expect.objectContaining({
        type: "project.run-configuration-definitions.write",
        sourcePath: primaryPath,
      }),
    ]);
    await database.repository.finishChatExecutionLane(
      chat.id,
      execution!.executionLaneId,
      "idle",
    );
    expect(await database.repository.deleteChat(LOCAL_USER_ID, chat.id)).toBe(
      "deleted",
    );
  });

  it("shares Primary while binding each Codex turn and message to one lane", async () => {
    const createPrimaryChat = (title: string) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/chats`,
        payload: { title, worktreeMode: "agent-managed" },
      });
    const [firstResponse, secondResponse] = await Promise.all([
      createPrimaryChat("Primary chat one"),
      createPrimaryChat("Primary chat two"),
    ]);
    expect(
      [firstResponse.statusCode, secondResponse.statusCode],
      JSON.stringify([firstResponse.body, secondResponse.body]),
    ).toEqual([201, 201]);
    const first = chatSummarySchema.parse(firstResponse.json());
    const second = chatSummarySchema.parse(secondResponse.json());
    const [firstLanes, secondLanes] = await Promise.all([
      database.repository.listChatExecutionLanes(LOCAL_USER_ID, first.id),
      database.repository.listChatExecutionLanes(LOCAL_USER_ID, second.id),
    ]);
    expect(firstLanes[0]).toMatchObject({
      worktreeId: primaryId,
      exclusive: false,
      state: "suspended",
    });
    expect(secondLanes[0]).toMatchObject({
      worktreeId: primaryId,
      exclusive: false,
      state: "suspended",
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/chats/${first.id}/turns`,
      payload: { text: "Run pwd", idempotencyKey: "primary-turn-1" },
    });
    expect(started.statusCode, started.body).toBe(202);
    await expect
      .poll(async () => {
        const context = await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          first.id,
        );
        return context?.status;
      })
      .toBe("idle");

    const command = chatTurnCommands.at(-1)!;
    expect(command).toMatchObject({
      chatId: first.id,
      cwd: primaryPath,
      isPrimary: true,
      worktreeId: primaryId,
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
    });
    expect(command.executionLaneId).toBeTruthy();
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${first.id}/messages`,
        })
      ).json(),
    );
    expect(messages).toHaveLength(3);
    expect(
      messages.every(
        ({ executionLaneId, worktreeId }) =>
          executionLaneId === command.executionLaneId &&
          worktreeId === primaryId,
      ),
    ).toBe(true);
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      first.id,
    );
    expect(context).toMatchObject({
      threadId: `thread-${primaryId}`,
      worktreeId: primaryId,
    });
    expect(context?.executionLaneId).toBeNull();
  });

  it("resolves queued prompts at dispatch time unless explicitly pinned", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: { title: "Queued routing", worktreeMode: "agent-managed" },
        })
      ).json(),
    );
    const dispatchFrozenPrompt = async (worktreeId: string | null) => {
      const before = chatTurnCommands.length;
      const prompt = queuedPromptSchema.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/queue`,
            payload: {
              text: "Queued pwd",
              idempotencyKey: `queued-${before}`,
              frozen: true,
              worktreeId,
            },
          })
        ).json(),
      );
      await app.inject({
        method: "PATCH",
        url: `/api/queued-prompts/${prompt.id}`,
        payload: { frozen: false },
      });
      await expect.poll(() => chatTurnCommands.length).toBe(before + 1);
      await expect
        .poll(
          async () =>
            (
              await database.repository.getChatExecutionContext(
                LOCAL_USER_ID,
                chat.id,
              )
            )?.status,
        )
        .toBe("idle");
      return chatTurnCommands.at(-1)!;
    };

    await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: managedIds[0], mode: "agent-managed" },
    });
    const dynamic = await dispatchFrozenPrompt(null);
    expect(dynamic.worktreeId).toBe(managedIds[0]);

    const releaseCurrent = async () => {
      const lane = (
        await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
      ).find(
        ({ state, worktreeId }) =>
          state !== "released" && worktreeId !== primaryId,
      )!;
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/execution-lanes/${lane.id}/release`,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    };
    await releaseCurrent();

    const pinned = await dispatchFrozenPrompt(managedIds[1]!);
    expect(pinned.worktreeId).toBe(managedIds[1]);
    await releaseCurrent();

    await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: managedIds[0], mode: "agent-managed" },
    });
    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).toMatchObject({
      threadId: `thread-${managedIds[0]}`,
      worktreeId: managedIds[0],
    });
    await releaseCurrent();
  });

  it("continues an agent turn in a separately routed worktree runtime", async () => {
    const targetId = managedIds[0]!;
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === targetId)!;
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Agent transition",
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    const before = chatTurnCommands.length;
    cliInvocation = {
      command: "worktree.switch",
      arguments: {
        worktree: targetId,
      },
    };

    const started = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: {
        text: "Implement this safely",
        idempotencyKey: "agent-transition-turn",
      },
    });
    expect(started.statusCode).toBe(202);
    await expect.poll(() => chatTurnCommands.length).toBe(before + 2);
    await expect
      .poll(
        async () =>
          (
            await database.repository.getChatExecutionContext(
              LOCAL_USER_ID,
              chat.id,
            )
          )?.status,
      )
      .toBe("idle");

    const [originCommand, continuationCommand] = chatTurnCommands.slice(before);
    expect(originCommand).toMatchObject({
      chatId: chat.id,
      cwd: primaryPath,
      isPrimary: true,
      worktreeId: primaryId,
      worktreePolicy: "required-for-writes",
    });
    expect(continuationCommand).toMatchObject({
      chatId: chat.id,
      cwd: target.path,
      isPrimary: false,
      worktreeId: targetId,
      worktreePolicy: "required-for-writes",
    });
    expect(continuationCommand!.executionLaneId).not.toBe(
      originCommand!.executionLaneId,
    );
    expect(continuationCommand!.prompt).toContain(
      `Continued in ${target.name}`,
    );

    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(context).toMatchObject({
      worktreeId: targetId,
      threadId: `thread-${targetId}`,
    });
    const lanes = await database.repository.listChatExecutionLanes(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originCommand!.executionLaneId,
          worktreeId: primaryId,
          state: "suspended",
        }),
        expect.objectContaining({
          id: continuationCommand!.executionLaneId,
          worktreeId: targetId,
          state: "suspended",
          transitionKind: null,
        }),
      ]),
    );
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    const worktreeActivities = messages.filter(({ content }) =>
      content.some(
        (part) => part.type === "activity" && part.activity.type === "worktree",
      ),
    );
    expect(worktreeActivities).toHaveLength(1);
    expect(worktreeActivities[0]).toMatchObject({
      executionLaneId: originCommand!.executionLaneId,
      worktreeId: primaryId,
    });

    const activeLane = lanes.find(
      ({ id }) => id === continuationCommand!.executionLaneId,
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/execution-lanes/${activeLane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
  });

  it("rejects agent transitions from pinned, stale, or spoofed lanes", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Pinned agent safety",
            worktreeId: primaryId,
            worktreeMode: "pinned",
          },
        })
      ).json(),
    );
    const execution = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Pinned safety check",
    );
    expect(execution).not.toBeNull();
    const payload = {
      arguments: { worktree: managedIds[0] },
      chatContext: {
        chatId: chat.id,
        executionLaneId: execution!.executionLaneId,
      },
      command: "worktree.switch",
      context: {
        codexThreadId: null,
        cwd: primaryPath,
        terminalId: null,
      },
      requestId: "pinned-call",
      workerId: execution!.workerId,
    };
    const pinned = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload,
    });
    expect(pinned.statusCode).toBe(409);
    expect(pinned.json().error).toContain("pinned");

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        ...payload,
        requestId: "spoofed-call",
        workerId: "other-worker",
      },
    });
    expect(spoofed.statusCode).toBe(404);
    expect(spoofed.json().error).toBe("Worker not found.");
    await database.repository.finishChatExecutionLane(
      chat.id,
      execution!.executionLaneId,
      "idle",
    );

    const stale = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: { ...payload, requestId: "stale-call" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("active chat lane");
  });

  it("recovers a durable pending transition when its worker reconnects", async () => {
    const targetId = managedIds[1]!;
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === targetId)!;
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Transition restart recovery",
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    const execution = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Interrupted origin turn",
    );
    expect(execution).not.toBeNull();
    const pending = await database.repository.scheduleChatWorktreeTransition(
      LOCAL_USER_ID,
      chat.id,
      execution!.executionLaneId,
      targetId,
      "switch",
      "Continue after server restart",
    );
    expect(pending?.lane.state).toBe("delivering");
    await database.repository.resetInterruptedChatExecutions();

    const before = chatTurnCommands.length;
    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/internal/workers/heartbeat",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        workerId: "test-worker",
        name: "Test Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "0.146.1",
        codexRuntime: unprobedCodexRuntimeReport,
        code: {
          available: true,
          version: "1.109.5",
          upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
          patchset: 1,
          transport: "web-proxy",
          maxSessions: 4,
          reason: null,
        },
        remoteSurfaces: {
          browser: false,
          transports: ["websocket"],
          maxSessions: 1,
        },
        startedAt: new Date().toISOString(),
      },
    });
    expect(heartbeat.statusCode).toBe(202);
    await expect.poll(() => chatTurnCommands.length).toBe(before + 1);
    await expect
      .poll(
        async () =>
          (
            await database.repository.getChatExecutionContext(
              LOCAL_USER_ID,
              chat.id,
            )
          )?.status,
      )
      .toBe("idle");
    expect(chatTurnCommands.at(-1)).toMatchObject({
      chatId: chat.id,
      cwd: target.path,
      worktreeId: targetId,
    });

    const activeLane = (
      await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
    ).find(
      ({ state, worktreeId }) =>
        state !== "released" && worktreeId === targetId,
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/execution-lanes/${activeLane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
  });

  it("recovers interrupted executions without losing durable lane metadata", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: { title: "Restart recovery", worktreeMode: "agent-managed" },
        })
      ).json(),
    );
    const started = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Recovery test",
    );
    expect(started?.executionLaneId).toBeTruthy();
    await database.repository.updateChatRuntime(
      chat.id,
      started!.workerId,
      started!.worktreeId,
      "thread-recovery",
      "00000000-0000-0000-0000-000000000021",
      "running",
    );

    await database.repository.resetInterruptedChatExecutions();

    const recovered = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(recovered).toMatchObject({
      status: "failed",
      threadId: "thread-recovery",
      worktreeId: primaryId,
    });
    expect(recovered?.executionLaneId).toBeNull();
    const lane = (
      await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
    )[0]!;
    expect(lane).toMatchObject({
      id: started!.executionLaneId,
      state: "suspended",
      codexThreadId: "thread-recovery",
      purpose: "Recovery test",
    });
  });

  it("routes tabs, forks, and chat transitions through explicit worktrees", async () => {
    const [firstId, secondId] = managedIds as [string, string];
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        title: "Pinned work",
        worktreeId: firstId,
        worktreeMode: "pinned",
      },
    });
    const chat = chatSummarySchema.parse(chatResponse.json());
    routedChatId = chat.id;
    expect(chat).toMatchObject({
      activeWorktreeId: firstId,
      worktreeMode: "pinned",
    });

    const terminal = terminalSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: { title: "Worktree shell", worktreeId: firstId },
        })
      ).json(),
    );
    routedTerminalId = terminal.id;
    expect(terminal.worktreeId).toBe(firstId);
    const explorer = explorerSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: { title: "Worktree files", worktreeId: secondId },
        })
      ).json(),
    );
    expect(explorer.worktreeId).toBe(secondId);
    expect(
      explorerSummarySchema.parse(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/explorers/${explorer.id}/view-state`,
            payload: { selectedPath: "package.json", fileMode: "visual" },
          })
        ).json(),
      ),
    ).toMatchObject({ selectedPath: "package.json", fileMode: "visual" });
    const retargetedExplorer = explorerSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/explorers/${explorer.id}/worktree`,
          payload: { worktreeId: firstId },
        })
      ).json(),
    );
    expect(retargetedExplorer).toMatchObject({
      worktreeId: firstId,
      selectedPath: null,
      fileMode: "preview",
    });
    expect(
      (await database.repository.listWorkers(LOCAL_USER_ID))[0]?.code.available,
    ).toBe(true);
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        title: "Worktree Code",
        worktreeId: secondId,
        profileId: "main-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabSummarySchema.parse(codeTabResponse.json());
    expect(codeTab).toMatchObject({
      worktreeId: secondId,
      activeWorkerId: "test-worker",
      profileId: "main-profile",
      themeMode: "follow-cantrip",
      status: "idle",
    });
    const renamedCodeTab = codeTabSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/code-tabs/${codeTab.id}`,
          payload: { title: "Review Code", themeMode: "independent" },
        })
      ).json(),
    );
    expect(renamedCodeTab).toMatchObject({
      title: "Review Code",
      themeMode: "follow-cantrip",
    });
    const session = await database.repository.getOrCreateCodeSession(
      LOCAL_USER_ID,
      codeTab.id,
      codeEditorBuild,
    );
    expect(codeSessionSummarySchema.parse(session)).toMatchObject({
      codeTabId: codeTab.id,
      projectId,
      workerId: "test-worker",
      worktreeId: secondId,
      profileId: "main-profile",
      status: "starting",
    });
    expect(
      codeSessionListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/code-tabs/${codeTab.id}/sessions`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    const retargetedCodeTab = codeTabSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/code-tabs/${codeTab.id}/worktree`,
          payload: { worktreeId: firstId },
        })
      ).json(),
    );
    expect(retargetedCodeTab.worktreeId).toBe(firstId);
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await database.repository.listCodeSessions(LOCAL_USER_ID, codeTab.id),
    ).toBeNull();
    const history = projectViewSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/views`,
          payload: { title: "History", kind: "history", worktreeId: secondId },
        })
      ).json(),
    );
    expect(history.worktreeId).toBe(secondId);

    const fork = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            worktreeId: secondId,
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    expect(fork).toMatchObject({
      activeWorktreeId: secondId,
      worktreeMode: "agent-managed",
    });

    const switched = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: secondId, mode: "pinned" },
    });
    expect(switched.statusCode).toBe(409);

    await database.repository.setChatStatus(chat.id, "running");
    const blockedSwitch = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: primaryId, mode: "agent-managed" },
    });
    expect(blockedSwitch.statusCode).toBe(409);
    await database.repository.setChatStatus(chat.id, "idle");

    const consoleTab = terminalSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
        })
      ).json(),
    );
    linkedConsoleId = consoleTab.id;
    expect(consoleTab.worktreeId).toBe(firstId);
  });

  it("rejects a Code runtime that finishes after its tab changes worktrees", async () => {
    const createdWorktreeResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees`,
      payload: {
        name: "code-race",
        mode: {
          type: "newBranch",
          branch: "code-race",
          startPoint: "main",
        },
      },
    });
    expect(
      createdWorktreeResponse.statusCode,
      createdWorktreeResponse.body,
    ).toBe(201);
    const createdWorktree = projectWorktreeSummarySchema.parse(
      createdWorktreeResponse.json(),
    );
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: createdWorktree.id,
        profileId: "race-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());

    const openCountBeforeStaleIntent = codeOpenCommands.length;
    const tunnelsBeforeStaleIntent = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/tunnels`,
      })
    ).json<unknown[]>();
    const staleIntentResponse = await app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
      payload: {
        appearance: "dark",
        expectedWorkerId: "other-worker",
        expectedWorktreeId: primaryId,
      },
    });
    expect(staleIntentResponse.statusCode, staleIntentResponse.body).toBe(409);
    expect(staleIntentResponse.json()).toMatchObject({
      error: "The Code tab changed while its editor was opening.",
    });
    expect(codeOpenCommands).toHaveLength(openCountBeforeStaleIntent);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tunnels`,
        })
      ).json<unknown[]>(),
    ).toHaveLength(tunnelsBeforeStaleIntent.length);

    let signalCodeOpenStarted!: () => void;
    let releaseCodeOpen!: () => void;
    const codeOpenStarted = new Promise<void>((resolve) => {
      signalCodeOpenStarted = resolve;
    });
    const codeOpenRelease = new Promise<void>((resolve) => {
      releaseCodeOpen = resolve;
    });
    heldCodeOpen = {
      release: codeOpenRelease,
      started: signalCodeOpenStarted,
    };
    const intentResponsePromise = app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
      payload: {
        appearance: "dark",
        expectedWorkerId: codeTab.activeWorkerId,
        expectedWorktreeId: codeTab.worktreeId,
      },
    });
    await codeOpenStarted;
    const [session] =
      (await database.repository.listCodeSessions(LOCAL_USER_ID, codeTab.id)) ??
      [];
    expect(codeSessionSummarySchema.parse(session)).toMatchObject({
      codeTabId: codeTab.id,
      workerId: "test-worker",
      worktreeId: createdWorktree.id,
      profileId: "race-profile",
      status: "starting",
    });

    const retargetedResponse = await app.inject({
      method: "PATCH",
      url: `/api/code-tabs/${codeTab.id}/worktree`,
      payload: { worktreeId: primaryId },
    });
    expect(retargetedResponse.statusCode, retargetedResponse.body).toBe(200);
    expect(
      codeTabWireSummarySchema.parse(retargetedResponse.json()).worktreeId,
    ).toBe(primaryId);
    releaseCodeOpen();
    const intentResponse = await intentResponsePromise;
    heldCodeOpen = undefined;

    expect(intentResponse.statusCode, intentResponse.body).toBe(409);
    expect(intentResponse.json()).toMatchObject({
      error: "The Code tab changed while its editor was opening.",
    });
    expect(codeOpenCommands.at(-1)).toMatchObject({
      sessionId: session!.id,
      worktreeId: createdWorktree.id,
      cwd: createdWorktree.path,
    });
    expect(codeStopCommands).toContainEqual({
      type: "code.stop",
      sessionId: session!.id,
      expectedSessionIncarnationId: codeSessionIncarnationId,
    });
    expect(
      await database.repository.updateCodeSessionRuntime(
        LOCAL_USER_ID,
        codeTab.id,
        session!.id,
        {
          sessionId: session!.id,
          status: "running",
          editorBuild: codeEditorBuild,
          processInstanceId: "stale-code-process",
          bridgeConnected: true,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: "2026-08-08T12:00:00.000Z",
          lastActivityAt: "2026-08-08T12:01:00.000Z",
          lastError: null,
        },
      ),
    ).toBeNull();
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
  });

  it("revokes a Code session inserted while its tab is changing worktrees", async () => {
    const targetResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees`,
      payload: {
        name: "code-cleanup-race",
        mode: {
          type: "newBranch",
          branch: "code-cleanup-race",
          startPoint: "main",
        },
      },
    });
    expect(targetResponse.statusCode, targetResponse.body).toBe(201);
    const target = projectWorktreeSummarySchema.parse(targetResponse.json());
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: primaryId,
        profileId: "cleanup-race-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());

    const originalUpdate = database.repository.updateCodeTabWorktree.bind(
      database.repository,
    );
    let signalUpdateStarted!: () => void;
    let releaseUpdate!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      signalUpdateStarted = resolve;
    });
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateSpy = vi
      .spyOn(database.repository, "updateCodeTabWorktree")
      .mockImplementation(async (...args) => {
        signalUpdateStarted();
        await updateRelease;
        return originalUpdate(...args);
      });
    const revokeSpy = vi.spyOn(
      DirectAttachmentCoordinator.prototype,
      "revokeResource",
    );
    try {
      const retargetResponsePromise = app.inject({
        method: "PATCH",
        url: `/api/code-tabs/${codeTab.id}/worktree`,
        payload: { worktreeId: target.id },
      });
      await updateStarted;
      const racedSession = await database.repository.getOrCreateCodeSession(
        LOCAL_USER_ID,
        codeTab.id,
        codeEditorBuild,
      );
      expect(racedSession).toMatchObject({
        codeTabId: codeTab.id,
        worktreeId: primaryId,
        status: "starting",
      });
      releaseUpdate();
      const retargetResponse = await retargetResponsePromise;

      expect(retargetResponse.statusCode, retargetResponse.body).toBe(200);
      expect(
        codeTabWireSummarySchema.parse(retargetResponse.json()).worktreeId,
      ).toBe(target.id);
      expect(revokeSpy).toHaveBeenCalledWith(
        LOCAL_USER_ID,
        "code",
        racedSession!.id,
      );
    } finally {
      releaseUpdate();
      updateSpy.mockRestore();
      revokeSpy.mockRestore();
    }
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
  });

  it("revokes exact project-share direct grants on replace and delete", async () => {
    const tunnelId = randomUUID();
    const opensBefore = projectShareOpenIds.length;
    const closesBefore = projectShareCloseIds.length;
    const createShare = (revision: number) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/network-shares`,
        payload: {
          tunnelId,
          workerId: "test-worker",
          protectedRecord: {
            ...protectedTunnelRecord(revision === 1 ? tunnelId : randomUUID()),
            revision,
          },
        },
      });
    const prepareDirect = async () => {
      const desktopResponse = await app.inject({
        method: "POST",
        url: `/api/tunnels/${tunnelId}/attachments`,
        payload: { clientId: randomUUID() },
      });
      expect(desktopResponse.statusCode, desktopResponse.body).toBe(201);
      const attachmentId = desktopResponse.json().attachmentId as string;
      const directResponse = await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${attachmentId}/direct`,
        payload: { diagnosticTraceId: randomUUID() },
      });
      expect(directResponse.statusCode, directResponse.body).toBe(201);
      return {
        attachmentId,
        capabilityId: directResponse.json().binding.capabilityId as string,
      };
    };
    const activate = (attachmentId: string, capabilityId: string) =>
      app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${attachmentId}/direct-activate`,
        payload: { capabilityId },
      });

    try {
      const created = await createShare(1);
      expect(created.statusCode, created.body).toBe(201);
      const replacedGrant = await prepareDirect();

      const replaced = await createShare(2);
      expect(replaced.statusCode, replaced.body).toBe(201);
      expect(directRevokeCapabilityIds).toContain(replacedGrant.capabilityId);
      expect(
        await activate(replacedGrant.attachmentId, replacedGrant.capabilityId),
      ).toMatchObject({ statusCode: 404 });
      expect(projectShareOpenIds.slice(opensBefore)).toEqual([
        tunnelId,
        tunnelId,
      ]);

      const deletedGrant = await prepareDirect();
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/project-shares/${tunnelId}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(directRevokeCapabilityIds).toContain(deletedGrant.capabilityId);
      expect(
        await activate(deletedGrant.attachmentId, deletedGrant.capabilityId),
      ).toMatchObject({ statusCode: 404 });
      expect(projectShareOpenIds.slice(opensBefore)).toEqual([
        tunnelId,
        tunnelId,
      ]);
      expect(projectShareCloseIds.slice(closesBefore)).toEqual([
        tunnelId,
        tunnelId,
      ]);
      expect(
        await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
      ).toMatchObject({ statusCode: 404 });
    } finally {
      await app.inject({
        method: "DELETE",
        url: `/api/project-shares/${tunnelId}`,
      });
    }
  });

  it.each(["attachment", "resource"] as const)(
    "rejects a stale direct route when its %s is revoked before authorization binds",
    async (scope) => {
      const explorerResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/explorers`,
        payload: {
          ...protectedExplorerFields(),
          worktreeId: primaryId,
        },
      });
      expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
      const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
      const sessionId = randomUUID();
      const tunnelId = randomUUID();
      const attachmentResponse = await app.inject({
        method: "POST",
        url: `/api/explorers/${explorer.id}/protected-code-attachments`,
        payload: {
          appearance: "dark",
          expectedWorkerId: explorer.activeWorkerId,
          expectedWorktreeId: explorer.worktreeId,
          path: "src/direct-revoke-race.ts",
          protectedRecord: protectedTunnelRecord(tunnelId),
          sessionId,
          tunnelId,
        },
      });
      expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(201);
      const desktopAttachmentResponse = await app.inject({
        method: "POST",
        url: `/api/tunnels/${tunnelId}/attachments`,
        payload: { clientId: `desktop-${sessionId}` },
      });
      expect(
        desktopAttachmentResponse.statusCode,
        desktopAttachmentResponse.body,
      ).toBe(201);
      const desktopAttachment = desktopAttachmentResponse.json();
      const originalGet = database.repository.getDesktopTunnelAttachment.bind(
        database.repository,
      );
      let signalReadStarted!: () => void;
      let releaseRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        signalReadStarted = resolve;
      });
      const readRelease = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let holdRead = true;
      const getSpy = vi
        .spyOn(database.repository, "getDesktopTunnelAttachment")
        .mockImplementation(async (...args) => {
          const result = await originalGet(...args);
          if (holdRead && args[1] === desktopAttachment.attachmentId) {
            holdRead = false;
            signalReadStarted();
            await readRelease;
          }
          return result;
        });
      let signalRevokeStarted!: () => void;
      const revokeStarted = new Promise<void>((resolve) => {
        signalRevokeStarted = resolve;
      });
      const originalRevoke =
        scope === "attachment"
          ? DirectAttachmentCoordinator.prototype.revokeAttachment
          : DirectAttachmentCoordinator.prototype.revokeResource;
      const revokeSpy =
        scope === "attachment"
          ? vi
              .spyOn(DirectAttachmentCoordinator.prototype, "revokeAttachment")
              .mockImplementation(async function (
                this: DirectAttachmentCoordinator,
                attachmentId,
              ) {
                if (attachmentId === desktopAttachment.attachmentId) {
                  signalRevokeStarted();
                }
                return originalRevoke.call(this, attachmentId);
              })
          : vi
              .spyOn(DirectAttachmentCoordinator.prototype, "revokeResource")
              .mockImplementation(async function (
                this: DirectAttachmentCoordinator,
                ownerId,
                resourceKind,
                resourceId,
              ) {
                if (resourceKind === "tunnel" && resourceId === tunnelId) {
                  signalRevokeStarted();
                }
                return originalRevoke.call(
                  this,
                  ownerId,
                  resourceKind,
                  resourceId,
                );
              });
      const preparationsBefore = directPrepareCapabilityIds.length;
      try {
        const directResponsePromise = app.inject({
          method: "POST",
          url: `/api/tunnel-attachments/${desktopAttachment.attachmentId}/direct`,
          payload: { diagnosticTraceId: randomUUID() },
        });
        await readStarted;
        let deletionFinished = false;
        const deletionResponsePromise = app
          .inject({
            method: "DELETE",
            url:
              scope === "attachment"
                ? `/api/tunnel-attachments/${desktopAttachment.attachmentId}`
                : `/api/explorers/${explorer.id}`,
          })
          .then((response) => {
            deletionFinished = true;
            return response;
          });
        await revokeStarted;
        expect(deletionFinished).toBe(false);

        releaseRead();
        const directResponse = await directResponsePromise;
        expect(directResponse.statusCode, directResponse.body).toBe(409);
        const deletionResponse = await deletionResponsePromise;
        expect(deletionResponse.statusCode, deletionResponse.body).toBe(204);
        expect(directPrepareCapabilityIds).toHaveLength(preparationsBefore);
      } finally {
        releaseRead();
        getSpy.mockRestore();
        revokeSpy.mockRestore();
        await app.inject({
          method: "DELETE",
          url: `/api/explorers/${explorer.id}`,
        });
      }
    },
  );

  it("rejects direct preparation when the protected Code lease has expired", async () => {
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const attachmentResponse = await app.inject({
      method: "POST",
      url: `/api/explorers/${explorer.id}/protected-code-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: explorer.activeWorkerId,
        expectedWorktreeId: explorer.worktreeId,
        path: "src/expired-direct.ts",
        protectedRecord: protectedTunnelRecord(tunnelId),
        sessionId,
        tunnelId,
      },
    });
    expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(201);
    const desktopResponse = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/attachments`,
      payload: { clientId: randomUUID() },
    });
    expect(desktopResponse.statusCode, desktopResponse.body).toBe(201);
    const attachmentId = desktopResponse.json().attachmentId as string;
    const originalRootLease =
      CodeTunnelBroker.prototype.acquireAttachmentRootLease;
    const activitySpy = vi
      .spyOn(CodeTunnelBroker.prototype, "acquireAttachmentRootLease")
      .mockImplementation(function (this: CodeTunnelBroker, candidate) {
        if (candidate.tunnelId !== tunnelId) {
          return originalRootLease.call(this, candidate);
        }
        void this.revokeAttachment(tunnelId, LOCAL_USER_ID);
        return { lease: null, managed: true };
      });
    const preparationsBefore = directPrepareCapabilityIds.length;
    try {
      const directResponse = await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${attachmentId}/direct`,
        payload: { diagnosticTraceId: randomUUID() },
      });
      expect(directResponse.statusCode, directResponse.body).toBe(409);
      expect(directResponse.json()).toMatchObject({
        error: "The protected Code attachment has expired.",
      });
      expect(directPrepareCapabilityIds).toHaveLength(preparationsBefore);
      await vi.waitFor(async () => {
        expect(
          await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
        ).toMatchObject({ statusCode: 404 });
      });
    } finally {
      activitySpy.mockRestore();
      await app.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      });
    }
  });

  it.each(["retarget", "delete"] as const)(
    "fences terminal direct startup before terminal %s mutation",
    async (scope) => {
      const targetResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees`,
        payload: {
          name: `terminal-direct-${scope}`,
          mode: {
            type: "newBranch",
            branch: `terminal-direct-${scope}`,
            startPoint: "main",
          },
        },
      });
      expect(targetResponse.statusCode, targetResponse.body).toBe(201);
      const target = projectWorktreeSummarySchema.parse(targetResponse.json());
      const terminalResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/terminals`,
        payload: {
          ...protectedTerminalFields(),
          worktreeId: primaryId,
        },
      });
      expect(terminalResponse.statusCode, terminalResponse.body).toBe(201);
      const terminal = terminalWireSummarySchema.parse(terminalResponse.json());
      const originalGetWorker = database.repository.getWorker.bind(
        database.repository,
      );
      let signalWorkerRead!: () => void;
      let releaseWorkerRead!: () => void;
      const workerRead = new Promise<void>((resolve) => {
        signalWorkerRead = resolve;
      });
      const workerReadRelease = new Promise<void>((resolve) => {
        releaseWorkerRead = resolve;
      });
      let holdWorkerRead = true;
      const workerSpy = vi
        .spyOn(database.repository, "getWorker")
        .mockImplementation(async (...args) => {
          const result = await originalGetWorker(...args);
          if (holdWorkerRead && args[1] === terminal.activeWorkerId) {
            holdWorkerRead = false;
            signalWorkerRead();
            await workerReadRelease;
          }
          return result;
        });
      const originalMutateResource =
        DirectAttachmentCoordinator.prototype.mutateResource;
      let signalMutationStarted!: () => void;
      const mutationStarted = new Promise<void>((resolve) => {
        signalMutationStarted = resolve;
      });
      const mutationSpy = vi
        .spyOn(DirectAttachmentCoordinator.prototype, "mutateResource")
        .mockImplementation(function (
          this: DirectAttachmentCoordinator,
          ownerId,
          resourceKind,
          resourceId,
          mutation,
        ) {
          const result = originalMutateResource.call(
            this,
            ownerId,
            resourceKind,
            resourceId,
            mutation,
          );
          if (resourceKind === "terminal" && resourceId === terminal.id) {
            signalMutationStarted();
          }
          return result;
        });
      const opensBefore = terminalOpenCommands.length;
      const closesBefore = terminalCloseIds.length;
      try {
        const directResponsePromise = app.inject({
          method: "POST",
          url: `/api/terminals/${terminal.id}/direct`,
          payload: { clientId: randomUUID() },
        });
        await workerRead;
        let mutationFinished = false;
        const mutationResponsePromise = app
          .inject({
            method: scope === "retarget" ? "PATCH" : "DELETE",
            url:
              scope === "retarget"
                ? `/api/terminals/${terminal.id}/worktree`
                : `/api/terminals/${terminal.id}`,
            ...(scope === "retarget"
              ? { payload: { worktreeId: target.id } }
              : {}),
          })
          .then((response) => {
            mutationFinished = true;
            return response;
          });
        await mutationStarted;
        expect(mutationFinished).toBe(false);

        releaseWorkerRead();
        const directResponse = await directResponsePromise;
        expect(directResponse.statusCode, directResponse.body).toBe(409);
        const mutationResponse = await mutationResponsePromise;
        expect(mutationResponse.statusCode, mutationResponse.body).toBe(
          scope === "retarget" ? 200 : 204,
        );
        expect(terminalOpenCommands).toHaveLength(opensBefore);
        if (scope === "retarget") {
          expect(
            await database.repository.getTerminalExecutionContext(
              LOCAL_USER_ID,
              terminal.id,
            ),
          ).toMatchObject({ worktreeId: target.id });
        } else {
          expect(
            await database.repository.getTerminalExecutionContext(
              LOCAL_USER_ID,
              terminal.id,
            ),
          ).toBeNull();
          expect(terminalCloseIds.slice(closesBefore)).toContain(terminal.id);
        }
      } finally {
        releaseWorkerRead();
        workerSpy.mockRestore();
        mutationSpy.mockRestore();
        await app.inject({
          method: "DELETE",
          url: `/api/terminals/${terminal.id}`,
        });
      }
    },
  );

  it("finishes stale terminal cleanup before retarget permits a new direct open", async () => {
    const targetResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees`,
      payload: {
        name: "terminal-post-open-retarget",
        mode: {
          type: "newBranch",
          branch: "terminal-post-open-retarget",
          startPoint: "main",
        },
      },
    });
    expect(targetResponse.statusCode, targetResponse.body).toBe(201);
    const target = projectWorktreeSummarySchema.parse(targetResponse.json());
    const terminalResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/terminals`,
      payload: {
        ...protectedTerminalFields(),
        worktreeId: primaryId,
      },
    });
    expect(terminalResponse.statusCode, terminalResponse.body).toBe(201);
    const terminal = terminalWireSummarySchema.parse(terminalResponse.json());
    const originalContext =
      await database.repository.getTerminalExecutionContext(
        LOCAL_USER_ID,
        terminal.id,
      );
    let signalOpenStarted!: () => void;
    let releaseOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve;
    });
    const openRelease = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    heldTerminalOpen = { release: openRelease, started: signalOpenStarted };
    const originalMutateResource =
      DirectAttachmentCoordinator.prototype.mutateResource;
    let signalMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    const mutationSpy = vi
      .spyOn(DirectAttachmentCoordinator.prototype, "mutateResource")
      .mockImplementation(function (
        this: DirectAttachmentCoordinator,
        ownerId,
        resourceKind,
        resourceId,
        mutation,
      ) {
        const result = originalMutateResource.call(
          this,
          ownerId,
          resourceKind,
          resourceId,
          mutation,
        );
        if (resourceKind === "terminal" && resourceId === terminal.id) {
          signalMutationStarted();
        }
        return result;
      });
    const opensBefore = terminalOpenCommands.length;
    const closesBefore = terminalCloseIds.length;
    try {
      const staleDirectPromise = app.inject({
        method: "POST",
        url: `/api/terminals/${terminal.id}/direct`,
        payload: { clientId: randomUUID() },
      });
      await openStarted;
      let retargetFinished = false;
      const retargetPromise = app
        .inject({
          method: "PATCH",
          url: `/api/terminals/${terminal.id}/worktree`,
          payload: { worktreeId: target.id },
        })
        .then((response) => {
          retargetFinished = true;
          return response;
        });
      await mutationStarted;
      expect(retargetFinished).toBe(false);

      heldTerminalOpen = undefined;
      releaseOpen();
      const staleDirect = await staleDirectPromise;
      expect(staleDirect.statusCode, staleDirect.body).toBe(409);
      const retarget = await retargetPromise;
      expect(retarget.statusCode, retarget.body).toBe(200);
      expect(terminalCloseIds.slice(closesBefore)).toContain(terminal.id);
      expect(terminalOpenCommands.slice(opensBefore)).toEqual([
        expect.objectContaining({
          terminalId: terminal.id,
          worktreePath: originalContext!.worktreePath,
        }),
      ]);

      const currentContext =
        await database.repository.getTerminalExecutionContext(
          LOCAL_USER_ID,
          terminal.id,
        );
      const currentDirect = await app.inject({
        method: "POST",
        url: `/api/terminals/${terminal.id}/direct`,
        payload: { clientId: randomUUID() },
      });
      expect(currentDirect.statusCode, currentDirect.body).toBe(201);
      expect(terminalOpenCommands.slice(opensBefore)).toEqual([
        expect.objectContaining({
          worktreePath: originalContext!.worktreePath,
        }),
        expect.objectContaining({ worktreePath: currentContext!.worktreePath }),
      ]);
    } finally {
      heldTerminalOpen = undefined;
      releaseOpen();
      mutationSpy.mockRestore();
      await app.inject({
        method: "DELETE",
        url: `/api/terminals/${terminal.id}`,
      });
    }
  });

  it("retains a valid same-session Explorer attachment when duplicate registration fails", async () => {
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const payload = {
      appearance: "dark",
      expectedWorkerId: explorer.activeWorkerId,
      expectedWorktreeId: explorer.worktreeId,
      path: "src/duplicate.ts",
      protectedRecord: protectedTunnelRecord(tunnelId),
      sessionId,
      tunnelId,
    };

    try {
      const created = await app.inject({
        method: "POST",
        url: `/api/explorers/${explorer.id}/protected-code-attachments`,
        payload,
      });
      expect(created.statusCode, created.body).toBe(201);
      const stopsBeforeDuplicate = codeStopCommands.length;

      const duplicate = await app.inject({
        method: "POST",
        url: `/api/explorers/${explorer.id}/protected-code-attachments`,
        payload,
      });
      expect(duplicate.statusCode, duplicate.body).toBe(503);
      expect(duplicate.json()).toMatchObject({
        error: "This protected Cantrip Code attachment already exists.",
      });
      expect(codeStopCommands).toHaveLength(stopsBeforeDuplicate);
      expect(
        await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
      ).toMatchObject({ statusCode: 200 });
    } finally {
      await app.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      });
    }
  });

  it("synchronously revokes an existing Explorer Code attachment on delete", async () => {
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const attachmentResponse = await app.inject({
      method: "POST",
      url: `/api/explorers/${explorer.id}/protected-code-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: explorer.activeWorkerId,
        expectedWorktreeId: explorer.worktreeId,
        path: "src/delete-me.ts",
        protectedRecord: protectedTunnelRecord(tunnelId),
        sessionId,
        tunnelId,
      },
    });
    expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(201);
    expect(attachmentResponse.json()).toMatchObject({
      attachmentId: tunnelId,
      sessionId,
      tunnelId,
    });

    const desktopAttachmentResponse = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/attachments`,
      payload: { clientId: `desktop-${sessionId}` },
    });
    expect(
      desktopAttachmentResponse.statusCode,
      desktopAttachmentResponse.body,
    ).toBe(201);
    const desktopAttachment = desktopAttachmentResponse.json();
    const directResponse = await app.inject({
      method: "POST",
      url: `/api/tunnel-attachments/${desktopAttachment.attachmentId}/direct`,
      payload: { diagnosticTraceId: randomUUID() },
    });
    expect(directResponse.statusCode, directResponse.body).toBe(201);
    const capabilityId = directResponse.json().binding.capabilityId as string;
    const renewalSpy = vi.spyOn(
      DirectAttachmentCoordinator.prototype,
      "renewActiveLease",
    );
    try {
      const activationResponse = await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${desktopAttachment.attachmentId}/direct-activate`,
        payload: { capabilityId },
      });
      expect(activationResponse.statusCode, activationResponse.body).toBe(204);
      const telemetryResponse = await app.inject({
        method: "POST",
        url: `/api/direct-attachments/${capabilityId}/telemetry`,
        payload: {
          bytesFromLocal: 1,
          bytesToLocal: 0,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      });
      expect(telemetryResponse.statusCode, telemetryResponse.body).toBe(204);
      expect(renewalSpy).toHaveBeenCalledWith(capabilityId, {
        authSessionId: `local:${LOCAL_USER_ID}`,
        ownerId: LOCAL_USER_ID,
      });
    } finally {
      renewalSpy.mockRestore();
    }
    const endpointRevocationsBefore = codeEndpointRevokedTunnelIds.length;
    const sessionStopsBefore = codeStopSessionIds.length;
    const stopCommandsBefore = codeStopCommands.length;

    const deletionResponse = await app.inject({
      method: "DELETE",
      url: `/api/explorers/${explorer.id}`,
    });
    expect(deletionResponse.statusCode, deletionResponse.body).toBe(204);
    expect(
      codeEndpointRevokedTunnelIds.slice(endpointRevocationsBefore),
    ).toEqual([tunnelId]);
    expect(codeStopSessionIds.slice(sessionStopsBefore)).toEqual([sessionId]);
    expect(codeStopCommands.slice(stopCommandsBefore)).toEqual([
      {
        type: "code.stop",
        sessionId,
        expectedSessionIncarnationId: codeSessionIncarnationId,
      },
    ]);
    expect(
      await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: `/api/direct-attachments/${capabilityId}/telemetry`,
        payload: {
          bytesFromLocal: 1,
          bytesToLocal: 0,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      }),
    ).toMatchObject({ statusCode: 404 });

    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      codeEndpointRevokedTunnelIds.slice(endpointRevocationsBefore),
    ).toEqual([tunnelId]);
    expect(codeStopSessionIds.slice(sessionStopsBefore)).toEqual([sessionId]);
  });

  it("synchronously revokes an existing Explorer Code attachment on retarget", async () => {
    const targetResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees`,
      payload: {
        name: "explorer-code-retarget",
        mode: {
          type: "newBranch",
          branch: "explorer-code-retarget",
          startPoint: "main",
        },
      },
    });
    expect(targetResponse.statusCode, targetResponse.body).toBe(201);
    const target = projectWorktreeSummarySchema.parse(targetResponse.json());
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const attachmentResponse = await app.inject({
      method: "POST",
      url: `/api/explorers/${explorer.id}/protected-code-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: explorer.activeWorkerId,
        expectedWorktreeId: explorer.worktreeId,
        path: "src/retarget-me.ts",
        protectedRecord: protectedTunnelRecord(tunnelId),
        sessionId,
        tunnelId,
      },
    });
    expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(201);
    const endpointRevocationsBefore = codeEndpointRevokedTunnelIds.length;
    const sessionStopsBefore = codeStopSessionIds.length;
    const stopCommandsBefore = codeStopCommands.length;

    const retargetResponse = await app.inject({
      method: "PATCH",
      url: `/api/explorers/${explorer.id}/worktree`,
      payload: {
        worktreeId: target.id,
        stateProtection: protectedExplorerFields().stateProtection,
      },
    });
    expect(retargetResponse.statusCode, retargetResponse.body).toBe(200);
    expect(
      explorerWireSummarySchema.parse(retargetResponse.json()).worktreeId,
    ).toBe(target.id);
    expect(
      codeEndpointRevokedTunnelIds.slice(endpointRevocationsBefore),
    ).toEqual([tunnelId]);
    expect(codeStopSessionIds.slice(sessionStopsBefore)).toEqual([sessionId]);
    expect(codeStopCommands.slice(stopCommandsBefore)).toEqual([
      {
        type: "code.stop",
        sessionId,
        expectedSessionIncarnationId: codeSessionIncarnationId,
      },
    ]);
    expect(
      await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
  });

  it("rejects an attachment created while its Code tab is deleted", async () => {
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: primaryId,
        profileId: "attachment-race-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());
    const intentResponse = await app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
      payload: {
        appearance: "dark",
        expectedWorkerId: codeTab.activeWorkerId,
        expectedWorktreeId: codeTab.worktreeId,
      },
    });
    expect(intentResponse.statusCode, intentResponse.body).toBe(201);
    const intent = codeProtectedAttachmentIntentSchema.parse(
      intentResponse.json(),
    );
    const mismatchedTunnelId = randomUUID();
    const statusCountBeforeMismatch = codeStatusSessionIds.length;
    const mismatchedAttachmentResponse = await app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: "other-worker",
        expectedWorktreeId: codeTab.worktreeId,
        protectedRecord: protectedTunnelRecord(mismatchedTunnelId),
        sessionId: intent.sessionId,
        tunnelId: mismatchedTunnelId,
      },
    });
    expect(
      mismatchedAttachmentResponse.statusCode,
      mismatchedAttachmentResponse.body,
    ).toBe(409);
    expect(codeStatusSessionIds).toHaveLength(statusCountBeforeMismatch);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/tunnels/${mismatchedTunnelId}`,
      }),
    ).toMatchObject({ statusCode: 404 });
    const tunnelId = randomUUID();
    const stopCountBefore = codeStopSessionIds.filter(
      (candidate) => candidate === intent.sessionId,
    ).length;
    const heldCreation = holdNextProtectedAttachmentCreation();
    const revokeSpy = vi.spyOn(CodeTunnelBroker.prototype, "revokeAttachment");
    const revokeSessionSpy = vi.spyOn(
      CodeTunnelBroker.prototype,
      "revokeSession",
    );
    try {
      const attachmentResponsePromise = app.inject({
        method: "POST",
        url: `/api/code-tabs/${codeTab.id}/protected-attachments`,
        payload: {
          appearance: "dark",
          expectedWorkerId: codeTab.activeWorkerId,
          expectedWorktreeId: codeTab.worktreeId,
          protectedRecord: protectedTunnelRecord(tunnelId),
          sessionId: intent.sessionId,
          tunnelId,
        },
      });
      await heldCreation.started;
      const deletionResponsePromise = app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      });
      await vi.waitFor(() => expect(revokeSessionSpy).toHaveBeenCalled());
      heldCreation.release();
      const attachmentResponse = await attachmentResponsePromise;
      const deletionResponse = await deletionResponsePromise;

      expect(deletionResponse.statusCode, deletionResponse.body).toBe(204);
      expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(409);
      expect(attachmentResponse.json()).toMatchObject({
        error: "The Code tab changed while its editor was attaching.",
      });
      expect(revokeSpy).toHaveBeenCalledWith(tunnelId, LOCAL_USER_ID);
      expect(codeEndpointRevokedTunnelIds).toContain(tunnelId);
      expect(
        codeStopSessionIds.filter(
          (candidate) => candidate === intent.sessionId,
        ),
      ).toHaveLength(stopCountBefore + 1);
      const tunnelResponse = await app.inject({
        method: "GET",
        url: `/api/tunnels/${tunnelId}`,
      });
      expect(tunnelResponse.statusCode, tunnelResponse.body).toBe(404);
    } finally {
      heldCreation.release();
      heldCreation.restore();
      revokeSpy.mockRestore();
      revokeSessionSpy.mockRestore();
    }
  });

  it("bounds a conditional Code intent rollback stop to five seconds", async () => {
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: primaryId,
        profileId: "bounded-rollback-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());
    let signalCodeOpenStarted!: () => void;
    let releaseCodeOpen!: () => void;
    const codeOpenStarted = new Promise<void>((resolve) => {
      signalCodeOpenStarted = resolve;
    });
    const codeOpenRelease = new Promise<void>((resolve) => {
      releaseCodeOpen = resolve;
    });
    heldCodeOpen = {
      release: codeOpenRelease,
      started: signalCodeOpenStarted,
    };
    const timeoutCountBefore = codeStopTimeouts.length;
    let contextSpy: { mockRestore(): void } | null = null;

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
        payload: {
          appearance: "dark",
          expectedWorkerId: codeTab.activeWorkerId,
          expectedWorktreeId: codeTab.worktreeId,
        },
      });
      await codeOpenStarted;
      contextSpy = vi
        .spyOn(database.repository, "getCodeTabExecutionContext")
        .mockRejectedValueOnce(new Error("database unavailable"));
      releaseCodeOpen();
      const response = await responsePromise;
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      await vi.waitFor(() =>
        expect(codeStopTimeouts).toHaveLength(timeoutCountBefore + 1),
      );
      expect(codeStopTimeouts.at(-1)).toBe(5_000);
    } finally {
      releaseCodeOpen();
      heldCodeOpen = undefined;
      contextSpy?.mockRestore();
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      });
    }
  });

  it("revokes a generic Code attachment when its post-create context read fails", async () => {
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: primaryId,
        profileId: "post-create-cleanup-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());
    const intentResponse = await app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
      payload: {
        appearance: "dark",
        expectedWorkerId: codeTab.activeWorkerId,
        expectedWorktreeId: codeTab.worktreeId,
      },
    });
    expect(intentResponse.statusCode, intentResponse.body).toBe(201);
    const intent = codeProtectedAttachmentIntentSchema.parse(
      intentResponse.json(),
    );
    const tunnelId = randomUUID();
    const heldCreation = holdNextProtectedAttachmentCreation();
    let contextSpy: { mockRestore(): void } | null = null;
    const endpointRevocationsBefore = codeEndpointRevokedTunnelIds.length;

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: `/api/code-tabs/${codeTab.id}/protected-attachments`,
        payload: {
          appearance: "dark",
          expectedWorkerId: codeTab.activeWorkerId,
          expectedWorktreeId: codeTab.worktreeId,
          protectedRecord: protectedTunnelRecord(tunnelId),
          sessionId: intent.sessionId,
          tunnelId,
        },
      });
      await heldCreation.started;
      contextSpy = vi
        .spyOn(database.repository, "getCodeTabExecutionContext")
        .mockRejectedValueOnce(new Error("database unavailable"));
      heldCreation.release();
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(503);
      expect(
        await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}` }),
      ).toMatchObject({ statusCode: 404 });
      expect(
        codeEndpointRevokedTunnelIds.slice(endpointRevocationsBefore),
      ).toEqual([tunnelId]);
    } finally {
      heldCreation.release();
      heldCreation.restore();
      contextSpy?.mockRestore();
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      });
    }
  });

  it("rejects a Code attachment whose pre-registration context read races session stop", async () => {
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        ...protectedDisplayLabelFields("code-tab"),
        worktreeId: primaryId,
        profileId: "pre-registration-race-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabWireSummarySchema.parse(codeTabResponse.json());
    const intentResponse = await app.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/protected-attachment-intents`,
      payload: {
        appearance: "dark",
        expectedWorkerId: codeTab.activeWorkerId,
        expectedWorktreeId: codeTab.worktreeId,
      },
    });
    expect(intentResponse.statusCode, intentResponse.body).toBe(201);
    const intent = codeProtectedAttachmentIntentSchema.parse(
      intentResponse.json(),
    );
    const tunnelId = randomUUID();
    const originalContext = database.repository.getCodeTabExecutionContext.bind(
      database.repository,
    );
    let signalContextStarted!: () => void;
    let releaseContext!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      signalContextStarted = resolve;
    });
    const contextRelease = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const contextSpy = vi
      .spyOn(database.repository, "getCodeTabExecutionContext")
      .mockImplementationOnce(async (...args) => {
        signalContextStarted();
        await contextRelease;
        return originalContext(...args);
      });
    const revokeSessionSpy = vi.spyOn(
      CodeTunnelBroker.prototype,
      "revokeSession",
    );

    try {
      const attachmentResponsePromise = app.inject({
        method: "POST",
        url: `/api/code-tabs/${codeTab.id}/protected-attachments`,
        payload: {
          appearance: "dark",
          expectedWorkerId: codeTab.activeWorkerId,
          expectedWorktreeId: codeTab.worktreeId,
          protectedRecord: protectedTunnelRecord(tunnelId),
          sessionId: intent.sessionId,
          tunnelId,
        },
      });
      await contextStarted;
      let stopFinished = false;
      const stopResponsePromise = app
        .inject({
          method: "POST",
          url: `/api/code-tabs/${codeTab.id}/stop`,
        })
        .then((response) => {
          stopFinished = true;
          return response;
        });
      await vi.waitFor(() =>
        expect(revokeSessionSpy).toHaveBeenCalledWith(intent.sessionId),
      );
      expect(stopFinished).toBe(false);

      releaseContext();
      const attachmentResponse = await attachmentResponsePromise;
      const stopResponse = await stopResponsePromise;

      expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(409);
      expect(stopResponse.statusCode, stopResponse.body).toBe(200);
      expect(
        await app.inject({
          method: "GET",
          url: `/api/tunnels/${tunnelId}`,
        }),
      ).toMatchObject({ statusCode: 404 });
      expect(codeEndpointRevokedTunnelIds).not.toContain(tunnelId);
    } finally {
      releaseContext();
      contextSpy.mockRestore();
      revokeSessionSpy.mockRestore();
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      });
    }
  });

  it("rejects an Explorer attachment that finishes after its Explorer is deleted", async () => {
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const initialFile = "src/current.ts";
    const openCommandCount = codeOpenCommands.length;
    const stopCommandCount = codeStopCommands.length;

    let signalCodeOpenStarted!: () => void;
    let releaseCodeOpen!: () => void;
    const codeOpenStarted = new Promise<void>((resolve) => {
      signalCodeOpenStarted = resolve;
    });
    const codeOpenRelease = new Promise<void>((resolve) => {
      releaseCodeOpen = resolve;
    });
    heldCodeOpen = {
      release: codeOpenRelease,
      started: signalCodeOpenStarted,
    };
    const attachmentResponsePromise = app.inject({
      method: "POST",
      url: `/api/explorers/${explorer.id}/protected-code-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: explorer.activeWorkerId,
        expectedWorktreeId: explorer.worktreeId,
        path: initialFile,
        protectedRecord: protectedTunnelRecord(tunnelId),
        sessionId,
        tunnelId,
      },
    });
    await codeOpenStarted;

    const mutationSpy = vi.spyOn(CodeTunnelBroker.prototype, "mutateExplorer");
    const deletionResponsePromise = app.inject({
      method: "DELETE",
      url: `/api/explorers/${explorer.id}`,
    });
    await vi.waitFor(() => expect(mutationSpy).toHaveBeenCalled());
    releaseCodeOpen();
    const attachmentResponse = await attachmentResponsePromise;
    const deletionResponse = await deletionResponsePromise;
    heldCodeOpen = undefined;
    mutationSpy.mockRestore();

    expect(deletionResponse.statusCode, deletionResponse.body).toBe(204);
    expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(409);
    expect(attachmentResponse.json()).toMatchObject({
      error: "The Explorer changed while its editor was opening.",
    });
    expect(codeOpenCommands.slice(openCommandCount)).toEqual([
      expect.objectContaining({
        sessionId,
        worktreeId: primaryId,
        cwd: primaryPath,
        initialFile,
      }),
    ]);
    expect(codeStopCommands.slice(stopCommandCount)).toEqual([
      {
        type: "code.stop",
        sessionId,
        expectedSessionIncarnationId: codeSessionIncarnationId,
      },
    ]);
    const tunnelResponse = await app.inject({
      method: "GET",
      url: `/api/tunnels/${tunnelId}`,
    });
    expect(tunnelResponse.statusCode, tunnelResponse.body).toBe(404);
  });

  it("revokes an attachment created while its Explorer is deleted", async () => {
    const explorerResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        worktreeId: primaryId,
      },
    });
    expect(explorerResponse.statusCode, explorerResponse.body).toBe(201);
    const explorer = explorerWireSummarySchema.parse(explorerResponse.json());
    const sessionId = randomUUID();
    const tunnelId = randomUUID();
    const initialFile = "src/after-create.ts";
    const mismatchedTunnelId = randomUUID();
    const openCountBeforeMismatch = codeOpenCommands.length;
    const mismatchedAttachmentResponse = await app.inject({
      method: "POST",
      url: `/api/explorers/${explorer.id}/protected-code-attachments`,
      payload: {
        appearance: "dark",
        expectedWorkerId: "other-worker",
        expectedWorktreeId: "other-worktree",
        path: initialFile,
        protectedRecord: protectedTunnelRecord(mismatchedTunnelId),
        sessionId: randomUUID(),
        tunnelId: mismatchedTunnelId,
      },
    });
    expect(
      mismatchedAttachmentResponse.statusCode,
      mismatchedAttachmentResponse.body,
    ).toBe(409);
    expect(codeOpenCommands).toHaveLength(openCountBeforeMismatch);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/tunnels/${mismatchedTunnelId}`,
      }),
    ).toMatchObject({ statusCode: 404 });
    const stopCountBefore = codeStopSessionIds.filter(
      (candidate) => candidate === sessionId,
    ).length;
    const heldCreation = holdNextProtectedAttachmentCreation();
    const revokeSpy = vi.spyOn(CodeTunnelBroker.prototype, "revokeAttachment");
    const mutationSpy = vi.spyOn(CodeTunnelBroker.prototype, "mutateExplorer");
    try {
      const attachmentResponsePromise = app.inject({
        method: "POST",
        url: `/api/explorers/${explorer.id}/protected-code-attachments`,
        payload: {
          appearance: "dark",
          expectedWorkerId: explorer.activeWorkerId,
          expectedWorktreeId: explorer.worktreeId,
          path: initialFile,
          protectedRecord: protectedTunnelRecord(tunnelId),
          sessionId,
          tunnelId,
        },
      });
      await heldCreation.started;
      const deletionResponsePromise = app.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      });
      await vi.waitFor(() => expect(mutationSpy).toHaveBeenCalled());
      heldCreation.release();
      const attachmentResponse = await attachmentResponsePromise;
      const deletionResponse = await deletionResponsePromise;

      expect(deletionResponse.statusCode, deletionResponse.body).toBe(204);
      expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(409);
      expect(attachmentResponse.json()).toMatchObject({
        error: "The Explorer changed while its editor was opening.",
      });
      expect(revokeSpy).toHaveBeenCalledWith(tunnelId, LOCAL_USER_ID);
      expect(codeEndpointRevokedTunnelIds).toContain(tunnelId);
      expect(
        codeStopSessionIds.filter((candidate) => candidate === sessionId),
      ).toHaveLength(stopCountBefore + 1);
      const tunnelResponse = await app.inject({
        method: "GET",
        url: `/api/tunnels/${tunnelId}`,
      });
      expect(tunnelResponse.statusCode, tunnelResponse.body).toBe(404);
    } finally {
      heldCreation.release();
      heldCreation.restore();
      revokeSpy.mockRestore();
      mutationSpy.mockRestore();
    }
  });

  it("uses exact worktree paths for status, history, and Git actions", async () => {
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === managedIds[0])!;
    const observedHead = "4".repeat(40);
    workerWorktrees.find(({ path }) => path === target.path)!.head =
      observedHead;
    const statusResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/status`,
    });
    expect(
      worktreeStatusResultSchema.parse(statusResponse.json()).worktree.path,
    ).toBe(target.path);
    expect(
      (
        await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
      ).find(({ id }) => id === target.id)?.head,
    ).toBe(observedHead);
    connected = false;
    const offlineStatus = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/status`,
    });
    expect(offlineStatus.statusCode).toBe(200);
    expect(
      worktreeStatusResultSchema.parse(offlineStatus.json()),
    ).toMatchObject({ worktree: { path: target.path, head: observedHead } });
    connected = true;
    const historyResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/history`,
    });
    expect(gitHistorySchema.parse(historyResponse.json()).commits).toHaveLength(
      1,
    );
    expect(gitHistoryCommands.at(-1)).toMatchObject({
      cwd: target.path,
      revisions: expect.arrayContaining(
        workerWorktrees
          .map(({ head }) => head)
          .filter((head): head is string => typeof head === "string"),
      ),
    });
    const graphSnapshotResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/graph/snapshot?rootPath=src&maxNodes=500`,
    });
    expect(graphSnapshotResponse.statusCode).toBe(200);
    expect(
      gitGraphSnapshotSchema.parse(graphSnapshotResponse.json()),
    ).toMatchObject({ rootPath: "src", totalNodes: 2 });
    expect(gitGraphCommands.at(-1)).toMatchObject({
      type: "git.graph.snapshot",
      cwd: target.path,
      revision: "HEAD",
      rootPath: "src",
      maxNodes: 500,
    });
    const graphMetricsResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/graph/metrics?revision=${"1".repeat(40)}&includeBlame=true`,
    });
    expect(graphMetricsResponse.statusCode).toBe(200);
    expect(
      gitGraphMetricsSchema.parse(graphMetricsResponse.json()),
    ).toMatchObject({ historyScope: "current-branch", renameAware: false });
    expect(gitGraphCommands.at(-1)).toMatchObject({
      type: "git.graph.metrics",
      cwd: target.path,
      revision: "1".repeat(40),
      rootPath: null,
      maxNodes: 100_000,
      includeBlame: true,
    });
    const graphOverlayResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/graph/commits/${"1".repeat(40)}?rootPath=src`,
    });
    expect(graphOverlayResponse.statusCode).toBe(200);
    expect(
      gitGraphCommitOverlaySchema.parse(graphOverlayResponse.json()),
    ).toMatchObject({
      revision: "1".repeat(40),
      rootPath: "src",
      filesChanged: 1,
    });
    expect(gitGraphCommands.at(-1)).toMatchObject({
      type: "git.graph.commit-overlay",
      cwd: target.path,
      revision: "1".repeat(40),
      rootPath: "src",
    });
    const invalidOverlayResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/graph/commits/short`,
    });
    expect(invalidOverlayResponse.statusCode).toBe(400);
    const invalidGraphResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/graph/snapshot?rootPath=..%2Foutside`,
    });
    expect(invalidGraphResponse.statusCode).toBe(400);
    const actionResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/actions`,
      payload: { type: "stageAll" },
    });
    gitActionResultSchema.parse(actionResponse.json());
    expect(gitActionPaths.at(-1)).toBe(target.path);
    const forcePreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/force-push/preview`,
      payload: {},
    });
    expect(
      gitForcePushPreviewSchema.parse(forcePreviewResponse.json()),
    ).toMatchObject({
      remote: "origin",
      expectedRemoteHead: "3".repeat(40),
    });
    expect(gitForcePushCommands.at(-1)).toMatchObject({
      type: "git.force-push.preview",
      cwd: target.path,
    });
    const forceApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/force-push/apply`,
      payload: { token: "f".repeat(64) },
    });
    expect(gitActionResultSchema.parse(forceApplyResponse.json()).output).toBe(
      "forced with lease",
    );
    expect(gitForcePushCommands.at(-1)).toMatchObject({
      type: "git.force-push.apply",
      cwd: target.path,
      token: "f".repeat(64),
    });
    const diffResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/diff?path=src%2Fapp.ts&scope=unstaged`,
    });
    expect(gitFileDiffSchema.parse(diffResponse.json())).toMatchObject({
      path: "src/app.ts",
      scope: "unstaged",
    });
    expect(gitDiffCommands.at(-1)).toMatchObject({
      cwd: target.path,
      path: "src/app.ts",
      scope: "unstaged",
    });
    const patchRequest = {
      operation: "stage" as const,
      path: "src/app.ts",
      hunks: [{ hunkIndex: 0, lineIndexes: [0, 1] }],
    };
    const patchPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/patch/preview`,
      payload: patchRequest,
    });
    expect(
      gitPartialPatchPreviewSchema.parse(patchPreviewResponse.json()),
    ).toMatchObject({
      operation: "stage",
      path: "src/app.ts",
      token: "a".repeat(64),
    });
    expect(gitPatchPreviewCommands.at(-1)).toMatchObject({
      cwd: target.path,
      request: patchRequest,
    });
    const patchApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/patch/apply`,
      payload: { request: patchRequest, token: "a".repeat(64) },
    });
    expect(
      gitActionResultSchema.parse(patchApplyResponse.json()),
    ).toMatchObject({
      output: "applied",
    });
    expect(gitPatchApplyCommands.at(-1)).toMatchObject({
      cwd: target.path,
      request: patchRequest,
      token: "a".repeat(64),
    });
    maximumConcurrentGitMutations = 0;
    await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/patch/apply`,
        payload: { request: patchRequest, token: "a".repeat(64) },
      }),
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/actions`,
        payload: { type: "stageAll" },
      }),
    ]);
    expect(maximumConcurrentGitMutations).toBe(1);
    const invalidPatchPath = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/patch/preview`,
      payload: { ...patchRequest, path: "../secret" },
    });
    expect(invalidPatchPath.statusCode).toBe(400);
    connected = false;
    const offlinePatchPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/patch/preview`,
      payload: patchRequest,
    });
    expect(offlinePatchPreview.statusCode).toBe(503);
    connected = true;
    const stashListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes`,
    });
    expect(gitStashListSchema.parse(stashListResponse.json()).stashes).toEqual([
      expect.objectContaining({ hash: stashFixture.hash }),
    ]);
    expect(gitStashCommands.at(-1)).toMatchObject({
      type: "git.stash.list",
      cwd: target.path,
    });
    const stashCreateResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes`,
      payload: {
        message: "Scoped shelf",
        includeStaged: false,
        includeUnstaged: true,
        includeUntracked: true,
      },
    });
    expect(
      gitStashMutationResultSchema.parse(stashCreateResponse.json()),
    ).toMatchObject({ stash: { message: "Scoped shelf" } });
    expect(gitStashCommands.at(-1)).toMatchObject({
      type: "git.stash.create",
      cwd: target.path,
      request: { message: "Scoped shelf" },
    });
    const stashDiffResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/${stashFixture.hash}/diff?path=src%2Fapp.ts`,
    });
    expect(
      gitStashFileDiffSchema.parse(stashDiffResponse.json()),
    ).toMatchObject({
      hash: stashFixture.hash,
      path: "src/app.ts",
    });
    const popAction = {
      type: "pop" as const,
      ref: stashFixture.ref,
      hash: stashFixture.hash,
    };
    const stashPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/preview`,
      payload: popAction,
    });
    expect(
      gitStashActionPreviewSchema.parse(stashPreviewResponse.json()),
    ).toMatchObject({ action: popAction, token: "e".repeat(64) });
    const stashApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/apply`,
      payload: { action: popAction, token: "e".repeat(64) },
    });
    expect(
      gitStashMutationResultSchema.parse(stashApplyResponse.json()),
    ).toMatchObject({ output: "stash action complete" });
    expect(gitStashCommands.at(-1)).toMatchObject({
      type: "git.stash.action.apply",
      cwd: target.path,
      action: popAction,
    });
    stashActionConflicts = true;
    managedOperationState = "conflicted";
    const stashConflictPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/preview`,
      payload: popAction,
    });
    expect(stashConflictPreviewResponse.statusCode).toBe(200);
    const stashConflictApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/apply`,
      payload: { action: popAction, token: "e".repeat(64) },
    });
    expect(
      gitStashMutationResultSchema.parse(stashConflictApplyResponse.json()),
    ).toMatchObject({
      operation: { type: "stash", state: "conflicted" },
      conflictedPaths: ["src/app.ts"],
    });
    const stashOperation = await database.repository.getActiveGitOperation(
      LOCAL_USER_ID,
      projectId,
      target.id,
    );
    expect(stashOperation).toMatchObject({
      type: "stash",
      state: "conflicted",
      sourceRevision: stashFixture.hash,
    });
    const blockedStashCreate = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes`,
      payload: {
        message: "Blocked while resolving",
        includeStaged: true,
        includeUnstaged: true,
        includeUntracked: false,
      },
    });
    expect(blockedStashCreate.statusCode).toBe(409);
    expect(blockedStashCreate.json()).toMatchObject({
      error: "Finish or abort the active stash operation first.",
    });
    const blockedStashPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/preview`,
      payload: popAction,
    });
    expect(blockedStashPreview.statusCode).toBe(409);
    expect(blockedStashPreview.json()).toMatchObject({
      error: "Finish or abort the active stash operation first.",
    });
    const abortStashResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/${stashOperation!.id}/control`,
      payload: { action: "abort" },
    });
    expect(
      gitManagedOperationResponseSchema.parse(abortStashResponse.json())
        .operation,
    ).toMatchObject({ type: "stash", state: "aborted" });
    stashActionConflicts = false;
    maximumConcurrentGitMutations = 0;
    await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes`,
        payload: {
          message: "Serialized shelf",
          includeStaged: true,
          includeUnstaged: true,
          includeUntracked: false,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/actions/apply`,
        payload: { action: popAction, token: "e".repeat(64) },
      }),
    ]);
    expect(maximumConcurrentGitMutations).toBe(1);
    const invalidStashDiff = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes/not-a-hash/diff?path=..%2Fsecret`,
    });
    expect(invalidStashDiff.statusCode).toBe(400);
    connected = false;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/worktrees/${target.id}/git/stashes`,
        })
      ).statusCode,
    ).toBe(503);
    connected = true;
    const branchListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches`,
    });
    expect(gitBranchListSchema.parse(branchListResponse.json())).toMatchObject({
      currentBranch: "main",
      defaultRemote: "origin",
    });
    expect(gitBranchCommands.at(-1)).toMatchObject({
      type: "git.branch.list",
      cwd: target.path,
    });
    const fetchAction = { type: "fetch" as const, remote: null, prune: true };
    const branchPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches/actions/preview`,
      payload: fetchAction,
    });
    expect(
      gitBranchActionPreviewSchema.parse(branchPreviewResponse.json()),
    ).toMatchObject({
      action: fetchAction,
      destructive: true,
      token: "f".repeat(64),
    });
    const branchApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches/actions/apply`,
      payload: { action: fetchAction, token: "f".repeat(64) },
    });
    expect(
      gitBranchMutationResultSchema.parse(branchApplyResponse.json()),
    ).toMatchObject({ output: "branch action complete" });
    expect(gitBranchCommands.at(-1)).toMatchObject({
      type: "git.branch.action.apply",
      cwd: target.path,
      action: fetchAction,
    });
    const invalidBranchAction = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches/actions/preview`,
      payload: { type: "fetch", remote: "--upload-pack=bad", prune: false },
    });
    expect(invalidBranchAction.statusCode).toBe(400);
    maximumConcurrentGitMutations = 0;
    await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches/actions/apply`,
        payload: { action: fetchAction, token: "f".repeat(64) },
      }),
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/actions`,
        payload: { type: "stageAll" },
      }),
    ]);
    expect(maximumConcurrentGitMutations).toBe(1);
    connected = false;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/worktrees/${target.id}/git/branches`,
        })
      ).statusCode,
    ).toBe(503);
    connected = true;
    const remoteListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/remotes`,
    });
    expect(gitRemoteListSchema.parse(remoteListResponse.json())).toMatchObject({
      remotes: [expect.objectContaining({ name: "origin" })],
    });
    expect(gitRemoteCommands.at(-1)).toMatchObject({
      type: "git.remote.list",
      cwd: target.path,
    });
    const remoteAction = {
      type: "fetch" as const,
      remote: "origin",
      prune: true,
    };
    const remotePreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/remotes/actions/preview`,
      payload: remoteAction,
    });
    expect(
      gitRemoteActionPreviewSchema.parse(remotePreviewResponse.json()),
    ).toMatchObject({ action: remoteAction, destructive: true });
    const remoteApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/remotes/actions/apply`,
      payload: { action: remoteAction, token: "a".repeat(64) },
    });
    expect(
      gitRemoteMutationResultSchema.parse(remoteApplyResponse.json()),
    ).toMatchObject({ output: "remote action complete" });
    expect(gitRemoteCommands.at(-1)).toMatchObject({
      type: "git.remote.action.apply",
      cwd: target.path,
      action: remoteAction,
    });
    const invalidRemoteResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/remotes/actions/preview`,
      payload: {
        type: "add",
        name: "evil",
        fetchUrl: "--upload-pack=bad",
        pushUrl: null,
      },
    });
    expect(invalidRemoteResponse.statusCode).toBe(400);

    const submoduleListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/submodules`,
    });
    expect(
      gitSubmoduleListSchema.parse(submoduleListResponse.json()),
    ).toMatchObject({
      submodules: [
        expect.objectContaining({
          path: "modules/library",
          state: "uninitialized",
        }),
      ],
    });
    expect(gitSubmoduleCommands.at(-1)).toMatchObject({
      type: "git.submodule.list",
      cwd: target.path,
    });
    const submoduleAction = {
      type: "initialize" as const,
      path: "modules/library",
      recursive: true,
    };
    const submodulePreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/submodules/actions/preview`,
      payload: submoduleAction,
    });
    expect(
      gitSubmoduleActionPreviewSchema.parse(submodulePreviewResponse.json()),
    ).toMatchObject({ action: submoduleAction, token: "9".repeat(64) });
    const submoduleApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/submodules/actions/apply`,
      payload: { action: submoduleAction, token: "9".repeat(64) },
    });
    expect(
      gitSubmoduleMutationResultSchema.parse(submoduleApplyResponse.json()),
    ).toMatchObject({
      output: "submodule action complete",
      submodules: {
        submodules: [
          expect.objectContaining({
            path: "modules/library",
            state: "clean",
          }),
        ],
      },
    });
    expect(gitSubmoduleCommands.at(-1)).toMatchObject({
      type: "git.submodule.action.apply",
      cwd: target.path,
      action: submoduleAction,
    });
    const invalidSubmoduleResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/submodules/actions/preview`,
      payload: {
        type: "deinitialize",
        path: "../outside",
        force: true,
      },
    });
    expect(invalidSubmoduleResponse.statusCode).toBe(400);

    const lfsStatusResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/lfs`,
    });
    expect(gitLfsStatusSchema.parse(lfsStatusResponse.json())).toMatchObject({
      available: true,
      files: [expect.objectContaining({ path: "asset.bin" })],
    });
    expect(gitLfsCommands.at(-1)).toMatchObject({
      type: "git.lfs.status",
      cwd: target.path,
      refreshLocks: false,
    });
    const lfsAction = {
      type: "track" as const,
      pattern: "*.archive",
    };
    const lfsPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/lfs/actions/preview`,
      payload: lfsAction,
    });
    expect(
      gitLfsActionPreviewSchema.parse(lfsPreviewResponse.json()),
    ).toMatchObject({ action: lfsAction, token: "8".repeat(64) });
    const lfsApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/lfs/actions/apply`,
      payload: { action: lfsAction, token: "8".repeat(64) },
    });
    expect(
      gitLfsMutationResultSchema.parse(lfsApplyResponse.json()),
    ).toMatchObject({ output: "Git LFS action complete" });
    expect(gitLfsCommands.at(-1)).toMatchObject({
      type: "git.lfs.action.apply",
      cwd: target.path,
      action: lfsAction,
    });
    const invalidLfsResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/lfs/actions/preview`,
      payload: { type: "lock", path: "../outside" },
    });
    expect(invalidLfsResponse.statusCode).toBe(400);

    const tagListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags`,
    });
    expect(tagListResponse.statusCode, tagListResponse.body).toBe(200);
    expect(gitTagListSchema.parse(tagListResponse.json())).toMatchObject({
      tags: [expect.objectContaining({ name: tagFixture.name })],
    });
    expect(gitTagCommands.at(-1)).toMatchObject({
      type: "git.tag.list",
      cwd: target.path,
    });
    const tagDetailResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags/${encodeURIComponent(tagFixture.name)}`,
    });
    expect(gitTagDetailSchema.parse(tagDetailResponse.json())).toMatchObject({
      name: tagFixture.name,
      message: expect.stringContaining("Signed release"),
    });
    const tagAction = {
      type: "push" as const,
      name: tagFixture.name,
      remote: "origin",
    };
    const tagPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags/actions/preview`,
      payload: tagAction,
    });
    expect(
      gitTagActionPreviewSchema.parse(tagPreviewResponse.json()),
    ).toMatchObject({ action: tagAction });
    const tagApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags/actions/apply`,
      payload: { action: tagAction, token: "b".repeat(64) },
    });
    expect(
      gitTagMutationResultSchema.parse(tagApplyResponse.json()),
    ).toMatchObject({ output: "tag action complete" });
    const invalidTagResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags/actions/preview`,
      payload: {
        type: "create",
        name: "v2",
        target: null,
        annotated: true,
        message: null,
      },
    });
    expect(invalidTagResponse.statusCode).toBe(400);

    const releaseListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/github/releases`,
    });
    expect(
      githubReleaseListSchema.parse(releaseListResponse.json()),
    ).toMatchObject({ releases: [expect.objectContaining({ id: 42 })] });
    expect(githubReleaseCommands.at(-1)).toMatchObject({
      type: "github.releases.list",
      cwd: target.path,
      repository: "ArcaneArts/Cantrip",
    });
    const releaseDetailResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/github/releases/42`,
    });
    expect(
      githubReleaseSummarySchema.parse(releaseDetailResponse.json()),
    ).toMatchObject({ id: 42, tagName: tagFixture.name });
    const releaseCreate = {
      tagName: tagFixture.name,
      name: "Cantrip stable",
      body: "## Changes\n\n- Git client",
      draft: true,
      prerelease: false,
    };
    const releaseCreateResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/github/releases`,
      payload: releaseCreate,
    });
    expect(releaseCreateResponse.statusCode).toBe(201);
    expect(
      githubReleaseSummarySchema.parse(releaseCreateResponse.json()),
    ).toMatchObject(releaseCreate);
    expect(githubReleaseCommands.at(-1)).toMatchObject({
      type: "github.release.create",
      cwd: target.path,
      repository: "ArcaneArts/Cantrip",
      request: releaseCreate,
    });
    maximumConcurrentGitMutations = 0;
    await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/remotes/actions/apply`,
        payload: { action: remoteAction, token: "a".repeat(64) },
      }),
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/github/releases`,
        payload: releaseCreate,
      }),
    ]);
    expect(maximumConcurrentGitMutations).toBe(1);
    connected = false;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/worktrees/${target.id}/git/tags`,
        })
      ).statusCode,
    ).toBe(503);
    connected = true;
    const actionRevision = "3".repeat(40);
    const commitAction = {
      type: "cherryPick" as const,
      selection: {
        type: "commits" as const,
        revisions: [actionRevision],
      },
    };
    const commitActionPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/actions/preview`,
      payload: commitAction,
    });
    expect(
      gitCommitActionPreviewSchema.parse(commitActionPreviewResponse.json()),
    ).toMatchObject({
      action: commitAction,
      resolvedRevisions: [actionRevision],
      token: "c".repeat(64),
    });
    expect(gitCommitActionCommands.at(-1)).toMatchObject({
      type: "git.commit.action.preview",
      cwd: target.path,
      action: commitAction,
    });
    const commitActionApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/actions/apply`,
      payload: { action: commitAction, token: "c".repeat(64) },
    });
    expect(
      gitCommitActionResultSchema.parse(commitActionApplyResponse.json()),
    ).toMatchObject({
      output: "commit action complete",
      operation: { type: "cherry-pick", state: "completed" },
    });
    expect(gitCommitActionCommands.at(-1)).toMatchObject({
      type: "git.commit.action.apply",
      cwd: target.path,
      action: commitAction,
    });
    managedOperationState = "conflicted";
    const operationPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/preview`,
      payload: managedOperationAction,
    });
    expect(
      gitManagedOperationPreviewSchema.parse(operationPreviewResponse.json()),
    ).toMatchObject({
      action: managedOperationAction,
      token: "d".repeat(64),
      wouldConflict: true,
    });
    const operationStartResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations`,
      payload: {
        action: managedOperationAction,
        token: "d".repeat(64),
      },
    });
    expect(operationStartResponse.statusCode, operationStartResponse.body).toBe(
      201,
    );
    const startedOperation = gitManagedOperationResponseSchema.parse(
      operationStartResponse.json(),
    ).operation!;
    expect(startedOperation).toMatchObject({
      projectId,
      worktreeId: target.id,
      workerId: "test-worker",
      type: "rebase",
      state: "conflicted",
      sourceRef: "origin/main",
      conflictedPaths: ["src/app.ts"],
    });
    expect(gitManagedOperationCommands.at(-1)).toMatchObject({
      type: "git.operation.start",
      cwd: target.path,
      action: managedOperationAction,
    });
    const blockedOperationPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/preview`,
      payload: { type: "merge", sourceRef: "feature" },
    });
    expect(blockedOperationPreview.statusCode).toBe(409);
    connected = false;
    const offlineOperation = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/current`,
    });
    expect(offlineOperation.statusCode).toBe(200);
    expect(
      gitManagedOperationResponseSchema.parse(offlineOperation.json())
        .operation,
    ).toMatchObject({ id: startedOperation.id, state: "conflicted" });
    connected = true;
    const conflictListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/conflicts`,
    });
    expect(
      gitConflictListSchema.parse(conflictListResponse.json()).files[0],
    ).toMatchObject({ path: "src/app.ts", kind: "both-modified" });
    const conflictDetailResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/conflicts/detail?path=${encodeURIComponent("src/app.ts")}`,
    });
    expect(
      gitConflictDetailSchema.parse(conflictDetailResponse.json()).theirs
        .content,
    ).toBe("theirs\n");
    const conflictResolution = {
      path: "src/app.ts",
      strategy: "manual" as const,
      content: "resolved\n",
    };
    const conflictPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/conflicts/preview`,
      payload: conflictResolution,
    });
    expect(
      gitConflictResolutionPreviewSchema.parse(conflictPreviewResponse.json()),
    ).toMatchObject({ token: "e".repeat(64), request: conflictResolution });
    const conflictApplyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/conflicts/apply`,
      payload: { request: conflictResolution, token: "e".repeat(64) },
    });
    expect(
      gitConflictResolutionResultSchema.parse(conflictApplyResponse.json()),
    ).toMatchObject({ resolved: true, remainingPaths: [] });
    expect(gitConflictCommands.at(-1)).toMatchObject({
      type: "git.conflicts.apply",
      cwd: target.path,
      request: conflictResolution,
    });
    expect(
      await database.repository.getLatestGitOperation(
        LOCAL_USER_ID,
        projectId,
        target.id,
      ),
    ).toMatchObject({
      id: startedOperation.id,
      state: "awaiting-user-action",
      conflictedPaths: [],
    });
    const operationControlResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/${startedOperation.id}/control`,
      payload: { action: "continue" },
    });
    expect(
      gitManagedOperationResponseSchema.parse(operationControlResponse.json())
        .operation,
    ).toMatchObject({
      id: startedOperation.id,
      state: "completed",
      currentStep: 1,
      pendingCommits: [],
    });
    expect(
      await database.repository.getLatestGitOperation(
        LOCAL_USER_ID,
        projectId,
        target.id,
      ),
    ).toMatchObject({ id: startedOperation.id, state: "completed" });
    const rewriteAction = {
      type: "interactiveRebase" as const,
      upstreamRef: "origin/main",
      todo: [
        {
          action: "edit" as const,
          revision: "3".repeat(40),
          message: null,
        },
      ],
    };
    const rewritePreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/preview`,
      payload: rewriteAction,
    });
    expect(
      gitManagedOperationPreviewSchema.parse(rewritePreviewResponse.json()),
    ).toMatchObject({
      action: rewriteAction,
      destructive: true,
      todo: rewriteAction.todo,
    });
    const rewriteStartResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations`,
      payload: { action: rewriteAction, token: "d".repeat(64) },
    });
    expect(rewriteStartResponse.statusCode, rewriteStartResponse.body).toBe(
      201,
    );
    const rewriteOperation = gitManagedOperationResponseSchema.parse(
      rewriteStartResponse.json(),
    ).operation!;
    expect(rewriteOperation).toMatchObject({
      type: "rebase",
      state: "awaiting-user-action",
      checkpointRef: "refs/cantrip/checkpoints/rewrite-test",
      pausedAction: "edit",
    });
    const rewriteAmendResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/${rewriteOperation.id}/amend`,
      payload: { message: "Edited through Cantrip" },
    });
    expect(
      gitManagedOperationResponseSchema.parse(rewriteAmendResponse.json())
        .operation,
    ).toMatchObject({ id: rewriteOperation.id, state: "completed" });
    expect(gitManagedOperationCommands.at(-1)).toMatchObject({
      type: "git.operation.amend",
      cwd: target.path,
      message: "Edited through Cantrip",
    });
    const bisectAction = {
      type: "bisect" as const,
      goodRef: "HEAD~7",
      badRef: "HEAD",
    };
    const bisectPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/preview`,
      payload: bisectAction,
    });
    expect(
      gitManagedOperationPreviewSchema.parse(bisectPreviewResponse.json()),
    ).toMatchObject({
      action: bisectAction,
      context: {
        type: "bisect",
        sourceRef: "HEAD~7",
        targetRef: "HEAD",
      },
    });
    const bisectStartResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations`,
      payload: { action: bisectAction, token: "d".repeat(64) },
    });
    expect(bisectStartResponse.statusCode, bisectStartResponse.body).toBe(201);
    const bisectOperation = gitManagedOperationResponseSchema.parse(
      bisectStartResponse.json(),
    ).operation!;
    expect(bisectOperation).toMatchObject({
      type: "bisect",
      state: "awaiting-user-action",
      workerId: "test-worker",
      sourceRef: "HEAD~7",
      targetRef: "HEAD",
    });
    connected = false;
    const offlineBisectResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/current`,
    });
    expect(
      gitManagedOperationResponseSchema.parse(offlineBisectResponse.json())
        .operation,
    ).toMatchObject({ id: bisectOperation.id, type: "bisect" });
    connected = true;
    const bisectGoodResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/${bisectOperation.id}/control`,
      payload: { action: "good" },
    });
    expect(
      gitManagedOperationResponseSchema.parse(bisectGoodResponse.json())
        .operation,
    ).toMatchObject({
      id: bisectOperation.id,
      type: "bisect",
      state: "awaiting-user-action",
    });
    expect(gitManagedOperationCommands.at(-1)).toMatchObject({
      type: "git.operation.control",
      cwd: target.path,
      action: "good",
    });
    const bisectResetResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/${bisectOperation.id}/control`,
      payload: { action: "reset" },
    });
    expect(
      gitManagedOperationResponseSchema.parse(bisectResetResponse.json())
        .operation,
    ).toMatchObject({
      id: bisectOperation.id,
      type: "bisect",
      state: "completed",
    });
    const invalidOperation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/operations/preview`,
      payload: { type: "rebase", sourceRef: "bad\nref" },
    });
    expect(invalidOperation.statusCode).toBe(400);
    const invalidCommitAction = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/actions/preview`,
      payload: {
        type: "revert",
        revision: "HEAD~1",
        mainlineParent: null,
      },
    });
    expect(invalidCommitAction.statusCode).toBe(400);
    maximumConcurrentGitMutations = 0;
    await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/actions/preview`,
        payload: commitAction,
      }),
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/worktrees/${target.id}/git/actions`,
        payload: { type: "stageAll" },
      }),
    ]);
    expect(maximumConcurrentGitMutations).toBe(1);
    connected = false;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/actions/preview`,
          payload: commitAction,
        })
      ).statusCode,
    ).toBe(503);
    connected = true;
    const revision = "1".repeat(40);
    const commitResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/${revision}?parent=0`,
    });
    expect(gitCommitDetailSchema.parse(commitResponse.json())).toMatchObject({
      hash: revision,
      filesChanged: 1,
    });
    expect(gitCommitCommands.at(-1)).toMatchObject({
      cwd: target.path,
      revision,
      parentIndex: 0,
      revisions: expect.arrayContaining([revision]),
    });
    const signatureResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/${revision}/signature`,
    });
    expect(signatureResponse.json()).toMatchObject({
      status: "valid",
      signer: "Cantrip Test",
    });
    expect(gitCommitSignatureCommands.at(-1)).toMatchObject({
      cwd: target.path,
      revision,
    });
    const revisionDiffResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/revisions/${revision}/diff?path=src%2Fapp.ts`,
    });
    expect(
      gitRevisionFileDiffSchema.parse(revisionDiffResponse.json()),
    ).toMatchObject({ revision, path: "src/app.ts", baseRevision: null });
    expect(gitRevisionDiffCommands.at(-1)).toMatchObject({
      cwd: target.path,
      revision,
      baseRevision: null,
      path: "src/app.ts",
    });
    const invalidRevision = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/HEAD~1`,
    });
    expect(invalidRevision.statusCode).toBe(400);
    const invalidPath = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/revisions/${revision}/diff?path=..%2Fsecret`,
    });
    expect(invalidPath.statusCode).toBe(400);
    const invalidParent = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/commits/${revision}?parent=1oops`,
    });
    expect(invalidParent.statusCode).toBe(400);
    const refsResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/refs`,
    });
    const candidates = gitRevisionCandidateListSchema.parse(
      refsResponse.json(),
    );
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "main", kind: "local" }),
        expect.objectContaining({
          name: `${target.name} worktree`,
          kind: "worktree",
          worktreeId: target.id,
        }),
      ]),
    );
    expect(gitRefsCommands.at(-1)?.cwd).toBe(target.path);
    const right = "2".repeat(40);
    const comparisonResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/compare?left=${revision}&right=${right}&mode=merge-base`,
    });
    expect(gitComparisonSchema.parse(comparisonResponse.json())).toMatchObject({
      left: revision,
      right,
      mode: "merge-base",
    });
    expect(gitCompareCommands.at(-1)).toMatchObject({
      cwd: target.path,
      left: revision,
      right,
      mode: "merge-base",
    });
    const invalidComparison = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/compare?left=main&right=${right}&mode=direct`,
    });
    expect(invalidComparison.statusCode).toBe(400);
  });

  it("rejects plaintext Git agent drafts and relays opaque agent requests", async () => {
    const target = { id: primaryId, path: primaryPath };
    const legacyResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/agent/drafts`,
      payload: {
        task: "draft-commit-message",
        instructions: "Mention the private Git client.",
      },
    });
    expect(legacyResponse.statusCode).toBe(410);

    const modelId = (await database.repository.getSettings(LOCAL_USER_ID))
      .preferences.defaultModelId!;
    const operationId = "99999999-9999-4999-8999-999999999999";
    const protectedRequest = {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/repository-operation`,
      payload: {
        operationId,
        protectedRequest,
        agent: true,
        modelId,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      operationId,
      protectedResponse: protectedRequest,
      agentExecution: null,
    });
    const command = repositoryOperationCommands.at(-1)!;
    expect(command).toMatchObject({
      type: "repository.operation",
      cwd: target.path,
      worktreeId: target.id,
      operationId,
      agent: true,
      modelId,
    });
    expect(command.agentRuntimes).toHaveLength(1);
    expect(JSON.stringify(command)).not.toContain("private Git client");
  });
  it("locks, unlocks, and protects Primary and external removal", async () => {
    const managedId = managedIds[0]!;
    const locked = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${managedId}/lock`,
      payload: { reason: "Review in progress" },
    });
    expect(projectWorktreeSummarySchema.parse(locked.json())).toMatchObject({
      locked: true,
      lockReason: "Review in progress",
    });
    const unlocked = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${managedId}/unlock`,
    });
    expect(projectWorktreeSummarySchema.parse(unlocked.json()).locked).toBe(
      false,
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${primaryId}`,
        })
      ).statusCode,
    ).toBe(409);
    const external = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ origin }) => origin === "external")!;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${external.id}`,
        })
      ).statusCode,
    ).toBe(409);
  });

  it("retires an active Run instance instead of treating it as a worktree removal blocker", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees`,
      payload: {
        name: "run-removal",
        mode: {
          type: "newBranch",
          branch: "run-removal",
          startPoint: "main",
        },
      },
    });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const worktree = projectWorktreeSummarySchema.parse(createdResponse.json());
    const ordinaryTerminal = await database.repository.createTerminal(
      LOCAL_USER_ID,
      projectId,
      { ...protectedTerminalFields(), worktreeId: worktree.id },
    );
    if (!ordinaryTerminal) throw new Error("Expected an ordinary terminal.");
    await database.repository.setTerminalStatus(ordinaryTerminal.id, "running");
    expect(
      await database.repository.getWorktreeRemovalBlockers(
        LOCAL_USER_ID,
        projectId,
        worktree.id,
      ),
    ).toMatchObject({ runningTerminalIds: [ordinaryTerminal.id] });
    await database.repository.setTerminalStatus(ordinaryTerminal.id, "exited");
    const requested =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        {
          operation: "start",
          operationId: randomUUID(),
          projectId,
          configurationId: randomUUID(),
          worktreeId: worktree.id,
          workerId: "test-worker",
          definitionRevision: "f".repeat(64),
          codexEnvironmentRevision: null,
        },
      );
    if (!requested.runtime) throw new Error("Expected an active runtime.");
    await database.repository.applyRunConfigurationRuntimeObservation(
      LOCAL_USER_ID,
      "test-worker",
      {
        runtimeId: requested.runtime.id,
        projectId,
        configurationId: requested.runtime.configurationId,
        worktreeId: worktree.id,
        workerId: "test-worker",
        definitionRevision: requested.runtime.definitionRevision,
        codexEnvironmentRevision: requested.runtime.codexEnvironmentRevision,
        generation: requested.runtime.generation,
        operationId: requested.runtime.requestedOperationId,
        terminalId: requested.runtime.terminalId!,
        state: "running",
        startedAt: "2026-08-24T02:00:00.000Z",
        endedAt: null,
        exitCode: null,
        signal: null,
        failure: null,
      },
    );
    expect(
      await database.repository.getWorktreeRemovalBlockers(
        LOCAL_USER_ID,
        projectId,
        worktree.id,
      ),
    ).toMatchObject({ runningTerminalIds: [] });

    const stopsBefore = runConfigurationStopCommands.length;
    connected = false;
    const offlineRemoval = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/worktrees/${worktree.id}`,
    });
    expect(offlineRemoval.statusCode).toBe(503);
    expect(runConfigurationStopCommands).toHaveLength(stopsBefore);
    expect(
      await database.repository.getRunConfigurationRuntime(
        LOCAL_USER_ID,
        projectId,
        requested.runtime.configurationId,
        worktree.id,
      ),
    ).toMatchObject({ state: "running" });

    connected = true;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/worktrees/${worktree.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(projectWorktreeSummarySchema.parse(removed.json())).toMatchObject({
      id: worktree.id,
      lifecycleState: "missing",
    });
    expect(runConfigurationStopCommands.slice(stopsBefore)).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ runtimeId: requested.runtime.id }),
      }),
    ]);
    expect(
      await database.repository.getRunConfigurationRuntime(
        LOCAL_USER_ID,
        projectId,
        requested.runtime.configurationId,
        worktree.id,
      ),
    ).toBeNull();
  });

  it("blocks removal while a chat, lease, or terminal is active", async () => {
    const [firstId, secondId] = managedIds as [string, string];
    await database.repository.setChatStatus(routedChatId, "running");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${secondId}`,
        })
      ).statusCode,
    ).toBe(409);
    await database.repository.setChatStatus(routedChatId, "idle");

    await database.repository.setTerminalStatus(linkedConsoleId, "exited");
    await database.repository.setTerminalStatus(routedTerminalId, "running");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${firstId}`,
        })
      ).statusCode,
    ).toBe(409);
    await database.repository.setTerminalStatus(routedTerminalId, "exited");
    const lane = (
      await database.repository.listChatExecutionLanes(
        LOCAL_USER_ID,
        routedChatId,
      )
    ).find(
      ({ worktreeId, state }) => worktreeId === firstId && state !== "released",
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${routedChatId}/execution-lanes/${lane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/worktrees/${firstId}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(projectWorktreeSummarySchema.parse(removed.json())).toMatchObject({
      id: firstId,
      lifecycleState: "missing",
    });
  });

  it("retains reconciled metadata while the worker is offline", async () => {
    connected = false;
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      projectWorktreeListSchema.parse(listed.json()).length,
    ).toBeGreaterThan(1);
    const reconcile = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/reconcile`,
    });
    expect(reconcile.statusCode).toBe(503);
    connected = true;
  });

  it("keeps live resumes in-turn and recovers durable pauses after restart", async () => {
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeMode: "agent-managed",
      },
    );
    expect(chat).not.toBeNull();
    const started = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat!.id,
      "agent",
      "Durable pause recovery",
    );
    expect(started).not.toBeNull();
    const storedThreadId = "thread-durable-pause-recovery";
    const settings = await database.repository.getSettings(LOCAL_USER_ID);
    const routeId = settings.models.find(
      ({ id }) => id === settings.preferences.defaultModelId,
    )!.routes[0]!.id;
    await database.repository.updateChatRuntime(
      chat!.id,
      started!.workerId,
      started!.worktreeId,
      storedThreadId,
      routeId,
      "running",
    );

    activeChatGoal = {
      threadId: storedThreadId,
      objective: "Continue after Cantrip restarts",
      status: "active",
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 1,
      createdAt: 1_786_665_600,
      updatedAt: 1_786_665_601,
    };
    await database.repository.setChatStatus(chat!.id, "running");
    expect(
      chatPauseStateSchema.parse(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/chats/${chat!.id}/pause`,
            payload: { paused: true },
          })
        ).json(),
      ),
    ).toEqual({ paused: true });
    expect(chatPauseCommands.at(-1)).toMatchObject({
      chatId: chat!.id,
      paused: true,
      timeoutMs: null,
    });

    const turnsBeforeLiveResume = chatTurnCommands.length;
    expect(
      chatPauseStateSchema.parse(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/chats/${chat!.id}/pause`,
            payload: { paused: false },
          })
        ).json(),
      ),
    ).toEqual({ paused: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(chatTurnCommands).toHaveLength(turnsBeforeLiveResume);

    expect(
      chatPauseStateSchema.parse(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/chats/${chat!.id}/pause`,
            payload: { paused: true },
          })
        ).json(),
      ),
    ).toEqual({ paused: true });
    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({
      config,
      database,
      logger: false,
      workerBridge,
    });

    expect(
      await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat!.id,
      ),
    ).toMatchObject({
      automationPaused: true,
      status: "idle",
      threadId: storedThreadId,
    });
    const turnsBeforeRestartResume = chatTurnCommands.length;
    const restartResume = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat!.id}/pause`,
      payload: { paused: false },
    });
    expect(restartResume.statusCode, restartResume.body).toBe(200);
    expect(chatPauseStateSchema.parse(restartResume.json())).toEqual({
      paused: false,
    });
    await expect
      .poll(() => chatTurnCommands.length)
      .toBe(turnsBeforeRestartResume + 1);
    expect(chatTurnCommands.at(-1)).toMatchObject({
      chatId: chat!.id,
      threadId: storedThreadId,
    });
  });
});
