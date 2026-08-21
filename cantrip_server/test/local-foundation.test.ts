import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentInteractionRequestListSchema,
  agentInteractionRequestSchema,
  agentThreadSyncSchema,
  appLiveServerMessageSchema,
  browserListSchema,
  browserSummarySchema,
  codexCustomizationInventorySchema,
  codexExternalImportStatusSchema,
  codexExternalImportPreviewSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigResultSchema,
  codexSkillRootsResultSchema,
  chatAttachmentSummarySchema,
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  chatListSchema,
  chatGoalResponseSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatPauseStateSchema,
  chatPermissionProfileStateSchema,
  chatPlanStateSchema,
  chatSummarySchema,
  codeAttachmentSchema,
  codeRuntimeStatusSchema,
  codeSaveAllResultSchema,
  codeTabSummarySchema,
  explorerDirectorySchema,
  explorerDirectoryCommitsSchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  gitActionResultSchema,
  gitBlameSchema,
  gitFileHistorySchema,
  gitCommitSearchResultSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryResultSchema,
  gitHistorySchema,
  gitStatusSchema,
  githubRepositoryListSchema,
  githubRepositoryOwnerListSchema,
  githubRepositorySchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutResultSchema,
  githubPullRequestDetailSchema,
  githubPullRequestLifecyclePreviewSchema,
  modelProfileSummarySchema,
  modelProviderAccountListSchema,
  modelProviderSummarySchema,
  projectWireListSchema,
  projectReplicaJobListSchema,
  projectReplicaListSchema,
  projectReplicaSummarySchema,
  projectShareAttachmentSchema,
  projectWireSummarySchema,
  projectTokenUsageSchema,
  projectTabLayoutSummarySchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  projectViewListSchema,
  projectViewSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  remoteDesktopListSchema,
  remoteDesktopSummarySchema,
  remoteSurfaceListSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  scriptCommandListSchema,
  skillListSchema,
  terminalListSchema,
  terminalSummarySchema,
  tunnelListSchema,
  unprobedCodexRuntimeReport,
  workerListSchema,
  workerManagementListSchema,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequestCreate,
  AppLiveServerMessage,
  PlanMode,
  ThreadGoal,
  WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { protectedProjectFields } from "./private-label-fixture.js";
import {
  protectedProviderCredentialFixture,
  providerCredentialMetadataFixture,
} from "./protected-provider-credential-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-local-foundation-"),
);

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

function workspaceNameProtection(fill: number) {
  return {
    state: "encrypted" as const,
    formatVersion: 1 as const,
    keyRevision: 1,
    blindIndex: Buffer.alloc(32, fill).toString("base64url"),
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: Buffer.alloc(12, fill).toString("base64url"),
      ciphertext: Buffer.alloc(16, fill).toString("base64url"),
    },
  };
}

let turnRequests = 0;
let compactRequests = 0;
const turnModelIds: string[] = [];
const turnProviderIds: string[] = [];
const turnProviderAccountIds: Array<string | null> = [];
const turnCredentialHomeKeys: Array<string | null> = [];
const turnRouteIds: string[] = [];
const turnThreadIds: Array<string | null> = [];
const customizationInventoryThreadIds: Array<string | null> = [];
const turnPermissionProfileIds: string[] = [];
const turnPrompts: string[] = [];
const turnSkillNames: string[][] = [];
const turnAttachmentIds: string[][] = [];
const turnPlanModes: PlanMode[] = [];
const turnPolicyContexts: Array<
  Extract<WorkerCommand, { type: "chat.turn" }>["policies"]
> = [];
const turnTimeouts: Array<number | null | undefined> = [];
const deletedProjectPaths: string[] = [];
const openedProjectShares: Array<
  Extract<WorkerCommand, { type: "project.share.open" }>
> = [];
const closedProjectShareIds: string[] = [];
const authProviderIds: string[] = [];
const authCredentialHomeKeys: string[] = [];
const authProviderKinds: Array<"chatgpt" | "grok"> = [];
const clearedProviderAccounts: Array<
  Extract<WorkerCommand, { type: "provider.auth.account.clear" }>
> = [];
const exhaustedProviderIds = new Set<string>();
const authUsageByCredentialHomeKey = new Map<string, number>();
const steeredPrompts: string[] = [];
const steeredAttachmentIds: string[][] = [];
const pauseCommands: Array<{ chatId: string; paused: boolean }> = [];
const interruptCommands: Array<
  Extract<WorkerCommand, { type: "chat.interrupt" }>
> = [];
const explorerWrites: Array<{
  content: string;
  path: string;
  version: string;
}> = [];
const explorerMediaBytes = Buffer.alloc(256 * 1_024 + 14, 0x5a);
const explorerMediaModifiedAt = "2026-08-07T12:00:00.000Z";
const terminalServiceReconciliations: Array<
  Extract<WorkerCommand, { type: "terminal.services.reconcile" }>
> = [];
const terminalServiceRestarts: string[] = [];
const closedTerminalIds: string[] = [];
let codexGoal: ThreadGoal | null = null;
let codexPlanMode: PlanMode = "default";
let releasePlanQuestion: (() => void) | null = null;
let releaseAgentInteraction: (() => void) | null = null;
const deliveredAgentInteractionResponses: unknown[] = [];
const issueComments: string[] = [];
const createdIssues: Array<
  Extract<WorkerCommand, { type: "github.issue.create" }>["request"]
> = [];
const issueListRequests: Array<{
  kind: "issue" | "pull-request";
  limit: number;
  page: number;
}> = [];
const repositoryCreateCommands: Array<
  Extract<WorkerCommand, { type: "github.repositories.create" }>
> = [];
const closedIssues: Array<{ comment: string | null; number: number }> = [];
const pullRequestCreateCommands: Array<
  Extract<WorkerCommand, { type: "github.pull-request.create" }>
> = [];
const pullRequestGetCommands: Array<
  Extract<WorkerCommand, { type: "github.pull-request.get" }>
> = [];
const pullRequestReviewCommands: WorkerCommand[] = [];
const pullRequestLifecyclePreviewCommands: Array<
  Extract<WorkerCommand, { type: "github.pull-request.lifecycle.preview" }>
> = [];
const pullRequestLifecycleApplyCommands: Array<
  Extract<WorkerCommand, { type: "github.pull-request.lifecycle.apply" }>
> = [];
const pullRequestCheckoutCommands: Array<
  Extract<WorkerCommand, { type: "github.pull-request.checkout.prepare" }>
> = [];
const pullRequestWorktreeCommands: Array<
  Extract<WorkerCommand, { type: "worktree.create" }>
> = [];
const gitFileHistoryCommands: Array<
  Extract<WorkerCommand, { type: "git.file.history" }>
> = [];
const gitFileBlameCommands: Array<
  Extract<WorkerCommand, { type: "git.file.blame" }>
> = [];
const gitCommitSearchCommands: Array<
  Extract<WorkerCommand, { type: "git.commit.search" }>
> = [];
const gitRecoveryCommands: Array<
  Extract<
    WorkerCommand,
    {
      type: "git.recovery.list" | "git.recovery.preview" | "git.recovery.apply";
    }
  >
> = [];
function pullRequestDetailFixture(number: number) {
  return {
    number,
    title: "Review pull requests",
    state: "open",
    url: `https://github.com/ArcaneArts/Cantrip/pull/${number}`,
    author: "cantrip-test",
    commentCount: 1,
    labels: [{ name: "feature", color: "22d3ee" }],
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T13:00:00.000Z",
    closedAt: null,
    body: "Please review.",
    draft: false,
    merged: false,
    headRef: "feature/review",
    headSha: "4".repeat(40),
    baseRef: "main",
    baseSha: "3".repeat(40),
    comments: [],
    commentsTruncated: false,
    requestedReviewers: ["reviewer"],
    mergeable: true,
    mergeableState: "clean",
    reviewDecision: "review-required",
    checksState: "success",
    additions: 4,
    deletions: 1,
    changedFileCount: 1,
    commitCount: 1,
    commits: [],
    commitsTruncated: false,
    files: [],
    filesTruncated: false,
    checks: [],
    checksTruncated: false,
    reviews: [],
    reviewsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
  } as const;
}
const relayedSurfaceFrames: Array<{
  workerId: string;
  sequence: number;
  payload: number[];
}> = [];
const surfaceAttachCommands: Array<
  Extract<WorkerCommand, { type: "surface.attach" }>
> = [];
const codeEditorBuild = {
  version: "1.109.5-cantrip.1",
  upstreamRevision: "a".repeat(40),
  patchset: 1,
  fingerprint: "b".repeat(64),
};
const attachmentUploads = new Map<
  string,
  { chunks: Buffer[]; fileName: string; sizeBytes: number }
>();
const attachmentFiles = new Map<string, Buffer>();
const surfaceFrameListeners = new Set<
  (
    header: Parameters<WorkerCommandBus["sendSurfaceFrame"]>[1],
    payload: Uint8Array,
  ) => void
>();
let releaseHeldTurn: (() => void) | null = null;
let heldProjectCloneName: string | null = null;
let releaseProjectClone: (() => void) | null = null;
const workerBridge = {
  attach() {},
  close() {},
  isConnected(workerId: string) {
    return workerId === "test-worker" || workerId === "test-worker-secondary";
  },
  sendSurfaceFrame(workerId, header, payload) {
    relayedSurfaceFrames.push({
      workerId,
      sequence: header.sequence,
      payload: [...payload],
    });
    return true;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames(_workerId, listener) {
    surfaceFrameListeners.add(listener);
    return () => surfaceFrameListeners.delete(listener);
  },
  async request(_workerId, command, options) {
    switch (command.type) {
      case "attachment.upload.begin":
        attachmentUploads.set(command.attachmentId, {
          chunks: [],
          fileName: command.fileName,
          sizeBytes: command.sizeBytes,
        });
        return { accepted: true };
      case "attachment.upload.chunk": {
        const upload = attachmentUploads.get(command.attachmentId);
        if (!upload) throw new Error("Attachment upload was not started.");
        upload.chunks[command.chunkIndex] = Buffer.from(command.data, "base64");
        return { accepted: true };
      }
      case "attachment.upload.complete": {
        const upload = attachmentUploads.get(command.attachmentId);
        if (!upload) throw new Error("Attachment upload was not started.");
        const bytes = Buffer.concat(upload.chunks);
        attachmentFiles.set(command.attachmentId, bytes);
        attachmentUploads.delete(command.attachmentId);
        return {
          path: path.join(
            dataDirectory,
            "attachments",
            command.chatId,
            command.attachmentId,
            upload.fileName,
          ),
          sha256: "0".repeat(64),
          sizeBytes: bytes.byteLength,
        };
      }
      case "attachment.read": {
        const bytes = attachmentFiles.get(command.attachmentId);
        if (!bytes) throw new Error("Attachment was not found.");
        const chunk = bytes.subarray(
          command.offset,
          command.offset + command.limit,
        );
        return {
          data: chunk.toString("base64"),
          eof: command.offset + chunk.byteLength >= bytes.byteLength,
          sizeBytes: bytes.byteLength,
        };
      }
      case "attachment.delete":
        attachmentUploads.delete(command.attachmentId);
        attachmentFiles.delete(command.attachmentId);
        return { accepted: true };
      case "codex.auth.status":
        authProviderIds.push(command.providerId);
        authProviderKinds.push(command.providerKind);
        {
          const credentialHomeKey =
            command.credentialHomeKey ?? command.providerId;
          authCredentialHomeKeys.push(credentialHomeKey);
          return {
            authenticated: true,
            authMode: command.providerKind,
            email:
              command.providerKind === "grok"
                ? "grok@example.com"
                : "test@example.com",
            planType: command.providerKind === "grok" ? "SuperGrok" : "plus",
            weeklyUsage:
              command.providerKind === "grok"
                ? null
                : {
                    usedPercent:
                      authUsageByCredentialHomeKey.get(credentialHomeKey) ??
                      (exhaustedProviderIds.has(command.providerId) ? 100 : 37),
                    resetsAt: 1_786_665_600,
                  },
          };
        }
      case "codex.auth.login.start":
        authProviderIds.push(command.providerId);
        authProviderKinds.push(command.providerKind);
        authCredentialHomeKeys.push(
          command.credentialHomeKey ?? command.providerId,
        );
        return {
          loginId: "login-1",
          verificationUrl:
            command.providerKind === "grok"
              ? "https://auth.x.ai/activate"
              : "https://auth.openai.com/codex/device",
          userCode: "TEST-CODE",
        };
      case "codex.auth.logout":
        authProviderIds.push(command.providerId);
        authProviderKinds.push(command.providerKind);
        authCredentialHomeKeys.push(
          command.credentialHomeKey ?? command.providerId,
        );
        return { accepted: true };
      case "provider.auth.account.clear":
        clearedProviderAccounts.push(command);
        return { accepted: true };
      case "github.auth.status":
        return { authenticated: true, login: "cantrip-test", source: "gh-cli" };
      case "github.repositories.cached":
      case "github.repositories.list":
        return [
          {
            id: "github-repository-1",
            name: "Cantrip",
            nameWithOwner: "ArcaneArts/Cantrip",
            description: "Test repository",
            isPrivate: true,
            isFork: false,
            url: "https://github.com/ArcaneArts/Cantrip",
            defaultBranch: "main",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ];
      case "github.repository-owners.list":
        return [
          { login: "cantrip-test", kind: "user" },
          { login: "ArcaneArts", kind: "organization" },
        ];
      case "github.repositories.create":
        repositoryCreateCommands.push(command);
        return {
          id: "github-created-repository",
          name: command.request.name,
          nameWithOwner: command.request.owner + "/" + command.request.name,
          description: command.request.description || null,
          isPrivate: command.request.visibility === "private",
          isFork: false,
          url:
            "https://github.com/" +
            command.request.owner +
            "/" +
            command.request.name,
          defaultBranch: "main",
          updatedAt: "2026-08-11T12:00:00.000Z",
        };
      case "github.issues.list":
        issueListRequests.push({
          kind: command.kind,
          limit: command.limit,
          page: command.page,
        });
        return {
          kind: command.kind,
          state: command.state,
          total: 1,
          nextPage: command.page + 1,
          issues: [
            {
              number: 42,
              title: "Test the GitHub issue view",
              state: command.state,
              url: "https://github.com/ArcaneArts/Cantrip/issues/42",
              author: "cantrip-test",
              commentCount: 1,
              labels: [{ name: "feature", color: "22d3ee" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T13:00:00.000Z",
              closedAt:
                command.state === "closed" ? "2026-08-07T14:00:00.000Z" : null,
            },
          ],
        };
      case "github.issue.get":
      case "github.issue.comment":
      case "github.issue.close": {
        if (command.type === "github.issue.comment") {
          issueComments.push(command.body);
        }
        if (command.type === "github.issue.close") {
          closedIssues.push({
            number: command.number,
            comment: command.comment,
          });
        }
        const closed = command.type === "github.issue.close";
        return {
          number: command.number,
          title: "Test the GitHub issue view",
          state: closed ? "closed" : "open",
          url: `https://github.com/ArcaneArts/Cantrip/issues/${command.number}`,
          author: "cantrip-test",
          commentCount: 1,
          labels: [{ name: "feature", color: "22d3ee" }],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T13:00:00.000Z",
          closedAt: closed ? "2026-08-07T14:00:00.000Z" : null,
          body: "Issue details",
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              body: "Looks good",
              url: `https://github.com/ArcaneArts/Cantrip/issues/${command.number}#issuecomment-1`,
              createdAt: "2026-08-07T12:30:00.000Z",
              updatedAt: "2026-08-07T12:30:00.000Z",
            },
          ],
        };
      }
      case "github.issue.create":
        createdIssues.push(command.request);
        return {
          number: 43,
          title: command.request.title,
          state: "open",
          url: "https://github.com/ArcaneArts/Cantrip/issues/43",
          author: "cantrip-test",
          commentCount: 0,
          labels: [],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
          closedAt: null,
          body: command.request.body || null,
          comments: [],
        };
      case "github.pull-request.create":
        pullRequestCreateCommands.push(command);
        return {
          pullRequest: {
            number: 44,
            title: command.request.title,
            state: "open",
            url: "https://github.com/ArcaneArts/Cantrip/pull/44",
            author: "cantrip-test",
            commentCount: 0,
            labels: command.request.labels.map((name) => ({
              name,
              color: "22d3ee",
            })),
            createdAt: "2026-08-10T12:00:00.000Z",
            updatedAt: "2026-08-10T12:00:00.000Z",
            closedAt: null,
            body: command.request.body,
            draft: command.request.draft,
            merged: false,
            headRef: command.request.head,
            headSha: "4".repeat(40),
            baseRef: command.request.base,
            baseSha: "3".repeat(40),
          },
          warnings: [],
        };
      case "github.pull-request.get":
        pullRequestGetCommands.push(command);
        return pullRequestDetailFixture(command.number);
      case "github.pull-request.comment":
      case "github.pull-request.review.submit":
      case "github.pull-request.review.comment":
      case "github.pull-request.review.reply":
        pullRequestReviewCommands.push(command);
        return pullRequestDetailFixture(command.number);
      case "github.pull-request.lifecycle.preview": {
        pullRequestLifecyclePreviewCommands.push(command);
        const detail = pullRequestDetailFixture(command.number);
        return {
          action: command.action,
          number: detail.number,
          title: detail.title,
          state: detail.state,
          draft: detail.draft,
          headRef: detail.headRef,
          headSha: detail.headSha,
          baseRef: detail.baseRef,
          baseSha: detail.baseSha,
          mergeable: detail.mergeable,
          mergeableState: detail.mergeableState,
          checksState: detail.checksState,
          reviewDecision: detail.reviewDecision,
          destructive:
            command.action.type === "close" || command.action.type === "merge",
          confirmationPhrase:
            command.action.type === "close"
              ? `close #${command.number}`
              : command.action.type === "merge"
                ? `${command.action.method} #${command.number}`
                : null,
          warnings: [],
          token: "9".repeat(64),
        };
      }
      case "github.pull-request.lifecycle.apply": {
        pullRequestLifecycleApplyCommands.push(command);
        const detail = pullRequestDetailFixture(command.number);
        return command.request.action.type === "merge"
          ? { ...detail, state: "closed", merged: true }
          : command.request.action.type === "close"
            ? { ...detail, state: "closed" }
            : detail;
      }
      case "github.pull-request.checkout.prepare": {
        pullRequestCheckoutCommands.push(command);
        const pullRequest = pullRequestDetailFixture(command.number);
        return {
          pullRequest,
          branch: `cantrip/pr/${command.number}-feature-review-44444444`,
          name: `PR #${command.number} ${pullRequest.title}`,
          headSha: pullRequest.headSha,
          remote: "origin",
        };
      }
      case "worktree.create": {
        pullRequestWorktreeCommands.push(command);
        if (command.mode.type !== "newBranch") {
          throw new Error("Expected a new pull request branch.");
        }
        const createdPath = path.join(
          dataDirectory,
          "worktrees",
          command.worktreeId,
        );
        const primary = {
          path: command.sourcePath,
          head: "3".repeat(40),
          branch: "main",
          detached: false,
          isPrimary: true,
          managed: false,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        };
        const worktree = {
          ...primary,
          path: createdPath,
          head: command.mode.startPoint,
          branch: command.mode.branch,
          isPrimary: false,
          managed: true,
        };
        return {
          worktree,
          inventory: {
            sourcePath: command.sourcePath,
            primaryPath: command.sourcePath,
            gitCommonDir: path.join(command.sourcePath, ".git"),
            managedRoot: path.join(dataDirectory, "worktrees"),
            repositoryFingerprint: "a".repeat(64),
            worktrees: [primary, worktree],
          },
        };
      }
      case "project.clone":
        if (command.repository.nameWithOwner === heldProjectCloneName) {
          await new Promise<void>((resolve) => {
            releaseProjectClone = resolve;
          });
        }
        return {
          path: path.join(dataDirectory, "repositories", "Cantrip"),
          displayPath: "ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        };
      case "project.replica.provision":
        if (command.repository.nameWithOwner === heldProjectCloneName) {
          await new Promise<void>((resolve) => {
            releaseProjectClone = resolve;
          });
        }
        return {
          status: "ready",
          jobId: command.jobId,
          attempt: command.attempt,
          path: path.join(
            dataDirectory,
            "repositories",
            command.repository.nameWithOwner.split("/").at(-1)!,
          ),
          displayPath: command.repository.nameWithOwner,
          repositoryFingerprint: "a".repeat(64),
          resolvedRevision: "b".repeat(40),
          branch: "main",
          reused: false,
          worktreePolicy: null,
        };
      case "project.files.delete":
        deletedProjectPaths.push(command.path);
        return { deleted: true };
      case "project.script-commands":
        return [
          {
            id: "package:package.json:dev",
            kind: "package",
            name: "dev",
            command: "pnpm run dev",
            description: "vite",
            source: "package.json",
          },
        ];
      case "project.share.open":
        openedProjectShares.push(command);
        return {
          shareId: command.shareId,
          protocol: "webdav",
          publicBasePath: command.publicBasePath,
          publicOrigin: command.publicOrigin,
          loopbackHost: "127.0.0.1",
          loopbackPort: 43_210,
          username: "cantrip-test-user",
          password: "a-strong-random-test-password",
          realm: "Cantrip Project Share",
        };
      case "project.share.close":
        closedProjectShareIds.push(command.shareId);
        return { accepted: true };
      case "git.history":
        return {
          branch: "main",
          head: "0123456789abcdef",
          totalCount: 1,
          commits: [
            {
              hash: "0123456789abcdef",
              shortHash: "0123456",
              parents: [],
              subject: "feat: test history",
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-07T12:00:00.000Z",
              refs: [
                { name: "HEAD", kind: "head", current: true },
                { name: "main", kind: "local", current: true },
              ],
              isHead: true,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.file.history":
        gitFileHistoryCommands.push(command);
        return {
          path: command.path,
          revision: "1".repeat(40),
          commits: [
            {
              hash: "1".repeat(40),
              shortHash: "1".repeat(8),
              subject: "Update README",
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-10T12:00:00.000Z",
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.file.blame":
        gitFileBlameCommands.push(command);
        return {
          path: command.path,
          revision: "1".repeat(40),
          ranges: [
            {
              commit: "1".repeat(40),
              shortCommit: "1".repeat(8),
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-10T12:00:00.000Z",
              summary: "Update README",
              startLine: 1,
              endLine: 2,
              lines: ["Cantrip", "Git client"],
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.commit.search":
        gitCommitSearchCommands.push(command);
        return {
          query: command.query,
          commits: [
            {
              hash: "1".repeat(40),
              shortHash: "1".repeat(8),
              parents: [],
              subject: "fix: searched commit",
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-10T12:00:00.000Z",
              refs: [],
              isHead: false,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.recovery.list":
        gitRecoveryCommands.push(command);
        return {
          kind: command.kind,
          entries: [
            {
              kind: command.kind,
              selector: "HEAD@{0}",
              hash: "1".repeat(40),
              shortHash: "1".repeat(8),
              action: "reset",
              subject: "reset: moving to HEAD~1",
              explanation: "HEAD or its branch was reset.",
              actorName: "Cantrip Test",
              actorEmail: "test@cantrip.art",
              occurredAt: "2026-08-10T12:00:00.000Z",
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.recovery.preview":
        gitRecoveryCommands.push(command);
        return {
          action: command.action,
          token: "a".repeat(64),
          destructive: command.action.type !== "createBranch",
          summary: "Preview recovery.",
          warnings: [],
          confirmation: "RESET --MIXED TO 1111111111",
          targetRevision: "1".repeat(40),
          currentHead: "2".repeat(40),
          branchBefore: null,
          checkpointRef: "refs/cantrip/recovery/reset-example",
          commitsRemoved: [],
          commitsRemovedTruncated: false,
          files: [],
          filesTruncated: false,
          status: {
            branch: "main",
            head: "2".repeat(40),
            upstream: null,
            ahead: 0,
            behind: 0,
            files: [],
            branches: [],
          },
        };
      case "git.recovery.apply":
        gitRecoveryCommands.push(command);
        return {
          action: command.request.action,
          output: "",
          checkpointRef: "refs/cantrip/recovery/reset-example",
          headBefore: "2".repeat(40),
          headAfter: "1".repeat(40),
          status: {
            branch: "main",
            head: "1".repeat(40),
            upstream: null,
            ahead: 0,
            behind: 0,
            files: [],
            branches: [],
          },
        };
      case "git.status":
        return {
          branch: "main",
          head: "0123456789abcdef",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          files: [
            {
              path: "README.md",
              originalPath: null,
              indexStatus: " ",
              worktreeStatus: "M",
              staged: false,
              unstaged: true,
            },
          ],
          branches: [
            {
              name: "main",
              kind: "local",
              current: true,
              hash: "0123456789abcdef",
              upstream: "origin/main",
            },
          ],
        };
      case "git.action":
        return {
          status: {
            branch:
              command.action.type === "createBranch"
                ? command.action.name
                : "main",
            head: "0123456789abcdef",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [],
            branches: [
              {
                name: "main",
                kind: "local",
                current: command.action.type !== "createBranch",
                hash: "0123456789abcdef",
                upstream: "origin/main",
              },
            ],
          },
          output: "Git action complete",
        };
      case "explorer.directory.list":
        return {
          path: command.path,
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              size: 18,
              modifiedAt: "2026-08-07T12:00:00.000Z",
              viewable: true,
              markdown: true,
            },
            {
              name: "preview.png",
              path: "preview.png",
              kind: "file",
              size: explorerMediaBytes.byteLength,
              modifiedAt: explorerMediaModifiedAt,
              viewable: true,
              markdown: false,
            },
          ],
          truncated: false,
        };
      case "explorer.directory.commits":
        return {
          path: command.path,
          available: true,
          entries: [
            {
              path: "README.md",
              tracked: true,
              lastCommit: {
                hash: "a".repeat(40),
                shortHash: "aaaaaaa",
                subject: "Document Explorer",
                authorName: "Cantrip Test",
                authorEmail: "cantrip@example.com",
                authoredAt: "2026-08-07T12:00:00.000Z",
              },
            },
          ],
        };
      case "explorer.file.read":
        return {
          path: command.path,
          content: "# Cantrip explorer\n",
          size: 18,
          markdown: true,
          version: "a".repeat(64),
        };
      case "explorer.media.stat":
        return {
          path: command.path,
          kind: "image",
          mimeType: "image/png",
          size: explorerMediaBytes.byteLength,
          modifiedAt: explorerMediaModifiedAt,
        };
      case "explorer.media.read": {
        const bytes = explorerMediaBytes.subarray(
          command.offset,
          command.offset + command.limit,
        );
        return {
          path: command.path,
          kind: "image",
          mimeType: "image/png",
          size: explorerMediaBytes.byteLength,
          modifiedAt: explorerMediaModifiedAt,
          offset: command.offset,
          data: bytes.toString("base64"),
          eof:
            command.offset + bytes.byteLength >= explorerMediaBytes.byteLength,
        };
      }
      case "explorer.file.write":
        explorerWrites.push({
          content: command.content,
          path: command.path,
          version: command.version,
        });
        return {
          path: command.path,
          content: command.content,
          size: Buffer.byteLength(command.content),
          markdown: true,
          version: "b".repeat(64),
        };
      case "skills.list":
        return [
          {
            name: "skill-creator",
            displayName: "Skill Creator",
            description: "Create reusable skills",
          },
        ];
      case "customization.inventory.read": {
        customizationInventoryThreadIds.push(command.threadId);
        const available = {
          available: true,
          reason: null,
          stability: "stable" as const,
        };
        const unsupported = {
          available: false,
          reason: "Not supported by this runtime.",
          stability: "unsupported" as const,
        };
        return {
          capabilities: {
            isolatedCodexHome: true,
            collaborationModes: { ...available, stability: "experimental" },
            threadGoals: available,
            nativeSubagents: available,
            customAgents: unsupported,
            hooks: available,
            skills: {
              list: available,
              configure: available,
              extraRoots: available,
            },
            mcp: {
              status: available,
              resourceRead: available,
              oauth: available,
              reload: available,
            },
            plugins: {
              list: unsupported,
              read: unsupported,
              install: unsupported,
              uninstall: unsupported,
            },
            externalImports: {
              detect: { ...available, stability: "experimental" },
              apply: { ...available, stability: "experimental" },
            },
          },
          skills: {
            items: [
              {
                name: "skill-creator",
                displayName: "Skill Creator",
                description: "Create reusable skills",
                path: path.join(command.cwd, ".agents/skills/skill-creator"),
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
          hooks: { items: [], warnings: [], errors: [] },
          mcpServers: [
            {
              name: "docs",
              serverInfo: null,
              authStatus: "oAuth",
              tools: [
                {
                  name: "search",
                  title: null,
                  description: "Search documentation",
                  inputSchema: { type: "object" },
                  outputSchema: null,
                },
              ],
              resources: [
                {
                  uri: "docs://readme",
                  name: "README",
                  title: null,
                  description: null,
                  mimeType: "text/markdown",
                  size: null,
                },
              ],
              resourceTemplates: [],
            },
          ],
        };
      }
      case "customization.external.preview":
        return {
          sourceScope: "project",
          items: [
            {
              id: "external-command-preview",
              itemType: "COMMANDS",
              description: "Claude commands",
              cwd: command.cwd,
              details: {
                pluginNames: [],
                skillNames: [],
                sessionCount: 0,
                mcpServerNames: [],
                hookNames: [],
                subagentNames: [],
                commandNames: ["release"],
                memoryFiles: [],
              },
            },
          ],
        };
      case "customization.mcp.resource.read":
        return {
          contents: [
            {
              type: "text",
              uri: command.uri,
              mimeType: "text/markdown",
              text: "# Cantrip",
            },
          ],
        };
      case "customization.skill.configure":
        return {
          path: command.path,
          effectiveEnabled: command.enabled,
        };
      case "customization.skill-roots.set":
        return {
          roots: command.roots.map((root) => path.resolve(command.cwd, root)),
        };
      case "customization.mcp.oauth.start":
        return {
          server: command.server,
          authorizationUrl: `https://auth.example.test/${command.server}`,
          status: "pending",
        };
      case "customization.mcp.oauth.status":
        return { server: command.server, status: "succeeded", error: null };
      case "customization.mcp.reload":
        return { reloaded: true };
      case "customization.external.apply":
        return { importId: "import-1", status: "pending", results: [] };
      case "customization.external.status":
        return {
          importId: command.importId,
          status: "completed",
          results: [
            {
              itemType: "COMMANDS",
              successCount: 1,
              failures: [],
            },
          ],
        };
      case "permission-profiles.list":
        return {
          available: true,
          profiles: [
            {
              id: ":read-only",
              description: "Inspection only",
              allowed: true,
            },
            {
              id: ":workspace",
              description: "Workspace writes",
              allowed: true,
            },
            {
              id: ":danger-full-access",
              description: "Unrestricted access",
              allowed: true,
            },
            {
              id: ":blocked",
              description: "Disabled by policy",
              allowed: false,
            },
          ],
          reason: null,
        };
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
      case "code.status":
      case "code.setTheme":
        return {
          sessionId: command.sessionId,
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
        return {
          sessionId: command.sessionId,
          status: "stopped",
          editorBuild: codeEditorBuild,
          processInstanceId: "code-process-1",
          bridgeConnected: false,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: "2026-08-08T12:00:00.000Z",
          lastActivityAt: "2026-08-08T12:02:00.000Z",
          lastError: null,
        };
      case "code.saveAll":
        return { saved: ["file:///workspace/Cantrip/README.md"], failed: [] };
      case "code.prepareAgentTurn":
        return { prepared: true, sessions: [] };
      case "code.agentTurnState":
        return { notifiedSessions: 0, refreshed: [], conflicts: [] };
      case "terminal.open":
        return { status: "detached" };
      case "terminal.detach":
      case "terminal.input":
      case "terminal.resize":
        return { accepted: true };
      case "terminal.close":
        closedTerminalIds.push(command.terminalId);
        return { accepted: true };
      case "terminal.services.reconcile":
        terminalServiceReconciliations.push(command);
        return { accepted: true };
      case "terminal.service.restart":
        terminalServiceRestarts.push(command.terminalId);
        return { accepted: true };
      case "surface.attach":
        surfaceAttachCommands.push(command);
        return { accepted: true, transport: "websocket" };
      case "surface.detach":
      case "surface.configure":
      case "surface.suspend":
      case "surface.resume":
      case "surface.close":
        return { accepted: true };
      case "surface.desktop.probe":
        return { available: true, message: null };
      case "chat.turn": {
        if (command.prompt !== "Render rich events") {
          turnRequests += 1;
          turnModelIds.push(command.model.id);
          turnProviderIds.push(command.provider.id);
          turnProviderAccountIds.push(command.provider.accountId);
          turnCredentialHomeKeys.push(command.provider.credentialHomeKey);
          turnRouteIds.push(command.model.routeId);
          turnThreadIds.push(command.threadId);
          turnPermissionProfileIds.push(command.permissionProfileId);
          turnPrompts.push(command.prompt);
          turnSkillNames.push(command.skillNames);
          turnAttachmentIds.push(
            command.attachments.map((attachment) => attachment.id),
          );
          turnPlanModes.push(command.planMode);
          turnPolicyContexts.push(command.policies);
          turnTimeouts.push(options?.timeoutMs);
        }
        codexPlanMode = command.planMode;
        if (command.prompt === "Finish the long-running goal") {
          await options?.onEvent?.({
            type: "agent.checkpoint",
            turnId: "goal-turn-1",
            text: "Finished the first goal milestone.",
          });
        }
        if (command.prompt === "Draft a deployment plan") {
          await options?.onEvent?.({
            type: "agent.plan.updated",
            turnId: "plan-turn-1",
            explanation: "Choose the deployment topology.",
            steps: [
              { step: "Inspect the runtime", status: "completed" },
              { step: "Choose a topology", status: "inProgress" },
            ],
          });
          await options?.onEvent?.({
            type: "agent.interaction.requested",
            request: {
              requestKey: "plan-question-1",
              threadId: command.threadId ?? "codex-plan-thread-1",
              turnId: "plan-turn-1",
              itemId: "plan-item-1",
              payload: {
                kind: "userInput",
                questions: [
                  {
                    id: "topology",
                    header: "Topology",
                    question: "Which topology should the plan target?",
                    isOther: true,
                    isSecret: false,
                    options: [
                      {
                        label: "Four nodes",
                        description: "Load balance across four servers.",
                      },
                    ],
                  },
                ],
                autoResolutionMs: null,
              },
              expiresAt: "2030-08-08T18:30:00.000Z",
            },
          });
          await options?.onEvent?.({
            type: "agent.plan.question",
            question: {
              id: "plan-question-1",
              threadId: command.threadId ?? "codex-plan-thread-1",
              turnId: "plan-turn-1",
              itemId: "plan-item-1",
              createdAt: "2026-08-08T12:00:00.000Z",
              questions: [
                {
                  id: "topology",
                  header: "Topology",
                  question: "Which topology should the plan target?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    {
                      label: "Four nodes",
                      description: "Load balance across four servers.",
                    },
                  ],
                },
              ],
            },
          });
          await new Promise<void>((resolve) => {
            releasePlanQuestion = resolve;
          });
        }
        if (command.prompt === "Request a command approval") {
          await options?.onEvent?.({
            type: "agent.interaction.requested",
            request: {
              requestKey: "runtime-bridge:approval-1",
              threadId: command.threadId ?? "codex-approval-thread-1",
              turnId: "approval-turn-1",
              itemId: "approval-item-1",
              payload: {
                kind: "commandExecution",
                startedAtMs: 1_786_665_600_000,
                approvalId: null,
                environmentId: null,
                reason: "Run the verification suite",
                command: "pnpm check",
                cwd: command.cwd,
                commandActions: null,
                networkApprovalContext: null,
                additionalPermissions: null,
                proposedExecpolicyAmendment: null,
                proposedNetworkPolicyAmendments: null,
                availableDecisions: ["accept", "decline", "cancel"],
              },
              expiresAt: "2030-08-08T18:30:00.000Z",
            },
          });
          await new Promise<void>((resolve) => {
            releaseAgentInteraction = resolve;
          });
        }
        if (command.prompt === "Render rich events") {
          const richCorrelation = (
            sourceMethod: string,
            itemId: string | null,
          ) => ({
            sourceMethod,
            diagnosticId: `runtime-session:${itemId ?? "turn"}`,
            threadId: "codex-rich-thread-1",
            turnId: "rich-turn-1",
            itemId,
          });
          await options?.onEvent?.({
            type: "agent.message",
            message: {
              id: "commentary-1",
              text: "I’m comparing the event schemas.",
              phase: "commentary",
              correlation: richCorrelation("item/completed", "commentary-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "reasoning",
              id: "reasoning-1",
              status: "completed",
              summary: ["Compared the supported event unions."],
              correlation: richCorrelation("item/completed", "reasoning-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "mcpToolCall",
              id: "mcp-1",
              status: "completed",
              server: "github",
              tool: "search_issues",
              error: null,
              durationMs: 75,
              correlation: richCorrelation("item/completed", "mcp-1"),
            },
          });
          const tokenUsage = {
            totalTokens: 1_200,
            inputTokens: 800,
            cachedInputTokens: 200,
            cacheWriteInputTokens: 0,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          };
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "usage",
              id: "turn:rich-turn-1:usage",
              status: "completed",
              total: tokenUsage,
              last: tokenUsage,
              modelContextWindow: 10_000,
              contextUsedPercent: 12,
              correlation: richCorrelation("thread/tokenUsage/updated", null),
            },
          });
          await options?.onEvent?.({
            type: "agent.message",
            message: {
              id: "final-1",
              text: "Rich events are preserved.",
              phase: "final_answer",
              correlation: richCorrelation("item/completed", "final-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "turnSummary",
              id: "turn:rich-turn-1:summary",
              status: "completed",
              durationMs: 2_000,
              startedAt: 1_786_134_300,
              completedAt: 1_786_134_302,
              correlation: richCorrelation("turn/completed", null),
            },
          });
          return {
            threadId: "codex-rich-thread-1",
            // Keep turnId absent: older/provider-specific workers may omit it.
            text: "Rich events are preserved.",
            status: "completed",
          };
        }
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: "/worktree\n",
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "fileChange",
            id: "file-change-1",
            status: "completed",
            changes: [{ path: "README.md", kind: "update" }],
          },
        });
        if (command.prompt.includes("Hold queue open.")) {
          await new Promise<void>((resolve) => {
            releaseHeldTurn = resolve;
          });
        }
        return {
          threadId: command.threadId ?? "codex-thread-1",
          text: "The local agent replied.",
          status: "completed",
        };
      }
      case "chat.compact":
        compactRequests += 1;
        return { accepted: true };
      case "chat.pause.set":
        pauseCommands.push({ chatId: command.chatId, paused: command.paused });
        return { paused: command.paused };
      case "chat.interrupt":
        interruptCommands.push(command);
        return { interrupted: true };
      case "chat.goal.get":
        return { goal: codexGoal };
      case "chat.goal.create":
        codexGoal = {
          threadId: command.threadId ?? "codex-goal-thread-1",
          objective: command.objective,
          status: "active",
          tokenBudget: command.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1_786_665_600,
          updatedAt: 1_786_665_600,
        };
        return { goal: codexGoal };
      case "chat.goal.update":
        if (!codexGoal) return { goal: null };
        codexGoal = {
          ...codexGoal,
          status: command.status,
          updatedAt: codexGoal.updatedAt + 1,
        };
        return { goal: codexGoal };
      case "chat.goal.clear":
        codexGoal = null;
        return { cleared: true };
      case "chat.thread.ensure":
        codexPlanMode = command.planMode;
        return {
          threadId: command.threadId ?? "codex-console-thread-1",
        };
      case "chat.plan.get":
        return { mode: codexPlanMode, threadId: command.threadId };
      case "chat.plan.set":
        codexPlanMode = command.mode;
        return {
          mode: codexPlanMode,
          threadId: command.threadId ?? "codex-plan-thread-1",
        };
      case "agent.interaction.respond":
        deliveredAgentInteractionResponses.push(command.response);
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true };
      case "agent.interaction.respond.protected":
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true };
      case "agent.interaction.cancel":
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        return { accepted: true };
      case "chat.steer":
        steeredPrompts.push(command.prompt);
        steeredAttachmentIds.push(
          command.attachments.map((attachment) => attachment.id),
        );
        return { steered: true, turnId: "turn-held" };
      case "chat.sync":
        return {
          threadId: command.threadId,
          status: "idle",
          turns: [
            {
              id: "console-turn-1",
              status: "completed",
              startedAt: 1_786_134_300,
              completedAt: 1_786_134_302,
              durationMs: 2_000,
              items: [
                {
                  type: "userMessage",
                  id: "console-user-1",
                  text: "What is 4+4?",
                },
                {
                  type: "agentMessage",
                  id: "console-commentary-1",
                  text: "I’m calculating the result.",
                  phase: "commentary",
                  correlation: {
                    sourceMethod: "thread/read",
                    diagnosticId: null,
                    threadId: command.threadId,
                    turnId: "console-turn-1",
                    itemId: "console-commentary-1",
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "reasoning",
                    id: "console-reasoning-1",
                    status: "completed",
                    summary: ["Added four and four."],
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: "console-reasoning-1",
                    },
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "contextCompaction",
                    id: "console-compaction-1",
                    status: "completed",
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: "console-compaction-1",
                    },
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "turnSummary",
                    id: "turn:console-turn-1:summary",
                    status: "completed",
                    durationMs: 2_000,
                    startedAt: 1_786_134_300,
                    completedAt: 1_786_134_302,
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: null,
                    },
                  },
                },
                {
                  type: "agentMessage",
                  id: "console-agent-1",
                  text: "8",
                  phase: "final_answer",
                  correlation: {
                    sourceMethod: "thread/read",
                    diagnosticId: null,
                    threadId: command.threadId,
                    turnId: "console-turn-1",
                    itemId: "console-agent-1",
                  },
                },
              ],
            },
          ],
        };
    }
  },
} satisfies WorkerCommandBus;

afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("local server foundation", () => {
  it("persists server configuration, workers, and conversations", async () => {
    const firstDatabase = await connectDatabase(config);
    const firstApp = await buildApp({
      config,
      database: firstDatabase,
      logger: false,
      workerBridge,
    });

    const mutationPreflight = await firstApp.inject({
      method: "OPTIONS",
      url: "/api/projects/order",
      headers: {
        origin: config.appOrigins[0]!,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });
    expect(mutationPreflight).toMatchObject({ statusCode: 204 });
    expect(mutationPreflight.headers["access-control-allow-methods"]).toContain(
      "PATCH",
    );
    expect(mutationPreflight.headers["access-control-allow-methods"]).toContain(
      "DELETE",
    );

    const bootstrap = serverBootstrapSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/bootstrap" })).json(),
    );
    expect(bootstrap.auth).toMatchObject({
      mode: "none",
      state: "authenticated",
      currentUser: { kind: "anonymous", role: "owner" },
      registration: { enabled: false },
    });
    expect(bootstrap.routing.directWorkerConnections).toBe(false);
    expect(bootstrap.capabilities.worktrees).toBe(true);
    expect(bootstrap.capabilities.projectReplicas).toBe(true);
    expect(bootstrap.capabilities.replicaProvisioning).toBe(true);
    expect(bootstrap.capabilities.browserFleetDiscovery).toBe(true);
    expect(bootstrap.capabilities.crossWorkerExecutionTargets).toBe(true);
    expect(bootstrap.capabilities.remoteDesktopFleet).toBe(true);
    expect(bootstrap.capabilities.gitSync).toBe(true);

    const initialSettings = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(initialSettings.preferences).toMatchObject({
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 80,
      eliteMode: false,
      eliteRevealConfig: {
        glitchCountMax: 3,
        glitchCountMin: 1,
        glitchShowMs: 9,
        staggerSpreadMs: 50,
      },
      sidebarWidth: 288,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: null,
      defaultPermissionProfileId: ":workspace",
      mobileProjectTabConfigurations: {},
    });
    expect(initialSettings.providers).toEqual([]);
    expect(initialSettings.models).toEqual([]);
    const providerResponse = await firstApp.inject({
      method: "POST",
      url: "/api/settings/providers",
      payload: {
        id: "00000000-0000-4000-8000-000000000941",
        name: "Test provider",
        kind: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        protectedApiKey: {
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
    expect(providerResponse.body).not.toContain("server-only-secret");
    expect(providerResponse.body).not.toContain("apiKey");
    const provider = modelProviderSummarySchema.parse(providerResponse.json());
    expect(provider.hasApiKey).toBe(true);
    const editedProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/providers/${provider.id}`,
          payload: {
            name: "Edited test provider",
            kind: "openai-compatible",
            baseUrl: "https://edited-models.example.test/v1/",
          },
        })
      ).json(),
    );
    expect(editedProvider).toMatchObject({
      name: "Edited test provider",
      baseUrl: "https://edited-models.example.test/v1",
      hasApiKey: true,
    });
    const selectedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "Test model",
            routes: [
              {
                providerId: provider.id,
                modelName: "test-model",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    const editedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/models/${selectedModel.id}`,
          payload: {
            name: "Edited test model",
            routes: [
              {
                id: selectedModel.routes[0]?.id,
                providerId: provider.id,
                modelName: "edited-test-model",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    expect(editedModel).toMatchObject({
      name: "Edited test model",
      routingPolicy: "priority",
      routes: [
        expect.objectContaining({
          providerName: "Edited test provider",
          modelName: "edited-test-model",
          position: 0,
        }),
      ],
    });
    const invalidProModeOpacity = await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { proModeOpacity: 101 },
    });
    expect(invalidProModeOpacity.statusCode).toBe(400);
    const updatedSettings = settingsBundleSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            theme: "dark",
            highContrast: true,
            proMode: true,
            proModeOpacity: 64,
            eliteMode: true,
            eliteRevealConfig: {
              glitchCountMax: 2,
              glitchCountMin: 2,
              glitchShowMs: 12,
              staggerSpreadMs: 40,
              variants: ["chromatic", "scanline"],
            },
            sidebarWidth: 352,
            desktopFrameRate: 60,
            desktopStreamQuality: "balanced",
            defaultModelId: selectedModel.id,
            defaultPermissionProfileId: ":read-only",
            mobileProjectTabConfigurations: {
              "project-1": ["group-1", null],
            },
          },
        })
      ).json(),
    );
    expect(updatedSettings.preferences).toEqual({
      theme: "dark",
      highContrast: true,
      proMode: true,
      proModeOpacity: 64,
      eliteMode: true,
      eliteRevealConfig: {
        glitchCountMax: 2,
        glitchCountMin: 2,
        glitchShowMs: 12,
        staggerSpreadMs: 40,
        variants: ["chromatic", "scanline"],
      },
      sidebarWidth: 352,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
      defaultPermissionProfileId: ":read-only",
      defaultWorkerId: null,
      automaticReplicaProvisioning: false,
      automaticReplicaSynchronization: "off",
      mobileProjectTabConfigurations: {
        "project-1": ["group-1", null],
      },
    });
    const mergedMobileTabs = settingsBundleSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            mobileProjectTabConfigurations: {
              "project-2": ["group-2"],
            },
          },
        })
      ).json(),
    );
    expect(mergedMobileTabs.preferences.mobileProjectTabConfigurations).toEqual(
      {
        "project-1": ["group-1", null],
        "project-2": ["group-2"],
      },
    );
    expect(
      settingsBundleSchema.parse(
        (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
      ).preferences.mobileProjectTabConfigurations,
    ).toEqual({
      "project-1": ["group-1", null],
      "project-2": ["group-2"],
    });
    const chatGptProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            id: "00000000-0000-4000-8000-000000000943",
            name: "Personal ChatGPT",
            kind: "chatgpt",
            baseUrl: "https://api.openai.com/v1",
          },
        })
      ).json(),
    );
    expect(chatGptProvider.accounts).toEqual([
      expect.objectContaining({
        label: "ChatGPT account",
        position: 0,
      }),
    ]);
    const primaryChatGptAccount = chatGptProvider.accounts[0]!;
    await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      primaryChatGptAccount.id,
      protectedProviderCredentialFixture("B"),
      providerCredentialMetadataFixture(),
    );
    await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 37,
    });

    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: "Bearer wrong-worker-token" },
        payload: {},
      }),
    ).toMatchObject({ statusCode: 401 });
    const heartbeatResponse = await firstApp.inject({
      method: "POST",
      url: "/api/internal/workers/heartbeat",
      headers: { authorization: "Bearer test-worker-token" },
      payload: {
        workerId: "test-worker",
        name: "Test Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "codex-cli 1.0.0",
        codexRuntime: unprobedCodexRuntimeReport,
        remoteSurfaces: {
          browser: true,
          desktop: true,
          transports: ["websocket"],
          maxSessions: 4,
        },
        code: {
          available: true,
          version: codeEditorBuild.version,
          upstreamRevision: codeEditorBuild.upstreamRevision,
          patchset: codeEditorBuild.patchset,
          transport: "web-proxy",
          maxSessions: 4,
          reason: null,
        },
        projectReplicas: {
          provision: true,
          synchronize: false,
          remove: false,
          exactRevision: true,
        },
        startedAt: "2026-08-07T12:00:00.000Z",
      },
    });
    expect(heartbeatResponse.statusCode).toBe(202);
    const placementSettings = settingsBundleSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            defaultWorkerId: "test-worker",
            automaticReplicaProvisioning: true,
            automaticReplicaSynchronization: "fast-forward-primary",
          },
        })
      ).json(),
    );
    expect(placementSettings.preferences).toMatchObject({
      defaultWorkerId: "test-worker",
      automaticReplicaProvisioning: true,
      automaticReplicaSynchronization: "fast-forward-primary",
      mobileProjectTabConfigurations: {
        "project-1": ["group-1", null],
        "project-2": ["group-2"],
      },
    });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { defaultWorkerId: "unknown-worker" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/codex/auth/status?providerId=${chatGptProvider.id}`,
        })
      ).json(),
    ).toMatchObject({
      authMode: "chatgpt",
      planType: "plus",
      weeklyUsage: { usedPercent: 37 },
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/codex/auth/device-login",
          payload: {
            workerId: "test-worker",
            providerId: chatGptProvider.id,
          },
        })
      ).json(),
    ).toMatchObject({ userCode: "TEST-CODE" });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/codex/auth/logout",
        payload: {
          workerId: "test-worker",
          providerId: chatGptProvider.id,
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(authProviderIds).toEqual([chatGptProvider.id]);
    expect(authCredentialHomeKeys).toEqual([chatGptProvider.id]);
    expect(authProviderKinds).toEqual(["chatgpt"]);
    expect(clearedProviderAccounts).toEqual([
      expect.objectContaining({
        providerAccountId: primaryChatGptAccount.id,
        providerId: chatGptProvider.id,
        type: "provider.auth.account.clear",
      }),
    ]);
    await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      primaryChatGptAccount.id,
      protectedProviderCredentialFixture("B"),
      providerCredentialMetadataFixture(),
    );
    const additionalAccount = (
      await firstApp.inject({
        method: "POST",
        url: `/api/settings/providers/${chatGptProvider.id}/accounts`,
        payload: { label: "Work" },
      })
    ).json<{ id: string; label: string; position: number }>();
    expect(additionalAccount).toMatchObject({ label: "Work", position: 1 });
    const reorderAccountsResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/settings/providers/${chatGptProvider.id}/accounts/order`,
      payload: { ids: [additionalAccount.id, primaryChatGptAccount.id] },
    });
    expect(
      reorderAccountsResponse.statusCode,
      reorderAccountsResponse.body,
    ).toBe(204);
    expect(
      modelProviderAccountListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/settings/providers/${chatGptProvider.id}/accounts`,
            })
          ).json(),
        )
        .map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: additionalAccount.id, position: 0 },
      { id: primaryChatGptAccount.id, position: 1 },
    ]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/settings/providers/${chatGptProvider.id}/accounts/order`,
        payload: { ids: [additionalAccount.id] },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/codex/auth/status?providerId=${chatGptProvider.id}&accountId=${additionalAccount.id}`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(authCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    const pooledSettings = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(
      pooledSettings.providers
        .find((provider) => provider.id === chatGptProvider.id)
        ?.accounts.find((account) => account.id === additionalAccount.id),
    ).toMatchObject({
      credentialState: "signed-out",
      email: null,
      workerBindings: [],
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/settings/providers",
        payload: {
          id: "00000000-0000-4000-8000-000000000944",
          name: "Another ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const grokProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            id: "00000000-0000-4000-8000-000000000945",
            name: "SuperGrok",
            kind: "grok",
            baseUrl: "https://cli-chat-proxy.grok.com/v1",
          },
        })
      ).json(),
    );
    expect(grokProvider.accounts).toEqual([
      expect.objectContaining({ label: "Grok account", position: 0 }),
    ]);
    await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      grokProvider.id,
      grokProvider.accounts[0]!.id,
      protectedProviderCredentialFixture("C"),
      providerCredentialMetadataFixture(),
    );
    expect(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/codex/auth/status?providerId=${grokProvider.id}`,
        })
      ).json(),
    ).toMatchObject({
      authenticated: true,
      authMode: "grok",
      email: null,
      planType: null,
      weeklyUsage: null,
    });
    expect(authProviderKinds.at(-1)).toBe("chatgpt");
    expect(authCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/settings/providers/${grokProvider.id}/accounts`,
          payload: { label: "Backup Grok" },
        })
      ).json(),
    ).toMatchObject({ label: "Backup Grok", position: 1 });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/settings/providers",
        payload: {
          id: "00000000-0000-4000-8000-000000000946",
          name: "Another Grok",
          kind: "grok",
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      githubRepositoryListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: "/api/github/repositories/cache?workerId=test-worker&login=cantrip-test",
          })
        ).json(),
      ),
    ).toMatchObject([{ nameWithOwner: "ArcaneArts/Cantrip", imported: false }]);
    expect(
      githubRepositoryOwnerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: "/api/github/repository-owners?workerId=test-worker",
          })
        ).json(),
      ),
    ).toEqual([
      { login: "cantrip-test", kind: "user" },
      { login: "ArcaneArts", kind: "organization" },
    ]);
    const createdRepositoryResponse = await firstApp.inject({
      method: "POST",
      url: "/api/github/repositories?workerId=test-worker",
      payload: {
        owner: "ArcaneArts",
        name: "cantrip-labs",
        description: "A Cantrip project",
        visibility: "private",
      },
    });
    expect(createdRepositoryResponse.statusCode).toBe(201);
    expect(
      githubRepositorySchema.parse(createdRepositoryResponse.json()),
    ).toMatchObject({
      id: "github-created-repository",
      nameWithOwner: "ArcaneArts/cantrip-labs",
      isPrivate: true,
      imported: false,
    });
    expect(repositoryCreateCommands.at(-1)?.request).toEqual({
      owner: "ArcaneArts",
      name: "cantrip-labs",
      description: "A Cantrip project",
      initialize: "readme",
      visibility: "private",
    });

    heldProjectCloneName = "ArcaneArts/Cantrip";
    const projectResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    expect(projectResponse.statusCode).toBe(202);
    const queuedProject = projectWireSummarySchema.parse(
      projectResponse.json(),
    );
    expect(queuedProject).toMatchObject({
      originKind: "github",
      capabilities: {
        git: true,
        github: true,
        worktrees: true,
        replicas: true,
        relocation: true,
      },
      setupStatus: "cloning",
      setupError: null,
      source: null,
    });
    const preferredProject = projectWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${queuedProject.id}/preferred-worker`,
          payload: { workerId: "test-worker" },
        })
      ).json(),
    );
    expect(preferredProject.preferredWorkerId).toBe("test-worker");
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${queuedProject.id}/preferred-worker`,
        payload: { workerId: "unknown-worker" },
      }),
    ).toMatchObject({ statusCode: 404 });
    await vi.waitFor(() => expect(releaseProjectClone).not.toBeNull());
    const parallelResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        repositoryId: "github-repository-2",
        nameWithOwner: "ArcaneArts/ParallelClone",
        url: "https://github.com/ArcaneArts/ParallelClone",
      },
    });
    expect(parallelResponse.statusCode).toBe(202);
    const parallelProject = projectWireSummarySchema.parse(
      parallelResponse.json(),
    );
    await vi.waitFor(async () => {
      const currentProjects = projectWireListSchema.parse(
        (await firstApp.inject({ method: "GET", url: "/api/projects" })).json(),
      );
      expect(
        currentProjects.find((candidate) => candidate.id === parallelProject.id)
          ?.setupStatus,
      ).toBe("ready");
      expect(
        currentProjects.find((candidate) => candidate.id === queuedProject.id)
          ?.setupStatus,
      ).toBe("cloning");
    });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/projects/${parallelProject.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
    heldProjectCloneName = null;
    releaseProjectClone?.();
    releaseProjectClone = null;
    const project = await vi.waitFor(async () => {
      const current = projectWireListSchema
        .parse(
          (
            await firstApp.inject({ method: "GET", url: "/api/projects" })
          ).json(),
        )
        .find((candidate) => candidate.id === queuedProject.id);
      expect(current).toMatchObject({
        setupStatus: "ready",
        setupError: null,
        source: expect.objectContaining({
          sourceKind: "git",
          workerId: "test-worker",
        }),
        replicas: [expect.objectContaining({ sourceKind: "git" })],
      });
      return current!;
    });
    expect(
      projectReplicaJobListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/replica-jobs`,
          })
        ).json(),
      ),
    ).toEqual([
      expect.objectContaining({
        state: "succeeded",
        attempt: 1,
        resolvedRevision: "b".repeat(40),
        projectReplicaId: expect.any(String),
      }),
    ]);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/projects/${project.id}/replicas`,
        payload: {
          workerId: "test-worker",
          expectedRevision: null,
          idempotencyKey: "duplicate-existing-replica",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const initialWorkspaces = projectWorkspaceWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/workspaces" })).json(),
    );
    const defaultWorkspace = initialWorkspaces.workspaces[0]!;
    expect(defaultWorkspace).toMatchObject({
      nameProtection: { state: "system-default" },
      isDefault: true,
      projectIds: [project.id],
    });
    const encryptionClientId = "261eec06-fd9d-4244-8bea-b44b29245ac9";
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/encryption/profile/initialize",
        payload: {
          profile: {
            formatVersion: 1,
            activeMasterKeyRevision: 1,
            passwordKdf: null,
            passwordWrappedMasterKey: null,
            payloadMigrationStatus: "pending",
          },
          initialClient: {
            id: encryptionClientId,
            label: "Local foundation client",
            publicKey: {
              version: 1,
              algorithm: "P-256",
              format: "raw",
              value: Buffer.alloc(65).toString("base64url"),
            },
            wrappedMasterKey: {
              version: 1,
              purpose: "client-account-master-key",
              clientId: encryptionClientId,
              masterKeyRevision: 1,
              envelope: {
                version: 1,
                algorithm: "HPKE-RFC9180",
                suite: {
                  mode: "base",
                  kem: "DHKEM(P-256,HKDF-SHA256)",
                  kdf: "HKDF-SHA256",
                  aead: "AES-256-GCM",
                },
                encapsulatedKey: Buffer.alloc(65).toString("base64url"),
                ciphertext: Buffer.alloc(48).toString("base64url"),
              },
            },
          },
        },
      }),
    ).toMatchObject({ statusCode: 201 });
    const renamedDefaultWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/workspaces/${defaultWorkspace.id}`,
          payload: {
            expectedRevision: defaultWorkspace.revision,
            nameProtection: workspaceNameProtection(1),
          },
        })
      ).json(),
    );
    expect(renamedDefaultWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: true,
    });
    const personalWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/workspaces",
          payload: {
            id: "c41a00ec-7438-42a8-929b-5048ca426c8c",
            nameProtection: workspaceNameProtection(2),
          },
        })
      ).json(),
    );
    expect(personalWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: false,
      projectIds: [],
    });
    const assignedWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/workspaces/${personalWorkspace.id}`,
          payload: {
            expectedRevision: personalWorkspace.revision,
            nameProtection: workspaceNameProtection(3),
            projectIds: [project.id],
          },
        })
      ).json(),
    );
    expect(assignedWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      projectIds: [project.id],
    });
    const promotedWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/workspaces/${personalWorkspace.id}`,
          payload: {
            expectedRevision: assignedWorkspace.revision,
            isDefault: true,
          },
        })
      ).json(),
    );
    expect(promotedWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: true,
    });
    const updatedWorkspaces = projectWorkspaceWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/workspaces" })).json(),
    ).workspaces;
    expect(updatedWorkspaces.filter(({ isDefault }) => isDefault)).toEqual([
      expect.objectContaining({ id: personalWorkspace.id }),
    ]);
    expect(
      updatedWorkspaces.find(({ id }) => id === defaultWorkspace.id),
    ).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: false,
    });
    expect(
      updatedWorkspaces.filter(({ projectIds }) =>
        projectIds.includes(project.id),
      ),
    ).toHaveLength(2);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${personalWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${defaultWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const projectShareResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/network-shares`,
    });
    expect(projectShareResponse.statusCode).toBe(201);
    const projectShare = projectShareAttachmentSchema.parse(
      projectShareResponse.json(),
    );
    expect(projectShare).toMatchObject({
      projectId: project.id,
      protocol: "webdav",
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:4311\/project-shares\/[A-Za-z0-9_-]{43}\/$/u,
      ),
      username: "cantrip-test-user",
      password: "a-strong-random-test-password",
    });
    const reusedProjectShare = projectShareAttachmentSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/network-shares`,
        })
      ).json(),
    );
    expect(reusedProjectShare.attachmentId).toBe(projectShare.attachmentId);
    expect(openedProjectShares).toHaveLength(2);
    expect(openedProjectShares[0]).toMatchObject({
      root: project.source?.path,
      shareId: projectShare.attachmentId,
      publicBasePath: new URL(projectShare.url).pathname.replace(/\/$/u, ""),
      publicOrigin: "http://127.0.0.1:4311",
    });
    expect(openedProjectShares[1]).toEqual(openedProjectShares[0]);
    const projectShareTunnels = tunnelListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tunnels`,
        })
      ).json(),
    );
    expect(projectShareTunnels).toEqual([
      expect.objectContaining({
        projectId: project.id,
        origin: "project-share",
        protocolHint: "webdav",
        source: { kind: "server-http", adapter: "project-share" },
        destination: expect.objectContaining({
          kind: "worker-adapter",
          adapter: "project-share",
          resourceId: projectShare.attachmentId,
        }),
        attachments: [
          expect.objectContaining({
            id: projectShare.attachmentId,
            kind: "server-relay",
            status: "active",
          }),
        ],
      }),
    ]);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-shares/${projectShare.attachmentId}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(closedProjectShareIds).toEqual([projectShare.attachmentId]);
    expect(
      tunnelListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/tunnels`,
          })
        ).json(),
      ),
    ).toEqual([]);
    const codeTab = codeTabSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/code-tabs`,
          payload: { title: "Code" },
        })
      ).json(),
    );
    const codeAttachmentResponse = await firstApp.inject({
      method: "POST",
      url: `/api/code-tabs/${codeTab.id}/attachments`,
      payload: { appearance: "high-contrast-dark" },
    });
    expect(codeAttachmentResponse.statusCode).toBe(201);
    const codeAttachment = codeAttachmentSchema.parse(
      codeAttachmentResponse.json(),
    );
    expect(codeAttachment).toMatchObject({
      sessionId: expect.any(String),
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4311\/code\//u),
      runtime: { status: "running", processInstanceId: "code-process-1" },
    });
    const secondCodeAttachment = codeAttachmentSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/code-tabs/${codeTab.id}/attachments`,
          payload: { appearance: "high-contrast-dark" },
        })
      ).json(),
    );
    expect(secondCodeAttachment).toMatchObject({
      sessionId: codeAttachment.sessionId,
      runtime: { processInstanceId: "code-process-1" },
    });
    expect(secondCodeAttachment.attachmentId).not.toBe(
      codeAttachment.attachmentId,
    );
    const codeTunnels = tunnelListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tunnels`,
        })
      ).json(),
    );
    expect(codeTunnels).toEqual([
      expect.objectContaining({
        projectId: project.id,
        origin: "code",
        protocolHint: "http-websocket",
        source: { kind: "server-http", adapter: "code" },
        destination: expect.objectContaining({
          kind: "worker-adapter",
          workerId: "test-worker",
          adapter: "code",
          resourceId: codeTab.id,
        }),
        managedBy: { kind: "code", id: codeTab.id },
        attachments: expect.arrayContaining([
          expect.objectContaining({
            id: codeAttachment.attachmentId,
            kind: "server-relay",
            status: "active",
          }),
          expect.objectContaining({
            id: secondCodeAttachment.attachmentId,
            kind: "server-relay",
            status: "active",
          }),
        ]),
      }),
    ]);
    expect(
      codeRuntimeStatusSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/code-tabs/${codeTab.id}/sessions/${codeAttachment.sessionId}/runtime`,
          })
        ).json(),
      ),
    ).toMatchObject({
      sessionId: codeAttachment.sessionId,
      bridgeConnected: true,
      status: "running",
    });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/code-attachments/${codeAttachment.attachmentId}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      tunnelListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/tunnels`,
          })
        ).json(),
      )[0]?.attachments,
    ).toEqual([
      expect.objectContaining({ id: secondCodeAttachment.attachmentId }),
    ]);
    expect(
      codeSaveAllResultSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/code-tabs/${codeTab.id}/save-all`,
          })
        ).json(),
      ),
    ).toMatchObject({ saved: ["file:///workspace/Cantrip/README.md"] });
    expect(
      codeTabSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/code-tabs/${codeTab.id}/theme`,
            payload: {
              themeMode: "follow-cantrip",
              appearance: "light",
            },
          })
        ).json(),
      ).themeMode,
    ).toBe("follow-cantrip");
    expect(
      codeRuntimeStatusSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/code-tabs/${codeTab.id}/stop`,
          })
        ).json(),
      ).status,
    ).toBe("stopped");
    expect(
      tunnelListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/tunnels`,
          })
        ).json(),
      ),
    ).toEqual([]);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const remoteSurface = remoteSurfaceSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-surfaces`,
          payload: {
            workerId: "test-worker",
            title: "Worker browser",
            configuration: {
              kind: "browser",
              initialUrl: "https://example.com/",
            },
          },
        })
      ).json(),
    );
    expect(remoteSurface).toMatchObject({
      workerId: "test-worker",
      kind: "browser",
      status: "idle",
      preferredTransport: "websocket",
      configuration: {
        kind: "browser",
        initialUrl: "https://example.com/",
        profileId: null,
      },
    });
    expect(
      remoteSurfaceListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/remote-surfaces/${remoteSurface.id}`,
            payload: { title: "Renamed worker browser" },
          })
        ).json(),
      ).title,
    ).toBe("Renamed worker browser");
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/remote-surfaces/${remoteSurface.id}/suspend`,
          })
        ).json(),
      ).status,
    ).toBe("suspended");
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/remote-surfaces/${remoteSurface.id}/resume`,
          })
        ).json(),
      ).status,
    ).toBe("active");
    await firstApp.ready();
    let resolveRejectedOrigin: ((code: number) => void) | null = null;
    const rejectedOriginPromise = new Promise<number>((resolve) => {
      resolveRejectedOrigin = resolve;
    });
    const rejectedSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteSurface.id}/connect`,
      { headers: { origin: "https://attacker.example" } },
      {
        onInit(socket) {
          socket.once("close", (code) => resolveRejectedOrigin?.(code));
        },
      },
    );
    expect(await rejectedOriginPromise).toBe(1008);
    rejectedSocket.terminate();
    let resolveReadyMessage: ((message: unknown) => void) | null = null;
    const readyMessagePromise = new Promise<unknown>((resolve) => {
      resolveReadyMessage = resolve;
    });
    const surfaceSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteSurface.id}/connect?width=800&height=600&devicePixelRatio=2`,
      { headers: { origin: "http://127.0.0.1:5173" } },
      {
        onInit(socket) {
          socket.once("message", (data) =>
            resolveReadyMessage?.(JSON.parse(data.toString())),
          );
        },
      },
    );
    const readyMessage = await readyMessagePromise;
    const connection = remoteSurfaceConnectionMessageSchema.parse(readyMessage);
    expect(connection).toMatchObject({
      type: "ready",
      surfaceId: remoteSurface.id,
      transport: "websocket",
    });
    if (connection.type !== "ready") throw new Error("Surface did not attach.");

    surfaceSocket.send(
      encodeRemoteSurfaceFrame(
        {
          protocolVersion: 1,
          surfaceId: remoteSurface.id,
          attachmentId: connection.attachmentId,
          sequence: 0,
          channel: "control",
        },
        new Uint8Array([1, 2, 3]),
      ),
    );
    await vi.waitFor(() =>
      expect(relayedSurfaceFrames.at(-1)).toEqual({
        workerId: "test-worker",
        sequence: 0,
        payload: [1, 2, 3],
      }),
    );

    const workerFrame = new Promise<Uint8Array>((resolve) => {
      surfaceSocket.once("message", (data) =>
        resolve(new Uint8Array(data as ArrayBuffer)),
      );
    });
    for (const listener of surfaceFrameListeners) {
      listener(
        {
          protocolVersion: 1,
          surfaceId: remoteSurface.id,
          attachmentId: connection.attachmentId,
          sequence: 0,
          channel: "frame",
        },
        new Uint8Array([9, 8, 7]),
      );
    }
    expect([...decodeRemoteSurfaceFrame(await workerFrame).payload]).toEqual([
      9, 8, 7,
    ]);
    surfaceSocket.terminate();
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/remote-surfaces/${remoteSurface.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstDatabase.repository.listProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
      ),
    ).toMatchObject([
      {
        name: "Primary",
        isPrimary: true,
        isDefault: true,
        lifecycleState: "ready",
        path: project.source!.path,
        workerId: "test-worker",
      },
    ]);
    expect(
      githubIssueListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/github/issues?kind=pull-request&state=open&page=3&limit=25`,
          })
        ).json(),
      ),
    ).toMatchObject({
      kind: "pull-request",
      total: 1,
      issues: [{ number: 42, state: "open" }],
      nextPage: 4,
    });
    expect(issueListRequests).toContainEqual({
      kind: "pull-request",
      page: 3,
      limit: 25,
    });
    const issueCreateResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github/issues`,
      payload: {
        title: "Issue created from Cantrip",
        body: "Issue details from the Git tab.",
      },
    });
    expect(issueCreateResponse.statusCode).toBe(201);
    expect(
      githubIssueDetailSchema.parse(issueCreateResponse.json()),
    ).toMatchObject({
      number: 43,
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    expect(createdIssues).toContainEqual({
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/projects/${project.id}/github/issues`,
        payload: { title: "   " },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/projects/${project.id}/github/issues?kind=discussion`,
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      githubIssueDetailSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/github/issues/42`,
          })
        ).json(),
      ),
    ).toMatchObject({ number: 42, body: "Issue details" });
    await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github/issues/42/comments`,
      payload: { body: "Comment from Cantrip" },
    });
    expect(issueComments).toContain("Comment from Cantrip");
    expect(
      githubIssueDetailSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/projects/${project.id}/github/issues/42/close`,
            payload: { comment: "Closing from Cantrip" },
          })
        ).json(),
      ).state,
    ).toBe("closed");
    expect(closedIssues).toContainEqual({
      number: 42,
      comment: "Closing from Cantrip",
    });
    const [primaryWorktree] =
      await firstDatabase.repository.listProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
      );
    expect(primaryWorktree).toBeDefined();
    const pullRequestCreateResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/github/pull-requests`,
      payload: {
        base: "main",
        head: "feature/pr-ui",
        title: "feat: add pull request creation",
        body: "Creates pull requests from Cantrip.",
        draft: true,
        labels: ["feature"],
        reviewers: ["reviewer"],
        linkedIssueNumbers: [42],
      },
    });
    expect(pullRequestCreateResponse.statusCode).toBe(201);
    expect(
      githubPullRequestCreateResultSchema.parse(
        pullRequestCreateResponse.json(),
      ),
    ).toMatchObject({
      pullRequest: {
        number: 44,
        draft: true,
        headRef: "feature/pr-ui",
        baseRef: "main",
      },
      warnings: [],
    });
    expect(pullRequestCreateCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      request: {
        base: "main",
        head: "feature/pr-ui",
        title: "feat: add pull request creation",
        draft: true,
        labels: ["feature"],
        reviewers: ["reviewer"],
        linkedIssueNumbers: [42],
      },
    });
    const pullRequestDetailResponse = await firstApp.inject({
      method: "GET",
      url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/github/pull-requests/44`,
    });
    expect(pullRequestDetailResponse.statusCode).toBe(200);
    expect(
      githubPullRequestDetailSchema.parse(pullRequestDetailResponse.json()),
    ).toMatchObject({
      number: 44,
      mergeable: true,
      reviewDecision: "review-required",
      checksState: "success",
    });
    expect(pullRequestGetCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
    });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/github/pull-requests/not-a-number`,
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/projects/${project.id}/worktrees/missing-worktree/github/pull-requests/44`,
      }),
    ).toMatchObject({ statusCode: 404 });
    const pullRequestBaseUrl = `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/github/pull-requests/44`;
    const pullRequestActionUrl = `${pullRequestBaseUrl}/actions`;
    for (const payload of [
      { type: "comment", body: "General feedback" },
      {
        type: "submit-review",
        review: { event: "approve", body: "Looks good" },
      },
      {
        type: "inline-comment",
        comment: {
          body: "Please rename this.",
          path: "src/review.ts",
          line: 12,
          side: "RIGHT",
        },
      },
      { type: "reply", commentId: 99, body: "Updated." },
    ]) {
      const response = await firstApp.inject({
        method: "POST",
        url: pullRequestActionUrl,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(githubPullRequestDetailSchema.parse(response.json()).number).toBe(
        44,
      );
    }
    expect(pullRequestReviewCommands.slice(-4)).toMatchObject([
      {
        type: "github.pull-request.comment",
        cwd: primaryWorktree!.path,
        number: 44,
        body: "General feedback",
      },
      {
        type: "github.pull-request.review.submit",
        review: { event: "approve", body: "Looks good" },
      },
      {
        type: "github.pull-request.review.comment",
        comment: { path: "src/review.ts", line: 12, side: "RIGHT" },
      },
      {
        type: "github.pull-request.review.reply",
        commentId: 99,
        body: "Updated.",
      },
    ]);
    expect(
      await firstApp.inject({
        method: "POST",
        url: pullRequestActionUrl,
        payload: {
          type: "submit-review",
          review: { event: "request-changes", body: "" },
        },
      }),
    ).toMatchObject({ statusCode: 400 });
    const lifecyclePreviewResponse = await firstApp.inject({
      method: "POST",
      url: `${pullRequestBaseUrl}/lifecycle/preview`,
      payload: {
        type: "merge",
        method: "squash",
        commitTitle: "feat: lifecycle",
        commitMessage: null,
      },
    });
    expect(lifecyclePreviewResponse.statusCode).toBe(200);
    const lifecyclePreview = githubPullRequestLifecyclePreviewSchema.parse(
      lifecyclePreviewResponse.json(),
    );
    expect(lifecyclePreview).toMatchObject({
      confirmationPhrase: "squash #44",
      destructive: true,
    });
    const lifecycleApplyResponse = await firstApp.inject({
      method: "POST",
      url: `${pullRequestBaseUrl}/lifecycle/apply`,
      payload: {
        action: lifecyclePreview.action,
        token: lifecyclePreview.token,
        confirmation: "squash #44",
      },
    });
    expect(lifecycleApplyResponse.statusCode).toBe(200);
    expect(
      githubPullRequestDetailSchema.parse(lifecycleApplyResponse.json()),
    ).toMatchObject({ state: "closed", merged: true });
    expect(pullRequestLifecyclePreviewCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
      action: { type: "merge", method: "squash" },
    });
    expect(pullRequestLifecycleApplyCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
      request: {
        token: "9".repeat(64),
        confirmation: "squash #44",
      },
    });
    const checkoutResponse = await firstApp.inject({
      method: "POST",
      url: `${pullRequestBaseUrl}/checkout`,
      payload: {},
    });
    expect(checkoutResponse.statusCode).toBe(200);
    expect(
      githubPullRequestCheckoutResultSchema.parse(checkoutResponse.json()),
    ).toMatchObject({
      pullRequest: { number: 44 },
      worktree: {
        name: "PR #44 Review pull requests",
        branch: "cantrip/pr/44-feature-review-44444444",
        head: "4".repeat(40),
        isPrimary: false,
        origin: "user",
      },
      reused: false,
    });
    expect(pullRequestCheckoutCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
    });
    expect(pullRequestWorktreeCommands.at(-1)).toMatchObject({
      sourcePath: primaryWorktree!.path,
      mode: {
        type: "newBranch",
        branch: "cantrip/pr/44-feature-review-44444444",
        startPoint: "4".repeat(40),
      },
    });
    const history = gitHistorySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/history`,
        })
      ).json(),
    );
    expect(history).toMatchObject({
      branch: "main",
      commits: [{ subject: "feat: test history" }],
    });
    const fileHistory = gitFileHistorySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/files/history?path=README.md&revision=HEAD&cursor=0&limit=25`,
        })
      ).json(),
    );
    expect(fileHistory).toMatchObject({
      path: "README.md",
      commits: [{ subject: "Update README" }],
    });
    expect(gitFileHistoryCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      path: "README.md",
      revision: "HEAD",
      cursor: 0,
      limit: 25,
    });
    const blame = gitBlameSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/files/blame?path=README.md&revision=main&cursor=200&limit=100`,
        })
      ).json(),
    );
    expect(blame).toMatchObject({
      path: "README.md",
      ranges: [{ startLine: 1, endLine: 2 }],
    });
    expect(gitFileBlameCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      revision: "main",
      cursor: 200,
      limit: 100,
    });
    const searchResult = gitCommitSearchResultSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/commits/search?message=searched&author=Cantrip&path=README.md&branch=main&cursor=10&limit=25`,
        })
      ).json(),
    );
    expect(searchResult).toMatchObject({
      query: {
        message: "searched",
        author: "Cantrip",
        path: "README.md",
        branch: "main",
        tag: null,
      },
      commits: [{ subject: "fix: searched commit" }],
    });
    expect(gitCommitSearchCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      cursor: 10,
      limit: 25,
    });
    const recoveryBase = `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/recovery`;
    const recoveryList = gitRecoveryCandidateListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `${recoveryBase}?kind=reflog&cursor=20&limit=25`,
        })
      ).json(),
    );
    expect(recoveryList.entries[0]).toMatchObject({ kind: "reflog" });
    const recoveryAction = {
      type: "reset" as const,
      mode: "mixed" as const,
      target: "1".repeat(40),
    };
    const recoveryPreview = gitRecoveryPreviewSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `${recoveryBase}/preview`,
          payload: recoveryAction,
        })
      ).json(),
    );
    const recoveryApply = gitRecoveryResultSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `${recoveryBase}/apply`,
          payload: {
            action: recoveryAction,
            token: recoveryPreview.token,
            confirmation: recoveryPreview.confirmation,
          },
        })
      ).json(),
    );
    expect(recoveryApply).toMatchObject({
      action: recoveryAction,
      headAfter: "1".repeat(40),
    });
    expect(gitRecoveryCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "git.recovery.list",
          cwd: primaryWorktree!.path,
          kind: "reflog",
          cursor: 20,
          limit: 25,
        }),
        expect.objectContaining({
          type: "git.recovery.apply",
          cwd: primaryWorktree!.path,
        }),
      ]),
    );
    expect(
      await firstApp.inject({ method: "GET", url: recoveryBase }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/commits/search`,
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/projects/${project.id}/worktrees/${primaryWorktree!.id}/git/files/history?path=../secret`,
      }),
    ).toMatchObject({ statusCode: 400 });
    const gitStatus = gitStatusSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/status`,
        })
      ).json(),
    );
    expect(gitStatus).toMatchObject({
      branch: "main",
      ahead: 1,
      files: [{ path: "README.md", unstaged: true }],
    });
    const gitAction = gitActionResultSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/git/actions`,
          payload: { type: "stageAll" },
        })
      ).json(),
    );
    expect(gitAction).toMatchObject({
      output: "Git action complete",
      status: { files: [] },
    });
    const terminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: {
            title: "Dev shell",
            directoryPath: "packages/app",
          },
        })
      ).json(),
    );
    expect(terminal).toMatchObject({
      projectId: project.id,
      title: "Dev shell",
      activeWorkerId: "test-worker",
      service: { enabled: false, command: "" },
    });
    expect(
      terminalListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/terminals/${terminal.id}`,
            payload: { title: "Renamed shell" },
          })
        ).json(),
      ).title,
    ).toBe("Renamed shell");
    const enabledService = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, command: "pnpm dev" },
        })
      ).json(),
    );
    expect(enabledService).toMatchObject({
      status: "running",
      service: { enabled: true, command: "pnpm dev" },
    });
    expect(terminalServiceReconciliations.at(-1)?.services).toEqual([
      expect.objectContaining({
        terminalId: terminal.id,
        command: "pnpm dev",
        cwd: `${primaryWorktree!.path}/packages/app`,
      }),
    ]);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/terminals/${terminal.id}/service/restart`,
        })
      ).statusCode,
    ).toBe(202);
    expect(terminalServiceRestarts).toContain(terminal.id);
    const disabledService = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: false, command: "pnpm dev" },
        })
      ).json(),
    );
    expect(disabledService).toMatchObject({
      status: "idle",
      service: { enabled: false, command: "pnpm dev" },
    });
    expect(terminalServiceReconciliations.at(-1)?.services).toEqual([]);
    expect(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, command: "pnpm dev" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/terminals/${terminal.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(closedTerminalIds).toContain(terminal.id);

    const duplicateResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const chatResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: { title: "Foundation" },
    });
    const chat = chatSummarySchema.parse(chatResponse.json());
    const attachmentText = "A durable worker-owned attachment.";
    const uploadedAttachment = chatAttachmentSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/attachments`,
          headers: {
            "content-type": "application/octet-stream",
            "x-cantrip-file-name": encodeURIComponent("notes.txt"),
            "x-cantrip-mime-type": "text/plain",
            "x-cantrip-attachment-kind": "text",
            "x-cantrip-attachment-source": "paste",
          },
          payload: Buffer.from(attachmentText),
        })
      ).json(),
    );
    expect(uploadedAttachment).toMatchObject({
      chatId: chat.id,
      fileName: "notes.txt",
      kind: "text",
      previewText: attachmentText,
      source: "paste",
    });
    const attachmentContent = await firstApp.inject({
      method: "GET",
      url: `/api/attachments/${uploadedAttachment.id}/content`,
    });
    expect(attachmentContent.statusCode).toBe(200);
    expect(attachmentContent.body).toBe(attachmentText);
    const selectedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/model`,
          payload: { modelId: selectedModel.id },
        })
      ).json(),
    );
    expect(selectedChat).toMatchObject({
      modelId: selectedModel.id,
    });

    const initialPermissionProfiles = chatPermissionProfileStateSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/permission-profiles`,
        })
      ).json(),
    );
    expect(initialPermissionProfiles).toMatchObject({
      available: true,
      selectedId: ":read-only",
      effectiveId: ":read-only",
      defaultId: ":read-only",
      usesDefault: true,
      forcedByWorktreePolicy: false,
    });
    expect(initialPermissionProfiles.profiles).toContainEqual({
      id: ":yolo",
      description: "Unrestricted access without approval prompts",
      allowed: true,
    });
    await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { defaultPermissionProfileId: ":workspace" },
    });
    expect(
      chatPermissionProfileStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/permission-profiles`,
          })
        ).json(),
      ),
    ).toMatchObject({
      selectedId: ":workspace",
      defaultId: ":workspace",
      usesDefault: true,
    });
    await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { defaultPermissionProfileId: ":read-only" },
    });
    const selectedPermissionProfile = chatPermissionProfileStateSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":danger-full-access" },
        })
      ).json(),
    );
    expect(selectedPermissionProfile).toMatchObject({
      selectedId: ":danger-full-access",
      effectiveId: ":danger-full-access",
    });
    const selectedYoloProfile = chatPermissionProfileStateSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":yolo" },
        })
      ).json(),
    );
    expect(selectedYoloProfile).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":yolo",
    });
    expect(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":blocked" },
        })
      ).statusCode,
    ).toBe(409);
    await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "required-for-writes" },
    });
    expect(
      chatPermissionProfileStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/permission-profiles`,
          })
        ).json(),
      ),
    ).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":read-only",
      forcedByWorktreePolicy: true,
    });
    await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "agent-managed" },
    });

    const approvalInput: AgentInteractionRequestCreate = {
      requestKey: "runtime-1:approval-1",
      projectId: project.id,
      provenance: {
        chatId: chat.id,
        threadId: "thread-approval",
        turnId: "turn-approval",
        itemId: "item-approval",
        executionLaneId: null,
        workflowRunId: null,
        workflowNodeId: null,
        workerId: "test-worker",
      },
      payload: {
        kind: "commandExecution",
        startedAtMs: Date.now(),
        approvalId: null,
        environmentId: null,
        reason: "Install dependencies",
        command: "pnpm install",
        cwd: project.source!.path,
        networkApprovalContext: {
          host: "registry.npmjs.org",
          protocol: "https",
        },
        additionalPermissions: { network: { enabled: true } },
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
      expiresAt: "2030-08-08T18:00:00Z",
    };
    const approval =
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      );
    expect(
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      ),
    ).toEqual(approval);
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    expect(
      agentInteractionRequestListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests?chatId=${chat.id}&status=pending`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: approval.id, status: "pending" }]);
    const permissionChangedDuringApproval =
      chatPermissionProfileStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${chat.id}/permission-profile`,
            payload: { id: null },
          })
        ).json(),
      );
    expect(permissionChangedDuringApproval).toMatchObject({
      selectedId: ":read-only",
      defaultId: ":read-only",
      usesDefault: true,
    });

    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: {
            idempotencyKey: "resolution-unavailable",
            response: {
              kind: "commandExecution",
              decision: "acceptForSession",
            },
          },
        })
      ).statusCode,
    ).toBe(409);

    const resolution = {
      idempotencyKey: "resolution-1",
      response: {
        kind: "commandExecution" as const,
        decision: "decline" as const,
      },
    };
    const resolvedApproval = agentInteractionRequestSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).json(),
    );
    expect(resolvedApproval).toMatchObject({
      status: "resolved",
      response: { kind: "commandExecution", decision: "decline" },
      resolvedByUserId: LOCAL_USER_ID,
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: { ...resolution, idempotencyKey: "resolution-2" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("running");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const expiringRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-expired",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-input",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "userInput",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Continue?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Yes", description: "Continue the operation." },
              ],
            },
          ],
          autoResolutionMs: 1,
        },
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests/${expiringRequest.id}`,
          })
        ).json(),
      ).status,
    ).toBe("expired");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const permissionRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-permissions",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-permissions",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "permissions",
          startedAtMs: Date.now(),
          environmentId: null,
          cwd: project.source!.path,
          reason: "Read test fixtures",
          requestedPermissions: {
            network: null,
            fileSystem: { read: ["/fixtures"], write: null },
          },
        },
        expiresAt: null,
      });
    await expect(
      firstDatabase.repository.validateAgentInteractionResolution(
        LOCAL_USER_ID,
        permissionRequest.id,
        {
          idempotencyKey: "resolution-overbroad",
          response: {
            kind: "permissions",
            permissions: {
              fileSystem: { read: ["/outside"] },
            },
            scope: "turn",
            strictAutoReview: false,
          },
        },
      ),
    ).rejects.toThrow(/subset of the requested permissions/u);
    await firstDatabase.repository.interruptAgentInteractionRequests(chat.id);
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const secretRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-secret",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-secret",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "userInput",
          questions: [
            {
              id: "token",
              header: "Token",
              question: "Enter the temporary token",
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
          autoResolutionMs: null,
        },
        expiresAt: null,
      });
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/agent-requests/${secretRequest.id}/respond`,
            payload: {
              idempotencyKey: "resolution-secret",
              response: {
                kind: "userInput",
                answers: { token: { answers: ["do-not-persist"] } },
              },
            },
          })
        ).json(),
      ).response,
    ).toEqual({
      kind: "userInput",
      answers: { token: { answers: ["[redacted]"] } },
    });
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const interruptedRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-interrupted",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-file",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "fileChange",
          startedAtMs: Date.now(),
          reason: "Write generated files",
          grantRoot: project.source!.path,
        },
        expiresAt: null,
      });
    await firstDatabase.repository.resetInterruptedChatExecutions();
    expect(
      (
        await firstDatabase.repository.getAgentInteractionRequest(
          LOCAL_USER_ID,
          interruptedRequest.id,
        )
      )?.status,
    ).toBe("interrupted");
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("failed");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    expect(
      skillListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/skills`,
          })
        ).json(),
      ),
    ).toEqual([
      {
        name: "skill-creator",
        displayName: "Skill Creator",
        description: "Create reusable skills",
      },
    ]);

    const customizationInventory = codexCustomizationInventorySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/customizations?refresh=true`,
        })
      ).json(),
    );
    expect(customizationInventory).toMatchObject({
      capabilities: {
        isolatedCodexHome: true,
        nativeSubagents: { available: true },
        customAgents: { available: false },
        plugins: { install: { available: false } },
      },
      skills: { items: [{ name: "skill-creator", enabled: true }] },
      mcpServers: [{ name: "docs", resources: [{ uri: "docs://readme" }] }],
    });
    expect(customizationInventoryThreadIds.at(-1)).toBeNull();
    const externalPreview = codexExternalImportPreviewSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/customizations/external-preview`,
        })
      ).json(),
    );
    expect(externalPreview.items).toEqual([
      expect.objectContaining({
        itemType: "COMMANDS",
        details: expect.objectContaining({ commandNames: ["release"] }),
      }),
    ]);
    expect(
      codexMcpResourceReadSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-resource`,
            payload: { server: "docs", uri: "docs://readme" },
          })
        ).json(),
      ),
    ).toEqual({
      contents: [
        {
          type: "text",
          uri: "docs://readme",
          mimeType: "text/markdown",
          text: "# Cantrip",
        },
      ],
    });

    expect(
      codexSkillConfigResultSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${chat.id}/customizations/skill`,
            payload: {
              path: customizationInventory.skills.items[0]!.path,
              enabled: false,
            },
          })
        ).json(),
      ),
    ).toMatchObject({ effectiveEnabled: false });
    expect(
      codexSkillRootsResultSchema.parse(
        (
          await firstApp.inject({
            method: "PUT",
            url: `/api/chats/${chat.id}/customizations/skill-roots`,
            payload: { roots: [".agents/skills"] },
          })
        ).json(),
      ).roots[0],
    ).toMatch(/\.agents\/skills$/u);
    expect(
      codexMcpOauthStartResultSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-oauth`,
            payload: { server: "docs" },
          })
        ).json(),
      ),
    ).toMatchObject({ server: "docs", status: "pending" });
    expect(
      codexMcpOauthStatusSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/customizations/mcp-oauth/status?server=docs`,
          })
        ).json(),
      ).status,
    ).toBe("succeeded");
    expect(
      codexMcpReloadResultSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-reload`,
          })
        ).json(),
      ).reloaded,
    ).toBe(true);
    const importStarted = codexExternalImportStatusSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/customizations/external-import`,
          payload: { itemIds: [externalPreview.items[0]!.id] },
        })
      ).json(),
    );
    expect(importStarted.status).toBe("pending");
    expect(
      codexExternalImportStatusSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/customizations/external-import/status?importId=${importStarted.importId}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      status: "completed",
      results: [{ itemType: "COMMANDS", successCount: 1 }],
    });

    const messagePayload = {
      text: "$skill-creator Persist this message.",
      attachmentIds: [uploadedAttachment.id],
      idempotencyKey: "first-message",
    };
    const firstMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    const repeatedMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    expect(repeatedMessage.id).toBe(firstMessage.id);
    await vi.waitFor(async () => {
      const messages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/messages`,
          })
        ).json(),
      );
      expect(messages).toHaveLength(4);
    });
    expect(turnRequests).toBe(1);
    expect(turnPolicyContexts[0]).toEqual({ policies: [] });
    expect(JSON.stringify(turnPolicyContexts[0])).not.toContain("bodyMarkdown");
    expect(turnSkillNames[0]).toEqual(["skill-creator"]);
    expect(turnAttachmentIds[0]).toEqual([uploadedAttachment.id]);
    expect(firstMessage.content).toContainEqual({
      type: "attachment",
      attachment: uploadedAttachment,
    });
    expect(turnTimeouts).toEqual([null]);
    expect(turnModelIds).toContain(selectedModel.id);
    expect(turnPermissionProfileIds[0]).toBe(":read-only");
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/compact`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(compactRequests).toBe(1);
    const firstSync = agentThreadSyncSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/sync`,
        })
      ).json(),
    );
    expect(firstSync.turns).toHaveLength(1);
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/sync`,
    });
    const completedMessages = chatMessageListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    expect(completedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "8", phase: "final_answer" }],
    });
    expect(
      completedMessages.some((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "commentary",
        ),
      ),
    ).toBe(true);
    expect(
      completedMessages
        .flatMap((message) => message.content)
        .flatMap((content) =>
          content.type === "activity" ? [content.activity.type] : [],
        ),
    ).toEqual(
      expect.arrayContaining(["reasoning", "contextCompaction", "turnSummary"]),
    );
    const renamedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}`,
          payload: { title: "Renamed foundation" },
        })
      ).json(),
    );
    expect(renamedChat.title).toBe("Renamed foundation");
    const forkedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            messageId: completedMessages.at(-1)?.id,
          },
        })
      ).json(),
    );
    const duplicatedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {},
        })
      ).json(),
    );
    expect(
      chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      ),
    ).toHaveLength(completedMessages.length);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${forkedChat.id}/turns`,
        payload: {
          text: "Continue from the fork.",
          idempotencyKey: "fork-follow-up",
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnPrompts).toHaveLength(2));
    expect(turnPolicyContexts[1]).toEqual({ policies: [] });
    expect(turnPrompts[1]).toContain(
      "Continue this existing Cantrip conversation",
    );
    expect(turnPrompts[1]).toContain("The local agent replied.");
    await vi.waitFor(async () => {
      const forkMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      );
      expect(forkMessages).toHaveLength(completedMessages.length + 4);
    });
    const richChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Rich events" },
        })
      ).json(),
    );
    const richLiveEvents: AppLiveServerMessage[] = [];
    let richLiveClient: WebSocket | null = null;
    const richLiveSocket = await firstApp.injectWS(
      "/api/live",
      { headers: { origin: config.appOrigins[0] } },
      {
        onInit(client) {
          richLiveClient = client;
          client.on("message", (data) => {
            richLiveEvents.push(
              appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
            );
          });
        },
      },
    );
    if (!richLiveClient)
      throw new Error("Rich live socket did not initialize.");
    richLiveClient.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "rich-events", name: "Foundation test", version: "1" },
        resume: null,
      }),
    );
    await vi.waitFor(() =>
      expect(richLiveEvents.at(-1)).toMatchObject({ type: "ready" }),
    );
    richLiveClient.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "rich-chat",
        scopes: [{ kind: "chat", chatId: richChat.id }],
      }),
    );
    await vi.waitFor(() =>
      expect(richLiveEvents.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "rich-chat",
      }),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${richChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${richChat.id}/turns`,
      payload: { text: "Render rich events", idempotencyKey: "rich-events" },
    });
    let richMessages = chatMessageListSchema.parse([]);
    await vi.waitFor(async () => {
      richMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${richChat.id}/messages`,
          })
        ).json(),
      );
      expect(richMessages).toHaveLength(7);
    });
    expect(richMessages.map((message) => message.content[0])).toMatchObject([
      { type: "text", text: "Render rich events" },
      { type: "text", phase: "commentary" },
      { type: "activity", activity: { type: "reasoning" } },
      { type: "activity", activity: { type: "mcpToolCall" } },
      { type: "activity", activity: { type: "usage" } },
      { type: "text", phase: "final_answer" },
      { type: "activity", activity: { type: "turnSummary" } },
    ]);
    expect(
      richMessages.filter((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "final_answer",
        ),
      ),
    ).toHaveLength(1);
    await vi.waitFor(() => {
      const streamedMessages = richLiveEvents.filter(
        (event) => event.type === "event" && event.resource === "chat-message",
      );
      expect(streamedMessages).toHaveLength(7);
      expect(
        streamedMessages.map((event) =>
          event.type === "event" ? event.payload : null,
        ),
      ).toEqual(richMessages);
      expect(
        richLiveEvents.some(
          (event) =>
            event.type === "event" &&
            event.resource === "chat" &&
            event.scope.kind === "chat",
        ),
      ).toBe(true);
    });
    richLiveSocket.terminate();
    const projectUsage = projectTokenUsageSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
        })
      ).json(),
    );
    expect(projectUsage.total).toEqual({
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 100,
      totalTokens: 1_100,
    });
    expect(projectUsage.daily.at(-1)).toMatchObject({ totalTokens: 1_100 });
    expect(projectUsage.providers).toContainEqual(
      expect.objectContaining({
        id: provider.id,
        name: "Edited test provider",
        totalTokens: 1_100,
      }),
    );
    expect(projectUsage.models).toContainEqual(
      expect.objectContaining({
        id: selectedModel.id,
        name: "Edited test model",
        totalTokens: 1_100,
      }),
    );
    await firstDatabase.repository.recordTokenUsage(LOCAL_USER_ID, {
      projectId: project.id,
      chatId: richChat.id,
      sourceKey: `chat:${richChat.id}:rich-turn-1`,
      modelRouteId: selectedModel.routes[0]!.id,
      modelName: "Edited test model",
      providerName: "Edited test provider",
      providerModelName: "edited-test-model",
      usage: {
        inputTokens: 850,
        cachedInputTokens: 100,
        outputTokens: 300,
        reasoningOutputTokens: 150,
        totalTokens: 1_300,
      },
    });
    const refreshedProjectUsage = projectTokenUsageSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
        })
      ).json(),
    );
    expect(refreshedProjectUsage.total).toEqual({
      inputTokens: 1_650,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 0,
      outputTokens: 600,
      reasoningOutputTokens: 250,
      totalTokens: 2_250,
    });
    const usageSettings = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(
      usageSettings.providers.find(({ id }) => id === provider.id)?.tokenUsage,
    ).toEqual({
      inputTokens: refreshedProjectUsage.total.inputTokens,
      outputTokens: refreshedProjectUsage.total.outputTokens,
      totalTokens: refreshedProjectUsage.total.totalTokens,
    });
    expect(
      usageSettings.models.find(({ id }) => id === selectedModel.id)
        ?.tokenUsage,
    ).toEqual({
      inputTokens: refreshedProjectUsage.total.inputTokens,
      outputTokens: refreshedProjectUsage.total.outputTokens,
      totalTokens: refreshedProjectUsage.total.totalTokens,
    });
    expect(
      await firstApp.inject({
        method: "GET",
        url: "/api/projects/missing-project/token-usage",
      }),
    ).toMatchObject({ statusCode: 404 });
    const reorderedTerminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: { title: "Sortable shell" },
        })
      ).json(),
    );
    expect(
      scriptCommandListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/terminals/${reorderedTerminal.id}/script-commands`,
          })
        ).json(),
      ),
    ).toEqual([
      expect.objectContaining({
        name: "dev",
        command: "pnpm run dev",
      }),
    ]);
    const explorer = explorerSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/explorers`,
          payload: { title: "Project files" },
        })
      ).json(),
    );
    expect(explorer).toMatchObject({
      selectedPath: null,
      fileMode: "preview",
    });
    expect(
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      explorerDirectorySchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/directory?path=`,
          })
        ).json(),
      ).entries[0],
    ).toMatchObject({ name: "README.md", markdown: true });
    expect(
      explorerDirectoryCommitsSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/directory/commits?path=`,
          })
        ).json(),
      ).entries[0],
    ).toMatchObject({
      path: "README.md",
      tracked: true,
      lastCommit: { subject: "Document Explorer" },
    });
    expect(
      explorerFileSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/file?path=README.md`,
          })
        ).json(),
      ).content,
    ).toContain("Cantrip explorer");
    const mediaResponse = await firstApp.inject({
      method: "GET",
      url: `/api/explorers/${explorer.id}/media?path=preview.png`,
    });
    expect(mediaResponse.statusCode).toBe(200);
    expect(mediaResponse.headers).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(explorerMediaBytes.byteLength),
      "content-type": "image/png",
    });
    expect(mediaResponse.rawPayload).toEqual(explorerMediaBytes);
    const rangedMediaResponse = await firstApp.inject({
      method: "GET",
      url: `/api/explorers/${explorer.id}/media?path=preview.png`,
      headers: { range: "bytes=2-7" },
    });
    expect(rangedMediaResponse.statusCode).toBe(206);
    expect(rangedMediaResponse.headers).toMatchObject({
      "content-length": "6",
      "content-range": `bytes 2-7/${explorerMediaBytes.byteLength}`,
    });
    expect(rangedMediaResponse.rawPayload).toEqual(
      explorerMediaBytes.subarray(2, 8),
    );
    const invalidMediaRangeResponse = await firstApp.inject({
      method: "GET",
      url: `/api/explorers/${explorer.id}/media?path=preview.png`,
      headers: { range: "bytes=999999-" },
    });
    expect(invalidMediaRangeResponse.statusCode).toBe(416);
    expect(invalidMediaRangeResponse.headers["content-range"]).toBe(
      `bytes */${explorerMediaBytes.byteLength}`,
    );
    const explorerWriteVersion = "a".repeat(64);
    expect(
      explorerFileSchema.parse(
        (
          await firstApp.inject({
            method: "PUT",
            url: `/api/explorers/${explorer.id}/file`,
            payload: {
              path: "README.md",
              content: "# Edited in Monaco\n",
              version: explorerWriteVersion,
            },
          })
        ).json(),
      ),
    ).toMatchObject({
      content: "# Edited in Monaco\n",
      version: "b".repeat(64),
    });
    expect(explorerWrites.at(-1)).toEqual({
      path: "README.md",
      content: "# Edited in Monaco\n",
      version: explorerWriteVersion,
    });
    const explorerEditorState = explorerSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/explorers/${explorer.id}/view-state`,
          payload: { selectedPath: "README.md", fileMode: "edit" },
        })
      ).json(),
    );
    expect(explorerEditorState).toMatchObject({
      selectedPath: "README.md",
      fileMode: "edit",
    });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/explorers/${explorer.id}/view-state`,
        payload: { selectedPath: "", fileMode: "source" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      )[0],
    ).toMatchObject({ selectedPath: "README.md", fileMode: "edit" });
    expect(
      explorerSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/explorers/${explorer.id}`,
            payload: { title: "Source browser" },
          })
        ).json(),
      ).title,
    ).toBe("Source browser");
    const browser = browserSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/browsers`,
          payload: { title: "Project web" },
        })
      ).json(),
    );
    expect(
      remoteSurfaceListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: browser.id,
        kind: "browser",
        workerId: "test-worker",
      }),
    );
    expect(
      browserSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/browsers/${browser.id}`,
            payload: { title: "Docs", url: "https://example.com/docs" },
          })
        ).json(),
      ),
    ).toMatchObject({ title: "Docs", url: "https://example.com/docs" });
    expect(
      remoteSurfaceListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/remote-surfaces`,
            })
          ).json(),
        )
        .find(({ id }) => id === browser.id)?.configuration,
    ).toMatchObject({
      kind: "browser",
      initialUrl: "https://example.com/docs",
    });
    const projectView = projectViewSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/views`,
          payload: { kind: "history", title: "History" },
        })
      ).json(),
    );
    expect(
      projectViewSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/project-views/${projectView.id}`,
            payload: { title: "Repository history" },
          })
        ).json(),
      ),
    ).toMatchObject({ kind: "history", title: "Repository history" });
    const remoteDesktop = remoteDesktopSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-desktops`,
          payload: {},
        })
      ).json(),
    );
    expect(remoteDesktop).toMatchObject({
      projectId: project.id,
      workerId: "test-worker",
      status: "idle",
      target: { kind: "monitor", id: null, name: null },
    });
    expect(JSON.stringify(remoteDesktop)).not.toContain("password");
    expect(
      remoteDesktopListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-desktops`,
          })
        ).json(),
      ),
    ).toContainEqual(expect.objectContaining({ id: remoteDesktop.id }));
    const targetedDesktop = remoteDesktopSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/remote-desktops/${remoteDesktop.id}`,
          payload: {
            target: {
              kind: "window",
              id: "window-42",
              application: "Code",
              title: "Cantrip",
            },
          },
        })
      ).json(),
    );
    expect(targetedDesktop.target).toEqual({
      kind: "window",
      id: "window-42",
      application: "Code",
      title: "Cantrip",
    });
    expect(
      projectViewListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/views`,
            })
          ).json(),
        )
        .find(({ id }) => id === remoteDesktop.id),
    ).toMatchObject({ kind: "remote-desktop", title: "Remote Desktop" });
    const initialTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(
      initialTabLayout.groups.every(({ members }) => members.length === 1),
    ).toBe(true);
    expect(
      initialTabLayout.groups.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).toContain(`view:${remoteDesktop.id}`);
    const explorerGroup = initialTabLayout.groups.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `explorer:${explorer.id}`),
    )!;
    const groupedIssuesView = projectViewSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/views`,
          payload: {
            kind: "issues",
            title: "Issues",
            tabGroupId: explorerGroup.id,
          },
        })
      ).json(),
    );
    const groupedTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(groupedTabLayout.groups).toHaveLength(
      initialTabLayout.groups.length,
    );
    expect(
      groupedTabLayout.groups
        .find(({ id }) => id === explorerGroup.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`explorer:${explorer.id}`, `view:${groupedIssuesView.id}`]);
    expect(
      groupedTabLayout.groups.find(({ id }) => id === explorerGroup.id)?.title,
    ).toBe("Source browser");
    const renamedGroupLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/tab-groups/${explorerGroup.id}`,
          payload: {
            revision: groupedTabLayout.revision,
            title: "Research",
          },
        })
      ).json(),
    );
    expect(
      renamedGroupLayout.groups.find(({ id }) => id === explorerGroup.id)
        ?.title,
    ).toBe("Research");
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/project-views/${groupedIssuesView.id}`,
        payload: { title: "Tracker" },
      }),
    ).toMatchObject({ statusCode: 200 });
    const independentlyNamedLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(
      independentlyNamedLayout.groups.find(({ id }) => id === explorerGroup.id),
    ).toMatchObject({
      title: "Research",
      members: [{ title: "Source browser" }, { title: "Tracker" }],
    });
    const reorderedTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/tab-groups/${explorerGroup.id}/members/order`,
          payload: {
            revision: independentlyNamedLayout.revision,
            tabKeys: [
              `view:${groupedIssuesView.id}`,
              `explorer:${explorer.id}`,
            ],
          },
        })
      ).json(),
    );
    expect(
      reorderedTabLayout.groups
        .find(({ id }) => id === explorerGroup.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`view:${groupedIssuesView.id}`, `explorer:${explorer.id}`]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tab-groups/member`,
        payload: {
          revision: groupedTabLayout.revision,
          tabKey: `view:${groupedIssuesView.id}`,
          targetGroupId: null,
          targetMemberPosition: 0,
          targetGroupPosition: 0,
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const splitTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/tab-groups/member`,
          payload: {
            revision: reorderedTabLayout.revision,
            tabKey: `view:${groupedIssuesView.id}`,
            targetGroupId: null,
            targetMemberPosition: 0,
            targetGroupPosition: 0,
          },
        })
      ).json(),
    );
    expect(splitTabLayout.groups[0]?.members).toMatchObject([
      { tabKey: `view:${groupedIssuesView.id}`, title: "Tracker" },
    ]);
    expect(splitTabLayout.groups[0]?.title).toBe("Tracker");
    expect(
      splitTabLayout.groups.find(({ id }) => id === explorerGroup.id)?.title,
    ).toBe("Source browser");
    const reorderedGroupsLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/tab-groups/order`,
          payload: {
            revision: splitTabLayout.revision,
            groupIds: splitTabLayout.groups.map(({ id }) => id).reverse(),
          },
        })
      ).json(),
    );
    expect(reorderedGroupsLayout.groups.map(({ id }) => id)).toEqual(
      splitTabLayout.groups.map(({ id }) => id).reverse(),
    );
    const mergedTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/tab-groups/member`,
          payload: {
            revision: reorderedGroupsLayout.revision,
            tabKey: `view:${groupedIssuesView.id}`,
            targetGroupId: explorerGroup.id,
            targetMemberPosition: 1,
          },
        })
      ).json(),
    );
    expect(
      mergedTabLayout.groups.find(({ id }) => id === explorerGroup.id),
    ).toMatchObject({
      anchorTabKey: `explorer:${explorer.id}`,
      title: "Source browser",
      members: [
        { tabKey: `explorer:${explorer.id}` },
        { tabKey: `view:${groupedIssuesView.id}` },
      ],
    });
    const concurrentOrders = await Promise.all([
      firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tab-groups/order`,
        payload: {
          revision: mergedTabLayout.revision,
          groupIds: mergedTabLayout.groups.map(({ id }) => id),
        },
      }),
      firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tab-groups/order`,
        payload: {
          revision: mergedTabLayout.revision,
          groupIds: mergedTabLayout.groups.map(({ id }) => id).reverse(),
        },
      }),
    ]);
    expect(concurrentOrders.map(({ statusCode }) => statusCode).sort()).toEqual(
      [200, 409],
    );
    let resolveDesktopReady: ((message: unknown) => void) | null = null;
    const desktopReadyPromise = new Promise<unknown>((resolve) => {
      resolveDesktopReady = resolve;
    });
    const desktopSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteDesktop.id}/connect`,
      { headers: { origin: "http://127.0.0.1:5173" } },
      {
        onInit(socket) {
          socket.once("message", (data) =>
            resolveDesktopReady?.(JSON.parse(data.toString())),
          );
        },
      },
    );
    expect(
      remoteSurfaceConnectionMessageSchema.parse(await desktopReadyPromise),
    ).toMatchObject({ type: "ready", surfaceId: remoteDesktop.id });
    expect(surfaceAttachCommands.at(-1)?.desktopStream).toEqual({
      targetFps: 60,
      quality: "balanced",
    });
    expect(surfaceAttachCommands.at(-1)?.configuration).toMatchObject({
      kind: "desktop",
      target: { kind: "window", application: "Code", title: "Cantrip" },
    });
    desktopSocket.terminate();
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-views/${remoteDesktop.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      projectTabLayoutSummarySchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/tab-groups`,
            })
          ).json(),
        )
        .groups.some(({ members }) =>
          members.some(({ tabKey }) => tabKey === `view:${remoteDesktop.id}`),
        ),
    ).toBe(false);
    const consoleFirstChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Console-first chat" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${consoleFirstChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    const consoleFirstTerminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${consoleFirstChat.id}/console`,
        })
      ).json(),
    );
    expect(consoleFirstTerminal.linkedChatId).toBe(consoleFirstChat.id);
    expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        consoleFirstChat.id,
      ),
    ).toMatchObject({
      modelId: selectedModel.id,
      threadId: "codex-console-thread-1",
    });
    await firstApp.inject({
      method: "DELETE",
      url: `/api/terminals/${consoleFirstTerminal.id}`,
    });
    await firstApp.inject({
      method: "DELETE",
      url: `/api/chats/${consoleFirstChat.id}`,
    });
    const linkedConsole = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
        })
      ).json(),
    );
    expect(linkedConsole).toMatchObject({
      linkedChatId: chat.id,
      projectId: project.id,
      title: "Codex console",
    });
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/console`,
          })
        ).json(),
      ).id,
    ).toBe(linkedConsole.id);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/terminals/${linkedConsole.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/chats/${duplicatedChat.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/projects/order",
        payload: { ids: [project.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const changedModelResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(changedModelResponse.statusCode).toBe(200);
    expect(chatSummarySchema.parse(changedModelResponse.json()).modelId).toBe(
      selectedModel.id,
    );
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: {
          text: "Use the newly selected model.",
          idempotencyKey: "dynamic-model-turn",
          modelId: selectedModel.id,
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnModelIds).toHaveLength(3));
    expect(turnModelIds.at(-1)).toBe(selectedModel.id);

    const queueChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Prompt queue" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    const queuedAttachment = chatAttachmentSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/attachments`,
          headers: {
            "content-type": "application/octet-stream",
            "x-cantrip-file-name": encodeURIComponent("queued.txt"),
            "x-cantrip-mime-type": "text/plain",
            "x-cantrip-attachment-kind": "text",
            "x-cantrip-attachment-source": "file",
          },
          payload: Buffer.from("queued attachment"),
        })
      ).json(),
    );
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${queueChat.id}/turns`,
      payload: { text: "Hold queue open.", idempotencyKey: "queue-running" },
    });
    await vi.waitFor(() => expect(releaseHeldTurn).not.toBeNull());
    expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ),
    ).toMatchObject({ status: "running", threadId: null });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/interrupt`,
        })
      ).json(),
    ).toEqual({ interrupted: true });
    expect(interruptCommands.at(-1)).toMatchObject({
      chatId: queueChat.id,
      threadId: null,
    });

    const firstQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: {
            text: "First follow-up",
            attachmentIds: [queuedAttachment.id],
            idempotencyKey: "queued-first",
          },
        })
      ).json().prompt,
    );
    expect(firstQueued.attachments).toEqual([queuedAttachment]);
    const secondQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: {
            text: "Second follow-up",
            mode: "plan",
            idempotencyKey: "queued-second",
          },
        })
      ).json().prompt,
    );
    expect(
      queuedPromptListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/chats/${queueChat.id}/queue`,
            })
          ).json(),
        )
        .map(({ id }) => id),
    ).toEqual([firstQueued.id, secondQueued.id]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/chats/${queueChat.id}/queue/order`,
        payload: { ids: [secondQueued.id, firstQueued.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const editedQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/queued-prompts/${secondQueued.id}`,
          payload: { text: "Edited second follow-up", frozen: true },
        })
      ).json(),
    );
    expect(editedQueued).toMatchObject({
      id: secondQueued.id,
      position: 0,
      frozen: true,
      mode: "plan",
      text: "Edited second follow-up",
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/queued-prompts/${secondQueued.id}/steer`,
      }),
    ).toMatchObject({ statusCode: 409 });
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${firstQueued.id}`,
      payload: { frozen: true },
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/queued-prompts/${firstQueued.id}/steer`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(steeredPrompts).toContain("First follow-up");
    expect(steeredAttachmentIds).toContainEqual([queuedAttachment.id]);

    expect(
      chatPauseStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${queueChat.id}/pause`,
            payload: { paused: true },
          })
        ).json(),
      ),
    ).toEqual({ paused: true });
    expect(pauseCommands.at(-1)).toEqual({
      chatId: queueChat.id,
      paused: true,
    });

    const turnsBeforeRelease = turnRequests;
    releaseHeldTurn?.();
    releaseHeldTurn = null;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${secondQueued.id}`,
      payload: { frozen: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    expect(
      chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === queueChat.id),
    ).toMatchObject({ automationPaused: true, status: "idle" });
    expect(
      chatPauseStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${queueChat.id}/pause`,
            payload: { paused: false },
          })
        ).json(),
      ),
    ).toEqual({ paused: false });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Edited second follow-up"),
    );
    await vi.waitFor(async () => {
      const remaining = queuedPromptListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${queueChat.id}/queue`,
          })
        ).json(),
      );
      expect(remaining).toHaveLength(0);
    });
    expect(
      chatMessageListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/chats/${queueChat.id}/messages`,
            })
          ).json(),
        )
        .find((message) =>
          message.content.some(
            (item) =>
              item.type === "text" && item.text === "Edited second follow-up",
          ),
        )?.mode,
    ).toBe("plan");

    const routedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "Priority model",
            routes: [
              {
                providerId: chatGptProvider.id,
                modelName: "gpt-primary",
                enabled: true,
              },
              {
                providerId: provider.id,
                modelName: "gpt-fallback",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    expect(routedModel.routes).toMatchObject([
      { providerId: chatGptProvider.id, position: 0 },
      { providerId: provider.id, position: 1 },
    ]);

    authUsageByCredentialHomeKey.set(chatGptProvider.id, 98);
    authUsageByCredentialHomeKey.set(additionalAccount.id, 37);
    await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 98,
    });
    await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      additionalAccount.id,
      protectedProviderCredentialFixture("D"),
      providerCredentialMetadataFixture(),
    );
    await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: additionalAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 37,
    });
    const pooledChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "ChatGPT account routing" },
        })
      ).json(),
    );
    const pooledTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: {
        text: "Use the account with healthy weekly usage.",
        idempotencyKey: "pooled-account-turn",
        modelId: routedModel.id,
      },
    });
    expect(pooledTurn.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(additionalAccount.id),
    );
    expect(turnCredentialHomeKeys.at(-1)).toBe(additionalAccount.id);
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            pooledChat.id,
          )
        )?.status,
      ).toBe("idle");
    });
    expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        pooledChat.id,
      ),
    ).toMatchObject({ providerAccountId: additionalAccount.id });

    const stickyTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: {
        text: "Continue on the current account.",
        idempotencyKey: "pooled-account-sticky-turn",
        modelId: routedModel.id,
      },
    });
    expect(stickyTurn.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(additionalAccount.id),
    );
    expect(turnThreadIds.at(-1)).toBe("codex-thread-1");
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            pooledChat.id,
          )
        )?.status,
      ).toBe("idle");
    });

    authUsageByCredentialHomeKey.set(chatGptProvider.id, 50);
    authUsageByCredentialHomeKey.set(additionalAccount.id, 98);
    await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 50,
    });
    await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: additionalAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 98,
    });
    const switchedTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: {
        text: "Move past the account below reserve.",
        idempotencyKey: "pooled-account-switch-turn",
        modelId: routedModel.id,
      },
    });
    expect(switchedTurn.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(
        chatGptProvider.accounts[0]!.id,
      ),
    );
    expect(turnCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    expect(turnThreadIds.at(-1)).toBeNull();
    expect(turnPrompts.at(-1)).toContain(
      "Continue this existing Cantrip conversation. The server-owned history follows:",
    );
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            pooledChat.id,
          )
        )?.status,
      ).toBe("idle");
    });
    authUsageByCredentialHomeKey.clear();

    const grokModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "Grok subscription model",
            routes: [
              {
                providerId: grokProvider.id,
                modelName: "grok-4",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    const grokChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Grok account routing" },
        })
      ).json(),
    );
    const grokTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${grokChat.id}/turns`,
      payload: {
        text: "Use the SuperGrok subscription.",
        idempotencyKey: "grok-account-turn",
        modelId: grokModel.id,
      },
    });
    expect(grokTurn.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(turnProviderIds.at(-1)).toBe(grokProvider.id),
    );
    expect(turnProviderAccountIds.at(-1)).toBe(grokProvider.accounts[0]!.id);
    expect(turnCredentialHomeKeys.at(-1)).toBe(grokProvider.id);
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            grokChat.id,
          )
        )?.status,
      ).toBe("idle");
    });

    exhaustedProviderIds.add(chatGptProvider.id);
    for (const accountId of [primaryChatGptAccount.id, additionalAccount.id]) {
      await firstDatabase.repository.recordModelProviderAccountUsage({
        accountId,
        ownerId: LOCAL_USER_ID,
        planType: "plus",
        providerId: chatGptProvider.id,
        resetsAt: null,
        usedPercent: 100,
      });
    }
    const routedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Provider failover" },
        })
      ).json(),
    );
    const routedTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${routedChat.id}/turns`,
      payload: {
        text: "Use the first available provider.",
        idempotencyKey: "priority-route-turn",
        modelId: routedModel.id,
      },
    });
    expect(routedTurn.statusCode).toBe(202);
    expect(chatMessageSchema.parse(routedTurn.json().message)).toMatchObject({
      modelId: routedModel.id,
      modelRouteId: routedModel.routes[1]?.id,
      providerId: provider.id,
      providerModelName: "gpt-fallback",
    });
    await vi.waitFor(() => expect(turnProviderIds.at(-1)).toBe(provider.id));
    expect(turnRouteIds.at(-1)).toBe(routedModel.routes[1]?.id);

    const planChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Deployment plan" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${planChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    const planTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${planChat.id}/turns`,
      payload: {
        text: "Draft a deployment plan",
        mode: "plan",
        idempotencyKey: "plan-turn",
        modelId: selectedModel.id,
      },
    });
    expect(planTurn.statusCode).toBe(202);
    expect(chatMessageSchema.parse(planTurn.json().message).mode).toBe("plan");
    await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("plan"));
    const pendingPlan = await vi.waitFor(async () => {
      const state = chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${planChat.id}/plan`,
          })
        ).json(),
      );
      expect(state.question?.id).toBe("plan-question-1");
      return state;
    });
    expect(pendingPlan.steps).toMatchObject([
      { status: "completed" },
      { status: "inProgress" },
    ]);
    expect(
      chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${planChat.id}/plan`,
          })
        ).json(),
      ).question?.id,
    ).toBe("plan-question-1");
    expect(
      chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === planChat.id)?.hasPendingPlanQuestion,
    ).toBe(true);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${planChat.id}/plan/answer`,
          payload: { answers: { topology: ["Four nodes"] } },
        })
      ).json(),
    ).toEqual({ accepted: true });
    expect(
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      ),
    ).toMatchObject({
      status: "resolved",
      response: {
        kind: "userInput",
        answers: { topology: { answers: ["Four nodes"] } },
      },
    });
    await vi.waitFor(async () => {
      const current = chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === planChat.id);
      expect(current).toMatchObject({
        status: "idle",
        planMode: "plan",
        hasPendingPlanQuestion: false,
      });
    });
    const defaultTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${planChat.id}/turns`,
      payload: {
        text: "Implement the approved plan",
        idempotencyKey: "default-after-plan",
        modelId: selectedModel.id,
      },
    });
    expect(defaultTurn.statusCode).toBe(202);
    expect(chatMessageSchema.parse(defaultTurn.json().message).mode).toBe(
      "default",
    );
    await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("default"));
    expect(
      chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${planChat.id}/plan`,
          })
        ).json(),
      ).mode,
    ).toBe("default");

    const goalChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Long-running goal" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${goalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/goal`,
          })
        ).json(),
      ).goal,
    ).toBeNull();
    const goalTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${goalChat.id}/turns`,
      payload: {
        text: "Finish the long-running goal",
        mode: "goal",
        idempotencyKey: "goal-mode-turn",
        modelId: selectedModel.id,
      },
    });
    expect(goalTurn.statusCode).toBe(202);
    expect(chatMessageSchema.parse(goalTurn.json().message).mode).toBe("goal");
    const createdGoal = await vi.waitFor(async () => {
      const goal = chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/goal`,
          })
        ).json(),
      ).goal;
      expect(goal).not.toBeNull();
      return goal;
    });
    expect(createdGoal).toMatchObject({
      objective: "Finish the long-running goal",
      status: "active",
      tokenBudget: null,
    });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Finish the long-running goal"),
    );
    await vi.waitFor(async () => {
      const goalMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/messages`,
          })
        ).json(),
      );
      expect(goalMessages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Finished the first goal milestone.",
              phase: "final_answer",
            },
          ],
        }),
      );
    });
    await vi.waitFor(async () => {
      const current = chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === goalChat.id);
      expect(current?.status).toBe("idle");
    });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${goalChat.id}/goal`,
            payload: { status: "paused" },
          })
        ).json(),
      ).goal?.status,
    ).toBe("paused");
    const turnsBeforeGoalResume = turnRequests;
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${goalChat.id}/goal`,
            payload: { status: "active" },
          })
        ).json(),
      ).goal?.status,
    ).toBe("active");
    await vi.waitFor(() =>
      expect(turnRequests).toBe(turnsBeforeGoalResume + 1),
    );
    expect(turnPrompts.at(-1)).toContain("Continue working toward");
    expect(turnPolicyContexts).toHaveLength(turnRequests);
    expect(
      turnPolicyContexts.every((context) => context.policies.length === 0),
    ).toBe(true);
    expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/chats/${goalChat.id}/goal`,
        })
      ).json(),
    ).toEqual({ cleared: true });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/goal`,
          })
        ).json(),
      ).goal,
    ).toBeNull();

    deliveredAgentInteractionResponses.length = 0;
    const bridgedApprovalChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Bridged approval" },
        })
      ).json(),
    );
    const approvalLiveEvents: AppLiveServerMessage[] = [];
    let approvalLiveClient: WebSocket | null = null;
    const approvalLiveSocket = await firstApp.injectWS(
      "/api/live",
      { headers: { origin: config.appOrigins[0] } },
      {
        onInit(client) {
          approvalLiveClient = client;
          client.on("message", (data) => {
            approvalLiveEvents.push(
              appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
            );
          });
        },
      },
    );
    if (!approvalLiveClient) {
      throw new Error("Approval live socket did not initialize.");
    }
    approvalLiveClient.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "approval", name: "Foundation test", version: "1" },
        resume: null,
      }),
    );
    await vi.waitFor(() =>
      expect(approvalLiveEvents.at(-1)).toMatchObject({ type: "ready" }),
    );
    approvalLiveClient.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "approval-chat",
        scopes: [{ kind: "chat", chatId: bridgedApprovalChat.id }],
      }),
    );
    await vi.waitFor(() =>
      expect(approvalLiveEvents.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "approval-chat",
      }),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${bridgedApprovalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${bridgedApprovalChat.id}/turns`,
          payload: {
            text: "Request a command approval",
            idempotencyKey: "bridged-approval-turn",
            modelId: selectedModel.id,
          },
        })
      ).statusCode,
    ).toBe(202);
    const bridgedApproval = await vi.waitFor(async () => {
      const pending = agentInteractionRequestListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests?chatId=${bridgedApprovalChat.id}&status=pending`,
          })
        ).json(),
      );
      expect(pending).toHaveLength(1);
      return pending[0]!;
    });
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          bridgedApprovalChat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    expect(deliveredAgentInteractionResponses).toEqual([]);
    await vi.waitFor(() =>
      expect(
        approvalLiveEvents.filter(
          (event) =>
            event.type === "event" && event.resource === "agent-interaction",
        ),
      ).toHaveLength(1),
    );
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/agent-requests/${bridgedApproval.id}/respond`,
            payload: {
              idempotencyKey: "bridged-resolution-1",
              response: {
                kind: "commandExecution",
                decision: "decline",
              },
            },
          })
        ).json(),
      ).status,
    ).toBe("resolved");
    expect(deliveredAgentInteractionResponses).toEqual([
      {
        kind: "commandExecution",
        decision: "decline",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      },
    ]);
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            bridgedApprovalChat.id,
          )
        )?.status,
      ).toBe("idle");
    });
    await vi.waitFor(() =>
      expect(
        approvalLiveEvents.filter(
          (event) =>
            event.type === "event" && event.resource === "agent-interaction",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    approvalLiveSocket.terminate();

    await firstDatabase.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "test-worker-secondary",
      name: "Secondary Worker",
      platform: "linux",
      architecture: "x64",
      codexVersion: "codex-cli 1.0.0",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: "2026-08-07T12:00:00.000Z",
    });
    const secondaryPath = path.join(
      dataDirectory,
      "secondary-repositories",
      "Cantrip",
    );
    const completedSecondary =
      await firstDatabase.repository.completeGithubProjectSetup(
        LOCAL_USER_ID,
        project.id,
        "test-worker-secondary",
        {
          path: secondaryPath,
          displayPath: "Secondary/ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        },
      );
    expect(completedSecondary?.replicas).toHaveLength(2);
    await firstDatabase.repository.reconcileProjectWorktrees(
      LOCAL_USER_ID,
      project.id,
      "test-worker-secondary",
      {
        sourcePath: secondaryPath,
        primaryPath: secondaryPath,
        gitCommonDir: path.join(secondaryPath, ".git"),
        managedRoot: path.join(dataDirectory, "secondary-worktrees"),
        repositoryFingerprint: "b".repeat(64),
        worktrees: [
          {
            path: secondaryPath,
            head: "2".repeat(40),
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: false,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
        ],
      },
    );
    const replicatedProjects = projectWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    expect(replicatedProjects).toHaveLength(1);
    const replicatedProject = replicatedProjects[0]!;
    expect(replicatedProject.source?.workerId).toBe("test-worker");
    expect(replicatedProject.replicas).toHaveLength(2);
    const replicas = projectReplicaListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/replicas`,
        })
      ).json(),
    );
    expect(replicas.map(({ workerId }) => workerId)).toEqual([
      "test-worker",
      "test-worker-secondary",
    ]);
    expect(
      workerManagementListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: "/api/workers/management",
            })
          ).json(),
        )
        .find(({ workerId }) => workerId === "test-worker-secondary")?.sources,
    ).toEqual([
      expect.objectContaining({
        projectId: project.id,
        projectReplicaId: replicas[1]!.id,
      }),
    ]);
    expect(
      projectReplicaSummarySchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/replicas/${replicas[1]!.id}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      projectId: project.id,
      workerId: "test-worker-secondary",
      workerName: "Secondary Worker",
      repositoryFingerprint: "b".repeat(64),
      branch: "main",
      head: "2".repeat(40),
      ready: true,
      worktreeCount: 1,
    });

    const layoutBeforeRestart = projectTabLayoutSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    await firstApp.close();

    const secondDatabase = await connectDatabase(config);
    const secondApp = await buildApp({
      config,
      database: secondDatabase,
      logger: false,
      workerBridge,
    });

    const projects = projectWireListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    const workers = workerListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/workers" })).json(),
    );
    const restoredSettings = settingsBundleSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    const messages = chatMessageListSchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    const restoredRichMessages = chatMessageListSchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/chats/${richChat.id}/messages`,
        })
      ).json(),
    );

    expect(projects).toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(workers[0]?.codexRuntime).toEqual(unprobedCodexRuntimeReport);
    const restoredTabLayout = projectTabLayoutSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(restoredTabLayout).toEqual(layoutBeforeRestart);
    expect(messages.slice(0, 4)).toMatchObject([
      firstMessage,
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "command",
              status: "completed",
              command: "pwd",
              output: "/worktree\n",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "fileChange",
              status: "completed",
              changes: [{ path: "README.md", kind: "update" }],
            },
          },
        ],
      },
      { role: "assistant", content: [{ text: "The local agent replied." }] },
    ]);
    expect(restoredRichMessages).toHaveLength(7);
    expect(restoredRichMessages[2]?.content[0]).toMatchObject({
      type: "activity",
      activity: {
        type: "reasoning",
        correlation: {
          sourceMethod: "item/completed",
          diagnosticId: "runtime-session:reasoning-1",
        },
      },
    });
    expect(restoredSettings.preferences).toEqual({
      theme: "dark",
      highContrast: true,
      proMode: true,
      proModeOpacity: 64,
      eliteMode: true,
      eliteRevealConfig: {
        glitchCountMax: 2,
        glitchCountMin: 2,
        glitchShowMs: 12,
        staggerSpreadMs: 40,
        variants: ["chromatic", "scanline"],
      },
      sidebarWidth: 352,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
      defaultPermissionProfileId: ":read-only",
      defaultWorkerId: "test-worker",
      automaticReplicaProvisioning: true,
      automaticReplicaSynchronization: "fast-forward-primary",
      mobileProjectTabConfigurations: {
        "project-1": ["group-1", null],
        "project-2": ["group-2"],
      },
    });
    expect(
      explorerListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: explorer.id, title: "Source browser" }]);
    expect(
      browserListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([
      { id: browser.id, title: "Docs", url: "https://example.com/docs" },
    ]);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/browsers/${browser.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const layoutAfterBrowserDelete = projectTabLayoutSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(
      layoutAfterBrowserDelete.groups.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).not.toContain(`browser:${browser.id}`);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const layoutAfterSurfaceDeletes = projectTabLayoutSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tab-groups`,
        })
      ).json(),
    );
    expect(
      layoutAfterSurfaceDeletes.groups.find(({ members }) =>
        members.some(({ tabKey }) => tabKey === `view:${groupedIssuesView.id}`),
      ),
    ).toMatchObject({
      anchorTabKey: `view:${groupedIssuesView.id}`,
      title: "Tracker",
      members: [{ tabKey: `view:${groupedIssuesView.id}` }],
    });
    expect(
      layoutAfterSurfaceDeletes.groups.map(({ position }) => position),
    ).toEqual(layoutAfterSurfaceDeletes.groups.map((_, position) => position));

    const unlinkResponse = await secondApp.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: false },
    });
    expect(unlinkResponse.statusCode).toBe(204);
    expect(deletedProjectPaths).toEqual([]);
    expect(
      projectWireListSchema.parse(
        (
          await secondApp.inject({ method: "GET", url: "/api/projects" })
        ).json(),
      ),
    ).toEqual([]);

    const queuedRelinked = projectWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "POST",
          url: "/api/projects/from-github",
          payload: {
            ...protectedProjectFields(),
            workerId: "test-worker",
            repositoryId: "github-repository-1",
            nameWithOwner: "ArcaneArts/Cantrip",
            url: "https://github.com/ArcaneArts/Cantrip",
          },
        })
      ).json(),
    );
    const relinked = await vi.waitFor(async () => {
      const current = projectWireListSchema
        .parse(
          (
            await secondApp.inject({ method: "GET", url: "/api/projects" })
          ).json(),
        )
        .find((candidate) => candidate.id === queuedRelinked.id);
      expect(current?.setupStatus).toBe("ready");
      return current!;
    });
    await secondDatabase.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      relinked.id,
      "test-worker-secondary",
      {
        path: secondaryPath,
        displayPath: "Secondary/ArcaneArts/Cantrip",
        reused: false,
        updated: false,
        warning: null,
      },
    );
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/projects/${relinked.id}`,
        payload: { deleteLocalFiles: true },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(deletedProjectPaths).toEqual([
      path.join(dataDirectory, "repositories", "Cantrip"),
      secondaryPath,
    ]);

    await secondApp.close();
  }, 15_000);
});
