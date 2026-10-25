import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  encryptChatMessageProtectedContent,
  decryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
  decryptQueuedPromptProtectedContent,
} from "../../packages/crypto/src/communication-content.js";
import { chatMessageOpaqueSummarySchema } from "@cantrip/protocol/communication-content";
import {
  attachmentContentDigest,
  encryptAttachmentMetadata,
  decryptAttachmentMetadata,
  encryptAttachmentChunk,
  decryptAttachmentChunk,
} from "../../packages/crypto/src/attachment-content.js";
import {
  attachmentDownloadOpaqueSchema,
  chatAttachmentOpaqueSummarySchema,
} from "@cantrip/protocol/attachment-content";
import {
  encryptSurfacePrivateState,
  decryptSurfacePrivateState,
} from "../../packages/crypto/src/surface-private-state.js";
import {
  decryptRepositoryOperationPayload,
  encryptRepositoryOperationPayload,
} from "../../packages/crypto/src/repository-operation.js";
import {
  repositoryOperationAccess,
  repositoryOperationOutcomeContentSchema,
  repositoryOperationRequestContentSchema,
  repositoryOperationWireResponseSchema,
  repositoryMetadataValuesSchema,
  repositoryMetadataResultSchema,
  type RepositoryOperationType,
} from "@cantrip/protocol/repository-operation";

import {
  agentInteractionRequestListSchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestWireSchema,
  nativeCommandAdmissionSchema,
  nativeSettingsUpdateReceiptSchema,
  type NativeSettingsEvidence,
  agentInteractionRequestSchema,
  agentThreadSyncSchema,
  appLiveServerMessageSchema,
  browserWireSummarySchema,
  browserWireListSchema,
  customizationContentScopeSchema,
  chatAttachmentSummarySchema,
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  chatWireListSchema,
  chatGoalResponseSchema,
  chatMessageListSchema,
  chatMessageWireListSchema,
  chatMessageSchema,
  chatMessageContentSchema,
  chatPauseStateSchema,
  chatPermissionProfileStateSchema,
  chatPlanStateSchema,
  encryptedChatPlanWireStateSchema,
  chatWireSummarySchema,
  codeTabWireListSchema,
  codeTabWireSummarySchema,
  explorerDirectorySchema,
  explorerDirectoryCommitsSchema,
  explorerFileSchema,
  explorerMediaFileChunkSchema,
  explorerWireSummarySchema,
  explorerWireListSchema,
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
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutResultSchema,
  githubPullRequestCheckoutPreparedSchema,
  projectWorktreeSummarySchema,
  githubPullRequestDetailSchema,
  githubPullRequestListSchema,
  githubPullRequestLifecyclePreviewSchema,
  modelProfileSummarySchema,
  modelProviderAccountWireListSchema,
  modelProviderWireSummarySchema,
  projectWireListSchema,
  projectReplicaJobListSchema,
  projectReplicaListSchema,
  projectReplicaSummarySchema,
  projectShareAttachmentWireSchema,
  projectWireSummarySchema,
  projectTokenUsageSchema,
  projectTabLayoutWireSummarySchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  projectViewWireListSchema,
  projectViewWireSummarySchema,
  encryptedQueuedPromptSchema,
  encryptedQueuedPromptListSchema,
  queuedPromptSchema,
  remoteDesktopWireListSchema,
  remoteDesktopWireSummarySchema,
  remoteSurfaceWireListSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceWireSummarySchema,
  serverBootstrapSchema,
  settingsBundleWireSchema,
  protectedScriptCommandListSchema,
  protectedCustomizationResponseSchema,
  protectedCustomizationRequestSchema,
  terminalWireListSchema,
  terminalWireSummarySchema,
  tunnelWireListSchema,
  unprobedCodexRuntimeReport,
  workerListSchema,
  workerManagementListSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequestCreate,
  AppLiveServerMessage,
  PlanMode,
  ThreadGoal,
  WorkerCommand,
} from "@cantrip/protocol";
import type {
  CustomizationContentOperation,
  CustomizationContentScope,
} from "@cantrip/protocol/customization-content";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.js";
import {
  openEncryptedChatTurn,
  protectChatTurn,
  encryptChatTurnResult,
  EncryptedChatEventSealer,
} from "../../cantrip_worker/src/chat-message-encryption.js";
import { openChatPlanState } from "../../cantrip_worker/src/chat-plan-encryption.js";
import {
  protectAgentInteractionRequest,
  protectAgentInteractionResponse,
  openAgentInteractionResponse,
} from "../../cantrip_worker/src/interaction-encryption.js";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { readExplorerMediaFile } from "../../cantrip_worker/src/explorer.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../../cantrip_worker/src/surface-stream-encryption.js";
import {
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  type ExplorerOperationRequestContent,
} from "@cantrip/protocol/surface-stream";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { effectivePermissionProfile } from "../src/chats/execution-helpers.js";
import { settingsEnvelope } from "./native-settings-repository-fixture.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import {
  protectedProjectFields,
  protectedDisplayLabelFields,
  protectedBrowserRemoteSurfaceFields,
  protectedTerminalFields,
  protectedExplorerFields,
  protectedChatFields,
} from "./private-label-fixture.js";
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

const protectedScriptCommands = {
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

function protectedProviderAccount() {
  return {
    id: randomUUID(),
    protectedLabel: protectedProjectFields().nameProtection.protectedLabel,
  };
}

const protectedCustomizationContent = {
  ...protectedScriptCommands,
  domain: "customization-content" as const,
};

function protectedCustomizationResponse(
  operationId: string,
  operation: CustomizationContentOperation,
  scope: CustomizationContentScope,
  lifecycle: "pending" | "completed" | "unknown" | null = null,
) {
  return protectedCustomizationResponseSchema.parse({
    operationId,
    operation,
    scope,
    result: "succeeded",
    lifecycle,
    protectedResponse: protectedCustomizationContent,
  });
}

function protectedCustomizationRequest(
  operationId: string,
  operation: CustomizationContentOperation,
  scope: CustomizationContentScope,
) {
  return protectedCustomizationRequestSchema.parse({
    operationId,
    operation,
    scope,
    protectedRequest: protectedCustomizationContent,
  });
}

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
type QueuedNativeCommand = Extract<
  WorkerCommand,
  {
    type: "chat.turn" | "chat.steer" | "chat.native-control";
  }
>;
let beginQueuedNativeCommand:
  | ((
      command: QueuedNativeCommand,
    ) => Promise<(() => Promise<void>) | undefined>)
  | undefined;
const pauseCommands: Array<{ chatId: string; paused: boolean }> = [];
const interruptCommands: Array<
  Extract<WorkerCommand, { type: "chat.interrupt" | "chat.native-control" }>
> = [];
const explorerWrites: Array<{
  content: string;
  path: string;
  version: string;
}> = [];
const explorerMediaBytes = Buffer.alloc(256 * 1_024 + 14, 0x5a);
for (let index = 0; index < explorerMediaBytes.length; index += 1) {
  explorerMediaBytes[index] = index % 251;
}
await writeFile(path.join(dataDirectory, "preview.png"), explorerMediaBytes);
const explorerMediaModifiedAt = "2026-08-07T12:00:00.000Z";
const terminalServiceReconciliations: Array<
  Extract<WorkerCommand, { type: "terminal.services.reconcile" }>
> = [];
const terminalServiceRestarts: string[] = [];
const closedTerminalIds: string[] = [];
let codexGoal: ThreadGoal | null = null;
const goalUpdateCommands: Array<
  Extract<WorkerCommand, { type: "chat.goal.update" }>
> = [];
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
  cursor: string | null;
  limit: number;
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
    nodeId: `PR_${number}`,
    viewerLogin: "cantrip-test",
    pendingReview: null,
    autoMerge: null,
    mergeQueueEnabled: true,
    mergeQueueEntry: null,
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
const attachmentUploads = new Map<
  string,
  { chunks: Buffer[]; fileName: string; sizeBytes: number; sha256: string }
>();
const attachmentFiles = new Map<string, Buffer>();
const surfaceFrameListeners = new Set<
  (
    header: Parameters<WorkerCommandBus["sendSurfaceFrame"]>[1],
    payload: Uint8Array,
  ) => void
>();
let releaseHeldTurn: (() => void) | null = null;
let heldTurnCommand: Extract<WorkerCommand, { type: "chat.turn" }> | null =
  null;
let heldProjectCloneName: string | null = null;
let releaseProjectClone: (() => void) | null = null;
// Only the simulated client and worker hold this key; the HTTP server relays
// opaque payloads and must not learn the repository arguments or result.
const repositoryComponentKey = randomBytes(32);
const chatComponentKey = randomBytes(32);
const chatProtection = {
  ownerId: LOCAL_USER_ID,
  keyRevision: 1,
  componentKey: chatComponentKey,
};
async function openQueuedPrompt(value: unknown) {
  const wire = encryptedQueuedPromptSchema.parse(value);
  const content = await decryptQueuedPromptProtectedContent({
    ...chatProtection,
    promptId: wire.id,
    encrypted: wire.protectedContent,
    publicClassification: wire.classification,
  });
  const attachments = await Promise.all(
    wire.attachments.map(async (attachment) =>
      chatAttachmentSummarySchema.parse({
        ...attachment,
        ...(await decryptAttachmentMetadata({
          ...attachmentProtection,
          chatId: wire.chatId,
          attachmentId: attachment.id,
          encrypted: attachment.protectedMetadata,
        })),
      }),
    ),
  );
  return queuedPromptSchema.parse({
    ...wire,
    ...content.classification,
    text: content.text,
    attachments,
  });
}
const chatEncryptionService = await WorkerEncryptionService.open({
  dataDirectory: path.join(dataDirectory, "chat-encryption"),
  serverUrl: "http://127.0.0.1:4310",
  workerId: "local-foundation-worker",
});
vi.spyOn(chatEncryptionService, "ownerId").mockReturnValue(LOCAL_USER_ID);
vi.spyOn(chatEncryptionService, "componentKey").mockImplementation(() => ({
  key: Uint8Array.from(chatComponentKey),
  keyRevision: 1,
}));
const surfaceComponentKey = randomBytes(32);
const surfaceEncryptionService = await WorkerEncryptionService.open({
  dataDirectory: path.join(dataDirectory, "surface-encryption"),
  serverUrl: "http://127.0.0.1:4310",
  workerId: "local-foundation-worker",
});
vi.spyOn(surfaceEncryptionService, "ownerId").mockReturnValue(LOCAL_USER_ID);
vi.spyOn(surfaceEncryptionService, "componentKey").mockImplementation(() => ({
  key: Uint8Array.from(surfaceComponentKey),
  keyRevision: 1,
}));

async function explorerFixture(
  command: ExplorerOperationRequestContent,
): Promise<unknown> {
  switch (command.type) {
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
    case "explorer.media.read": {
      return readExplorerMediaFile(
        dataDirectory,
        command.path,
        command.offset,
        command.limit,
      );
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
    default:
      throw new Error(
        `Unsupported Explorer fixture operation: ${command.type}`,
      );
  }
}

async function explorerOperation(
  app: FastifyInstance,
  serverId: string,
  explorerId: string,
  request: ExplorerOperationRequestContent,
): Promise<unknown> {
  const context = {
    serverId,
    surfaceKind: "explorer" as const,
    surfaceId: explorerId,
    operationId: randomUUID(),
    direction: "request" as const,
    sequence: 0,
  };
  const response = await app.inject({
    method: "POST",
    url: `/api/explorers/${explorerId}/operation`,
    payload: {
      operationId: context.operationId,
      sequence: context.sequence,
      protectedRequest: await protectWorkerSurfaceStreamContent({
        context,
        content: request,
        schema: explorerOperationRequestContentSchema,
        service: surfaceEncryptionService,
      }),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const wire = surfaceStreamWireResponseSchema.parse(response.json());
  expect(wire.operationId).toBe(context.operationId);
  expect(wire.sequence).toBe(context.sequence);
  const outcome = await openWorkerSurfaceStreamContent({
    context: { ...context, direction: "response" },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
    service: surfaceEncryptionService,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return explorerOperationResultContentSchema.parse(outcome.result).value;
}
const attachmentComponentKey = randomBytes(32);
const attachmentProtection = {
  ownerId: LOCAL_USER_ID,
  componentKey: attachmentComponentKey,
  keyRevision: 1,
};
async function uploadTextAttachment(
  app: FastifyInstance,
  chatId: string,
  fileName: string,
  text: string,
) {
  const attachmentId = randomUUID();
  const operationId = randomUUID();
  const scope = { ...attachmentProtection, chatId, attachmentId };
  const metadata = {
    version: 1 as const,
    fileName,
    mimeType: "text/plain",
    kind: "text" as const,
    source: "file" as const,
    previewText: text,
    error: null,
    sha256: attachmentContentDigest(Buffer.from(text)),
  };
  const protectedMetadata = await encryptAttachmentMetadata({
    ...scope,
    content: metadata,
  });
  const chunk = await encryptAttachmentChunk({
    ...scope,
    operationId,
    direction: "upload",
    sequence: 0,
    eof: true,
    plaintext: Buffer.from(text),
  });
  const response = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/attachments`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(
      JSON.stringify({
        attachmentId,
        operationId,
        sizeBytes: Buffer.byteLength(text),
        protectedMetadata,
        chunks: [chunk],
      }),
    ),
  });
  expect(response.statusCode, response.body).toBe(201);
  const wire = chatAttachmentOpaqueSummarySchema.parse(response.json());
  const opened = await decryptAttachmentMetadata({
    ...scope,
    encrypted: wire.protectedMetadata,
  });
  expect(opened).toEqual(metadata);
  expect(wire).toMatchObject({
    id: attachmentId,
    chatId,
    sizeBytes: Buffer.byteLength(text),
  });
  return chatAttachmentSummarySchema.parse({ ...wire, ...opened });
}
const routingRegistry = new WorkerRoutingRegistry(
  path.join(dataDirectory, "worker-routing"),
);

async function workerRepositoryOperation(
  app: FastifyInstance,
  serverId: string,
  type: RepositoryOperationType,
  args: Record<string, unknown> = {},
  target?: { projectId: string; worktreeId: string },
): Promise<unknown> {
  const context = {
    serverId,
    projectId: target?.projectId ?? "foundation-repository-catalog",
    worktreeId: target?.worktreeId ?? "test-worker",
    operationId: randomUUID(),
    direction: "request" as const,
  };
  const protection = {
    ownerId: LOCAL_USER_ID,
    componentKey: repositoryComponentKey,
    keyRevision: 1,
  };
  const protectedRequest = await encryptRepositoryOperationPayload({
    ...protection,
    context,
    plaintext: Buffer.from(
      JSON.stringify(
        repositoryOperationRequestContentSchema.parse({
          type,
          arguments: args,
        }),
      ),
    ),
  });
  const response = await app.inject({
    method: "POST",
    url: target
      ? `/api/projects/${target.projectId}/worktrees/${target.worktreeId}/repository-operation`
      : "/api/workers/test-worker/repository-operation",
    payload: {
      ...(!target ? { scopeId: context.projectId } : {}),
      operationId: context.operationId,
      protectedRequest,
      access: repositoryOperationAccess(type),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const wire = repositoryOperationWireResponseSchema.parse(response.json());
  expect(wire.operationId).toBe(context.operationId);
  const bytes = await decryptRepositoryOperationPayload({
    ...protection,
    context: { ...context, direction: "response" },
    opaque: wire.protectedResponse,
  });
  try {
    const outcome = repositoryOperationOutcomeContentSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  } finally {
    bytes.fill(0);
  }
}

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
  async request(_workerId, command, options): Promise<unknown> {
    command = await routingRegistry.resolveCommand(command);
    switch (command.type) {
      case "explorer.operation": {
        const context = {
          serverId: command.serverId,
          surfaceKind: "explorer" as const,
          surfaceId: command.explorerId,
          operationId: command.operationId,
          direction: "request" as const,
          sequence: command.sequence,
        };
        const request = await openWorkerSurfaceStreamContent({
          context,
          opaque: command.protectedRequest,
          schema: explorerOperationRequestContentSchema,
          service: surfaceEncryptionService,
        });
        // Reuse the existing filesystem fixture behind the encrypted transport.
        const type =
          request.type === "explorer.file.read" ||
          request.type === "explorer.file.write"
            ? "explorer.file"
            : request.type === "explorer.media.read"
              ? "explorer.media"
              : request.type;
        let outcome;
        try {
          outcome = surfaceOperationOutcomeContentSchema.parse({
            ok: true,
            result: { type, value: await explorerFixture(request) },
          });
        } catch (error) {
          outcome = surfaceOperationOutcomeContentSchema.parse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Explorer operation failed.",
          });
        }
        return {
          operationId: command.operationId,
          sequence: command.sequence,
          protectedResponse: await protectWorkerSurfaceStreamContent({
            context: { ...context, direction: "response" },
            content: outcome,
            schema: surfaceOperationOutcomeContentSchema,
            service: surfaceEncryptionService,
          }),
        };
      }
      case "repository.operation": {
        if (!options?.ownerId)
          throw new Error("Repository operation owner missing.");
        const context = {
          serverId: command.serverId,
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          operationId: command.operationId,
          direction: "request" as const,
        };
        const protection = {
          ownerId: options.ownerId,
          componentKey: repositoryComponentKey,
          keyRevision: 1,
        };
        const bytes = await decryptRepositoryOperationPayload({
          ...protection,
          context,
          opaque: command.protectedRequest,
        });
        try {
          const request = repositoryOperationRequestContentSchema.parse(
            JSON.parse(Buffer.from(bytes).toString("utf8")),
          );
          expect(command.access).toBe(repositoryOperationAccess(request.type));
          const nestedCommand =
            request.type === "repository.metadata.register"
              ? null
              : workerCommandSchema.parse({
                  ...request.arguments,
                  type: request.type,
                  cwd: command.cwd,
                  sourcePath: command.sourcePath,
                  worktreePath: command.cwd,
                  repository: command.repository,
                });
          const result = nestedCommand
            ? await workerBridge.request(_workerId, nestedCommand, options)
            : {
                values: await routingRegistry.protectMetadata(
                  repositoryMetadataValuesSchema.parse(
                    request.arguments.values,
                  ),
                ),
              };
          return {
            operationId: command.operationId,
            protectedResponse: await encryptRepositoryOperationPayload({
              ...protection,
              context: { ...context, direction: "response" },
              plaintext: Buffer.from(JSON.stringify({ ok: true, result })),
            }),
          };
        } finally {
          bytes.fill(0);
        }
      }
      case "attachment.upload.begin": {
        const metadata = await decryptAttachmentMetadata({
          ...attachmentProtection,
          chatId: command.chatId,
          attachmentId: command.attachmentId,
          encrypted: command.protectedMetadata,
        });
        attachmentUploads.set(command.attachmentId, {
          chunks: [],
          fileName: metadata.fileName,
          sizeBytes: command.sizeBytes,
          sha256: metadata.sha256,
        });
        return { accepted: true };
      }
      case "attachment.upload.chunk": {
        const upload = attachmentUploads.get(command.attachmentId);
        if (!upload) throw new Error("Attachment upload was not started.");
        upload.chunks[command.chunk.sequence] = Buffer.from(
          await decryptAttachmentChunk({
            ...attachmentProtection,
            chatId: command.chatId,
            attachmentId: command.attachmentId,
            operationId: command.operationId,
            direction: command.direction,
            sequence: command.chunk.sequence,
            encrypted: command.chunk,
          }),
        );
        return { accepted: true };
      }
      case "attachment.upload.complete": {
        const upload = attachmentUploads.get(command.attachmentId);
        if (!upload) throw new Error("Attachment upload was not started.");
        const bytes = Buffer.concat(upload.chunks);
        attachmentFiles.set(command.attachmentId, bytes);
        attachmentUploads.delete(command.attachmentId);
        return {
          verified:
            bytes.byteLength === upload.sizeBytes &&
            attachmentContentDigest(bytes) === upload.sha256,
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
          chunk: await encryptAttachmentChunk({
            ...attachmentProtection,
            chatId: command.chatId,
            attachmentId: command.attachmentId,
            operationId: command.operationId,
            direction: command.direction,
            sequence: command.sequence,
            eof: command.offset + chunk.byteLength >= bytes.byteLength,
            plaintext: chunk,
          }),
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
          kind: "issue",
          cursor: command.cursor,
          limit: command.limit,
        });
        return {
          kind: "issue",
          state: command.state,
          total: 1,
          nextCursor: "next-issue-cursor",
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
      case "github.pull-requests.list":
        issueListRequests.push({
          kind: "pull-request",
          cursor: command.cursor,
          limit: command.limit,
        });
        return {
          state: command.state,
          total: 1,
          nextCursor: "next-pr-cursor",
          pullRequests: [
            {
              number: 42,
              title: "Test the GitHub pull request view",
              state: command.state,
              url: "https://github.com/ArcaneArts/Cantrip/pull/42",
              author: "cantrip-test",
              commentCount: 1,
              labels: [{ name: "feature", color: "22d3ee" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T13:00:00.000Z",
              closedAt:
                command.state === "closed" ? "2026-08-07T14:00:00.000Z" : null,
              body: "Pull request details",
              draft: false,
              merged: false,
              headRef: "feature/github-list",
              headSha: "1".repeat(40),
              baseRef: "main",
              baseSha: "2".repeat(40),
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
      case "github.pull-request.review.mutate":
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
          created: true,
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
            ...(command.workspaceStorage.kind === "managed"
              ? ["workspaces", command.workspaceStorage.workspaceId]
              : []),
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
        return protectedScriptCommands;
      case "project.share.open":
        openedProjectShares.push(command);
        return {
          accepted: true,
          shareId: command.shareId,
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
      case "skills.list":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.inventory.read": {
        customizationInventoryThreadIds.push(command.threadId);
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      }
      case "customization.external.preview":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.mcp.resource.read":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.skill.configure":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.skill-roots.set":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.mcp.oauth.start":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
          "pending",
        );
      case "customization.mcp.oauth.status":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
          "completed",
        );
      case "customization.mcp.reload":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
        );
      case "customization.external.apply":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
          "pending",
        );
      case "customization.external.status":
        return protectedCustomizationResponse(
          command.operationId,
          command.type,
          command.scope,
          "completed",
        );
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
      case "terminal.prepare-state":
        return protectedTerminalFields(command.terminalId);
      case "terminal.open":
        await options?.onEvent?.({ type: "terminal.ready" });
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
      case "chat.messages.reprotect":
        return Promise.all(
          command.messages.map(async ({ source, id, idempotencyKey }) => {
            const classification = {
              role: source.role,
              mode: source.mode,
              attachmentIds: source.attachmentIds,
            };
            const content = await decryptChatMessageProtectedContent({
              ...chatProtection,
              messageId: source.id,
              encrypted: source.protectedContent,
              publicClassification: classification,
            });
            return {
              id,
              idempotencyKey,
              classification,
              reasoningEffort: source.reasoningEffort,
              protectedContent: await encryptChatMessageProtectedContent({
                ...chatProtection,
                messageId: id,
                content,
              }),
            };
          }),
        );
      case "chat.message.protect": {
        const attachments = command.attachments;
        const content = await Promise.all(
          command.message.content.map(async (entry) => {
            if (entry.type !== "attachment") return entry;
            const attachment = attachments.find(
              (value) => value.id === entry.attachment.id,
            );
            if (!attachment) return entry;
            return {
              ...entry,
              attachment: chatAttachmentSummarySchema.parse({
                ...attachment,
                ...(await decryptAttachmentMetadata({
                  ...attachmentProtection,
                  chatId: attachment.chatId,
                  attachmentId: attachment.id,
                  encrypted: attachment.protectedMetadata,
                })),
              }),
            };
          }),
        );
        const classification = {
          role: command.message.role,
          mode: command.message.mode ?? "default",
          attachmentIds: content.flatMap((entry) =>
            entry.type === "attachment" ? [entry.attachment.id] : [],
          ),
        };
        return {
          id: command.message.id,
          classification,
          idempotencyKey: command.message.idempotencyKey,
          reasoningEffort: command.message.reasoningEffort ?? null,
          protectedContent: await encryptChatMessageProtectedContent({
            ...chatProtection,
            messageId: command.message.id,
            content: { version: 1, classification, content },
          }),
        };
      }
      case "chat.turn": {
        const completeQueuedCommand = await beginQueuedNativeCommand?.(command);
        if (command.protectedPrompt) {
          command = {
            ...command,
            prompt: await openEncryptedChatTurn({
              service: chatEncryptionService,
              prompt: command.protectedPrompt,
              history: command.protectedHistory,
              threadId: command.threadId,
            }),
          };
        }
        if (command.prompt === undefined)
          throw new Error("Chat turn prompt missing.");
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
          const goalSealer = new EncryptedChatEventSealer(
            chatEncryptionService,
            command.chatId,
            { explanation: null, steps: [], question: null },
          );
          await options?.onEvent?.(
            await goalSealer.checkpoint({
              turnId: "goal-turn-1",
              text: "Finished the first goal milestone.",
            }),
          );
        }
        if (command.prompt === "Draft a deployment plan") {
          const planSealer = new EncryptedChatEventSealer(
            chatEncryptionService,
            command.chatId,
            { explanation: null, steps: [], question: null },
          );
          await options?.onEvent?.(
            await planSealer.plan({
              turnId: "plan-turn-1",
              explanation: "Choose the deployment topology.",
              steps: [
                { step: "Inspect the runtime", status: "completed" },
                { step: "Choose a topology", status: "inProgress" },
              ],
            }),
          );
          await options?.onEvent?.({
            type: "agent.interaction.requested.protected",
            request: await protectAgentInteractionRequest({
              service: chatEncryptionService,
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
            }),
          });
          await options?.onEvent?.(
            await planSealer.planQuestion({
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
            }),
          );
          await new Promise<void>((resolve) => {
            releasePlanQuestion = resolve;
          });
          await options?.onEvent?.(
            await planSealer.planQuestionResolved("plan-question-1"),
          );
        }
        if (command.prompt === "Request a command approval") {
          await options?.onEvent?.({
            type: "agent.interaction.requested.protected",
            request: await protectAgentInteractionRequest({
              service: chatEncryptionService,
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
            }),
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
          const richResult = {
            threadId: "codex-rich-thread-1",
            // Keep turnId absent: older/provider-specific workers may omit it.
            text: "Rich events are preserved.",
            status: "completed" as const,
          };
          return command.resultMode.kind === "chat-message-encrypted"
            ? encryptChatTurnResult({
                service: chatEncryptionService,
                result: richResult,
                messageId: command.resultMode.messageId,
                idempotencyKey: command.resultMode.idempotencyKey,
              })
            : richResult;
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
          heldTurnCommand = command;
          await new Promise<void>((resolve) => {
            releaseHeldTurn = resolve;
          });
        }
        const structuredResult =
          command.resultMode.kind === "chat-message-encrypted"
            ? {
                message: {
                  id: command.resultMode.messageId,
                  idempotencyKey: command.resultMode.idempotencyKey,
                  classification: {
                    role: "assistant",
                    mode: "default",
                    attachmentIds: [],
                  },
                  protectedContent: await encryptChatMessageProtectedContent({
                    ...chatProtection,
                    messageId: command.resultMode.messageId,
                    content: {
                      version: 1,
                      classification: {
                        role: "assistant",
                        mode: "default",
                        attachmentIds: [],
                      },
                      content: [
                        {
                          type: "text",
                          text: "The local agent replied.",
                          phase: "final_answer",
                        },
                      ],
                    },
                  }),
                },
              }
            : undefined;
        await completeQueuedCommand?.();
        return {
          threadId: command.threadId ?? "codex-thread-1",
          text: "The local agent replied.",
          status: "completed",
          structuredResult,
        };
      }
      case "chat.compact":
        compactRequests += 1;
        return { accepted: true };
      case "chat.pause.set":
        pauseCommands.push({ chatId: command.chatId, paused: command.paused });
        return { paused: command.paused, active: null };
      case "chat.automation.resume":
        // This fixture has no native autonomous goal to resume; queued input
        // remains the server's next action.
        return { resumed: false };
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
        goalUpdateCommands.push(command);
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
      case "chat.native-control":
        if (command.control.kind === "interrupt") {
          interruptCommands.push(command);
          return { interrupted: true };
        }
        if (command.control.kind === "steer") {
          const completeQueuedCommand =
            await beginQueuedNativeCommand?.(command);
          const prompt = command.control.protectedPrompt;
          const content = await decryptChatMessageProtectedContent({
            ...chatProtection,
            messageId: prompt.id,
            encrypted: prompt.protectedContent,
            publicClassification: prompt.classification,
          });
          steeredPrompts.push(
            chatMessageContentSchema
              .parse(content.content)
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          );
          steeredAttachmentIds.push(
            command.control.attachments.map(({ id }) => id),
          );
          await completeQueuedCommand?.();
          return { steered: true, turnId: "turn-held" };
        }
        if (command.control.kind !== "reply")
          throw new Error(
            `Unsupported foundation native control: ${command.control.kind}`,
          );
        if (command.control.response)
          deliveredAgentInteractionResponses.push(command.control.response);
        if (command.control.protectedResponse)
          deliveredAgentInteractionResponses.push(
            await openAgentInteractionResponse({
              requestKey: command.control.requestKey,
              response: command.control.protectedResponse,
              service: chatEncryptionService,
            }),
          );
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true };
      case "agent.interaction.respond":
        deliveredAgentInteractionResponses.push(command.response);
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true };
      case "agent.interaction.respond.protected":
        deliveredAgentInteractionResponses.push(
          await openAgentInteractionResponse({
            requestKey: command.requestKey,
            response: command.response,
            service: chatEncryptionService,
          }),
        );
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true };
      case "agent.interaction.cancel":
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        return { accepted: true };
      case "chat.steer": {
        const completeQueuedCommand = await beginQueuedNativeCommand?.(command);
        const prompt = command.protectedPrompt;
        if (!prompt) throw new Error("Protected steering prompt missing.");
        const content = await decryptChatMessageProtectedContent({
          ...chatProtection,
          messageId: prompt.id,
          encrypted: prompt.protectedContent,
          publicClassification: prompt.classification,
        });
        steeredPrompts.push(
          chatMessageContentSchema
            .parse(content.content)
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
        );
        steeredAttachmentIds.push(
          command.attachments.map((attachment) => attachment.id),
        );
        await completeQueuedCommand?.();
        return { steered: true, turnId: "turn-held" };
      }
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
  repositoryComponentKey.fill(0);
  chatComponentKey.fill(0);
  surfaceComponentKey.fill(0);
  attachmentComponentKey.fill(0);
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

    const initialSettings = settingsBundleWireSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(initialSettings.preferences).toMatchObject({
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 80,
      contentGutters: false,
      eliteMode: false,
      eliteRevealConfig: {
        glitchCountMax: 8,
        glitchCountMin: 4,
        glitchShowMs: 16,
        staggerSpreadMs: 50,
        variantWeights: {
          outline: 1,
          "full-frame": 0.01,
          "left-frame": 0.01,
          "right-frame": 0.01,
          chromatic: 0.25,
          "spatial-shift": 1,
          scanline: 0.33,
          "text-jitter": 1,
        },
      },
      sidebarWidth: 288,
      showChatPromptOverlay: true,
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
        initialAccount: null,
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
    expect(providerResponse.statusCode, providerResponse.body).toBe(201);
    expect(providerResponse.body).not.toContain("server-only-secret");
    expect(providerResponse.body).not.toContain("apiKey");
    const provider = modelProviderWireSummarySchema.parse(
      providerResponse.json(),
    );
    expect(provider.hasApiKey).toBe(true);
    const editedProvider = modelProviderWireSummarySchema.parse(
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
    const updatedSettings = settingsBundleWireSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            theme: "dark",
            highContrast: true,
            proMode: true,
            proModeOpacity: 64,
            contentGutters: true,
            eliteMode: true,
            eliteRevealConfig: {
              glitchCountMax: 2,
              glitchCountMin: 2,
              glitchShowMs: 12,
              staggerSpreadMs: 40,
              variants: ["chromatic", "scanline"],
              variantWeights: {
                outline: 1,
                "full-frame": 0.1,
                "left-frame": 0.1,
                "right-frame": 0.1,
                chromatic: 2,
                "spatial-shift": 1,
                scanline: 0.75,
                "text-jitter": 1,
              },
            },
            sidebarWidth: 352,
            showChatPromptOverlay: false,
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
      ...initialSettings.preferences,
      theme: "dark",
      highContrast: true,
      proMode: true,
      proModeOpacity: 64,
      contentGutters: true,
      eliteMode: true,
      eliteRevealConfig: {
        glitchCountMax: 2,
        glitchCountMin: 2,
        glitchShowMs: 12,
        staggerSpreadMs: 40,
        variants: ["chromatic", "scanline"],
        variantWeights: {
          outline: 1,
          "full-frame": 0.1,
          "left-frame": 0.1,
          "right-frame": 0.1,
          chromatic: 2,
          "spatial-shift": 1,
          scanline: 0.75,
          "text-jitter": 1,
        },
      },
      sidebarWidth: 352,
      showChatPromptOverlay: false,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
      defaultReasoningEffort: null,
      defaultCustomSubagentModel: false,
      defaultSubagentModelId: null,
      defaultSubagentReasoningEffort: null,
      defaultPermissionProfileId: ":read-only",
      defaultWorkerId: null,
      automaticReplicaProvisioning: false,
      automaticReplicaSynchronization: "off",
      mobileProjectTabConfigurations: {
        "project-1": ["group-1", null],
      },
    });
    const mergedMobileTabs = settingsBundleWireSchema.parse(
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
      settingsBundleWireSchema.parse(
        (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
      ).preferences.mobileProjectTabConfigurations,
    ).toEqual({
      "project-1": ["group-1", null],
      "project-2": ["group-2"],
    });
    const initialChatGptAccount = protectedProviderAccount();
    const chatGptProvider = modelProviderWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            id: "00000000-0000-4000-8000-000000000943",
            initialAccount: initialChatGptAccount,
            name: "Personal ChatGPT",
            kind: "chatgpt",
            baseUrl: "https://api.openai.com/v1",
          },
        })
      ).json(),
    );
    expect(chatGptProvider.accounts).toEqual([
      expect.objectContaining({
        ...initialChatGptAccount,
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
        projectReplicas: {
          provision: true,
          synchronize: false,
          remove: false,
          exactRevision: true,
          workspaceScopedRoots: true,
        },
        startedAt: "2026-08-07T12:00:00.000Z",
      },
    });
    expect(heartbeatResponse.statusCode).toBe(202);
    const placementSettings = settingsBundleWireSchema.parse(
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
    const workAccount = protectedProviderAccount();
    const additionalAccountResponse = await firstApp.inject({
      method: "POST",
      url: `/api/settings/providers/${chatGptProvider.id}/accounts`,
      payload: workAccount,
    });
    expect(
      additionalAccountResponse.statusCode,
      additionalAccountResponse.body,
    ).toBe(201);
    const additionalAccount = additionalAccountResponse.json<{
      id: string;
      position: number;
    }>();
    expect(additionalAccount).toMatchObject({ ...workAccount, position: 1 });
    expect(additionalAccount).not.toHaveProperty("label");
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
      modelProviderAccountWireListSchema
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
    const pooledSettings = settingsBundleWireSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(
      pooledSettings.providers
        .find((provider) => provider.id === chatGptProvider.id)
        ?.accounts.find((account) => account.id === additionalAccount.id),
    ).toMatchObject({
      credentialState: "signed-out",
      workerBindings: [],
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/settings/providers",
        payload: {
          id: "00000000-0000-4000-8000-000000000944",
          initialAccount: protectedProviderAccount(),
          name: "Another ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const initialGrokAccount = protectedProviderAccount();
    const grokProvider = modelProviderWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            id: "00000000-0000-4000-8000-000000000945",
            initialAccount: initialGrokAccount,
            name: "SuperGrok",
            kind: "grok",
            baseUrl: "https://cli-chat-proxy.grok.com/v1",
          },
        })
      ).json(),
    );
    expect(grokProvider.accounts).toEqual([
      expect.objectContaining({ ...initialGrokAccount, position: 0 }),
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
    const backupGrokAccount = protectedProviderAccount();
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/settings/providers/${grokProvider.id}/accounts`,
          payload: backupGrokAccount,
        })
      ).json(),
    ).toMatchObject({ ...backupGrokAccount, position: 1 });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/settings/providers",
        payload: {
          id: "00000000-0000-4000-8000-000000000946",
          initialAccount: protectedProviderAccount(),
          name: "Another Grok",
          kind: "grok",
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      githubRepositoryListSchema.parse(
        await workerRepositoryOperation(
          firstApp,
          bootstrap.server.id,
          "github.repositories.cached",
          { login: "cantrip-test" },
        ),
      ),
    ).toMatchObject([{ nameWithOwner: "ArcaneArts/Cantrip", imported: false }]);
    expect(
      githubRepositoryOwnerListSchema.parse(
        await workerRepositoryOperation(
          firstApp,
          bootstrap.server.id,
          "github.repository-owners.list",
        ),
      ),
    ).toEqual([
      { login: "cantrip-test", kind: "user" },
      { login: "ArcaneArts", kind: "organization" },
    ]);
    const createdRepository = await workerRepositoryOperation(
      firstApp,
      bootstrap.server.id,
      "github.repositories.create",
      {
        request: {
          owner: "ArcaneArts",
          name: "cantrip-labs",
          description: "A Cantrip project",
          visibility: "private",
        },
      },
    );
    expect(githubRepositorySchema.parse(createdRepository)).toMatchObject({
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

    const cantripRepositoryFields: Record<string, string> = {
      ...repositoryMetadataResultSchema.parse(
        await workerRepositoryOperation(
          firstApp,
          bootstrap.server.id,
          "repository.metadata.register",
          {
            values: {
              repositoryId: "github-repository-1",
              nameWithOwner: "ArcaneArts/Cantrip",
              url: "https://github.com/ArcaneArts/Cantrip",
            },
          },
        ),
      ).values,
      repositoryBlindIndex: randomBytes(32).toString("base64url"),
    };
    const parallelRepositoryFields = {
      ...repositoryMetadataResultSchema.parse(
        await workerRepositoryOperation(
          firstApp,
          bootstrap.server.id,
          "repository.metadata.register",
          {
            values: {
              repositoryId: "github-repository-2",
              nameWithOwner: "ArcaneArts/ParallelClone",
              url: "https://github.com/ArcaneArts/ParallelClone",
            },
          },
        ),
      ).values,
      repositoryBlindIndex: randomBytes(32).toString("base64url"),
    };
    heldProjectCloneName = "ArcaneArts/Cantrip";
    const projectResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        ...cantripRepositoryFields,
      },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(202);
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
        ...parallelRepositoryFields,
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
          repository: cantripRepositoryFields.nameWithOwner,
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const initialWorkspaces = projectWorkspaceWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/workspaces" })).json(),
    );
    const defaultWorkspace = initialWorkspaces.workspaces[0]!;
    expect(defaultWorkspace).toMatchObject({
      nameProtection: { state: "system-default" },
      storage: { kind: "system" },
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
            storage: { kind: "managed" },
          },
        })
      ).json(),
    );
    expect(personalWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      storage: { kind: "managed" },
      isDefault: false,
      projectIds: [],
    });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/workspaces/${personalWorkspace.id}`,
        payload: {
          expectedRevision: personalWorkspace.revision,
          projectIds: [project.id],
        },
      }),
    ).toMatchObject({ statusCode: 400 });
    const renamedPersonalWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/workspaces/${personalWorkspace.id}`,
          payload: {
            expectedRevision: personalWorkspace.revision,
            nameProtection: workspaceNameProtection(3),
          },
        })
      ).json(),
    );
    const promotedWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/workspaces/${personalWorkspace.id}`,
          payload: {
            expectedRevision: renamedPersonalWorkspace.revision,
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
    ).toEqual([expect.objectContaining({ id: defaultWorkspace.id })]);
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
    ).toMatchObject({ statusCode: 409 });
    const emptyWorkspace = projectWorkspaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/workspaces",
          payload: {
            id: "28b33bd0-413e-42cb-985d-b516124dd4cc",
            nameProtection: workspaceNameProtection(4),
            storage: { kind: "managed" },
          },
        })
      ).json(),
    );
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${emptyWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const projectShareTunnelId = randomUUID();
    const projectShareRecord = (operationId: string, revision: number) => ({
      operationId,
      revision,
      protectedContent: {
        formatVersion: 1 as const,
        domain: "tunnel-content" as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    });
    const projectShareResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/network-shares`,
      payload: {
        tunnelId: projectShareTunnelId,
        workerId: project.source?.workerId,
        protectedRecord: projectShareRecord(projectShareTunnelId, 1),
      },
    });
    expect(projectShareResponse.statusCode).toBe(201);
    const projectShare = projectShareAttachmentWireSchema.parse(
      projectShareResponse.json(),
    );
    expect(projectShare).toMatchObject({
      attachmentId: projectShareTunnelId,
      projectId: project.id,
      protocol: "webdav",
      tunnelId: projectShareTunnelId,
    });
    const reusedProjectShare = projectShareAttachmentWireSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/network-shares`,
          payload: {
            tunnelId: projectShareTunnelId,
            workerId: project.source?.workerId,
            protectedRecord: projectShareRecord(randomUUID(), 2),
          },
        })
      ).json(),
    );
    expect(reusedProjectShare.attachmentId).toBe(projectShare.attachmentId);
    const staleShareTunnelId = randomUUID();
    const staleShareResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/network-shares`,
      payload: {
        tunnelId: staleShareTunnelId,
        workerId: project.source?.workerId,
        protectedRecord: projectShareRecord(staleShareTunnelId, 1),
      },
    });
    expect(staleShareResponse.statusCode, staleShareResponse.body).toBe(409);
    expect(staleShareResponse.json()).toMatchObject({
      code: "project-share-state-stale",
      failureStage: "share-state-validation",
      requestId: expect.any(String),
      workerId: project.source?.workerId,
    });
    expect(openedProjectShares).toHaveLength(2);
    expect(openedProjectShares[0]).toMatchObject({
      shareId: projectShare.attachmentId,
      protectedRecord: projectShareRecord(projectShareTunnelId, 1),
    });
    expect(JSON.stringify(openedProjectShares)).not.toContain(
      project.source?.path,
    );
    const projectShareTunnels = tunnelWireListSchema.parse(
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
        source: { kind: "desktop-loopback" },
        destination: expect.objectContaining({
          kind: "worker-adapter",
          adapter: "project-share",
          resourceId: projectShare.attachmentId,
        }),
        attachments: [],
        protectedRecord: expect.objectContaining({ revision: 2 }),
      }),
    ]);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-shares/${projectShare.attachmentId}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(closedProjectShareIds).toEqual([
      projectShare.attachmentId,
      projectShare.attachmentId,
    ]);
    expect(
      tunnelWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/tunnels`,
          })
        ).json(),
      ),
    ).toEqual([]);
    const codeTab = codeTabWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/code-tabs`,
          payload: protectedDisplayLabelFields("code-tab"),
        })
      ).json(),
    );
    // Native Code tabs retain metadata and file authority, not embedded
    // workbench sessions. File read/save coverage lives in native-code-file-context.
    const renamedCodeFields = protectedDisplayLabelFields(
      "code-tab",
      codeTab.id,
    );
    const renamedCodeResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/code-tabs/${codeTab.id}`,
      payload: { titleProtection: renamedCodeFields.titleProtection },
    });
    expect(renamedCodeResponse.statusCode, renamedCodeResponse.body).toBe(200);
    const renamedCode = codeTabWireSummarySchema.parse(
      renamedCodeResponse.json(),
    );
    expect(renamedCode).toMatchObject({
      id: codeTab.id,
      projectId: project.id,
      activeWorkerId: codeTab.activeWorkerId,
      worktreeId: codeTab.worktreeId,
      titleProtection: renamedCodeFields.titleProtection,
    });
    expect(
      codeTabWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/code-tabs`,
          })
        ).json(),
      ),
    ).toEqual([renamedCode]);
    for (const suffix of [
      "protected-attachment-intents",
      "protected-attachments",
      "save-all",
      "theme",
      "stop",
    ]) {
      const retiredResponse = await firstApp.inject({
        method: "POST",
        url: `/api/code-tabs/${codeTab.id}/${suffix}`,
        payload: {},
      });
      expect(retiredResponse.statusCode, suffix).toBe(404);
    }
    expect(
      tunnelWireListSchema.parse(
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
    const remoteSurfaceFields = protectedBrowserRemoteSurfaceFields();
    const remoteSurface = remoteSurfaceWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-surfaces`,
          payload: {
            workerId: "test-worker",
            ...remoteSurfaceFields,
            configuration: {
              kind: "browser",
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
      ...remoteSurfaceFields,
      configuration: {
        kind: "browser",
        profileId: null,
      },
    });
    expect(
      remoteSurfaceWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    const renamedSurfaceFields = protectedDisplayLabelFields(
      "remote-surface",
      remoteSurface.id,
    );
    expect(
      remoteSurfaceWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/remote-surfaces/${remoteSurface.id}`,
            payload: { titleProtection: renamedSurfaceFields.titleProtection },
          })
        ).json(),
      ).titleProtection,
    ).toEqual(renamedSurfaceFields.titleProtection);
    expect(
      remoteSurfaceWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/remote-surfaces/${remoteSurface.id}/suspend`,
          })
        ).json(),
      ).status,
    ).toBe("suspended");
    expect(
      remoteSurfaceWireSummarySchema.parse(
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
    const [primaryWorktree] =
      await firstDatabase.repository.listProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
      );
    expect(primaryWorktree).toBeDefined();
    const repositoryOperation = (
      type: RepositoryOperationType,
      args: Record<string, unknown> = {},
    ) =>
      workerRepositoryOperation(firstApp, bootstrap.server.id, type, args, {
        projectId: project.id,
        worktreeId: primaryWorktree!.id,
      });
    expect(
      githubPullRequestListSchema.parse(
        await repositoryOperation("github.pull-requests.list", {
          state: "open",
          cursor: "cursor-3",
          limit: 25,
        }),
      ),
    ).toMatchObject({
      total: 1,
      pullRequests: [{ number: 42, state: "open" }],
      nextCursor: "next-pr-cursor",
    });
    expect(issueListRequests).toContainEqual({
      kind: "pull-request",
      cursor: "cursor-3",
      limit: 25,
    });
    const createdIssue = await repositoryOperation("github.issue.create", {
      request: {
        title: "Issue created from Cantrip",
        body: "Issue details from the Git tab.",
      },
    });
    expect(githubIssueDetailSchema.parse(createdIssue)).toMatchObject({
      number: 43,
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    expect(createdIssues).toContainEqual({
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    // The server cannot validate encrypted arguments. The worker command
    // schema retains these input boundaries before dispatch.
    expect(
      workerCommandSchema.safeParse({
        type: "github.issue.create",
        repository: "ArcaneArts/Cantrip",
        request: { title: "   " },
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        type: "github.inbox.list",
        repository: "ArcaneArts/Cantrip",
        state: "open",
        kind: "discussion",
      }).success,
    ).toBe(false);
    expect(
      githubIssueDetailSchema.parse(
        await repositoryOperation("github.issue.get", { number: 42 }),
      ),
    ).toMatchObject({ number: 42, body: "Issue details" });
    await repositoryOperation("github.issue.comment", {
      number: 42,
      body: "Comment from Cantrip",
    });
    expect(issueComments).toContain("Comment from Cantrip");
    expect(
      githubIssueDetailSchema.parse(
        await repositoryOperation("github.issue.close", {
          number: 42,
          comment: "Closing from Cantrip",
        }),
      ).state,
    ).toBe("closed");
    expect(closedIssues).toContainEqual({
      number: 42,
      comment: "Closing from Cantrip",
    });
    const createdPullRequest = await repositoryOperation(
      "github.pull-request.create",
      {
        request: {
          base: "main",
          head: "feature/pr-ui",
          title: "feat: add pull request creation",
          body: "Creates pull requests from Cantrip.",
          draft: true,
          labels: ["feature"],
          reviewers: ["reviewer"],
          linkedIssueNumbers: [42],
        },
      },
    );
    expect(
      githubPullRequestCreateResultSchema.parse(createdPullRequest),
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
    const pullRequestDetail = await repositoryOperation(
      "github.pull-request.get",
      { number: 44 },
    );
    expect(
      githubPullRequestDetailSchema.parse(pullRequestDetail),
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
      workerCommandSchema.safeParse({
        type: "github.pull-request.get",
        cwd: primaryWorktree!.path,
        repository: "ArcaneArts/Cantrip",
        number: "not-a-number",
      }).success,
    ).toBe(false);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/projects/${project.id}/worktrees/missing-worktree/repository-operation`,
        payload: {
          operationId: randomUUID(),
          access: "read",
          protectedRequest:
            protectedProjectFields().nameProtection.protectedLabel,
        },
      }),
    ).toMatchObject({ statusCode: 404 });
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
      const result = await repositoryOperation(
        "github.pull-request.review.mutate",
        {
          number: 44,
          action: payload,
        },
      );
      expect(githubPullRequestDetailSchema.parse(result).number).toBe(44);
    }
    expect(pullRequestReviewCommands.slice(-4)).toMatchObject([
      {
        type: "github.pull-request.review.mutate",
        cwd: primaryWorktree!.path,
        number: 44,
        action: { type: "comment", body: "General feedback" },
      },
      {
        type: "github.pull-request.review.mutate",
        action: {
          type: "submit-review",
          review: { event: "approve", body: "Looks good" },
        },
      },
      {
        type: "github.pull-request.review.mutate",
        action: {
          type: "inline-comment",
          comment: { path: "src/review.ts", line: 12, side: "RIGHT" },
        },
      },
      {
        type: "github.pull-request.review.mutate",
        action: { type: "reply", commentId: 99, body: "Updated." },
      },
    ]);
    expect(
      workerCommandSchema.safeParse({
        type: "github.pull-request.review.mutate",
        cwd: primaryWorktree!.path,
        repository: "ArcaneArts/Cantrip",
        number: 44,
        action: {
          type: "submit-review",
          review: { event: "request-changes", body: "" },
        },
      }).success,
    ).toBe(false);
    const lifecyclePreviewResult = await repositoryOperation(
      "github.pull-request.lifecycle.preview",
      {
        number: 44,
        action: {
          type: "merge",
          method: "squash",
          commitTitle: "feat: lifecycle",
          commitMessage: null,
        },
      },
    );
    const lifecyclePreview = githubPullRequestLifecyclePreviewSchema.parse(
      lifecyclePreviewResult,
    );
    expect(lifecyclePreview).toMatchObject({
      confirmationPhrase: "squash #44",
      destructive: true,
    });
    const lifecycleApplyResult = await repositoryOperation(
      "github.pull-request.lifecycle.apply",
      {
        number: 44,
        request: {
          action: lifecyclePreview.action,
          token: lifecyclePreview.token,
          confirmation: "squash #44",
        },
      },
    );
    expect(
      githubPullRequestDetailSchema.parse(lifecycleApplyResult),
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
    const preparedCheckout = githubPullRequestCheckoutPreparedSchema.parse(
      await repositoryOperation("github.pull-request.checkout.prepare", {
        number: 44,
      }),
    );
    const checkoutMetadata = repositoryMetadataResultSchema.parse(
      await repositoryOperation("repository.metadata.register", {
        values: {
          name: preparedCheckout.name,
          branch: preparedCheckout.branch,
          startPoint: preparedCheckout.headSha,
        },
      }),
    ).values;
    const checkoutResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/worktrees`,
      payload: {
        name: checkoutMetadata.name,
        mode: {
          type: "newBranch",
          branch: checkoutMetadata.branch,
          startPoint: checkoutMetadata.startPoint,
        },
      },
    });
    expect(checkoutResponse.statusCode, checkoutResponse.body).toBe(201);
    const checkoutWorktree = projectWorktreeSummarySchema.parse(
      checkoutResponse.json(),
    );
    expect(
      githubPullRequestCheckoutResultSchema.parse({
        pullRequest: preparedCheckout.pullRequest,
        worktree: {
          ...checkoutWorktree,
          name: await routingRegistry.resolveToken(checkoutWorktree.name),
          branch:
            checkoutWorktree.branch &&
            (await routingRegistry.resolveToken(checkoutWorktree.branch)),
        },
        reused: false,
      }),
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
      await repositoryOperation("git.history"),
    );
    expect(history).toMatchObject({
      branch: "main",
      commits: [{ subject: "feat: test history" }],
    });
    const fileHistory = gitFileHistorySchema.parse(
      await repositoryOperation("git.file.history", {
        path: "README.md",
        revision: "HEAD",
        cursor: 0,
        limit: 25,
      }),
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
      await repositoryOperation("git.file.blame", {
        path: "README.md",
        revision: "main",
        cursor: 200,
        limit: 100,
      }),
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
      await repositoryOperation("git.commit.search", {
        query: {
          message: "searched",
          author: "Cantrip",
          path: "README.md",
          branch: "main",
        },
        cursor: 10,
        limit: 25,
      }),
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
    const recoveryList = gitRecoveryCandidateListSchema.parse(
      await repositoryOperation("git.recovery.list", {
        kind: "reflog",
        cursor: 20,
        limit: 25,
      }),
    );
    expect(recoveryList.entries[0]).toMatchObject({ kind: "reflog" });
    const recoveryAction = {
      type: "reset" as const,
      mode: "mixed" as const,
      target: "1".repeat(40),
    };
    const recoveryPreview = gitRecoveryPreviewSchema.parse(
      await repositoryOperation("git.recovery.preview", {
        action: recoveryAction,
      }),
    );
    const recoveryApply = gitRecoveryResultSchema.parse(
      await repositoryOperation("git.recovery.apply", {
        request: {
          action: recoveryAction,
          token: recoveryPreview.token,
          confirmation: recoveryPreview.confirmation,
        },
      }),
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
    for (const invalidCommand of [
      { type: "git.recovery.list" },
      { type: "git.commit.search", query: {} },
      { type: "git.file.history", path: "../secret" },
    ]) {
      expect(
        workerCommandSchema.safeParse({
          ...invalidCommand,
          cwd: primaryWorktree!.path,
        }).success,
        invalidCommand.type,
      ).toBe(false);
    }
    const gitStatus = gitStatusSchema.parse(
      await repositoryOperation("git.status"),
    );
    expect(gitStatus).toMatchObject({
      branch: "main",
      ahead: 1,
      files: [{ path: "README.md", unstaged: true }],
    });
    const gitAction = gitActionResultSchema.parse(
      await repositoryOperation("git.action", { action: { type: "stageAll" } }),
    );
    expect(gitAction).toMatchObject({
      output: "Git action complete",
      status: { files: [] },
    });
    const terminalFields = protectedTerminalFields();
    const terminalProtection = {
      ownerId: LOCAL_USER_ID,
      componentKey: surfaceComponentKey,
      keyRevision: 1,
      context: {
        serverId: bootstrap.server.id,
        resource: "terminal-row" as const,
        resourceId: terminalFields.id,
        operationId: null,
        recordKind: "terminal-state" as const,
      },
    };
    const terminalContent = {
      version: 1 as const,
      classification: { recordKind: "terminal-state" as const },
      directory: { kind: "relative-path" as const, path: "packages/app" },
      serviceCommand: "",
    };
    terminalFields.stateProtection = await encryptSurfacePrivateState({
      ...terminalProtection,
      content: terminalContent,
    });
    const terminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: terminalFields,
        })
      ).json(),
    );
    expect(terminal).toMatchObject({
      projectId: project.id,
      ...terminalFields,
      activeWorkerId: "test-worker",
      serviceEnabled: false,
    });
    expect(
      terminalWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    const renamedTerminal = protectedDisplayLabelFields(
      "terminal",
      terminal.id,
    );
    expect(
      terminalWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/terminals/${terminal.id}`,
            payload: { titleProtection: renamedTerminal.titleProtection },
          })
        ).json(),
      ).titleProtection,
    ).toEqual(renamedTerminal.titleProtection);
    const serviceState = await encryptSurfacePrivateState({
      ...terminalProtection,
      content: { ...terminalContent, serviceCommand: "pnpm dev" },
    });
    const enabledService = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, stateProtection: serviceState },
        })
      ).json(),
    );
    expect(enabledService).toMatchObject({
      status: "running",
      serviceEnabled: true,
      stateProtection: serviceState,
    });
    expect(terminalServiceReconciliations.at(-1)?.services).toEqual([
      expect.objectContaining({
        terminalId: terminal.id,
        serverId: bootstrap.server.id,
        worktreePath: primaryWorktree!.path,
        stateProtection: serviceState,
      }),
    ]);
    const service = terminalServiceReconciliations.at(-1)!.services[0]!;
    expect(
      await decryptSurfacePrivateState({
        ...terminalProtection,
        context: {
          ...terminalProtection.context,
          serverId: service.serverId,
          resourceId: service.terminalId,
        },
        opaque: service.stateProtection,
      }),
    ).toEqual({ ...terminalContent, serviceCommand: "pnpm dev" });
    expect(JSON.stringify(service)).not.toContain("pnpm dev");
    expect(JSON.stringify(service)).not.toContain("packages/app");
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/terminals/${terminal.id}/service/restart`,
        })
      ).statusCode,
    ).toBe(202);
    expect(terminalServiceRestarts).toContain(terminal.id);
    const disabledService = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: false, stateProtection: serviceState },
        })
      ).json(),
    );
    expect(disabledService).toMatchObject({
      status: "idle",
      serviceEnabled: false,
      stateProtection: serviceState,
    });
    expect(terminalServiceReconciliations.at(-1)?.services).toEqual([]);
    expect(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, stateProtection: serviceState },
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
        ...cantripRepositoryFields,
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const chatResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: protectedChatFields(),
    });
    expect(chatResponse.statusCode, chatResponse.body).toBe(201);
    const chat = chatWireSummarySchema.parse(chatResponse.json());
    const attachmentText = "A durable worker-owned attachment.";
    const attachmentId = randomUUID();
    const uploadOperationId = randomUUID();
    const attachmentScope = {
      ...attachmentProtection,
      chatId: chat.id,
      attachmentId,
    };
    const protectedMetadata = await encryptAttachmentMetadata({
      ...attachmentScope,
      content: {
        version: 1,
        fileName: "notes.txt",
        mimeType: "text/plain",
        kind: "text",
        source: "paste",
        previewText: attachmentText,
        error: null,
        sha256: attachmentContentDigest(Buffer.from(attachmentText)),
      },
    });
    const uploadChunk = await encryptAttachmentChunk({
      ...attachmentScope,
      operationId: uploadOperationId,
      direction: "upload",
      sequence: 0,
      eof: true,
      plaintext: Buffer.from(attachmentText),
    });
    const uploadedAttachment = chatAttachmentOpaqueSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/attachments`,
          headers: {
            "content-type": "application/octet-stream",
          },
          payload: Buffer.from(
            JSON.stringify({
              attachmentId,
              operationId: uploadOperationId,
              sizeBytes: Buffer.byteLength(attachmentText),
              protectedMetadata,
              chunks: [uploadChunk],
            }),
          ),
        })
      ).json(),
    );
    expect(uploadedAttachment).toMatchObject({
      chatId: chat.id,
      id: attachmentId,
      protectedMetadata,
      sizeBytes: Buffer.byteLength(attachmentText),
    });
    expect(
      await decryptAttachmentMetadata({
        ...attachmentScope,
        encrypted: uploadedAttachment.protectedMetadata,
      }),
    ).toMatchObject({
      fileName: "notes.txt",
      kind: "text",
      previewText: attachmentText,
      source: "paste",
    });
    const downloadOperationId = randomUUID();
    const attachmentContent = await firstApp.inject({
      method: "GET",
      url: `/api/attachments/${uploadedAttachment.id}/content?operationId=${downloadOperationId}`,
    });
    expect(attachmentContent.statusCode).toBe(200);
    const downloaded = attachmentDownloadOpaqueSchema.parse(
      attachmentContent.json(),
    );
    expect(downloaded.operationId).toBe(downloadOperationId);
    const downloadedBytes = await Promise.all(
      downloaded.chunks.map((chunk) =>
        decryptAttachmentChunk({
          ...attachmentScope,
          operationId: downloaded.operationId,
          direction: "download",
          sequence: chunk.sequence,
          encrypted: chunk,
        }),
      ),
    );
    expect(Buffer.concat(downloadedBytes).toString()).toBe(attachmentText);
    downloadedBytes.forEach((bytes) => bytes.fill(0));
    expect(attachmentContent.body).not.toContain(attachmentText);
    expect(attachmentContent.body).not.toContain("notes.txt");
    const selectedChat = chatWireSummarySchema.parse(
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
    // Bound settings are commands, not immediate server-side selection writes.
    // Simulate the native worker's admission and evidence against the real DB.
    const nativeCommands = firstDatabase.repository.nativeCommands;
    let nativeSettingsRevision = 0;
    await nativeCommands.refreshSettingsState(
      LOCAL_USER_ID,
      chat.id,
      async (scope) => ({
        context: {
          chatId: scope.chatId,
          workerId: scope.workerId,
          threadId: scope.threadId,
          runtimeGeneration: "foundation-runtime",
          settingsVersion: { epoch: "foundation-epoch", revision: "0" },
        },
        protectedContent: settingsEnvelope,
        contentFingerprint: "c".repeat(64),
      }),
    );
    const changePermission = async (id: string | null, rejected = false) => {
      const before = (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      ))!;
      const state = (await nativeCommands.settingsState(
        LOCAL_USER_ID,
        chat.id,
      ))!;
      const operationId = randomUUID();
      let evidence: NativeSettingsEvidence | undefined;
      const originalRequest = workerBridge.request.bind(workerBridge);
      const requestSpy = vi
        .spyOn(workerBridge, "request")
        .mockImplementation(async (workerId, command, options) => {
          if (command.type !== "chat.permissions.update")
            return originalRequest(workerId, command, options);
          expect(command.binding.bindingId).toBe(state.binding!.bindingId);
          const input = nativeCommandAdmissionSchema.parse({
            workerId,
            operationId: command.operationId,
            origin: "gui",
            method: "thread/settings/update",
            session: {
              chatId: chat.id,
              threadId: before.threadId,
              contextKind: before.contextKind,
              projectId: before.projectId,
              placementId: before.worktreeId ?? before.scratchRootId,
              modelRouteId: before.modelRouteId,
              providerAccountId: before.providerAccountId,
              runtimeGeneration: "foundation-runtime",
              connectionId: "foundation-view",
            },
            payloadDigest: "a".repeat(64),
            protectedPayload: settingsEnvelope,
            expectedActivationGeneration: (
              await nativeCommands.controlContext(LOCAL_USER_ID, chat.id)
            ).activationGeneration,
            intent: {
              scope: "thread",
              settingKeys: ["permissions", "approvalPolicy"],
              nativeSettingsOperationId: randomUUID(),
              settingsBindingId: command.binding.bindingId,
              permissionProfileId:
                effectivePermissionProfile(before).effectiveId,
              permissionTransition: command.permissionTransition,
              expectedTurnId: null,
            },
          });
          const admitted = await nativeCommands.admit(LOCAL_USER_ID, input);
          expect(admitted.receipt.status).toBe("accepted");
          await nativeCommands.dispatch(LOCAL_USER_ID, {
            workerId,
            operationId,
            operationGeneration: admitted.receipt.operationGeneration,
            payloadDigest: input.payloadDigest,
            session: input.session,
          });
          evidence = {
            workerId,
            operationId,
            operationGeneration: admitted.receipt.operationGeneration,
            eventId: randomUUID(),
            threadId: input.session.threadId!,
            runtimeGeneration: "foundation-runtime",
            nativeOperationId: input.intent.nativeSettingsOperationId!,
            submissionId: operationId,
            kind: rejected ? "rejected" : "applied",
            resultDigest: "b".repeat(64),
            protectedResult: settingsEnvelope,
            ...(!rejected
              ? {
                  permissionPolicy: {
                    effectiveId: command.permissionTransition.effectiveId,
                    settingsVersion: {
                      epoch: "foundation-epoch",
                      revision: String(++nativeSettingsRevision),
                    },
                  },
                }
              : {}),
          };
          await nativeCommands.recordSettingsEvidence(LOCAL_USER_ID, {
            ...evidence,
            eventId: randomUUID(),
            kind: "queued",
            permissionPolicy: undefined,
          });
          return { operationId, submissionId: operationId, status: "queued" };
        });
      try {
        const response = await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: {
            id,
            operationId,
            bindingId: state.binding!.bindingId,
            expectedRevision: state.permissionPolicy?.revision ?? "0",
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(
          nativeSettingsUpdateReceiptSchema.parse(response.json()),
        ).toMatchObject({ operationId, status: "queued" });
        expect(
          (await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            chat.id,
          ))!.permissionProfileId,
        ).toBe(before.permissionProfileId);
        expect(evidence).toBeDefined();
        await nativeCommands.recordSettingsEvidence(LOCAL_USER_ID, evidence!);
        return chatPermissionProfileStateSchema.parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/chats/${chat.id}/permission-profiles`,
            })
          ).json(),
        );
      } finally {
        requestSpy.mockRestore();
      }
    };
    const selectedPermissionProfile = await changePermission(
      ":danger-full-access",
    );
    expect(selectedPermissionProfile).toMatchObject({
      selectedId: ":danger-full-access",
      effectiveId: ":danger-full-access",
    });
    const selectedYoloProfile = await changePermission(":yolo");
    expect(selectedYoloProfile).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":yolo",
    });
    expect(await changePermission(":blocked", true)).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":yolo",
    });
    expect(
      (await nativeCommands.settingsState(LOCAL_USER_ID, chat.id))
        ?.desiredStatus,
    ).toBe("rejected");
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

    const approvalContext =
      (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      ))!;
    const approvalTurn = nativeCommandAdmissionSchema.parse({
      workerId: approvalContext.workerId,
      operationId: randomUUID(),
      origin: "gui",
      method: "turn/start",
      session: {
        chatId: chat.id,
        threadId: approvalContext.threadId,
        contextKind: approvalContext.contextKind,
        projectId: approvalContext.projectId,
        placementId:
          approvalContext.worktreeId ?? approvalContext.scratchRootId,
        modelRouteId: approvalContext.modelRouteId,
        providerAccountId: approvalContext.providerAccountId,
        runtimeGeneration: "foundation-runtime",
        connectionId: "foundation-view",
      },
      payloadDigest: "d".repeat(64),
      protectedPayload: settingsEnvelope,
      expectedActivationGeneration: null,
      intent: { scope: "thread", settingKeys: [], expectedTurnId: null },
    });
    const approvalGrant = await nativeCommands.admit(
      LOCAL_USER_ID,
      approvalTurn,
    );
    expect(approvalGrant.receipt.status).toBe("accepted");
    await nativeCommands.dispatch(LOCAL_USER_ID, {
      workerId: approvalTurn.workerId,
      operationId: approvalTurn.operationId,
      operationGeneration: approvalGrant.receipt.operationGeneration,
      payloadDigest: approvalTurn.payloadDigest,
      session: approvalTurn.session,
    });
    const approvalInput: AgentInteractionRequestCreate = {
      requestKey: "runtime-1:approval-1",
      projectId: project.id,
      provenance: {
        chatId: chat.id,
        threadId: approvalTurn.session.threadId,
        turnId: "turn-approval",
        itemId: "item-approval",
        executionLaneId: approvalGrant.receipt.executionLaneId,
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
    const permissionChangedDuringApproval = await changePermission(null);
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
    await nativeCommands.settle(LOCAL_USER_ID, {
      workerId: approvalTurn.workerId,
      operationId: approvalTurn.operationId,
      operationGeneration: approvalGrant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "e".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: true,
    });

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

    const customizationTarget = customizationContentScopeSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/customizations/target`,
        })
      ).json(),
    );
    const skillsOperationId = "08bc829f-8c6a-4aec-9b2c-36239ad22d32";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/skills?operationId=${skillsOperationId}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: skillsOperationId,
      operation: "skills.list",
      scope: customizationTarget,
    });

    const inventoryOperationId = "a4c99bde-b302-4784-b064-b99b3b97a815";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/customizations?refresh=true&operationId=${inventoryOperationId}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: inventoryOperationId,
      operation: "customization.inventory.read",
      scope: customizationTarget,
    });
    expect(customizationInventoryThreadIds.at(-1)).toBe(
      approvalTurn.session.threadId,
    );
    const previewOperationId = "4d299a12-8c01-4d19-8eaf-0e966d8db12a";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/customizations/external-preview?operationId=${previewOperationId}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: previewOperationId,
      operation: "customization.external.preview",
      scope: customizationTarget,
    });
    const mcpResourceOperationId = "67c5b79c-caa7-4d1a-9a4f-fd00be321d9a";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-resource`,
            payload: protectedCustomizationRequest(
              mcpResourceOperationId,
              "customization.mcp.resource.read",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: mcpResourceOperationId,
      operation: "customization.mcp.resource.read",
    });

    const configureSkillOperationId = "5ddd4be8-a280-4f4e-b745-0be96068093a";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${chat.id}/customizations/skill`,
            payload: protectedCustomizationRequest(
              configureSkillOperationId,
              "customization.skill.configure",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: configureSkillOperationId,
      operation: "customization.skill.configure",
    });
    const skillRootsOperationId = "891db5ef-a6fb-4e5b-8954-917176576d6f";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PUT",
            url: `/api/chats/${chat.id}/customizations/skill-roots`,
            payload: protectedCustomizationRequest(
              skillRootsOperationId,
              "customization.skill-roots.set",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: skillRootsOperationId,
      operation: "customization.skill-roots.set",
    });
    const mcpOauthOperationId = "2a39a88b-5384-4678-81e3-a18160313aef";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-oauth`,
            payload: protectedCustomizationRequest(
              mcpOauthOperationId,
              "customization.mcp.oauth.start",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: mcpOauthOperationId,
      operation: "customization.mcp.oauth.start",
      lifecycle: "pending",
    });
    const mcpOauthStatusOperationId = "20a9b172-9f0b-4d34-946d-fef443460aae";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-oauth/status`,
            payload: protectedCustomizationRequest(
              mcpOauthStatusOperationId,
              "customization.mcp.oauth.status",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: mcpOauthStatusOperationId,
      operation: "customization.mcp.oauth.status",
      lifecycle: "completed",
    });
    const mcpReloadOperationId = "64112f3c-c9b0-4450-9fe2-2408a4d3a9fa";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/mcp-reload`,
            payload: protectedCustomizationRequest(
              mcpReloadOperationId,
              "customization.mcp.reload",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: mcpReloadOperationId,
      operation: "customization.mcp.reload",
    });
    const importOperationId = "8a616f2c-4b84-40d4-9ce4-15c6fcbe987e";
    const importStarted = protectedCustomizationResponseSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/customizations/external-import`,
          payload: protectedCustomizationRequest(
            importOperationId,
            "customization.external.apply",
            customizationTarget,
          ),
        })
      ).json(),
    );
    expect(importStarted.lifecycle).toBe("pending");
    const importStatusOperationId = "6c95ca67-bc25-4402-a1ae-24ab6130d001";
    expect(
      protectedCustomizationResponseSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/customizations/external-import/status`,
            payload: protectedCustomizationRequest(
              importStatusOperationId,
              "customization.external.status",
              customizationTarget,
            ),
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: importStatusOperationId,
      operation: "customization.external.status",
      lifecycle: "completed",
    });

    const messageText = "$skill-creator Persist this message.";
    const messageId = randomUUID();
    const promptId = randomUUID();
    const classification = {
      role: "user" as const,
      mode: "default" as const,
      attachmentIds: [uploadedAttachment.id],
    };
    const readableAttachment = chatAttachmentSummarySchema.parse({
      ...uploadedAttachment,
      ...(await decryptAttachmentMetadata({
        ...attachmentScope,
        encrypted: uploadedAttachment.protectedMetadata,
      })),
    });
    const message = {
      id: messageId,
      classification,
      idempotencyKey: "first-message",
      reasoningEffort: null,
      protectedContent: await encryptChatMessageProtectedContent({
        ...chatProtection,
        messageId,
        content: {
          version: 1,
          classification,
          content: [
            { type: "text", text: messageText },
            { type: "attachment", attachment: readableAttachment },
          ],
        },
      }),
    };
    const queueClassification = {
      mode: classification.mode,
      attachmentIds: classification.attachmentIds,
    };
    const messagePayload = {
      message,
      modelId: selectedModel.id,
      queuedPrompt: {
        id: promptId,
        classification: queueClassification,
        modelId: selectedModel.id,
        idempotencyKey: "first-message",
        pendingMessage: message,
        protectedContent: await encryptQueuedPromptProtectedContent({
          ...chatProtection,
          promptId,
          content: {
            version: 1,
            classification: queueClassification,
            text: messageText,
          },
        }),
      },
    };
    expect(JSON.stringify(messagePayload)).not.toContain(messageText);
    const firstMessageResponse = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: messagePayload,
    });
    expect(firstMessageResponse.statusCode, firstMessageResponse.body).toBe(
      202,
    );
    const firstOpaqueMessage = chatMessageOpaqueSummarySchema.parse(
      firstMessageResponse.json().message,
    );
    const firstMessage = chatMessageSchema.parse({
      ...firstOpaqueMessage,
      content: (
        await decryptChatMessageProtectedContent({
          ...chatProtection,
          messageId: firstOpaqueMessage.id,
          encrypted: firstOpaqueMessage.protectedContent,
          publicClassification: classification,
        })
      ).content,
    });
    const repeatedMessage = chatMessageOpaqueSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    expect(repeatedMessage.id).toBe(firstMessage.id);
    const readChatMessages = async (chatId = chat.id, app = firstApp) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/chats/${chatId}/messages`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const wire = chatMessageWireListSchema.parse(response.json());
      expect(wire.kind).toBe("chat-encrypted");
      return Promise.all(
        wire.messages.map(async (value) =>
          chatMessageSchema.parse({
            ...value,
            content: (
              await decryptChatMessageProtectedContent({
                ...chatProtection,
                messageId: value.id,
                encrypted: value.protectedContent,
                publicClassification: {
                  role: value.role,
                  mode: value.mode,
                  attachmentIds: value.attachmentIds,
                },
              })
            ).content,
          }),
        ),
      );
    };
    await vi.waitFor(async () => {
      const messages = await readChatMessages();
      expect(messages, `worker turns dispatched: ${turnRequests}`).toHaveLength(
        4,
      );
    });
    expect(turnRequests).toBe(1);
    expect(turnPolicyContexts[0]).toEqual({ policies: [] });
    expect(JSON.stringify(turnPolicyContexts[0])).not.toContain("bodyMarkdown");
    // The relay cannot extract skill names from ciphertext; the worker receives
    // the original mention when it opens the protected prompt.
    expect(turnSkillNames[0]).toEqual([]);
    expect(turnPrompts[0]).toBe(messageText);
    expect(turnAttachmentIds[0]).toEqual([uploadedAttachment.id]);
    expect(firstMessage.content).toContainEqual({
      type: "attachment",
      attachment: readableAttachment,
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
    const completedMessages = await readChatMessages();
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
    const renamedChatFields = protectedChatFields(chat.id);
    const renamedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}`,
          payload: { titleProtection: renamedChatFields.titleProtection },
        })
      ).json(),
    );
    expect(renamedChat.titleProtection).toEqual(
      renamedChatFields.titleProtection,
    );
    const forkedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            ...protectedChatFields(),
            messageId: completedMessages.at(-1)?.id,
          },
        })
      ).json(),
    );
    const duplicatedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    const forkedMessages = await readChatMessages(forkedChat.id);
    expect(forkedMessages).toHaveLength(completedMessages.length);
    expect(forkedMessages.map((message) => message.content)).toEqual(
      completedMessages.map((message) => message.content),
    );
    expect(
      forkedMessages.every(
        (message) =>
          !completedMessages.some((source) => source.id === message.id),
      ),
    ).toBe(true);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${forkedChat.id}/turns`,
        payload: await protectChatTurn({
          service: chatEncryptionService,
          messageId: randomUUID(),
          promptId: randomUUID(),
          mode: "default",
          modelId: selectedModel.id,
          reasoningEffort: null,
          text: "Continue from the fork.",
          idempotencyKey: "fork-follow-up",
        }),
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnPrompts).toHaveLength(2));
    expect(turnPolicyContexts[1]).toEqual({ policies: [] });
    expect(turnPrompts[1]).toContain(
      "Continue this existing Cantrip conversation",
    );
    expect(turnPrompts[1]).toContain("The local agent replied.");
    await vi.waitFor(async () => {
      const forkMessages = await readChatMessages(forkedChat.id);
      expect(forkMessages).toHaveLength(completedMessages.length + 4);
    });
    const richChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
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
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        modelId: selectedModel.id,
        reasoningEffort: null,
        text: "Render rich events",
        idempotencyKey: "rich-events",
      }),
    });
    let richMessages = chatMessageListSchema.parse([]);
    await vi.waitFor(async () => {
      richMessages = await readChatMessages(richChat.id);
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
      richMessages.slice(1).map((message) => {
        const content = message.content[0];
        return content?.type === "text" || content?.type === "activity"
          ? content.sourceEvent
          : null;
      }),
    ).toEqual([
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "commentary-1",
        sequence: 0,
      },
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "reasoning-1",
        sequence: 1,
      },
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "mcp-1",
        sequence: 2,
      },
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "turn:rich-turn-1:usage",
        sequence: 3,
      },
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "final-1",
        sequence: 4,
      },
      {
        operationId: richMessages[0]!.id,
        turnId: "rich-turn-1",
        messageId: "turn:rich-turn-1:summary",
        sequence: 4,
      },
    ]);
    expect(
      richMessages.filter((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "final_answer",
        ),
      ),
    ).toHaveLength(1);
    await vi.waitFor(async () => {
      const streamedMessages = richLiveEvents.filter(
        (event) => event.type === "event" && event.resource === "chat-message",
      );
      // The user row is published at insertion and again when model attribution
      // is attached. Both updates retain one message identity and sequence.
      expect(streamedMessages).toHaveLength(8);
      const updates = streamedMessages.map((event) => {
        if (event.type !== "event") throw new Error("Expected a message event");
        const message = chatMessageOpaqueSummarySchema.parse(event.payload);
        expect(event.entityId).toBe(message.id);
        expect(event.revision).toBe(message.sequence);
        expect(event.action).toBe("updated");
        return message;
      });
      expect(updates.map(({ id }) => id)).toEqual([
        richMessages[0]!.id,
        ...richMessages.map(({ id }) => id),
      ]);
      expect(updates[0]!.modelRouteId).toBeNull();
      expect(updates[1]!.modelRouteId).toBe(richMessages[0]!.modelRouteId);
      expect(updates[0]!.protectedContent).toEqual(
        updates[1]!.protectedContent,
      );
      const latest = new Map(updates.map((message) => [message.id, message]));
      expect(
        await Promise.all(
          [...latest.values()].map(async (message) =>
            chatMessageSchema.parse({
              ...message,
              content: (
                await decryptChatMessageProtectedContent({
                  ...chatProtection,
                  messageId: message.id,
                  encrypted: message.protectedContent,
                  publicClassification: {
                    role: message.role,
                    mode: message.mode,
                    attachmentIds: message.attachmentIds,
                  },
                })
              ).content,
            }),
          ),
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
    const usageSettings = settingsBundleWireSchema.parse(
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
    const reorderedTerminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: protectedTerminalFields(),
        })
      ).json(),
    );
    const scriptOperationId = crypto.randomUUID();
    expect(
      protectedScriptCommandListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/terminals/${reorderedTerminal.id}/script-commands?operationId=${scriptOperationId}`,
          })
        ).json(),
      ),
    ).toMatchObject({
      operationId: scriptOperationId,
      projectId: reorderedTerminal.id,
      worktreeId: reorderedTerminal.id,
      protectedCommands: protectedScriptCommands,
    });
    const explorerFields = protectedExplorerFields();
    const explorer = explorerWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/explorers`,
          payload: explorerFields,
        })
      ).json(),
    );
    expect(explorer).toMatchObject({
      stateProtection: explorerFields.stateProtection,
      fileMode: "preview",
    });
    expect(
      explorerWireListSchema.parse(
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
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.directory.list",
          path: "",
        }),
      ).entries[0],
    ).toMatchObject({ name: "README.md", markdown: true });
    expect(
      explorerDirectoryCommitsSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.directory.commits",
          path: "",
        }),
      ).entries[0],
    ).toMatchObject({
      path: "README.md",
      tracked: true,
      lastCommit: { subject: "Document Explorer" },
    });
    expect(
      explorerFileSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.file.read",
          path: "README.md",
        }),
      ).content,
    ).toContain("Cantrip explorer");
    // Media now travels as encrypted chunks, not plaintext HTTP Range bodies.
    const readMedia = async (offset: number, limit: number) =>
      explorerMediaFileChunkSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.media.read",
          path: "preview.png",
          offset,
          limit,
        }),
      );
    const firstChunk = await readMedia(0, 256 * 1_024);
    const lastChunk = await readMedia(256 * 1_024, 256 * 1_024);
    expect(firstChunk).toMatchObject({
      mimeType: "image/png",
      size: explorerMediaBytes.byteLength,
      offset: 0,
      eof: false,
    });
    expect(lastChunk).toMatchObject({
      size: explorerMediaBytes.byteLength,
      offset: 256 * 1_024,
      eof: true,
    });
    expect(
      Buffer.concat([
        Buffer.from(firstChunk.data, "base64"),
        Buffer.from(lastChunk.data, "base64"),
      ]),
    ).toEqual(explorerMediaBytes);
    const rangedMedia = await readMedia(2, 6);
    expect(rangedMedia).toMatchObject({ offset: 2, eof: false });
    expect(Buffer.from(rangedMedia.data, "base64")).toEqual(
      explorerMediaBytes.subarray(2, 8),
    );
    await expect(readMedia(999999, 6)).rejects.toThrow(
      "The media read offset is outside the file.",
    );
    expect(await readMedia(explorerMediaBytes.byteLength, 6)).toMatchObject({
      data: "",
      eof: true,
    });
    const explorerWriteVersion = "a".repeat(64);
    expect(
      explorerFileSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.file.write",
          path: "README.md",
          content: "# Edited in Monaco\n",
          version: explorerWriteVersion,
        }),
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
    const explorerProtection = {
      ownerId: LOCAL_USER_ID,
      componentKey: surfaceComponentKey,
      keyRevision: 1,
      context: {
        serverId: bootstrap.server.id,
        resource: "explorer-row" as const,
        resourceId: explorer.id,
        operationId: null,
        recordKind: "explorer-state" as const,
      },
    };
    const explorerStateContent = {
      version: 1 as const,
      classification: { recordKind: "explorer-state" as const },
      selectedPath: "README.md",
    };
    const explorerStateProtection = await encryptSurfacePrivateState({
      ...explorerProtection,
      content: explorerStateContent,
    });
    const explorerEditorState = explorerWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/explorers/${explorer.id}/view-state`,
          payload: {
            stateProtection: explorerStateProtection,
            fileMode: "edit",
          },
        })
      ).json(),
    );
    expect(explorerEditorState).toMatchObject({
      stateProtection: explorerStateProtection,
      fileMode: "edit",
    });
    expect(
      await decryptSurfacePrivateState({
        ...explorerProtection,
        opaque: explorerEditorState.stateProtection,
      }),
    ).toEqual(explorerStateContent);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/explorers/${explorer.id}/view-state`,
        payload: { selectedPath: "", fileMode: "source" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      explorerWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      )[0],
    ).toMatchObject({
      stateProtection: explorerStateProtection,
      fileMode: "edit",
    });
    const renamedExplorer = protectedDisplayLabelFields(
      "explorer",
      explorer.id,
    );
    expect(
      explorerWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/explorers/${explorer.id}`,
            payload: { titleProtection: renamedExplorer.titleProtection },
          })
        ).json(),
      ).titleProtection,
    ).toEqual(renamedExplorer.titleProtection);
    const browserFields = protectedDisplayLabelFields("browser");
    const browserProtection = {
      ownerId: LOCAL_USER_ID,
      componentKey: surfaceComponentKey,
      keyRevision: 1,
      context: {
        serverId: bootstrap.server.id,
        resource: "browser-row" as const,
        resourceId: browserFields.id,
        operationId: null,
        recordKind: "browser-state" as const,
      },
    };
    const browserState = (revision: number, url: string) =>
      encryptSurfacePrivateState({
        ...browserProtection,
        content: {
          version: 1,
          classification: { recordKind: "browser-state" },
          revision,
          url,
        },
      });
    const browser = browserWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/browsers`,
          payload: {
            ...browserFields,
            stateProtection: await browserState(1, "https://example.com"),
          },
        })
      ).json(),
    );
    expect(
      remoteSurfaceWireListSchema.parse(
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
    const renamedBrowser = protectedDisplayLabelFields("browser", browser.id);
    const browserDocsState = await browserState(2, "https://example.com/docs");
    expect(
      browserWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/browsers/${browser.id}`,
            payload: {
              titleProtection: renamedBrowser.titleProtection,
              stateProtection: browserDocsState,
              expectedStateRevision: browser.stateRevision,
            },
          })
        ).json(),
      ),
    ).toMatchObject({
      titleProtection: renamedBrowser.titleProtection,
      stateProtection: browserDocsState,
      stateRevision: 2,
    });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/browsers/${browser.id}`,
        payload: {
          expectedStateRevision: browser.stateRevision,
          stateProtection: await browserState(2, "https://example.com/stale"),
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const browserSurface = remoteSurfaceWireListSchema
      .parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      )
      .find(({ id }) => id === browser.id)!;
    expect(browserSurface.configuration).toEqual({
      kind: "browser",
      profileId: null,
    });
    expect(browserSurface.stateRevision).toBe(2);
    if (!browserSurface.stateProtection)
      throw new Error("Browser protected state missing.");
    expect(
      await decryptSurfacePrivateState({
        ...browserProtection,
        opaque: browserSurface.stateProtection,
      }),
    ).toMatchObject({ revision: 2, url: "https://example.com/docs" });
    const projectView = projectViewWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/views`,
          payload: {
            kind: "history",
            ...protectedDisplayLabelFields("project-view"),
          },
        })
      ).json(),
    );
    const renamedProjectView = protectedDisplayLabelFields(
      "project-view",
      projectView.id,
    );
    expect(
      projectViewWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/project-views/${projectView.id}`,
            payload: { titleProtection: renamedProjectView.titleProtection },
          })
        ).json(),
      ),
    ).toMatchObject({
      kind: "history",
      titleProtection: renamedProjectView.titleProtection,
    });
    const desktopFields = protectedDisplayLabelFields("project-view");
    const desktopProtection = {
      ownerId: LOCAL_USER_ID,
      componentKey: surfaceComponentKey,
      keyRevision: 1,
      context: {
        serverId: bootstrap.server.id,
        resource: "remote-desktop-row" as const,
        resourceId: desktopFields.id,
        operationId: null,
        recordKind: "remote-desktop-state" as const,
      },
    };
    const initialDesktopState = await encryptSurfacePrivateState({
      ...desktopProtection,
      content: {
        version: 1,
        classification: { recordKind: "remote-desktop-state" },
        revision: 1,
        target: { kind: "monitor", id: null, name: null },
      },
    });
    const remoteDesktop = remoteDesktopWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-desktops`,
          payload: { ...desktopFields, stateProtection: initialDesktopState },
        })
      ).json(),
    );
    expect(remoteDesktop).toMatchObject({
      projectId: project.id,
      workerId: "test-worker",
      status: "idle",
      stateProtection: initialDesktopState,
    });
    expect(JSON.stringify(remoteDesktop)).not.toContain("password");
    expect(
      remoteDesktopWireListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-desktops`,
          })
        ).json(),
      ),
    ).toContainEqual(expect.objectContaining({ id: remoteDesktop.id }));
    const desktopTarget = {
      kind: "window" as const,
      id: "window-42",
      application: "Code",
      title: "Cantrip",
    };
    const targetedDesktopState = await encryptSurfacePrivateState({
      ...desktopProtection,
      content: {
        version: 1,
        classification: { recordKind: "remote-desktop-state" },
        revision: 2,
        target: desktopTarget,
      },
    });
    const targetedDesktop = remoteDesktopWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/remote-desktops/${remoteDesktop.id}`,
          payload: {
            expectedStateRevision: remoteDesktop.stateRevision,
            stateProtection: targetedDesktopState,
          },
        })
      ).json(),
    );
    expect(targetedDesktop.stateRevision).toBe(2);
    expect(
      await decryptSurfacePrivateState({
        ...desktopProtection,
        opaque: targetedDesktop.stateProtection,
      }),
    ).toMatchObject({ revision: 2, target: desktopTarget });
    expect(
      projectViewWireListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/views`,
            })
          ).json(),
        )
        .find(({ id }) => id === remoteDesktop.id),
    ).toMatchObject({
      kind: "remote-desktop",
      titleProtection: desktopFields.titleProtection,
    });
    const initialTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    expect(
      initialTabLayout.panes
        .filter(({ region }) => region === "center")
        .every(({ members }) => members.length === 1),
    ).toBe(true);
    expect(
      initialTabLayout.panes
        .filter(({ region }) => region === "right")
        .map(({ members }) => members.map(({ tabKey }) => tabKey)),
    ).toEqual([
      [
        `browser:${browser.id}`,
        `view:${projectView.id}`,
        `view:${remoteDesktop.id}`,
      ],
    ]);
    expect(
      initialTabLayout.panes
        .filter(({ region }) => region === "bottom")
        .map(({ members }) => members.map(({ tabKey }) => tabKey)),
    ).toEqual([[`terminal:${reorderedTerminal.id}`]]);
    expect(
      initialTabLayout.panes.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).toContain(`view:${remoteDesktop.id}`);
    const explorerPane = initialTabLayout.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `explorer:${explorer.id}`),
    )!;
    const groupedIssuesView = projectViewWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/views`,
          payload: {
            kind: "issues",
            ...protectedDisplayLabelFields("project-view"),
            paneId: explorerPane.id,
          },
        })
      ).json(),
    );
    const groupedTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    expect(groupedTabLayout.panes).toHaveLength(initialTabLayout.panes.length);
    expect(
      groupedTabLayout.panes
        .find(({ id }) => id === explorerPane.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`explorer:${explorer.id}`, `view:${groupedIssuesView.id}`]);
    expect(
      groupedTabLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toBeNull();
    const paneLabel = protectedDisplayLabelFields("tab-group", explorerPane.id);
    const renamedGroupLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/panes/${explorerPane.id}`,
          payload: {
            revision: groupedTabLayout.revision,
            titleProtection: paneLabel.titleProtection,
          },
        })
      ).json(),
    );
    expect(
      renamedGroupLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toEqual(paneLabel.titleProtection);
    const trackerLabel = protectedDisplayLabelFields(
      "project-view",
      groupedIssuesView.id,
    );
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/project-views/${groupedIssuesView.id}`,
        payload: { titleProtection: trackerLabel.titleProtection },
      }),
    ).toMatchObject({ statusCode: 200 });
    const independentlyNamedLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    expect(
      independentlyNamedLayout.panes.find(({ id }) => id === explorerPane.id),
    ).toMatchObject({
      titleProtection: paneLabel.titleProtection,
      members: [
        { titleProtection: renamedExplorer.titleProtection },
        { titleProtection: trackerLabel.titleProtection },
      ],
    });
    const reorderedTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/panes/${explorerPane.id}/members/order`,
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
      reorderedTabLayout.panes
        .find(({ id }) => id === explorerPane.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`view:${groupedIssuesView.id}`, `explorer:${explorer.id}`]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/panes/member`,
        payload: {
          revision: groupedTabLayout.revision,
          tabKey: `view:${groupedIssuesView.id}`,
          targetPaneId: null,
          targetMemberPosition: 0,
          targetPanePosition: 0,
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    const splitTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/panes/member`,
          payload: {
            revision: reorderedTabLayout.revision,
            tabKey: `view:${groupedIssuesView.id}`,
            targetPaneId: null,
            targetMemberPosition: 0,
            targetPanePosition: 0,
          },
        })
      ).json(),
    );
    expect(splitTabLayout.panes[0]?.members).toMatchObject([
      {
        tabKey: `view:${groupedIssuesView.id}`,
        titleProtection: trackerLabel.titleProtection,
      },
    ]);
    expect(splitTabLayout.panes[0]?.titleProtection).toBeNull();
    expect(
      splitTabLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toBeNull();
    const reorderedGroupsLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/panes/order`,
          payload: {
            revision: splitTabLayout.revision,
            region: "center",
            paneIds: splitTabLayout.panes
              .filter(({ region }) => region === "center")
              .map(({ id }) => id)
              .reverse(),
          },
        })
      ).json(),
    );
    expect(
      reorderedGroupsLayout.panes
        .filter(({ region }) => region === "center")
        .map(({ id }) => id),
    ).toEqual(
      splitTabLayout.panes
        .filter(({ region }) => region === "center")
        .map(({ id }) => id)
        .reverse(),
    );
    const mergedTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/panes/member`,
          payload: {
            revision: reorderedGroupsLayout.revision,
            tabKey: `view:${groupedIssuesView.id}`,
            targetPaneId: explorerPane.id,
            targetMemberPosition: 1,
          },
        })
      ).json(),
    );
    expect(
      mergedTabLayout.panes.find(({ id }) => id === explorerPane.id),
    ).toMatchObject({
      anchorTabKey: `explorer:${explorer.id}`,
      titleProtection: null,
      members: [
        { tabKey: `explorer:${explorer.id}` },
        { tabKey: `view:${groupedIssuesView.id}` },
      ],
    });
    const concurrentOrders = await Promise.all([
      firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/panes/order`,
        payload: {
          revision: mergedTabLayout.revision,
          region: "center",
          paneIds: mergedTabLayout.panes
            .filter(({ region }) => region === "center")
            .map(({ id }) => id),
        },
      }),
      firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/panes/order`,
        payload: {
          revision: mergedTabLayout.revision,
          region: "center",
          paneIds: mergedTabLayout.panes
            .filter(({ region }) => region === "center")
            .map(({ id }) => id)
            .reverse(),
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
    const desktopAttach = surfaceAttachCommands.at(-1)!;
    expect(desktopAttach).toMatchObject({
      configuration: { kind: "desktop" },
      stateResource: "remote-desktop-row",
      stateRevision: 2,
      surfaceId: remoteDesktop.id,
      projectId: project.id,
      serverId: bootstrap.server.id,
      stateProtection: targetedDesktopState,
    });
    expect(
      await decryptSurfacePrivateState({
        ...desktopProtection,
        opaque: desktopAttach.stateProtection!,
      }),
    ).toMatchObject({ revision: 2, target: desktopTarget });
    desktopSocket.terminate();
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-views/${remoteDesktop.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      projectTabLayoutWireSummarySchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/panes`,
            })
          ).json(),
        )
        .panes.some(({ members }) =>
          members.some(({ tabKey }) => tabKey === `view:${remoteDesktop.id}`),
        ),
    ).toBe(false);
    const consoleFirstChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${consoleFirstChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    const consoleFirstTerminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${consoleFirstChat.id}/console`,
          payload: protectedTerminalFields(),
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
    const linkedConsoleFields = protectedTerminalFields();
    const existingLinkedConsole = terminalWireListSchema
      .parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      )
      .find(({ linkedChatId }) => linkedChatId === chat.id);
    expect(existingLinkedConsole).toBeDefined();
    const linkedConsole = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
          payload: linkedConsoleFields,
        })
      ).json(),
    );
    expect(linkedConsole).toMatchObject({
      linkedChatId: chat.id,
      projectId: project.id,
      id: existingLinkedConsole!.id,
      titleProtection: existingLinkedConsole!.titleProtection,
      stateProtection: existingLinkedConsole!.stateProtection,
    });
    expect(
      terminalWireSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/console`,
            payload: linkedConsoleFields,
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
    expect(
      chatWireSummarySchema.parse(changedModelResponse.json()).modelId,
    ).toBe(selectedModel.id);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: await protectChatTurn({
          service: chatEncryptionService,
          messageId: randomUUID(),
          promptId: randomUUID(),
          mode: "default",
          reasoningEffort: null,
          text: "Use the newly selected model.",
          idempotencyKey: "dynamic-model-turn",
          modelId: selectedModel.id,
        }),
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnModelIds).toHaveLength(3));
    expect(turnModelIds.at(-1)).toBe(selectedModel.id);

    const queueChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    const queuedAttachment = await uploadTextAttachment(
      firstApp,
      queueChat.id,
      "queued.txt",
      "queued attachment",
    );
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${queueChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        modelId: selectedModel.id,
        text: "Hold queue open.",
        idempotencyKey: "queue-running",
      }),
    });
    await vi.waitFor(() => expect(releaseHeldTurn).not.toBeNull());
    const heldReceipt = heldTurnCommand!.nativeCommandReceipt!;
    expect(heldReceipt.status).toBe("accepted");
    const queueContext =
      (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ))!;
    const heldDispatch = await nativeCommands.dispatch(LOCAL_USER_ID, {
      workerId: queueContext.workerId,
      operationId: heldReceipt.operationId,
      operationGeneration: heldReceipt.operationGeneration,
      payloadDigest: heldReceipt.payloadDigest,
      session: {
        chatId: queueChat.id,
        threadId: queueContext.threadId,
        contextKind: queueContext.contextKind,
        projectId: queueContext.projectId,
        placementId: queueContext.worktreeId ?? queueContext.scratchRootId,
        modelRouteId: queueContext.modelRouteId,
        providerAccountId: queueContext.providerAccountId,
        runtimeGeneration: "foundation-queue-runtime",
        connectionId: "foundation-queue-view",
      },
    });
    expect(heldDispatch.receipt.status).toBe("dispatched");
    expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ),
    ).toMatchObject({ status: "running", threadId: "codex-console-thread-1" });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/interrupt`,
        })
      ).json(),
    ).toEqual({ interrupted: true });
    expect(interruptCommands.at(-1)).toMatchObject({
      type: "chat.native-control",
      chatId: queueChat.id,
      threadId: "codex-console-thread-1",
      nativeActivationGeneration: heldReceipt.activationGeneration,
      control: { kind: "interrupt" },
    });

    beginQueuedNativeCommand = async (command) => {
      if (command.chatId !== queueChat.id) return;
      const context = (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ))!;
      const session = {
        chatId: queueChat.id,
        threadId: context.threadId,
        contextKind: context.contextKind,
        projectId: context.projectId,
        placementId: context.worktreeId ?? context.scratchRootId,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        runtimeGeneration: "foundation-queue-runtime",
        connectionId: "foundation-queue-view",
      };
      const receipt =
        command.type === "chat.turn"
          ? command.nativeCommandReceipt!
          : (
              await nativeCommands.admit(
                LOCAL_USER_ID,
                nativeCommandAdmissionSchema.parse({
                  workerId: context.workerId,
                  operationId: command.operationId,
                  origin: "gui",
                  method: "turn/steer",
                  session,
                  queueClaim: command.queueClaim,
                  payloadDigest: "d".repeat(64),
                  protectedPayload: settingsEnvelope,
                  expectedActivationGeneration: (
                    await nativeCommands.controlContext(
                      LOCAL_USER_ID,
                      queueChat.id,
                    )
                  ).activationGeneration,
                  intent: {
                    scope: "thread",
                    settingKeys: [],
                    expectedTurnId: null,
                  },
                }),
              )
            ).receipt;
      expect(receipt.status, receipt.rejectionCode ?? undefined).toBe(
        "accepted",
      );
      await nativeCommands.dispatch(LOCAL_USER_ID, {
        workerId: context.workerId,
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: receipt.payloadDigest,
        session,
      });
      return async () => {
        await nativeCommands.settle(LOCAL_USER_ID, {
          workerId: context.workerId,
          operationId: receipt.operationId,
          operationGeneration: receipt.operationGeneration,
          status: "applied",
          resultDigest: "d".repeat(64),
          protectedResult: settingsEnvelope,
          rejectionCode: null,
          executionComplete: command.type === "chat.turn",
        });
      };
    };

    const firstQueuedTurn = await protectChatTurn({
      service: chatEncryptionService,
      messageId: randomUUID(),
      promptId: randomUUID(),
      mode: "default",
      reasoningEffort: null,
      modelId: selectedModel.id,
      text: "First follow-up",
      attachments: [queuedAttachment],
      idempotencyKey: "queued-first",
    });
    const firstQueued = await openQueuedPrompt(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: firstQueuedTurn,
        })
      ).json().prompt,
    );
    expect(firstQueued.attachments).toEqual([queuedAttachment]);
    const secondQueuedTurn = await protectChatTurn({
      service: chatEncryptionService,
      messageId: randomUUID(),
      promptId: randomUUID(),
      mode: "plan",
      reasoningEffort: null,
      modelId: selectedModel.id,
      text: "Second follow-up",
      idempotencyKey: "queued-second",
    });
    const secondQueued = await openQueuedPrompt(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: secondQueuedTurn,
        })
      ).json().prompt,
    );
    const queueSnapshot = (
      await firstApp.inject({
        method: "GET",
        url: `/api/chats/${queueChat.id}/queue`,
      })
    ).json();
    expect(
      encryptedQueuedPromptListSchema
        .parse(queueSnapshot.items)
        .map(({ id }) => id),
    ).toEqual([firstQueued.id, secondQueued.id]);
    const unversionedReorder = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/queue/order`,
      payload: { ids: [secondQueued.id, firstQueued.id] },
    });
    expect(unversionedReorder.statusCode).toBe(409);
    expect(unversionedReorder.json()).toEqual({
      code: "queue-revision-required",
    });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/chats/${queueChat.id}/queue/order`,
        payload: {
          ids: [secondQueued.id, firstQueued.id],
          expectedRevision: queueSnapshot.revision,
          operationId: randomUUID(),
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    const editedQueuedTurn = await protectChatTurn({
      service: chatEncryptionService,
      messageId: secondQueuedTurn.message.id,
      promptId: secondQueued.id,
      mode: "plan",
      reasoningEffort: null,
      modelId: selectedModel.id,
      text: "Edited second follow-up",
      idempotencyKey: "queued-second",
    });
    const reorderedQueue = (
      await firstApp.inject({
        method: "GET",
        url: `/api/chats/${queueChat.id}/queue`,
      })
    ).json();
    const reorderedItems = encryptedQueuedPromptListSchema.parse(
      reorderedQueue.items,
    );
    expect(reorderedItems.map(({ id }) => id)).toEqual([
      secondQueued.id,
      firstQueued.id,
    ]);
    const editedQueued = await openQueuedPrompt(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/queued-prompts/${secondQueued.id}`,
          payload: {
            prompt: { ...editedQueuedTurn.queuedPrompt, frozen: true },
            expectedItemRevision: reorderedItems[0]!.revision,
            operationId: randomUUID(),
          },
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
    const readQueueItem = async (id: string) => {
      const response = await firstApp.inject({
        method: "GET",
        url: `/api/chats/${queueChat.id}/queue`,
      });
      expect(response.statusCode).toBe(200);
      const item = encryptedQueuedPromptListSchema
        .parse(response.json().items)
        .find((prompt) => prompt.id === id);
      expect(item).toBeDefined();
      return item!;
    };
    const planSteerResponse = await firstApp.inject({
      method: "POST",
      url: `/api/queued-prompts/${secondQueued.id}/steer`,
      payload: {
        expectedItemRevision: (await readQueueItem(secondQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    expect(planSteerResponse.statusCode).toBe(409);
    expect(planSteerResponse.json()).toEqual({
      error:
        "Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.",
    });
    const frozenFirstResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${firstQueued.id}`,
      payload: {
        prompt: { ...firstQueuedTurn.queuedPrompt, frozen: true },
        expectedItemRevision: (await readQueueItem(firstQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    expect(frozenFirstResponse.statusCode).toBe(200);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/queued-prompts/${firstQueued.id}/steer`,
        payload: {
          expectedItemRevision: encryptedQueuedPromptSchema.parse(
            frozenFirstResponse.json(),
          ).revision,
          operationId: randomUUID(),
        },
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(steeredPrompts).toContain("First follow-up");
    expect(steeredAttachmentIds).toContainEqual([queuedAttachment.id]);

    const originalPauseRequest = workerBridge.request.bind(workerBridge);
    const pauseRequestSpy = vi
      .spyOn(workerBridge, "request")
      .mockImplementation(async (workerId, command, options) => {
        if (
          command.type !== "chat.native-control" ||
          command.control.kind !== "pause"
        )
          return originalPauseRequest(workerId, command, options);
        expect(command.chatId).toBe(queueChat.id);
        const paused = command.control.paused;
        const input = nativeCommandAdmissionSchema.parse({
          workerId,
          operationId: randomUUID(),
          origin: "gui",
          method: "turn/pause",
          session: {
            chatId: queueChat.id,
            threadId: queueContext.threadId,
            contextKind: queueContext.contextKind,
            projectId: queueContext.projectId,
            placementId: queueContext.worktreeId ?? queueContext.scratchRootId,
            modelRouteId: queueContext.modelRouteId,
            providerAccountId: queueContext.providerAccountId,
            runtimeGeneration: "foundation-queue-runtime",
            connectionId: "foundation-queue-view",
          },
          payloadDigest: "f".repeat(64),
          protectedPayload: settingsEnvelope,
          expectedActivationGeneration: command.nativeActivationGeneration,
          intent: {
            scope: "thread",
            settingKeys: [],
            expectedTurnId: null,
            paused,
            resumeAutonomy: !paused,
          },
        });
        const grant = await nativeCommands.admit(LOCAL_USER_ID, input);
        expect(grant.receipt.status).toBe("accepted");
        await nativeCommands.dispatch(LOCAL_USER_ID, {
          workerId,
          operationId: input.operationId,
          operationGeneration: grant.receipt.operationGeneration,
          payloadDigest: input.payloadDigest,
          session: input.session,
        });
        await nativeCommands.settle(LOCAL_USER_ID, {
          workerId,
          operationId: input.operationId,
          operationGeneration: grant.receipt.operationGeneration,
          status: "applied",
          resultDigest: null,
          protectedResult: null,
          rejectionCode: null,
          executionComplete: false,
        });
        pauseCommands.push({ chatId: command.chatId, paused });
        return {
          paused,
          active: { threadId: queueContext.threadId!, turnId: "turn-held" },
        };
      });
    const queuePauseResponse = await (async () => {
      try {
        return await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${queueChat.id}/pause`,
          payload: { paused: true },
        });
      } finally {
        pauseRequestSpy.mockRestore();
      }
    })();
    expect(queuePauseResponse.statusCode, queuePauseResponse.body).toBe(200);
    expect(chatPauseStateSchema.parse(queuePauseResponse.json())).toEqual({
      paused: true,
    });
    expect(pauseCommands.at(-1)).toEqual({
      chatId: queueChat.id,
      paused: true,
    });

    const turnsBeforeRelease = turnRequests;
    releaseHeldTurn?.();
    releaseHeldTurn = null;
    await nativeCommands.settle(LOCAL_USER_ID, {
      workerId: queueContext.workerId,
      operationId: heldReceipt.operationId,
      operationGeneration: heldReceipt.operationGeneration,
      status: "applied",
      resultDigest: "e".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    const unfrozenSecondResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${secondQueued.id}`,
      payload: {
        prompt: { ...editedQueuedTurn.queuedPrompt, frozen: false },
        expectedItemRevision: (await readQueueItem(secondQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    expect(unfrozenSecondResponse.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    expect(
      chatWireListSchema
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
    const queueResumeResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/pause`,
      payload: { paused: false },
    });
    expect(queueResumeResponse.statusCode, queueResumeResponse.body).toBe(200);
    expect(chatPauseStateSchema.parse(queueResumeResponse.json())).toEqual({
      paused: false,
    });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Edited second follow-up"),
    );
    await vi.waitFor(async () => {
      const remaining = encryptedQueuedPromptListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${queueChat.id}/queue`,
          })
        ).json().items,
      );
      expect(remaining).toHaveLength(0);
    });
    beginQueuedNativeCommand = undefined;
    expect(
      (await readChatMessages(queueChat.id)).find((message) =>
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
    const pooledChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    const pooledTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Use the account with healthy weekly usage.",
        idempotencyKey: "pooled-account-turn",
        modelId: routedModel.id,
      }),
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
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Continue on the current account.",
        idempotencyKey: "pooled-account-sticky-turn",
        modelId: routedModel.id,
      }),
    });
    expect(stickyTurn.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(turnPrompts.at(-1)).toBe("Continue on the current account."),
    );
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
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Move past the account below reserve.",
        idempotencyKey: "pooled-account-switch-turn",
        modelId: routedModel.id,
      }),
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
      "Continue this existing Cantrip conversation. The encrypted endpoint history follows:",
    );
    expect(turnPrompts.at(-1)).toContain(
      "USER: Use the account with healthy weekly usage.",
    );
    expect(turnPrompts.at(-1)).toContain(
      "USER: Continue on the current account.",
    );
    expect(turnPrompts.at(-1)).toContain(
      "USER: Move past the account below reserve.",
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
    const grokChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    const grokTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${grokChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Use the SuperGrok subscription.",
        idempotencyKey: "grok-account-turn",
        modelId: grokModel.id,
      }),
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
    const routedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    const routedTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${routedChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Use the first available provider.",
        idempotencyKey: "priority-route-turn",
        modelId: routedModel.id,
      }),
    });
    expect(routedTurn.statusCode).toBe(202);
    expect(
      chatMessageOpaqueSummarySchema.parse(routedTurn.json().message),
    ).toMatchObject({
      modelId: routedModel.id,
      modelRouteId: routedModel.routes[1]?.id,
      providerId: provider.id,
      providerModelName: "gpt-fallback",
    });
    await vi.waitFor(() => expect(turnProviderIds.at(-1)).toBe(provider.id));
    expect(turnRouteIds.at(-1)).toBe(routedModel.routes[1]?.id);

    const planChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
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
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        reasoningEffort: null,
        text: "Draft a deployment plan",
        mode: "plan",
        idempotencyKey: "plan-turn",
        modelId: selectedModel.id,
      }),
    });
    expect(planTurn.statusCode).toBe(202);
    expect(
      chatMessageOpaqueSummarySchema.parse(planTurn.json().message).mode,
    ).toBe("plan");
    await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("plan"));
    const readPlanState = async () => {
      const response = await firstApp.inject({
        method: "GET",
        url: `/api/chats/${planChat.id}/plan`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const wire = encryptedChatPlanWireStateSchema.parse(response.json());
      expect(wire.chatId).toBe(planChat.id);
      return chatPlanStateSchema.parse({
        mode: wire.mode,
        ...(await openChatPlanState({
          chatId: planChat.id,
          protectedState: wire.state,
          service: chatEncryptionService,
        })),
      });
    };
    const pendingPlan = await vi.waitFor(async () => {
      const state = await readPlanState();
      expect(state.question?.id).toBe("plan-question-1");
      return state;
    });
    expect(pendingPlan.steps).toMatchObject([
      { status: "completed" },
      { status: "inProgress" },
    ]);
    expect((await readPlanState()).question?.id).toBe("plan-question-1");
    expect(
      chatWireListSchema
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
    const planRequest =
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      );
    expect(planRequest).toMatchObject({ status: "pending" });
    const planAnswer = await protectAgentInteractionResponse({
      requestKey: "plan-question-1",
      service: chatEncryptionService,
      response: {
        kind: "userInput",
        answers: { topology: { answers: ["Four nodes"] } },
      },
    });
    const planAnswerResponse = await firstApp.inject({
      method: "POST",
      url: `/api/agent-requests/${planRequest!.id}/respond`,
      payload: planAnswer,
    });
    expect(planAnswerResponse.statusCode, planAnswerResponse.body).toBe(200);
    expect(
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      ),
    ).toMatchObject({
      status: "resolved",
      protectedResponse: planAnswer.protectedResponse,
    });
    expect(deliveredAgentInteractionResponses.at(-1)).toEqual({
      kind: "userInput",
      answers: { topology: { answers: ["Four nodes"] } },
    });
    await vi.waitFor(async () => {
      const current = chatWireListSchema
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
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Implement the approved plan",
        idempotencyKey: "default-after-plan",
        modelId: selectedModel.id,
      }),
    });
    expect(defaultTurn.statusCode).toBe(202);
    expect(
      chatMessageOpaqueSummarySchema.parse(defaultTurn.json().message).mode,
    ).toBe("default");
    await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("default"));
    expect((await readPlanState()).mode).toBe("default");

    const goalChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
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
    // Goal creation is a distinct API operation; the encrypted turn's mode
    // classifies its message but does not create native autonomy.
    const createGoalResponse = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${goalChat.id}/goal`,
      payload: { objective: "Finish the long-running goal" },
    });
    expect(createGoalResponse.statusCode, createGoalResponse.body).toBe(202);
    expect(
      chatGoalResponseSchema.parse(createGoalResponse.json()).goal,
    ).toMatchObject({
      objective: "Finish the long-running goal",
      status: "active",
      tokenBudget: null,
    });
    const goalTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${goalChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        reasoningEffort: null,
        text: "Finish the long-running goal",
        mode: "goal",
        idempotencyKey: "goal-mode-turn",
        modelId: selectedModel.id,
      }),
    });
    expect(goalTurn.statusCode).toBe(202);
    expect(
      chatMessageOpaqueSummarySchema.parse(goalTurn.json().message).mode,
    ).toBe("goal");
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
      const goalMessages = await readChatMessages(goalChat.id);
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
      const current = chatWireListSchema
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
    // Managed native runtimes own Goal continuation. The server must route the
    // resume to that session, not start a competing synthetic chat turn.
    expect(goalUpdateCommands.slice(-2).map(({ status }) => status)).toEqual([
      "paused",
      "active",
    ]);
    expect(goalUpdateCommands.at(-1)).toMatchObject({
      chatId: goalChat.id,
      status: "active",
      session: expect.any(Object),
    });
    expect(turnRequests).toBe(turnsBeforeGoalResume);
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
    const bridgedApprovalChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
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
          payload: await protectChatTurn({
            service: chatEncryptionService,
            messageId: randomUUID(),
            promptId: randomUUID(),
            mode: "default",
            reasoningEffort: null,
            text: "Request a command approval",
            idempotencyKey: "bridged-approval-turn",
            modelId: selectedModel.id,
          }),
        })
      ).statusCode,
    ).toBe(202);
    const bridgedApproval = await vi.waitFor(async () => {
      const pending = agentInteractionRequestWireListSchema.parse(
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
      agentInteractionRequestWireSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/agent-requests/${bridgedApproval.id}/respond`,
            payload: await protectAgentInteractionResponse({
              service: chatEncryptionService,
              requestKey: "runtime-bridge:approval-1",
              response: {
                kind: "commandExecution",
                decision: "decline",
                execpolicyAmendment: null,
                networkPolicyAmendment: null,
              },
            }),
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

    const layoutBeforeRestart = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
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
    const restoredSettings = settingsBundleWireSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    const messages = await readChatMessages(chat.id, secondApp);
    const restoredRichMessages = await readChatMessages(richChat.id, secondApp);

    expect(projects).toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(workers[0]?.codexRuntime).toEqual(unprobedCodexRuntimeReport);
    const restoredTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
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
      ...initialSettings.preferences,
      theme: "dark",
      highContrast: true,
      proMode: true,
      proModeOpacity: 64,
      contentGutters: true,
      eliteMode: true,
      eliteRevealConfig: {
        glitchCountMax: 2,
        glitchCountMin: 2,
        glitchShowMs: 12,
        staggerSpreadMs: 40,
        variants: ["chromatic", "scanline"],
        variantWeights: {
          outline: 1,
          "full-frame": 0.1,
          "left-frame": 0.1,
          "right-frame": 0.1,
          chromatic: 2,
          "spatial-shift": 1,
          scanline: 0.75,
          "text-jitter": 1,
        },
      },
      sidebarWidth: 352,
      showChatPromptOverlay: false,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
      defaultReasoningEffort: null,
      defaultCustomSubagentModel: false,
      defaultSubagentModelId: null,
      defaultSubagentReasoningEffort: null,
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
      explorerWireListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([
      {
        id: explorer.id,
        titleProtection: renamedExplorer.titleProtection,
        stateProtection: explorerStateProtection,
        fileMode: "edit",
      },
    ]);
    expect(
      browserWireListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([
      {
        id: browser.id,
        titleProtection: renamedBrowser.titleProtection,
        stateProtection: browserDocsState,
        stateRevision: 2,
      },
    ]);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/browsers/${browser.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const layoutAfterBrowserDelete = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    expect(
      layoutAfterBrowserDelete.panes.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).not.toContain(`browser:${browser.id}`);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const layoutAfterSurfaceDeletes = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    expect(
      layoutAfterSurfaceDeletes.panes.find(({ members }) =>
        members.some(({ tabKey }) => tabKey === `view:${groupedIssuesView.id}`),
      ),
    ).toMatchObject({
      anchorTabKey: `view:${groupedIssuesView.id}`,
      titleProtection: null,
      members: [{ tabKey: `view:${groupedIssuesView.id}` }],
    });
    for (const region of ["center", "right", "bottom"] as const) {
      const panes = layoutAfterSurfaceDeletes.panes.filter(
        (pane) => pane.region === region,
      );
      expect(panes.map(({ position }) => position)).toEqual(
        panes.map((_, position) => position),
      );
    }

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
            ...cantripRepositoryFields,
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
      expect(current?.setupStatus, JSON.stringify(current)).toBe("ready");
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
    expect(deletedProjectPaths).toEqual([relinked.source!.path, secondaryPath]);

    await secondApp.close();
  }, 15_000);
});
