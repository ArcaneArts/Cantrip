import { afterEach as __cantripTraceAfterEach } from "vitest";
import { writeFileSync as __cantripTraceWrite } from "node:fs";
const __cantripTraceRecords: Array<[number, number]> = [];
function __cantripReferenceTrace(line: number) { __cantripTraceRecords.push([line, performance.now()]); }
__cantripTraceAfterEach(() => { if (process.env.CANTRIP_REFERENCE_TRACE_PATH) __cantripTraceWrite(process.env.CANTRIP_REFERENCE_TRACE_PATH, JSON.stringify({ node: process.version, originalSourceSha256: "674ffba436356b665f479e3bf6fe6951bb97cd1a8cc41c5bc00fbcc312e4ab87", records: __cantripTraceRecords }, null, 2)); });
import { foundationAccountHandoff } from "./foundation-account-handoff-fixture.js";
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
let advanceAccountHandoff:
  | ((
      command: Extract<WorkerCommand, { type: "chat.runtime.handoff" }>,
    ) => Promise<void>)
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
      case "chat.runtime.handoff":
        if (!advanceAccountHandoff)
          throw new Error("Unexpected foundation runtime handoff");
        await advanceAccountHandoff(command);
        return null;
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
    __cantripReferenceTrace(2375);
const firstDatabase = await connectDatabase(config);
    __cantripReferenceTrace(2376);
const firstApp = await buildApp({
      config,
      database: firstDatabase,
      logger: false,
      workerBridge,
    });

    __cantripReferenceTrace(2383);
const mutationPreflight = await firstApp.inject({
      method: "OPTIONS",
      url: "/api/projects/order",
      headers: {
        origin: config.appOrigins[0]!,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });
    __cantripReferenceTrace(2392);
expect(mutationPreflight).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(2393);
expect(mutationPreflight.headers["access-control-allow-methods"]).toContain(
      "PATCH",
    );
    __cantripReferenceTrace(2396);
expect(mutationPreflight.headers["access-control-allow-methods"]).toContain(
      "DELETE",
    );

    __cantripReferenceTrace(2400);
const bootstrap = serverBootstrapSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/bootstrap" })).json(),
    );
    __cantripReferenceTrace(2403);
expect(bootstrap.auth).toMatchObject({
      mode: "none",
      state: "authenticated",
      currentUser: { kind: "anonymous", role: "owner" },
      registration: { enabled: false },
    });
    __cantripReferenceTrace(2409);
expect(bootstrap.routing.directWorkerConnections).toBe(false);
    __cantripReferenceTrace(2410);
expect(bootstrap.capabilities.worktrees).toBe(true);
    __cantripReferenceTrace(2411);
expect(bootstrap.capabilities.projectReplicas).toBe(true);
    __cantripReferenceTrace(2412);
expect(bootstrap.capabilities.replicaProvisioning).toBe(true);
    __cantripReferenceTrace(2413);
expect(bootstrap.capabilities.browserFleetDiscovery).toBe(true);
    __cantripReferenceTrace(2414);
expect(bootstrap.capabilities.crossWorkerExecutionTargets).toBe(true);
    __cantripReferenceTrace(2415);
expect(bootstrap.capabilities.remoteDesktopFleet).toBe(true);
    __cantripReferenceTrace(2416);
expect(bootstrap.capabilities.gitSync).toBe(true);

    __cantripReferenceTrace(2418);
const initialSettings = settingsBundleWireSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    __cantripReferenceTrace(2421);
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
    __cantripReferenceTrace(2452);
expect(initialSettings.providers).toEqual([]);
    __cantripReferenceTrace(2453);
expect(initialSettings.models).toEqual([]);
    __cantripReferenceTrace(2454);
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
    __cantripReferenceTrace(2476);
expect(providerResponse.statusCode, providerResponse.body).toBe(201);
    __cantripReferenceTrace(2477);
expect(providerResponse.body).not.toContain("server-only-secret");
    __cantripReferenceTrace(2478);
expect(providerResponse.body).not.toContain("apiKey");
    __cantripReferenceTrace(2479);
const provider = modelProviderWireSummarySchema.parse(
      providerResponse.json(),
    );
    __cantripReferenceTrace(2482);
expect(provider.hasApiKey).toBe(true);
    __cantripReferenceTrace(2483);
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
    __cantripReferenceTrace(2496);
expect(editedProvider).toMatchObject({
      name: "Edited test provider",
      baseUrl: "https://edited-models.example.test/v1",
      hasApiKey: true,
    });
    __cantripReferenceTrace(2501);
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
    __cantripReferenceTrace(2519);
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
    __cantripReferenceTrace(2538);
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
    __cantripReferenceTrace(2549);
const invalidProModeOpacity = await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { proModeOpacity: 101 },
    });
    __cantripReferenceTrace(2554);
expect(invalidProModeOpacity.statusCode).toBe(400);
    __cantripReferenceTrace(2555);
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
    __cantripReferenceTrace(2597);
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
    __cantripReferenceTrace(2639);
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
    __cantripReferenceTrace(2652);
expect(mergedMobileTabs.preferences.mobileProjectTabConfigurations).toEqual(
      {
        "project-1": ["group-1", null],
        "project-2": ["group-2"],
      },
    );
    __cantripReferenceTrace(2658);
expect(
      settingsBundleWireSchema.parse(
        (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
      ).preferences.mobileProjectTabConfigurations,
    ).toEqual({
      "project-1": ["group-1", null],
      "project-2": ["group-2"],
    });
    __cantripReferenceTrace(2666);
const initialChatGptAccount = protectedProviderAccount();
    __cantripReferenceTrace(2667);
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
    __cantripReferenceTrace(2682);
expect(chatGptProvider.accounts).toEqual([
      expect.objectContaining({
        ...initialChatGptAccount,
        position: 0,
      }),
    ]);
    __cantripReferenceTrace(2688);
const primaryChatGptAccount = chatGptProvider.accounts[0]!;
    __cantripReferenceTrace(2689);
await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      primaryChatGptAccount.id,
      protectedProviderCredentialFixture("B"),
      providerCredentialMetadataFixture(),
    );
    __cantripReferenceTrace(2696);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 37,
    });

    __cantripReferenceTrace(2705);
expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: "Bearer wrong-worker-token" },
        payload: {},
      }),
    ).toMatchObject({ statusCode: 401 });
    __cantripReferenceTrace(2713);
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
    __cantripReferenceTrace(2740);
expect(heartbeatResponse.statusCode).toBe(202);
    __cantripReferenceTrace(2741);
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
    __cantripReferenceTrace(2754);
expect(placementSettings.preferences).toMatchObject({
      defaultWorkerId: "test-worker",
      automaticReplicaProvisioning: true,
      automaticReplicaSynchronization: "fast-forward-primary",
      mobileProjectTabConfigurations: {
        "project-1": ["group-1", null],
        "project-2": ["group-2"],
      },
    });
    __cantripReferenceTrace(2763);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { defaultWorkerId: "unknown-worker" },
      }),
    ).toMatchObject({ statusCode: 400 });
    __cantripReferenceTrace(2770);
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
    __cantripReferenceTrace(2782);
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
    __cantripReferenceTrace(2794);
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
    __cantripReferenceTrace(2804);
expect(authProviderIds).toEqual([chatGptProvider.id]);
    __cantripReferenceTrace(2805);
expect(authCredentialHomeKeys).toEqual([chatGptProvider.id]);
    __cantripReferenceTrace(2806);
expect(authProviderKinds).toEqual(["chatgpt"]);
    __cantripReferenceTrace(2807);
expect(clearedProviderAccounts).toEqual([
      expect.objectContaining({
        providerAccountId: primaryChatGptAccount.id,
        providerId: chatGptProvider.id,
        type: "provider.auth.account.clear",
      }),
    ]);
    __cantripReferenceTrace(2814);
await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      primaryChatGptAccount.id,
      protectedProviderCredentialFixture("B"),
      providerCredentialMetadataFixture(),
    );
    __cantripReferenceTrace(2821);
const workAccount = protectedProviderAccount();
    __cantripReferenceTrace(2822);
const additionalAccountResponse = await firstApp.inject({
      method: "POST",
      url: `/api/settings/providers/${chatGptProvider.id}/accounts`,
      payload: workAccount,
    });
    __cantripReferenceTrace(2827);
expect(
      additionalAccountResponse.statusCode,
      additionalAccountResponse.body,
    ).toBe(201);
    __cantripReferenceTrace(2831);
const additionalAccount = additionalAccountResponse.json<{
      id: string;
      position: number;
    }>();
    __cantripReferenceTrace(2835);
expect(additionalAccount).toMatchObject({ ...workAccount, position: 1 });
    __cantripReferenceTrace(2836);
expect(additionalAccount).not.toHaveProperty("label");
    __cantripReferenceTrace(2837);
const reorderAccountsResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/settings/providers/${chatGptProvider.id}/accounts/order`,
      payload: { ids: [additionalAccount.id, primaryChatGptAccount.id] },
    });
    __cantripReferenceTrace(2842);
expect(
      reorderAccountsResponse.statusCode,
      reorderAccountsResponse.body,
    ).toBe(204);
    __cantripReferenceTrace(2846);
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
    __cantripReferenceTrace(2861);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/settings/providers/${chatGptProvider.id}/accounts/order`,
        payload: { ids: [additionalAccount.id] },
      }),
    ).toMatchObject({ statusCode: 400 });
    __cantripReferenceTrace(2868);
expect(
      await firstApp.inject({
        method: "GET",
        url: `/api/codex/auth/status?providerId=${chatGptProvider.id}&accountId=${additionalAccount.id}`,
      }),
    ).toMatchObject({ statusCode: 200 });
    __cantripReferenceTrace(2874);
expect(authCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    __cantripReferenceTrace(2875);
const pooledSettings = settingsBundleWireSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    __cantripReferenceTrace(2878);
expect(
      pooledSettings.providers
        .find((provider) => provider.id === chatGptProvider.id)
        ?.accounts.find((account) => account.id === additionalAccount.id),
    ).toMatchObject({
      credentialState: "signed-out",
      workerBindings: [],
    });
    __cantripReferenceTrace(2886);
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
    __cantripReferenceTrace(2899);
const initialGrokAccount = protectedProviderAccount();
    __cantripReferenceTrace(2900);
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
    __cantripReferenceTrace(2915);
expect(grokProvider.accounts).toEqual([
      expect.objectContaining({ ...initialGrokAccount, position: 0 }),
    ]);
    __cantripReferenceTrace(2918);
await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      grokProvider.id,
      grokProvider.accounts[0]!.id,
      protectedProviderCredentialFixture("C"),
      providerCredentialMetadataFixture(),
    );
    __cantripReferenceTrace(2925);
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
    __cantripReferenceTrace(2939);
expect(authProviderKinds.at(-1)).toBe("chatgpt");
    __cantripReferenceTrace(2940);
expect(authCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    __cantripReferenceTrace(2941);
const backupGrokAccount = protectedProviderAccount();
    __cantripReferenceTrace(2942);
expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/settings/providers/${grokProvider.id}/accounts`,
          payload: backupGrokAccount,
        })
      ).json(),
    ).toMatchObject({ ...backupGrokAccount, position: 1 });
    __cantripReferenceTrace(2951);
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
    __cantripReferenceTrace(2964);
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
    __cantripReferenceTrace(2974);
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
    __cantripReferenceTrace(2986);
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
    __cantripReferenceTrace(2999);
expect(githubRepositorySchema.parse(createdRepository)).toMatchObject({
      id: "github-created-repository",
      nameWithOwner: "ArcaneArts/cantrip-labs",
      isPrivate: true,
      imported: false,
    });
    __cantripReferenceTrace(3005);
expect(repositoryCreateCommands.at(-1)?.request).toEqual({
      owner: "ArcaneArts",
      name: "cantrip-labs",
      description: "A Cantrip project",
      initialize: "readme",
      visibility: "private",
    });

    __cantripReferenceTrace(3013);
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
    __cantripReferenceTrace(3030);
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
    __cantripReferenceTrace(3047);
heldProjectCloneName = "ArcaneArts/Cantrip";
    __cantripReferenceTrace(3048);
const projectResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        ...cantripRepositoryFields,
      },
    });
    __cantripReferenceTrace(3057);
expect(projectResponse.statusCode, projectResponse.body).toBe(202);
    __cantripReferenceTrace(3058);
const queuedProject = projectWireSummarySchema.parse(
      projectResponse.json(),
    );
    __cantripReferenceTrace(3061);
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
    __cantripReferenceTrace(3074);
const preferredProject = projectWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/projects/${queuedProject.id}/preferred-worker`,
          payload: { workerId: "test-worker" },
        })
      ).json(),
    );
    __cantripReferenceTrace(3083);
expect(preferredProject.preferredWorkerId).toBe("test-worker");
    __cantripReferenceTrace(3084);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${queuedProject.id}/preferred-worker`,
        payload: { workerId: "unknown-worker" },
      }),
    ).toMatchObject({ statusCode: 404 });
    __cantripReferenceTrace(3091);
await vi.waitFor(() => expect(releaseProjectClone).not.toBeNull());
    __cantripReferenceTrace(3092);
const parallelResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        ...parallelRepositoryFields,
      },
    });
    __cantripReferenceTrace(3101);
expect(parallelResponse.statusCode).toBe(202);
    __cantripReferenceTrace(3102);
const parallelProject = projectWireSummarySchema.parse(
      parallelResponse.json(),
    );
    __cantripReferenceTrace(3105);
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
    __cantripReferenceTrace(3118);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/projects/${parallelProject.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(3125);
heldProjectCloneName = null;
    __cantripReferenceTrace(3126);
releaseProjectClone?.();
    __cantripReferenceTrace(3127);
releaseProjectClone = null;
    __cantripReferenceTrace(3128);
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
    __cantripReferenceTrace(3147);
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
    __cantripReferenceTrace(3164);
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
    __cantripReferenceTrace(3176);
const initialWorkspaces = projectWorkspaceWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/workspaces" })).json(),
    );
    __cantripReferenceTrace(3179);
const defaultWorkspace = initialWorkspaces.workspaces[0]!;
    __cantripReferenceTrace(3180);
expect(defaultWorkspace).toMatchObject({
      nameProtection: { state: "system-default" },
      storage: { kind: "system" },
      isDefault: true,
      projectIds: [project.id],
    });
    __cantripReferenceTrace(3186);
const encryptionClientId = "261eec06-fd9d-4244-8bea-b44b29245ac9";
    __cantripReferenceTrace(3187);
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
    __cantripReferenceTrace(3230);
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
    __cantripReferenceTrace(3242);
expect(renamedDefaultWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: true,
    });
    __cantripReferenceTrace(3246);
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
    __cantripReferenceTrace(3259);
expect(personalWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      storage: { kind: "managed" },
      isDefault: false,
      projectIds: [],
    });
    __cantripReferenceTrace(3265);
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
    __cantripReferenceTrace(3275);
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
    __cantripReferenceTrace(3287);
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
    __cantripReferenceTrace(3299);
expect(promotedWorkspace).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: true,
    });
    __cantripReferenceTrace(3303);
const updatedWorkspaces = projectWorkspaceWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/workspaces" })).json(),
    ).workspaces;
    __cantripReferenceTrace(3306);
expect(updatedWorkspaces.filter(({ isDefault }) => isDefault)).toEqual([
      expect.objectContaining({ id: personalWorkspace.id }),
    ]);
    __cantripReferenceTrace(3309);
expect(
      updatedWorkspaces.find(({ id }) => id === defaultWorkspace.id),
    ).toMatchObject({
      nameProtection: { state: "encrypted" },
      isDefault: false,
    });
    __cantripReferenceTrace(3315);
expect(
      updatedWorkspaces.filter(({ projectIds }) =>
        projectIds.includes(project.id),
      ),
    ).toEqual([expect.objectContaining({ id: defaultWorkspace.id })]);
    __cantripReferenceTrace(3320);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${personalWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 409 });
    __cantripReferenceTrace(3326);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${defaultWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 409 });
    __cantripReferenceTrace(3332);
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
    __cantripReferenceTrace(3345);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/workspaces/${emptyWorkspace.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(3351);
const projectShareTunnelId = randomUUID();
    __cantripReferenceTrace(3352);
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
    __cantripReferenceTrace(3368);
const projectShareResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/network-shares`,
      payload: {
        tunnelId: projectShareTunnelId,
        workerId: project.source?.workerId,
        protectedRecord: projectShareRecord(projectShareTunnelId, 1),
      },
    });
    __cantripReferenceTrace(3377);
expect(projectShareResponse.statusCode).toBe(201);
    __cantripReferenceTrace(3378);
const projectShare = projectShareAttachmentWireSchema.parse(
      projectShareResponse.json(),
    );
    __cantripReferenceTrace(3381);
expect(projectShare).toMatchObject({
      attachmentId: projectShareTunnelId,
      projectId: project.id,
      protocol: "webdav",
      tunnelId: projectShareTunnelId,
    });
    __cantripReferenceTrace(3387);
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
    __cantripReferenceTrace(3400);
expect(reusedProjectShare.attachmentId).toBe(projectShare.attachmentId);
    __cantripReferenceTrace(3401);
const staleShareTunnelId = randomUUID();
    __cantripReferenceTrace(3402);
const staleShareResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/network-shares`,
      payload: {
        tunnelId: staleShareTunnelId,
        workerId: project.source?.workerId,
        protectedRecord: projectShareRecord(staleShareTunnelId, 1),
      },
    });
    __cantripReferenceTrace(3411);
expect(staleShareResponse.statusCode, staleShareResponse.body).toBe(409);
    __cantripReferenceTrace(3412);
expect(staleShareResponse.json()).toMatchObject({
      code: "project-share-state-stale",
      failureStage: "share-state-validation",
      requestId: expect.any(String),
      workerId: project.source?.workerId,
    });
    __cantripReferenceTrace(3418);
expect(openedProjectShares).toHaveLength(2);
    __cantripReferenceTrace(3419);
expect(openedProjectShares[0]).toMatchObject({
      shareId: projectShare.attachmentId,
      protectedRecord: projectShareRecord(projectShareTunnelId, 1),
    });
    __cantripReferenceTrace(3423);
expect(JSON.stringify(openedProjectShares)).not.toContain(
      project.source?.path,
    );
    __cantripReferenceTrace(3426);
const projectShareTunnels = tunnelWireListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/tunnels`,
        })
      ).json(),
    );
    __cantripReferenceTrace(3434);
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
    __cantripReferenceTrace(3449);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-shares/${projectShare.attachmentId}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(3455);
expect(closedProjectShareIds).toEqual([
      projectShare.attachmentId,
      projectShare.attachmentId,
    ]);
    __cantripReferenceTrace(3459);
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
    __cantripReferenceTrace(3469);
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
    __cantripReferenceTrace(3480);
const renamedCodeFields = protectedDisplayLabelFields(
      "code-tab",
      codeTab.id,
    );
    __cantripReferenceTrace(3484);
const renamedCodeResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/code-tabs/${codeTab.id}`,
      payload: { titleProtection: renamedCodeFields.titleProtection },
    });
    __cantripReferenceTrace(3489);
expect(renamedCodeResponse.statusCode, renamedCodeResponse.body).toBe(200);
    __cantripReferenceTrace(3490);
const renamedCode = codeTabWireSummarySchema.parse(
      renamedCodeResponse.json(),
    );
    __cantripReferenceTrace(3493);
expect(renamedCode).toMatchObject({
      id: codeTab.id,
      projectId: project.id,
      activeWorkerId: codeTab.activeWorkerId,
      worktreeId: codeTab.worktreeId,
      titleProtection: renamedCodeFields.titleProtection,
    });
    __cantripReferenceTrace(3500);
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
    __cantripReferenceTrace(3510);
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
    __cantripReferenceTrace(3524);
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
    __cantripReferenceTrace(3534);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(3540);
const remoteSurfaceFields = protectedBrowserRemoteSurfaceFields();
    __cantripReferenceTrace(3541);
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
    __cantripReferenceTrace(3556);
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
    __cantripReferenceTrace(3567);
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
    __cantripReferenceTrace(3577);
const renamedSurfaceFields = protectedDisplayLabelFields(
      "remote-surface",
      remoteSurface.id,
    );
    __cantripReferenceTrace(3581);
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
    __cantripReferenceTrace(3592);
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
    __cantripReferenceTrace(3602);
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
    __cantripReferenceTrace(3612);
await firstApp.ready();
    __cantripReferenceTrace(3613);
let resolveRejectedOrigin: ((code: number) => void) | null = null;
    __cantripReferenceTrace(3614);
const rejectedOriginPromise = new Promise<number>((resolve) => {
      resolveRejectedOrigin = resolve;
    });
    __cantripReferenceTrace(3617);
const rejectedSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteSurface.id}/connect`,
      { headers: { origin: "https://attacker.example" } },
      {
        onInit(socket) {
          socket.once("close", (code) => resolveRejectedOrigin?.(code));
        },
      },
    );
    __cantripReferenceTrace(3626);
expect(await rejectedOriginPromise).toBe(1008);
    __cantripReferenceTrace(3627);
rejectedSocket.terminate();
    __cantripReferenceTrace(3628);
let resolveReadyMessage: ((message: unknown) => void) | null = null;
    __cantripReferenceTrace(3629);
const readyMessagePromise = new Promise<unknown>((resolve) => {
      resolveReadyMessage = resolve;
    });
    __cantripReferenceTrace(3632);
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
    __cantripReferenceTrace(3643);
const readyMessage = await readyMessagePromise;
    __cantripReferenceTrace(3644);
const connection = remoteSurfaceConnectionMessageSchema.parse(readyMessage);
    __cantripReferenceTrace(3645);
expect(connection).toMatchObject({
      type: "ready",
      surfaceId: remoteSurface.id,
      transport: "websocket",
    });
    __cantripReferenceTrace(3650);
if (connection.type !== "ready") throw new Error("Surface did not attach.");

    __cantripReferenceTrace(3652);
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
    __cantripReferenceTrace(3664);
await vi.waitFor(() =>
      expect(relayedSurfaceFrames.at(-1)).toEqual({
        workerId: "test-worker",
        sequence: 0,
        payload: [1, 2, 3],
      }),
    );

    __cantripReferenceTrace(3672);
const workerFrame = new Promise<Uint8Array>((resolve) => {
      surfaceSocket.once("message", (data) =>
        resolve(new Uint8Array(data as ArrayBuffer)),
      );
    });
    __cantripReferenceTrace(3677);
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
    __cantripReferenceTrace(3689);
expect([...decodeRemoteSurfaceFrame(await workerFrame).payload]).toEqual([
      9, 8, 7,
    ]);
    __cantripReferenceTrace(3692);
surfaceSocket.terminate();
    __cantripReferenceTrace(3693);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/remote-surfaces/${remoteSurface.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(3699);
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
    __cantripReferenceTrace(3714);
const [primaryWorktree] =
      await firstDatabase.repository.listProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
      );
    __cantripReferenceTrace(3719);
expect(primaryWorktree).toBeDefined();
    __cantripReferenceTrace(3720);
const repositoryOperation = (
      type: RepositoryOperationType,
      args: Record<string, unknown> = {},
    ) =>
      workerRepositoryOperation(firstApp, bootstrap.server.id, type, args, {
        projectId: project.id,
        worktreeId: primaryWorktree!.id,
      });
    __cantripReferenceTrace(3728);
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
    __cantripReferenceTrace(3741);
expect(issueListRequests).toContainEqual({
      kind: "pull-request",
      cursor: "cursor-3",
      limit: 25,
    });
    __cantripReferenceTrace(3746);
const createdIssue = await repositoryOperation("github.issue.create", {
      request: {
        title: "Issue created from Cantrip",
        body: "Issue details from the Git tab.",
      },
    });
    __cantripReferenceTrace(3752);
expect(githubIssueDetailSchema.parse(createdIssue)).toMatchObject({
      number: 43,
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    __cantripReferenceTrace(3757);
expect(createdIssues).toContainEqual({
      title: "Issue created from Cantrip",
      body: "Issue details from the Git tab.",
    });
    // The server cannot validate encrypted arguments. The worker command
    // schema retains these input boundaries before dispatch.
    __cantripReferenceTrace(3763);
expect(
      workerCommandSchema.safeParse({
        type: "github.issue.create",
        repository: "ArcaneArts/Cantrip",
        request: { title: "   " },
      }).success,
    ).toBe(false);
    __cantripReferenceTrace(3770);
expect(
      workerCommandSchema.safeParse({
        type: "github.inbox.list",
        repository: "ArcaneArts/Cantrip",
        state: "open",
        kind: "discussion",
      }).success,
    ).toBe(false);
    __cantripReferenceTrace(3778);
expect(
      githubIssueDetailSchema.parse(
        await repositoryOperation("github.issue.get", { number: 42 }),
      ),
    ).toMatchObject({ number: 42, body: "Issue details" });
    __cantripReferenceTrace(3783);
await repositoryOperation("github.issue.comment", {
      number: 42,
      body: "Comment from Cantrip",
    });
    __cantripReferenceTrace(3787);
expect(issueComments).toContain("Comment from Cantrip");
    __cantripReferenceTrace(3788);
expect(
      githubIssueDetailSchema.parse(
        await repositoryOperation("github.issue.close", {
          number: 42,
          comment: "Closing from Cantrip",
        }),
      ).state,
    ).toBe("closed");
    __cantripReferenceTrace(3796);
expect(closedIssues).toContainEqual({
      number: 42,
      comment: "Closing from Cantrip",
    });
    __cantripReferenceTrace(3800);
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
    __cantripReferenceTrace(3815);
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
    __cantripReferenceTrace(3826);
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
    __cantripReferenceTrace(3839);
const pullRequestDetail = await repositoryOperation(
      "github.pull-request.get",
      { number: 44 },
    );
    __cantripReferenceTrace(3843);
expect(
      githubPullRequestDetailSchema.parse(pullRequestDetail),
    ).toMatchObject({
      number: 44,
      mergeable: true,
      reviewDecision: "review-required",
      checksState: "success",
    });
    __cantripReferenceTrace(3851);
expect(pullRequestGetCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
    });
    __cantripReferenceTrace(3856);
expect(
      workerCommandSchema.safeParse({
        type: "github.pull-request.get",
        cwd: primaryWorktree!.path,
        repository: "ArcaneArts/Cantrip",
        number: "not-a-number",
      }).success,
    ).toBe(false);
    __cantripReferenceTrace(3864);
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
    __cantripReferenceTrace(3876);
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
    __cantripReferenceTrace(3902);
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
    __cantripReferenceTrace(3928);
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
    __cantripReferenceTrace(3940);
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
    __cantripReferenceTrace(3952);
const lifecyclePreview = githubPullRequestLifecyclePreviewSchema.parse(
      lifecyclePreviewResult,
    );
    __cantripReferenceTrace(3955);
expect(lifecyclePreview).toMatchObject({
      confirmationPhrase: "squash #44",
      destructive: true,
    });
    __cantripReferenceTrace(3959);
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
    __cantripReferenceTrace(3970);
expect(
      githubPullRequestDetailSchema.parse(lifecycleApplyResult),
    ).toMatchObject({ state: "closed", merged: true });
    __cantripReferenceTrace(3973);
expect(pullRequestLifecyclePreviewCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
      action: { type: "merge", method: "squash" },
    });
    __cantripReferenceTrace(3979);
expect(pullRequestLifecycleApplyCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
      request: {
        token: "9".repeat(64),
        confirmation: "squash #44",
      },
    });
    __cantripReferenceTrace(3988);
const preparedCheckout = githubPullRequestCheckoutPreparedSchema.parse(
      await repositoryOperation("github.pull-request.checkout.prepare", {
        number: 44,
      }),
    );
    __cantripReferenceTrace(3993);
const checkoutMetadata = repositoryMetadataResultSchema.parse(
      await repositoryOperation("repository.metadata.register", {
        values: {
          name: preparedCheckout.name,
          branch: preparedCheckout.branch,
          startPoint: preparedCheckout.headSha,
        },
      }),
    ).values;
    __cantripReferenceTrace(4002);
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
    __cantripReferenceTrace(4014);
expect(checkoutResponse.statusCode, checkoutResponse.body).toBe(201);
    __cantripReferenceTrace(4015);
const checkoutWorktree = projectWorktreeSummarySchema.parse(
      checkoutResponse.json(),
    );
    __cantripReferenceTrace(4018);
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
    __cantripReferenceTrace(4041);
expect(pullRequestCheckoutCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      repository: "ArcaneArts/Cantrip",
      number: 44,
    });
    __cantripReferenceTrace(4046);
expect(pullRequestWorktreeCommands.at(-1)).toMatchObject({
      sourcePath: primaryWorktree!.path,
      mode: {
        type: "newBranch",
        branch: "cantrip/pr/44-feature-review-44444444",
        startPoint: "4".repeat(40),
      },
    });
    __cantripReferenceTrace(4054);
const history = gitHistorySchema.parse(
      await repositoryOperation("git.history"),
    );
    __cantripReferenceTrace(4057);
expect(history).toMatchObject({
      branch: "main",
      commits: [{ subject: "feat: test history" }],
    });
    __cantripReferenceTrace(4061);
const fileHistory = gitFileHistorySchema.parse(
      await repositoryOperation("git.file.history", {
        path: "README.md",
        revision: "HEAD",
        cursor: 0,
        limit: 25,
      }),
    );
    __cantripReferenceTrace(4069);
expect(fileHistory).toMatchObject({
      path: "README.md",
      commits: [{ subject: "Update README" }],
    });
    __cantripReferenceTrace(4073);
expect(gitFileHistoryCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      path: "README.md",
      revision: "HEAD",
      cursor: 0,
      limit: 25,
    });
    __cantripReferenceTrace(4080);
const blame = gitBlameSchema.parse(
      await repositoryOperation("git.file.blame", {
        path: "README.md",
        revision: "main",
        cursor: 200,
        limit: 100,
      }),
    );
    __cantripReferenceTrace(4088);
expect(blame).toMatchObject({
      path: "README.md",
      ranges: [{ startLine: 1, endLine: 2 }],
    });
    __cantripReferenceTrace(4092);
expect(gitFileBlameCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      revision: "main",
      cursor: 200,
      limit: 100,
    });
    __cantripReferenceTrace(4098);
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
    __cantripReferenceTrace(4110);
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
    __cantripReferenceTrace(4120);
expect(gitCommitSearchCommands.at(-1)).toMatchObject({
      cwd: primaryWorktree!.path,
      cursor: 10,
      limit: 25,
    });
    __cantripReferenceTrace(4125);
const recoveryList = gitRecoveryCandidateListSchema.parse(
      await repositoryOperation("git.recovery.list", {
        kind: "reflog",
        cursor: 20,
        limit: 25,
      }),
    );
    __cantripReferenceTrace(4132);
expect(recoveryList.entries[0]).toMatchObject({ kind: "reflog" });
    __cantripReferenceTrace(4133);
const recoveryAction = {
      type: "reset" as const,
      mode: "mixed" as const,
      target: "1".repeat(40),
    };
    __cantripReferenceTrace(4138);
const recoveryPreview = gitRecoveryPreviewSchema.parse(
      await repositoryOperation("git.recovery.preview", {
        action: recoveryAction,
      }),
    );
    __cantripReferenceTrace(4143);
const recoveryApply = gitRecoveryResultSchema.parse(
      await repositoryOperation("git.recovery.apply", {
        request: {
          action: recoveryAction,
          token: recoveryPreview.token,
          confirmation: recoveryPreview.confirmation,
        },
      }),
    );
    __cantripReferenceTrace(4152);
expect(recoveryApply).toMatchObject({
      action: recoveryAction,
      headAfter: "1".repeat(40),
    });
    __cantripReferenceTrace(4156);
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
    __cantripReferenceTrace(4171);
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
    __cantripReferenceTrace(4184);
const gitStatus = gitStatusSchema.parse(
      await repositoryOperation("git.status"),
    );
    __cantripReferenceTrace(4187);
expect(gitStatus).toMatchObject({
      branch: "main",
      ahead: 1,
      files: [{ path: "README.md", unstaged: true }],
    });
    __cantripReferenceTrace(4192);
const gitAction = gitActionResultSchema.parse(
      await repositoryOperation("git.action", { action: { type: "stageAll" } }),
    );
    __cantripReferenceTrace(4195);
expect(gitAction).toMatchObject({
      output: "Git action complete",
      status: { files: [] },
    });
    __cantripReferenceTrace(4199);
const terminalFields = protectedTerminalFields();
    __cantripReferenceTrace(4200);
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
    __cantripReferenceTrace(4212);
const terminalContent = {
      version: 1 as const,
      classification: { recordKind: "terminal-state" as const },
      directory: { kind: "relative-path" as const, path: "packages/app" },
      serviceCommand: "",
    };
    __cantripReferenceTrace(4218);
terminalFields.stateProtection = await encryptSurfacePrivateState({
      ...terminalProtection,
      content: terminalContent,
    });
    __cantripReferenceTrace(4222);
const terminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: terminalFields,
        })
      ).json(),
    );
    __cantripReferenceTrace(4231);
expect(terminal).toMatchObject({
      projectId: project.id,
      ...terminalFields,
      activeWorkerId: "test-worker",
      serviceEnabled: false,
    });
    __cantripReferenceTrace(4237);
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
    __cantripReferenceTrace(4247);
const renamedTerminal = protectedDisplayLabelFields(
      "terminal",
      terminal.id,
    );
    __cantripReferenceTrace(4251);
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
    __cantripReferenceTrace(4262);
const serviceState = await encryptSurfacePrivateState({
      ...terminalProtection,
      content: { ...terminalContent, serviceCommand: "pnpm dev" },
    });
    __cantripReferenceTrace(4266);
const enabledService = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, stateProtection: serviceState },
        })
      ).json(),
    );
    __cantripReferenceTrace(4275);
expect(enabledService).toMatchObject({
      status: "running",
      serviceEnabled: true,
      stateProtection: serviceState,
    });
    __cantripReferenceTrace(4280);
expect(terminalServiceReconciliations.at(-1)?.services).toEqual([
      expect.objectContaining({
        terminalId: terminal.id,
        serverId: bootstrap.server.id,
        worktreePath: primaryWorktree!.path,
        stateProtection: serviceState,
      }),
    ]);
    __cantripReferenceTrace(4288);
const service = terminalServiceReconciliations.at(-1)!.services[0]!;
    __cantripReferenceTrace(4289);
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
    __cantripReferenceTrace(4300);
expect(JSON.stringify(service)).not.toContain("pnpm dev");
    __cantripReferenceTrace(4301);
expect(JSON.stringify(service)).not.toContain("packages/app");
    __cantripReferenceTrace(4302);
expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/terminals/${terminal.id}/service/restart`,
        })
      ).statusCode,
    ).toBe(202);
    __cantripReferenceTrace(4310);
expect(terminalServiceRestarts).toContain(terminal.id);
    __cantripReferenceTrace(4311);
const disabledService = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: false, stateProtection: serviceState },
        })
      ).json(),
    );
    __cantripReferenceTrace(4320);
expect(disabledService).toMatchObject({
      status: "idle",
      serviceEnabled: false,
      stateProtection: serviceState,
    });
    __cantripReferenceTrace(4325);
expect(terminalServiceReconciliations.at(-1)?.services).toEqual([]);
    __cantripReferenceTrace(4326);
expect(
      (
        await firstApp.inject({
          method: "PUT",
          url: `/api/terminals/${terminal.id}/service`,
          payload: { enabled: true, stateProtection: serviceState },
        })
      ).statusCode,
    ).toBe(200);
    __cantripReferenceTrace(4335);
expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/terminals/${terminal.id}`,
        })
      ).statusCode,
    ).toBe(204);
    __cantripReferenceTrace(4343);
expect(closedTerminalIds).toContain(terminal.id);

    __cantripReferenceTrace(4345);
const duplicateResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        ...protectedProjectFields(),
        workerId: "test-worker",
        ...cantripRepositoryFields,
      },
    });
    __cantripReferenceTrace(4354);
expect(duplicateResponse.statusCode).toBe(409);

    __cantripReferenceTrace(4356);
const chatResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: protectedChatFields(),
    });
    __cantripReferenceTrace(4361);
expect(chatResponse.statusCode, chatResponse.body).toBe(201);
    __cantripReferenceTrace(4362);
const chat = chatWireSummarySchema.parse(chatResponse.json());
    __cantripReferenceTrace(4363);
const attachmentText = "A durable worker-owned attachment.";
    __cantripReferenceTrace(4364);
const attachmentId = randomUUID();
    __cantripReferenceTrace(4365);
const uploadOperationId = randomUUID();
    __cantripReferenceTrace(4366);
const attachmentScope = {
      ...attachmentProtection,
      chatId: chat.id,
      attachmentId,
    };
    __cantripReferenceTrace(4371);
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
    __cantripReferenceTrace(4384);
const uploadChunk = await encryptAttachmentChunk({
      ...attachmentScope,
      operationId: uploadOperationId,
      direction: "upload",
      sequence: 0,
      eof: true,
      plaintext: Buffer.from(attachmentText),
    });
    __cantripReferenceTrace(4392);
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
    __cantripReferenceTrace(4412);
expect(uploadedAttachment).toMatchObject({
      chatId: chat.id,
      id: attachmentId,
      protectedMetadata,
      sizeBytes: Buffer.byteLength(attachmentText),
    });
    __cantripReferenceTrace(4418);
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
    __cantripReferenceTrace(4429);
const downloadOperationId = randomUUID();
    __cantripReferenceTrace(4430);
const attachmentContent = await firstApp.inject({
      method: "GET",
      url: `/api/attachments/${uploadedAttachment.id}/content?operationId=${downloadOperationId}`,
    });
    __cantripReferenceTrace(4434);
expect(attachmentContent.statusCode).toBe(200);
    __cantripReferenceTrace(4435);
const downloaded = attachmentDownloadOpaqueSchema.parse(
      attachmentContent.json(),
    );
    __cantripReferenceTrace(4438);
expect(downloaded.operationId).toBe(downloadOperationId);
    __cantripReferenceTrace(4439);
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
    __cantripReferenceTrace(4450);
expect(Buffer.concat(downloadedBytes).toString()).toBe(attachmentText);
    __cantripReferenceTrace(4451);
downloadedBytes.forEach((bytes) => bytes.fill(0));
    __cantripReferenceTrace(4452);
expect(attachmentContent.body).not.toContain(attachmentText);
    __cantripReferenceTrace(4453);
expect(attachmentContent.body).not.toContain("notes.txt");
    __cantripReferenceTrace(4454);
const selectedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/model`,
          payload: { modelId: selectedModel.id },
        })
      ).json(),
    );
    __cantripReferenceTrace(4463);
expect(selectedChat).toMatchObject({
      modelId: selectedModel.id,
    });

    __cantripReferenceTrace(4467);
const initialPermissionProfiles = chatPermissionProfileStateSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/permission-profiles`,
        })
      ).json(),
    );
    __cantripReferenceTrace(4475);
expect(initialPermissionProfiles).toMatchObject({
      available: true,
      selectedId: ":read-only",
      effectiveId: ":read-only",
      defaultId: ":read-only",
      usesDefault: true,
      forcedByWorktreePolicy: false,
    });
    __cantripReferenceTrace(4483);
expect(initialPermissionProfiles.profiles).toContainEqual({
      id: ":yolo",
      description: "Unrestricted access without approval prompts",
      allowed: true,
    });
    __cantripReferenceTrace(4488);
await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { defaultPermissionProfileId: ":workspace" },
    });
    __cantripReferenceTrace(4493);
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
    __cantripReferenceTrace(4507);
await firstApp.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { defaultPermissionProfileId: ":read-only" },
    });
    // Bound settings are commands, not immediate server-side selection writes.
    // Simulate the native worker's admission and evidence against the real DB.
    __cantripReferenceTrace(4514);
const nativeCommands = firstDatabase.repository.nativeCommands;
    __cantripReferenceTrace(4515);
let nativeSettingsRevision = 0;
    __cantripReferenceTrace(4516);
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
    __cantripReferenceTrace(4531);
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
    __cantripReferenceTrace(4657);
const selectedPermissionProfile = await changePermission(
      ":danger-full-access",
    );
    __cantripReferenceTrace(4660);
expect(selectedPermissionProfile).toMatchObject({
      selectedId: ":danger-full-access",
      effectiveId: ":danger-full-access",
    });
    __cantripReferenceTrace(4664);
const selectedYoloProfile = await changePermission(":yolo");
    __cantripReferenceTrace(4665);
expect(selectedYoloProfile).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":yolo",
    });
    __cantripReferenceTrace(4669);
expect(await changePermission(":blocked", true)).toMatchObject({
      selectedId: ":yolo",
      effectiveId: ":yolo",
    });
    __cantripReferenceTrace(4673);
expect(
      (await nativeCommands.settingsState(LOCAL_USER_ID, chat.id))
        ?.desiredStatus,
    ).toBe("rejected");
    __cantripReferenceTrace(4677);
await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "required-for-writes" },
    });
    __cantripReferenceTrace(4682);
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
    __cantripReferenceTrace(4696);
await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "agent-managed" },
    });

    __cantripReferenceTrace(4702);
const approvalContext =
      (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      ))!;
    __cantripReferenceTrace(4707);
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
    __cantripReferenceTrace(4729);
const approvalGrant = await nativeCommands.admit(
      LOCAL_USER_ID,
      approvalTurn,
    );
    __cantripReferenceTrace(4733);
expect(approvalGrant.receipt.status).toBe("accepted");
    __cantripReferenceTrace(4734);
await nativeCommands.dispatch(LOCAL_USER_ID, {
      workerId: approvalTurn.workerId,
      operationId: approvalTurn.operationId,
      operationGeneration: approvalGrant.receipt.operationGeneration,
      payloadDigest: approvalTurn.payloadDigest,
      session: approvalTurn.session,
    });
    __cantripReferenceTrace(4741);
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
    __cantripReferenceTrace(4771);
const approval =
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      );
    __cantripReferenceTrace(4775);
expect(
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      ),
    ).toEqual(approval);
    __cantripReferenceTrace(4780);
expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    __cantripReferenceTrace(4788);
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
    __cantripReferenceTrace(4798);
const permissionChangedDuringApproval = await changePermission(null);
    __cantripReferenceTrace(4799);
expect(permissionChangedDuringApproval).toMatchObject({
      selectedId: ":read-only",
      defaultId: ":read-only",
      usesDefault: true,
    });

    __cantripReferenceTrace(4805);
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

    __cantripReferenceTrace(4821);
const resolution = {
      idempotencyKey: "resolution-1",
      response: {
        kind: "commandExecution" as const,
        decision: "decline" as const,
      },
    };
    __cantripReferenceTrace(4828);
const resolvedApproval = agentInteractionRequestSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).json(),
    );
    __cantripReferenceTrace(4837);
expect(resolvedApproval).toMatchObject({
      status: "resolved",
      response: { kind: "commandExecution", decision: "decline" },
      resolvedByUserId: LOCAL_USER_ID,
    });
    __cantripReferenceTrace(4842);
expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).statusCode,
    ).toBe(200);
    __cantripReferenceTrace(4851);
expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: { ...resolution, idempotencyKey: "resolution-2" },
        })
      ).statusCode,
    ).toBe(409);
    __cantripReferenceTrace(4860);
expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("running");
    __cantripReferenceTrace(4868);
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

    __cantripReferenceTrace(4879);
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
    __cantripReferenceTrace(4909);
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
    __cantripReferenceTrace(4919);
await firstDatabase.repository.setChatStatus(chat.id, "idle");

    __cantripReferenceTrace(4921);
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
    __cantripReferenceTrace(4946);
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
    __cantripReferenceTrace(4963);
await firstDatabase.repository.interruptAgentInteractionRequests(chat.id);
    __cantripReferenceTrace(4964);
await firstDatabase.repository.setChatStatus(chat.id, "idle");

    __cantripReferenceTrace(4966);
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
    __cantripReferenceTrace(4994);
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
    __cantripReferenceTrace(5014);
await firstDatabase.repository.setChatStatus(chat.id, "idle");

    __cantripReferenceTrace(5016);
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
    __cantripReferenceTrace(5036);
await firstDatabase.repository.resetInterruptedChatExecutions();
    __cantripReferenceTrace(5037);
expect(
      (
        await firstDatabase.repository.getAgentInteractionRequest(
          LOCAL_USER_ID,
          interruptedRequest.id,
        )
      )?.status,
    ).toBe("interrupted");
    __cantripReferenceTrace(5045);
expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("failed");
    __cantripReferenceTrace(5053);
await firstDatabase.repository.setChatStatus(chat.id, "idle");

    __cantripReferenceTrace(5055);
const customizationTarget = customizationContentScopeSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/customizations/target`,
        })
      ).json(),
    );
    __cantripReferenceTrace(5063);
const skillsOperationId = "08bc829f-8c6a-4aec-9b2c-36239ad22d32";
    __cantripReferenceTrace(5064);
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

    __cantripReferenceTrace(5079);
const inventoryOperationId = "a4c99bde-b302-4784-b064-b99b3b97a815";
    __cantripReferenceTrace(5080);
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
    __cantripReferenceTrace(5094);
expect(customizationInventoryThreadIds.at(-1)).toBe(
      approvalTurn.session.threadId,
    );
    __cantripReferenceTrace(5097);
const previewOperationId = "4d299a12-8c01-4d19-8eaf-0e966d8db12a";
    __cantripReferenceTrace(5098);
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
    __cantripReferenceTrace(5112);
const mcpResourceOperationId = "67c5b79c-caa7-4d1a-9a4f-fd00be321d9a";
    __cantripReferenceTrace(5113);
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

    __cantripReferenceTrace(5132);
const configureSkillOperationId = "5ddd4be8-a280-4f4e-b745-0be96068093a";
    __cantripReferenceTrace(5133);
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
    __cantripReferenceTrace(5151);
const skillRootsOperationId = "891db5ef-a6fb-4e5b-8954-917176576d6f";
    __cantripReferenceTrace(5152);
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
    __cantripReferenceTrace(5170);
const mcpOauthOperationId = "2a39a88b-5384-4678-81e3-a18160313aef";
    __cantripReferenceTrace(5171);
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
    __cantripReferenceTrace(5190);
const mcpOauthStatusOperationId = "20a9b172-9f0b-4d34-946d-fef443460aae";
    __cantripReferenceTrace(5191);
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
    __cantripReferenceTrace(5210);
const mcpReloadOperationId = "64112f3c-c9b0-4450-9fe2-2408a4d3a9fa";
    __cantripReferenceTrace(5211);
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
    __cantripReferenceTrace(5229);
const importOperationId = "8a616f2c-4b84-40d4-9ce4-15c6fcbe987e";
    __cantripReferenceTrace(5230);
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
    __cantripReferenceTrace(5243);
expect(importStarted.lifecycle).toBe("pending");
    __cantripReferenceTrace(5244);
const importStatusOperationId = "6c95ca67-bc25-4402-a1ae-24ab6130d001";
    __cantripReferenceTrace(5245);
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

    __cantripReferenceTrace(5265);
const messageText = "$skill-creator Persist this message.";
    __cantripReferenceTrace(5266);
const messageId = randomUUID();
    __cantripReferenceTrace(5267);
const promptId = randomUUID();
    __cantripReferenceTrace(5268);
const classification = {
      role: "user" as const,
      mode: "default" as const,
      attachmentIds: [uploadedAttachment.id],
    };
    __cantripReferenceTrace(5273);
const readableAttachment = chatAttachmentSummarySchema.parse({
      ...uploadedAttachment,
      ...(await decryptAttachmentMetadata({
        ...attachmentScope,
        encrypted: uploadedAttachment.protectedMetadata,
      })),
    });
    __cantripReferenceTrace(5280);
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
    __cantripReferenceTrace(5298);
const queueClassification = {
      mode: classification.mode,
      attachmentIds: classification.attachmentIds,
    };
    __cantripReferenceTrace(5302);
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
    __cantripReferenceTrace(5322);
expect(JSON.stringify(messagePayload)).not.toContain(messageText);
    __cantripReferenceTrace(5323);
const firstMessageResponse = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: messagePayload,
    });
    __cantripReferenceTrace(5328);
expect(firstMessageResponse.statusCode, firstMessageResponse.body).toBe(
      202,
    );
    __cantripReferenceTrace(5331);
const firstOpaqueMessage = chatMessageOpaqueSummarySchema.parse(
      firstMessageResponse.json().message,
    );
    __cantripReferenceTrace(5334);
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
    __cantripReferenceTrace(5345);
const repeatedMessage = chatMessageOpaqueSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    __cantripReferenceTrace(5354);
expect(repeatedMessage.id).toBe(firstMessage.id);
    __cantripReferenceTrace(5355);
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
    __cantripReferenceTrace(5383);
await vi.waitFor(async () => {
      const messages = await readChatMessages();
      expect(messages, `worker turns dispatched: ${turnRequests}`).toHaveLength(
        4,
      );
    });
    __cantripReferenceTrace(5389);
expect(turnRequests).toBe(1);
    __cantripReferenceTrace(5390);
expect(turnPolicyContexts[0]).toEqual({ policies: [] });
    __cantripReferenceTrace(5391);
expect(JSON.stringify(turnPolicyContexts[0])).not.toContain("bodyMarkdown");
    // The relay cannot extract skill names from ciphertext; the worker receives
    // the original mention when it opens the protected prompt.
    __cantripReferenceTrace(5394);
expect(turnSkillNames[0]).toEqual([]);
    __cantripReferenceTrace(5395);
expect(turnPrompts[0]).toBe(messageText);
    __cantripReferenceTrace(5396);
expect(turnAttachmentIds[0]).toEqual([uploadedAttachment.id]);
    __cantripReferenceTrace(5397);
expect(firstMessage.content).toContainEqual({
      type: "attachment",
      attachment: readableAttachment,
    });
    __cantripReferenceTrace(5401);
expect(turnTimeouts).toEqual([null]);
    __cantripReferenceTrace(5402);
expect(turnModelIds).toContain(selectedModel.id);
    __cantripReferenceTrace(5403);
expect(turnPermissionProfileIds[0]).toBe(":read-only");
    __cantripReferenceTrace(5404);
expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/compact`,
      }),
    ).toMatchObject({ statusCode: 200 });
    __cantripReferenceTrace(5410);
expect(compactRequests).toBe(1);
    __cantripReferenceTrace(5411);
const firstSync = agentThreadSyncSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/sync`,
        })
      ).json(),
    );
    __cantripReferenceTrace(5419);
expect(firstSync.turns).toHaveLength(1);
    __cantripReferenceTrace(5420);
await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/sync`,
    });
    __cantripReferenceTrace(5424);
const completedMessages = await readChatMessages();
    __cantripReferenceTrace(5425);
expect(completedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "8", phase: "final_answer" }],
    });
    __cantripReferenceTrace(5429);
expect(
      completedMessages.some((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "commentary",
        ),
      ),
    ).toBe(true);
    __cantripReferenceTrace(5437);
expect(
      completedMessages
        .flatMap((message) => message.content)
        .flatMap((content) =>
          content.type === "activity" ? [content.activity.type] : [],
        ),
    ).toEqual(
      expect.arrayContaining(["reasoning", "contextCompaction", "turnSummary"]),
    );
    __cantripReferenceTrace(5446);
const renamedChatFields = protectedChatFields(chat.id);
    __cantripReferenceTrace(5447);
const renamedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}`,
          payload: { titleProtection: renamedChatFields.titleProtection },
        })
      ).json(),
    );
    __cantripReferenceTrace(5456);
expect(renamedChat.titleProtection).toEqual(
      renamedChatFields.titleProtection,
    );
    __cantripReferenceTrace(5459);
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
    __cantripReferenceTrace(5471);
const duplicatedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(5480);
const forkedMessages = await readChatMessages(forkedChat.id);
    __cantripReferenceTrace(5481);
expect(forkedMessages).toHaveLength(completedMessages.length);
    __cantripReferenceTrace(5482);
expect(forkedMessages.map((message) => message.content)).toEqual(
      completedMessages.map((message) => message.content),
    );
    __cantripReferenceTrace(5485);
expect(
      forkedMessages.every(
        (message) =>
          !completedMessages.some((source) => source.id === message.id),
      ),
    ).toBe(true);
    __cantripReferenceTrace(5491);
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
    __cantripReferenceTrace(5507);
await vi.waitFor(() => expect(turnPrompts).toHaveLength(2));
    __cantripReferenceTrace(5508);
expect(turnPolicyContexts[1]).toEqual({ policies: [] });
    __cantripReferenceTrace(5509);
expect(turnPrompts[1]).toContain(
      "Continue this existing Cantrip conversation",
    );
    __cantripReferenceTrace(5512);
expect(turnPrompts[1]).toContain("The local agent replied.");
    __cantripReferenceTrace(5513);
await vi.waitFor(async () => {
      const forkMessages = await readChatMessages(forkedChat.id);
      expect(forkMessages).toHaveLength(completedMessages.length + 4);
    });
    __cantripReferenceTrace(5517);
const richChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(5526);
const richLiveEvents: AppLiveServerMessage[] = [];
    __cantripReferenceTrace(5527);
let richLiveClient: WebSocket | null = null;
    __cantripReferenceTrace(5528);
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
    __cantripReferenceTrace(5542);
if (!richLiveClient)
      throw new Error("Rich live socket did not initialize.");
    __cantripReferenceTrace(5544);
richLiveClient.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "rich-events", name: "Foundation test", version: "1" },
        resume: null,
      }),
    );
    __cantripReferenceTrace(5552);
await vi.waitFor(() =>
      expect(richLiveEvents.at(-1)).toMatchObject({ type: "ready" }),
    );
    __cantripReferenceTrace(5555);
richLiveClient.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "rich-chat",
        scopes: [{ kind: "chat", chatId: richChat.id }],
      }),
    );
    __cantripReferenceTrace(5562);
await vi.waitFor(() =>
      expect(richLiveEvents.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "rich-chat",
      }),
    );
    __cantripReferenceTrace(5568);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${richChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(5573);
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
    __cantripReferenceTrace(5587);
let richMessages = chatMessageListSchema.parse([]);
    __cantripReferenceTrace(5588);
await vi.waitFor(async () => {
      richMessages = await readChatMessages(richChat.id);
      expect(richMessages).toHaveLength(7);
    });
    __cantripReferenceTrace(5592);
expect(richMessages.map((message) => message.content[0])).toMatchObject([
      { type: "text", text: "Render rich events" },
      { type: "text", phase: "commentary" },
      { type: "activity", activity: { type: "reasoning" } },
      { type: "activity", activity: { type: "mcpToolCall" } },
      { type: "activity", activity: { type: "usage" } },
      { type: "text", phase: "final_answer" },
      { type: "activity", activity: { type: "turnSummary" } },
    ]);
    __cantripReferenceTrace(5601);
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
    __cantripReferenceTrace(5646);
expect(
      richMessages.filter((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "final_answer",
        ),
      ),
    ).toHaveLength(1);
    __cantripReferenceTrace(5654);
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
    __cantripReferenceTrace(5709);
richLiveSocket.terminate();
    __cantripReferenceTrace(5710);
const projectUsage = projectTokenUsageSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
        })
      ).json(),
    );
    __cantripReferenceTrace(5718);
expect(projectUsage.total).toEqual({
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 100,
      totalTokens: 1_100,
    });
    __cantripReferenceTrace(5726);
expect(projectUsage.daily.at(-1)).toMatchObject({ totalTokens: 1_100 });
    __cantripReferenceTrace(5727);
expect(projectUsage.providers).toContainEqual(
      expect.objectContaining({
        id: provider.id,
        name: "Edited test provider",
        totalTokens: 1_100,
      }),
    );
    __cantripReferenceTrace(5734);
expect(projectUsage.models).toContainEqual(
      expect.objectContaining({
        id: selectedModel.id,
        name: "Edited test model",
        totalTokens: 1_100,
      }),
    );
    __cantripReferenceTrace(5741);
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
    __cantripReferenceTrace(5757);
const refreshedProjectUsage = projectTokenUsageSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
        })
      ).json(),
    );
    __cantripReferenceTrace(5765);
expect(refreshedProjectUsage.total).toEqual({
      inputTokens: 1_650,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 0,
      outputTokens: 600,
      reasoningOutputTokens: 250,
      totalTokens: 2_250,
    });
    __cantripReferenceTrace(5773);
const usageSettings = settingsBundleWireSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    __cantripReferenceTrace(5776);
expect(
      usageSettings.providers.find(({ id }) => id === provider.id)?.tokenUsage,
    ).toEqual({
      inputTokens: refreshedProjectUsage.total.inputTokens,
      outputTokens: refreshedProjectUsage.total.outputTokens,
      totalTokens: refreshedProjectUsage.total.totalTokens,
    });
    __cantripReferenceTrace(5783);
expect(
      usageSettings.models.find(({ id }) => id === selectedModel.id)
        ?.tokenUsage,
    ).toEqual({
      inputTokens: refreshedProjectUsage.total.inputTokens,
      outputTokens: refreshedProjectUsage.total.outputTokens,
      totalTokens: refreshedProjectUsage.total.totalTokens,
    });
    __cantripReferenceTrace(5791);
expect(
      await firstApp.inject({
        method: "GET",
        url: "/api/projects/missing-project/token-usage",
      }),
    ).toMatchObject({ statusCode: 404 });
    __cantripReferenceTrace(5797);
const reorderedTerminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: protectedTerminalFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(5806);
const scriptOperationId = crypto.randomUUID();
    __cantripReferenceTrace(5807);
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
    __cantripReferenceTrace(5822);
const explorerFields = protectedExplorerFields();
    __cantripReferenceTrace(5823);
const explorer = explorerWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/explorers`,
          payload: explorerFields,
        })
      ).json(),
    );
    __cantripReferenceTrace(5832);
expect(explorer).toMatchObject({
      stateProtection: explorerFields.stateProtection,
      fileMode: "preview",
    });
    __cantripReferenceTrace(5836);
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
    __cantripReferenceTrace(5846);
expect(
      explorerDirectorySchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.directory.list",
          path: "",
        }),
      ).entries[0],
    ).toMatchObject({ name: "README.md", markdown: true });
    __cantripReferenceTrace(5854);
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
    __cantripReferenceTrace(5866);
expect(
      explorerFileSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.file.read",
          path: "README.md",
        }),
      ).content,
    ).toContain("Cantrip explorer");
    // Media now travels as encrypted chunks, not plaintext HTTP Range bodies.
    __cantripReferenceTrace(5875);
const readMedia = async (offset: number, limit: number) =>
      explorerMediaFileChunkSchema.parse(
        await explorerOperation(firstApp, bootstrap.server.id, explorer.id, {
          type: "explorer.media.read",
          path: "preview.png",
          offset,
          limit,
        }),
      );
    __cantripReferenceTrace(5884);
const firstChunk = await readMedia(0, 256 * 1_024);
    __cantripReferenceTrace(5885);
const lastChunk = await readMedia(256 * 1_024, 256 * 1_024);
    __cantripReferenceTrace(5886);
expect(firstChunk).toMatchObject({
      mimeType: "image/png",
      size: explorerMediaBytes.byteLength,
      offset: 0,
      eof: false,
    });
    __cantripReferenceTrace(5892);
expect(lastChunk).toMatchObject({
      size: explorerMediaBytes.byteLength,
      offset: 256 * 1_024,
      eof: true,
    });
    __cantripReferenceTrace(5897);
expect(
      Buffer.concat([
        Buffer.from(firstChunk.data, "base64"),
        Buffer.from(lastChunk.data, "base64"),
      ]).equals(explorerMediaBytes),
    ).toBe(true);
    __cantripReferenceTrace(5903);
const rangedMedia = await readMedia(2, 6);
    __cantripReferenceTrace(5904);
expect(rangedMedia).toMatchObject({ offset: 2, eof: false });
    __cantripReferenceTrace(5905);
expect(Buffer.from(rangedMedia.data, "base64")).toEqual(
      explorerMediaBytes.subarray(2, 8),
    );
    __cantripReferenceTrace(5908);
await expect(readMedia(999999, 6)).rejects.toThrow(
      "The media read offset is outside the file.",
    );
    __cantripReferenceTrace(5911);
expect(await readMedia(explorerMediaBytes.byteLength, 6)).toMatchObject({
      data: "",
      eof: true,
    });
    __cantripReferenceTrace(5915);
const explorerWriteVersion = "a".repeat(64);
    __cantripReferenceTrace(5916);
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
    __cantripReferenceTrace(5929);
expect(explorerWrites.at(-1)).toEqual({
      path: "README.md",
      content: "# Edited in Monaco\n",
      version: explorerWriteVersion,
    });
    __cantripReferenceTrace(5934);
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
    __cantripReferenceTrace(5946);
const explorerStateContent = {
      version: 1 as const,
      classification: { recordKind: "explorer-state" as const },
      selectedPath: "README.md",
    };
    __cantripReferenceTrace(5951);
const explorerStateProtection = await encryptSurfacePrivateState({
      ...explorerProtection,
      content: explorerStateContent,
    });
    __cantripReferenceTrace(5955);
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
    __cantripReferenceTrace(5967);
expect(explorerEditorState).toMatchObject({
      stateProtection: explorerStateProtection,
      fileMode: "edit",
    });
    __cantripReferenceTrace(5971);
expect(
      await decryptSurfacePrivateState({
        ...explorerProtection,
        opaque: explorerEditorState.stateProtection,
      }),
    ).toEqual(explorerStateContent);
    __cantripReferenceTrace(5977);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/explorers/${explorer.id}/view-state`,
        payload: { selectedPath: "", fileMode: "source" },
      }),
    ).toMatchObject({ statusCode: 400 });
    __cantripReferenceTrace(5984);
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
    __cantripReferenceTrace(5997);
const renamedExplorer = protectedDisplayLabelFields(
      "explorer",
      explorer.id,
    );
    __cantripReferenceTrace(6001);
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
    __cantripReferenceTrace(6012);
const browserFields = protectedDisplayLabelFields("browser");
    __cantripReferenceTrace(6013);
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
    __cantripReferenceTrace(6025);
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
    __cantripReferenceTrace(6035);
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
    __cantripReferenceTrace(6047);
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
    __cantripReferenceTrace(6063);
const renamedBrowser = protectedDisplayLabelFields("browser", browser.id);
    __cantripReferenceTrace(6064);
const browserDocsState = await browserState(2, "https://example.com/docs");
    __cantripReferenceTrace(6065);
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
    __cantripReferenceTrace(6084);
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
    __cantripReferenceTrace(6094);
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
    __cantripReferenceTrace(6104);
expect(browserSurface.configuration).toEqual({
      kind: "browser",
      profileId: null,
    });
    __cantripReferenceTrace(6108);
expect(browserSurface.stateRevision).toBe(2);
    __cantripReferenceTrace(6109);
if (!browserSurface.stateProtection)
      throw new Error("Browser protected state missing.");
    __cantripReferenceTrace(6111);
expect(
      await decryptSurfacePrivateState({
        ...browserProtection,
        opaque: browserSurface.stateProtection,
      }),
    ).toMatchObject({ revision: 2, url: "https://example.com/docs" });
    __cantripReferenceTrace(6117);
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
    __cantripReferenceTrace(6129);
const renamedProjectView = protectedDisplayLabelFields(
      "project-view",
      projectView.id,
    );
    __cantripReferenceTrace(6133);
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
    __cantripReferenceTrace(6147);
const desktopFields = protectedDisplayLabelFields("project-view");
    __cantripReferenceTrace(6148);
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
    __cantripReferenceTrace(6160);
const initialDesktopState = await encryptSurfacePrivateState({
      ...desktopProtection,
      content: {
        version: 1,
        classification: { recordKind: "remote-desktop-state" },
        revision: 1,
        target: { kind: "monitor", id: null, name: null },
      },
    });
    __cantripReferenceTrace(6169);
const remoteDesktop = remoteDesktopWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-desktops`,
          payload: { ...desktopFields, stateProtection: initialDesktopState },
        })
      ).json(),
    );
    __cantripReferenceTrace(6178);
expect(remoteDesktop).toMatchObject({
      projectId: project.id,
      workerId: "test-worker",
      status: "idle",
      stateProtection: initialDesktopState,
    });
    __cantripReferenceTrace(6184);
expect(JSON.stringify(remoteDesktop)).not.toContain("password");
    __cantripReferenceTrace(6185);
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
    __cantripReferenceTrace(6195);
const desktopTarget = {
      kind: "window" as const,
      id: "window-42",
      application: "Code",
      title: "Cantrip",
    };
    __cantripReferenceTrace(6201);
const targetedDesktopState = await encryptSurfacePrivateState({
      ...desktopProtection,
      content: {
        version: 1,
        classification: { recordKind: "remote-desktop-state" },
        revision: 2,
        target: desktopTarget,
      },
    });
    __cantripReferenceTrace(6210);
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
    __cantripReferenceTrace(6222);
expect(targetedDesktop.stateRevision).toBe(2);
    __cantripReferenceTrace(6223);
expect(
      await decryptSurfacePrivateState({
        ...desktopProtection,
        opaque: targetedDesktop.stateProtection,
      }),
    ).toMatchObject({ revision: 2, target: desktopTarget });
    __cantripReferenceTrace(6229);
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
    __cantripReferenceTrace(6244);
const initialTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(6252);
expect(
      initialTabLayout.panes
        .filter(({ region }) => region === "center")
        .every(({ members }) => members.length === 1),
    ).toBe(true);
    __cantripReferenceTrace(6257);
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
    __cantripReferenceTrace(6268);
expect(
      initialTabLayout.panes
        .filter(({ region }) => region === "bottom")
        .map(({ members }) => members.map(({ tabKey }) => tabKey)),
    ).toEqual([[`terminal:${reorderedTerminal.id}`]]);
    __cantripReferenceTrace(6273);
expect(
      initialTabLayout.panes.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).toContain(`view:${remoteDesktop.id}`);
    __cantripReferenceTrace(6278);
const explorerPane = initialTabLayout.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `explorer:${explorer.id}`),
    )!;
    __cantripReferenceTrace(6281);
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
    __cantripReferenceTrace(6294);
const groupedTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(6302);
expect(groupedTabLayout.panes).toHaveLength(initialTabLayout.panes.length);
    __cantripReferenceTrace(6303);
expect(
      groupedTabLayout.panes
        .find(({ id }) => id === explorerPane.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`explorer:${explorer.id}`, `view:${groupedIssuesView.id}`]);
    __cantripReferenceTrace(6308);
expect(
      groupedTabLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toBeNull();
    __cantripReferenceTrace(6312);
const paneLabel = protectedDisplayLabelFields("tab-group", explorerPane.id);
    __cantripReferenceTrace(6313);
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
    __cantripReferenceTrace(6325);
expect(
      renamedGroupLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toEqual(paneLabel.titleProtection);
    __cantripReferenceTrace(6329);
const trackerLabel = protectedDisplayLabelFields(
      "project-view",
      groupedIssuesView.id,
    );
    __cantripReferenceTrace(6333);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/project-views/${groupedIssuesView.id}`,
        payload: { titleProtection: trackerLabel.titleProtection },
      }),
    ).toMatchObject({ statusCode: 200 });
    __cantripReferenceTrace(6340);
const independentlyNamedLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(6348);
expect(
      independentlyNamedLayout.panes.find(({ id }) => id === explorerPane.id),
    ).toMatchObject({
      titleProtection: paneLabel.titleProtection,
      members: [
        { titleProtection: renamedExplorer.titleProtection },
        { titleProtection: trackerLabel.titleProtection },
      ],
    });
    __cantripReferenceTrace(6357);
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
    __cantripReferenceTrace(6372);
expect(
      reorderedTabLayout.panes
        .find(({ id }) => id === explorerPane.id)
        ?.members.map(({ tabKey }) => tabKey),
    ).toEqual([`view:${groupedIssuesView.id}`, `explorer:${explorer.id}`]);
    __cantripReferenceTrace(6377);
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
    __cantripReferenceTrace(6390);
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
    __cantripReferenceTrace(6405);
expect(splitTabLayout.panes[0]?.members).toMatchObject([
      {
        tabKey: `view:${groupedIssuesView.id}`,
        titleProtection: trackerLabel.titleProtection,
      },
    ]);
    __cantripReferenceTrace(6411);
expect(splitTabLayout.panes[0]?.titleProtection).toBeNull();
    __cantripReferenceTrace(6412);
expect(
      splitTabLayout.panes.find(({ id }) => id === explorerPane.id)
        ?.titleProtection,
    ).toBeNull();
    __cantripReferenceTrace(6416);
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
    __cantripReferenceTrace(6432);
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
    __cantripReferenceTrace(6442);
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
    __cantripReferenceTrace(6456);
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
    __cantripReferenceTrace(6466);
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
    __cantripReferenceTrace(6491);
expect(concurrentOrders.map(({ statusCode }) => statusCode).sort()).toEqual(
      [200, 409],
    );
    __cantripReferenceTrace(6494);
let resolveDesktopReady: ((message: unknown) => void) | null = null;
    __cantripReferenceTrace(6495);
const desktopReadyPromise = new Promise<unknown>((resolve) => {
      resolveDesktopReady = resolve;
    });
    __cantripReferenceTrace(6498);
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
    __cantripReferenceTrace(6509);
expect(
      remoteSurfaceConnectionMessageSchema.parse(await desktopReadyPromise),
    ).toMatchObject({ type: "ready", surfaceId: remoteDesktop.id });
    __cantripReferenceTrace(6512);
expect(surfaceAttachCommands.at(-1)?.desktopStream).toEqual({
      targetFps: 60,
      quality: "balanced",
    });
    __cantripReferenceTrace(6516);
const desktopAttach = surfaceAttachCommands.at(-1)!;
    __cantripReferenceTrace(6517);
expect(desktopAttach).toMatchObject({
      configuration: { kind: "desktop" },
      stateResource: "remote-desktop-row",
      stateRevision: 2,
      surfaceId: remoteDesktop.id,
      projectId: project.id,
      serverId: bootstrap.server.id,
      stateProtection: targetedDesktopState,
    });
    __cantripReferenceTrace(6526);
expect(
      await decryptSurfacePrivateState({
        ...desktopProtection,
        opaque: desktopAttach.stateProtection!,
      }),
    ).toMatchObject({ revision: 2, target: desktopTarget });
    __cantripReferenceTrace(6532);
desktopSocket.terminate();
    __cantripReferenceTrace(6533);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-views/${remoteDesktop.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(6539);
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
    __cantripReferenceTrace(6553);
const consoleFirstChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(6562);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${consoleFirstChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(6567);
const consoleFirstTerminal = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${consoleFirstChat.id}/console`,
          payload: protectedTerminalFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(6576);
expect(consoleFirstTerminal.linkedChatId).toBe(consoleFirstChat.id);
    __cantripReferenceTrace(6577);
expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        consoleFirstChat.id,
      ),
    ).toMatchObject({
      modelId: selectedModel.id,
      threadId: "codex-console-thread-1",
    });
    __cantripReferenceTrace(6586);
await firstApp.inject({
      method: "DELETE",
      url: `/api/terminals/${consoleFirstTerminal.id}`,
    });
    __cantripReferenceTrace(6590);
await firstApp.inject({
      method: "DELETE",
      url: `/api/chats/${consoleFirstChat.id}`,
    });
    __cantripReferenceTrace(6594);
const linkedConsoleFields = protectedTerminalFields();
    __cantripReferenceTrace(6595);
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
    __cantripReferenceTrace(6605);
expect(existingLinkedConsole).toBeDefined();
    __cantripReferenceTrace(6606);
const linkedConsole = terminalWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
          payload: linkedConsoleFields,
        })
      ).json(),
    );
    __cantripReferenceTrace(6615);
expect(linkedConsole).toMatchObject({
      linkedChatId: chat.id,
      projectId: project.id,
      id: existingLinkedConsole!.id,
      titleProtection: existingLinkedConsole!.titleProtection,
      stateProtection: existingLinkedConsole!.stateProtection,
    });
    __cantripReferenceTrace(6622);
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
    __cantripReferenceTrace(6633);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/terminals/${linkedConsole.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(6639);
expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/chats/${duplicatedChat.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(6645);
expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/projects/order",
        payload: { ids: [project.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(6652);
const changedModelResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(6657);
expect(changedModelResponse.statusCode).toBe(200);
    __cantripReferenceTrace(6658);
expect(
      chatWireSummarySchema.parse(changedModelResponse.json()).modelId,
    ).toBe(selectedModel.id);
    __cantripReferenceTrace(6661);
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
    __cantripReferenceTrace(6677);
await vi.waitFor(() => expect(turnModelIds).toHaveLength(3));
    __cantripReferenceTrace(6678);
expect(turnModelIds.at(-1)).toBe(selectedModel.id);

    __cantripReferenceTrace(6680);
const queueChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(6689);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(6694);
const queuedAttachment = await uploadTextAttachment(
      firstApp,
      queueChat.id,
      "queued.txt",
      "queued attachment",
    );
    __cantripReferenceTrace(6700);
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
    __cantripReferenceTrace(6714);
await vi.waitFor(() => expect(releaseHeldTurn).not.toBeNull());
    __cantripReferenceTrace(6715);
const heldReceipt = heldTurnCommand!.nativeCommandReceipt!;
    __cantripReferenceTrace(6716);
expect(heldReceipt.status).toBe("accepted");
    __cantripReferenceTrace(6717);
const queueContext =
      (await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ))!;
    __cantripReferenceTrace(6722);
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
    __cantripReferenceTrace(6739);
expect(heldDispatch.receipt.status).toBe("dispatched");
    __cantripReferenceTrace(6740);
expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queueChat.id,
      ),
    ).toMatchObject({ status: "running", threadId: "codex-console-thread-1" });
    __cantripReferenceTrace(6746);
expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/interrupt`,
        })
      ).json(),
    ).toEqual({ interrupted: true });
    __cantripReferenceTrace(6754);
expect(interruptCommands.at(-1)).toMatchObject({
      type: "chat.native-control",
      chatId: queueChat.id,
      threadId: "codex-console-thread-1",
      nativeActivationGeneration: heldReceipt.activationGeneration,
      control: { kind: "interrupt" },
    });

    __cantripReferenceTrace(6762);
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

    __cantripReferenceTrace(6832);
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
    __cantripReferenceTrace(6843);
const firstQueued = await openQueuedPrompt(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: firstQueuedTurn,
        })
      ).json().prompt,
    );
    __cantripReferenceTrace(6852);
expect(firstQueued.attachments).toEqual([queuedAttachment]);
    __cantripReferenceTrace(6853);
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
    __cantripReferenceTrace(6863);
const secondQueued = await openQueuedPrompt(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: secondQueuedTurn,
        })
      ).json().prompt,
    );
    __cantripReferenceTrace(6872);
const queueSnapshot = (
      await firstApp.inject({
        method: "GET",
        url: `/api/chats/${queueChat.id}/queue`,
      })
    ).json();
    __cantripReferenceTrace(6878);
expect(
      encryptedQueuedPromptListSchema
        .parse(queueSnapshot.items)
        .map(({ id }) => id),
    ).toEqual([firstQueued.id, secondQueued.id]);
    __cantripReferenceTrace(6883);
const unversionedReorder = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/queue/order`,
      payload: { ids: [secondQueued.id, firstQueued.id] },
    });
    __cantripReferenceTrace(6888);
expect(unversionedReorder.statusCode).toBe(409);
    __cantripReferenceTrace(6889);
expect(unversionedReorder.json()).toEqual({
      code: "queue-revision-required",
    });
    __cantripReferenceTrace(6892);
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
    __cantripReferenceTrace(6903);
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
    __cantripReferenceTrace(6913);
const reorderedQueue = (
      await firstApp.inject({
        method: "GET",
        url: `/api/chats/${queueChat.id}/queue`,
      })
    ).json();
    __cantripReferenceTrace(6919);
const reorderedItems = encryptedQueuedPromptListSchema.parse(
      reorderedQueue.items,
    );
    __cantripReferenceTrace(6922);
expect(reorderedItems.map(({ id }) => id)).toEqual([
      secondQueued.id,
      firstQueued.id,
    ]);
    __cantripReferenceTrace(6926);
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
    __cantripReferenceTrace(6939);
expect(editedQueued).toMatchObject({
      id: secondQueued.id,
      position: 0,
      frozen: true,
      mode: "plan",
      text: "Edited second follow-up",
    });
    __cantripReferenceTrace(6946);
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
    __cantripReferenceTrace(6958);
const planSteerResponse = await firstApp.inject({
      method: "POST",
      url: `/api/queued-prompts/${secondQueued.id}/steer`,
      payload: {
        expectedItemRevision: (await readQueueItem(secondQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    __cantripReferenceTrace(6966);
expect(planSteerResponse.statusCode).toBe(409);
    __cantripReferenceTrace(6967);
expect(planSteerResponse.json()).toEqual({
      error:
        "Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.",
    });
    __cantripReferenceTrace(6971);
const frozenFirstResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${firstQueued.id}`,
      payload: {
        prompt: { ...firstQueuedTurn.queuedPrompt, frozen: true },
        expectedItemRevision: (await readQueueItem(firstQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    __cantripReferenceTrace(6980);
expect(frozenFirstResponse.statusCode).toBe(200);
    __cantripReferenceTrace(6981);
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
    __cantripReferenceTrace(6993);
expect(steeredPrompts).toContain("First follow-up");
    __cantripReferenceTrace(6994);
expect(steeredAttachmentIds).toContainEqual([queuedAttachment.id]);

    __cantripReferenceTrace(6996);
const originalPauseRequest = workerBridge.request.bind(workerBridge);
    __cantripReferenceTrace(6997);
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
    __cantripReferenceTrace(7059);
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
    __cantripReferenceTrace(7070);
expect(queuePauseResponse.statusCode, queuePauseResponse.body).toBe(200);
    __cantripReferenceTrace(7071);
expect(chatPauseStateSchema.parse(queuePauseResponse.json())).toEqual({
      paused: true,
    });
    __cantripReferenceTrace(7074);
expect(pauseCommands.at(-1)).toEqual({
      chatId: queueChat.id,
      paused: true,
    });

    __cantripReferenceTrace(7079);
const turnsBeforeRelease = turnRequests;
    __cantripReferenceTrace(7080);
releaseHeldTurn?.();
    __cantripReferenceTrace(7081);
releaseHeldTurn = null;
    __cantripReferenceTrace(7082);
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
    __cantripReferenceTrace(7092);
await new Promise((resolve) => setTimeout(resolve, 25));
    __cantripReferenceTrace(7093);
expect(turnRequests).toBe(turnsBeforeRelease);
    __cantripReferenceTrace(7094);
const unfrozenSecondResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${secondQueued.id}`,
      payload: {
        prompt: { ...editedQueuedTurn.queuedPrompt, frozen: false },
        expectedItemRevision: (await readQueueItem(secondQueued.id)).revision,
        operationId: randomUUID(),
      },
    });
    __cantripReferenceTrace(7103);
expect(unfrozenSecondResponse.statusCode).toBe(200);
    __cantripReferenceTrace(7104);
await new Promise((resolve) => setTimeout(resolve, 25));
    __cantripReferenceTrace(7105);
expect(turnRequests).toBe(turnsBeforeRelease);
    __cantripReferenceTrace(7106);
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
    __cantripReferenceTrace(7118);
const queueResumeResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/pause`,
      payload: { paused: false },
    });
    __cantripReferenceTrace(7123);
expect(queueResumeResponse.statusCode, queueResumeResponse.body).toBe(200);
    __cantripReferenceTrace(7124);
expect(chatPauseStateSchema.parse(queueResumeResponse.json())).toEqual({
      paused: false,
    });
    __cantripReferenceTrace(7127);
await vi.waitFor(() =>
      expect(turnPrompts).toContain("Edited second follow-up"),
    );
    __cantripReferenceTrace(7130);
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
    __cantripReferenceTrace(7141);
beginQueuedNativeCommand = undefined;
    __cantripReferenceTrace(7142);
expect(
      (await readChatMessages(queueChat.id)).find((message) =>
        message.content.some(
          (item) =>
            item.type === "text" && item.text === "Edited second follow-up",
        ),
      )?.mode,
    ).toBe("plan");

    __cantripReferenceTrace(7151);
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
    __cantripReferenceTrace(7174);
expect(routedModel.routes).toMatchObject([
      { providerId: chatGptProvider.id, position: 0 },
      { providerId: provider.id, position: 1 },
    ]);

    __cantripReferenceTrace(7179);
authUsageByCredentialHomeKey.set(chatGptProvider.id, 98);
    __cantripReferenceTrace(7180);
authUsageByCredentialHomeKey.set(additionalAccount.id, 37);
    __cantripReferenceTrace(7181);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 98,
    });
    __cantripReferenceTrace(7189);
await firstDatabase.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      chatGptProvider.id,
      additionalAccount.id,
      protectedProviderCredentialFixture("D"),
      providerCredentialMetadataFixture(),
    );
    __cantripReferenceTrace(7196);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: additionalAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 37,
    });
    // Chat creation prepares its native runtime from the selected default.
    // A later turn body must not be used to replace that prepared binding.
    __cantripReferenceTrace(7206);
const selectNewChatModel = async (modelId: string) => {
      const response = await firstApp.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { defaultModelId: modelId },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    __cantripReferenceTrace(7214);
await selectNewChatModel(routedModel.id);
    __cantripReferenceTrace(7215);
const pooledChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7224);
const pooledThreadId = (
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        pooledChat.id,
      )
    )?.threadId;
    __cantripReferenceTrace(7230);
expect(pooledThreadId).toBe("codex-console-thread-1");
    __cantripReferenceTrace(7231);
const poolHandoff = await foundationAccountHandoff({
      repository: firstDatabase.repository,
      ownerId: LOCAL_USER_ID,
      chatId: pooledChat.id,
      targetAccountId: primaryChatGptAccount.id,
      encryption: {
        ownerId: () => LOCAL_USER_ID,
        serverIdentity: () => bootstrap.server.id,
        componentKey: () => ({
          key: Uint8Array.from(chatComponentKey),
          keyRevision: 1,
        }),
      },
    });
    __cantripReferenceTrace(7245);
advanceAccountHandoff = poolHandoff.run;
    __cantripReferenceTrace(7246);
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
    __cantripReferenceTrace(7260);
expect(pooledTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7261);
await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(additionalAccount.id),
    );
    __cantripReferenceTrace(7264);
expect(turnCredentialHomeKeys.at(-1)).toBe(additionalAccount.id);
    __cantripReferenceTrace(7265);
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
    __cantripReferenceTrace(7275);
expect(
      await firstDatabase.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        pooledChat.id,
      ),
    ).toMatchObject({ providerAccountId: additionalAccount.id });

    __cantripReferenceTrace(7282);
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
    __cantripReferenceTrace(7296);
expect(stickyTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7297);
await vi.waitFor(() =>
      expect(turnPrompts.at(-1)).toBe("Continue on the current account."),
    );
    __cantripReferenceTrace(7300);
await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(additionalAccount.id),
    );
    __cantripReferenceTrace(7303);
expect(turnThreadIds.at(-1)).toBe(pooledThreadId);
    __cantripReferenceTrace(7304);
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

    __cantripReferenceTrace(7315);
authUsageByCredentialHomeKey.set(chatGptProvider.id, 50);
    __cantripReferenceTrace(7316);
authUsageByCredentialHomeKey.set(additionalAccount.id, 98);
    __cantripReferenceTrace(7317);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: primaryChatGptAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 50,
    });
    __cantripReferenceTrace(7325);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: additionalAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 98,
    });
    __cantripReferenceTrace(7333);
const reserveTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Continue with remaining weekly allowance.",
        idempotencyKey: "pooled-account-reserve-turn",
        modelId: routedModel.id,
      }),
    });
    __cantripReferenceTrace(7347);
expect(reserveTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7348);
await vi.waitFor(() =>
      expect(turnPrompts.at(-1)).toBe(
        "Continue with remaining weekly allowance.",
      ),
    );
    __cantripReferenceTrace(7353);
await vi.waitFor(async () =>
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            pooledChat.id,
          )
        )?.status,
      ).toBe("idle"),
    );
    __cantripReferenceTrace(7363);
expect(turnProviderAccountIds.at(-1)).toBe(additionalAccount.id);
    __cantripReferenceTrace(7364);
expect(turnCredentialHomeKeys.at(-1)).toBe(additionalAccount.id);
    __cantripReferenceTrace(7365);
expect(turnThreadIds.at(-1)).toBe(pooledThreadId);
    __cantripReferenceTrace(7366);
expect(poolHandoff.count()).toBe(0);

    __cantripReferenceTrace(7368);
authUsageByCredentialHomeKey.set(additionalAccount.id, 100);
    __cantripReferenceTrace(7369);
await firstDatabase.repository.recordModelProviderAccountUsage({
      accountId: additionalAccount.id,
      ownerId: LOCAL_USER_ID,
      planType: "plus",
      providerId: chatGptProvider.id,
      resetsAt: null,
      usedPercent: 100,
    });
    __cantripReferenceTrace(7377);
const beforeHandoff = await readChatMessages(pooledChat.id);
    __cantripReferenceTrace(7378);
const switchedTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${pooledChat.id}/turns`,
      payload: await protectChatTurn({
        service: chatEncryptionService,
        messageId: randomUUID(),
        promptId: randomUUID(),
        mode: "default",
        reasoningEffort: null,
        text: "Move past the exhausted account.",
        idempotencyKey: "pooled-account-switch-turn",
        modelId: routedModel.id,
      }),
    });
    __cantripReferenceTrace(7392);
expect(switchedTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7393);
await vi.waitFor(() =>
      expect(turnProviderAccountIds.at(-1)).toBe(
        chatGptProvider.accounts[0]!.id,
      ),
    );
    __cantripReferenceTrace(7398);
expect(turnCredentialHomeKeys.at(-1)).toBe(chatGptProvider.id);
    __cantripReferenceTrace(7399);
expect(turnThreadIds.at(-1)).toBe(pooledThreadId);
    __cantripReferenceTrace(7400);
expect(poolHandoff.count()).toBe(1);
    __cantripReferenceTrace(7401);
expect(turnPrompts.at(-1)).toBe("Move past the exhausted account.");
    __cantripReferenceTrace(7402);
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
    __cantripReferenceTrace(7412);
const afterHandoff = await readChatMessages(pooledChat.id);
    __cantripReferenceTrace(7413);
expect(afterHandoff.slice(0, beforeHandoff.length)).toEqual(beforeHandoff);
    // The controlled worker emits a command and file-change activity as well
    // as the user/assistant pair. Verify every new row without duplicating the
    // history preserved by the account transfer.
    __cantripReferenceTrace(7417);
expect(afterHandoff).toHaveLength(beforeHandoff.length + 4);
    __cantripReferenceTrace(7418);
expect(afterHandoff.slice(beforeHandoff.length)).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Move past the exhausted account." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: { type: "command", status: "completed", exitCode: 0 },
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
      {
        role: "assistant",
        content: [{ type: "text", text: "The local agent replied." }],
      },
    ]);
    __cantripReferenceTrace(7450);
advanceAccountHandoff = undefined;
    __cantripReferenceTrace(7451);
authUsageByCredentialHomeKey.clear();

    __cantripReferenceTrace(7453);
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
    __cantripReferenceTrace(7471);
await selectNewChatModel(grokModel.id);
    __cantripReferenceTrace(7472);
const grokChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7481);
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
    __cantripReferenceTrace(7495);
expect(grokTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7496);
await vi.waitFor(() =>
      expect(turnProviderIds.at(-1)).toBe(grokProvider.id),
    );
    __cantripReferenceTrace(7499);
expect(turnProviderAccountIds.at(-1)).toBe(grokProvider.accounts[0]!.id);
    __cantripReferenceTrace(7500);
expect(turnCredentialHomeKeys.at(-1)).toBe(grokProvider.id);
    __cantripReferenceTrace(7501);
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

    __cantripReferenceTrace(7512);
exhaustedProviderIds.add(chatGptProvider.id);
    __cantripReferenceTrace(7513);
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
    __cantripReferenceTrace(7523);
await selectNewChatModel(routedModel.id);
    __cantripReferenceTrace(7524);
const routedChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7533);
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
    __cantripReferenceTrace(7547);
expect(routedTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7548);
expect(
      chatMessageOpaqueSummarySchema.parse(routedTurn.json().message),
    ).toMatchObject({
      modelId: routedModel.id,
      modelRouteId: routedModel.routes[1]?.id,
      providerId: provider.id,
      providerModelName: "gpt-fallback",
    });
    __cantripReferenceTrace(7556);
await vi.waitFor(() => expect(turnProviderIds.at(-1)).toBe(provider.id));
    __cantripReferenceTrace(7557);
expect(turnRouteIds.at(-1)).toBe(routedModel.routes[1]?.id);

    __cantripReferenceTrace(7559);
await selectNewChatModel(selectedModel.id);
    __cantripReferenceTrace(7560);
const planChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7569);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${planChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(7574);
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
    __cantripReferenceTrace(7588);
expect(planTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7589);
expect(
      chatMessageOpaqueSummarySchema.parse(planTurn.json().message).mode,
    ).toBe("plan");
    __cantripReferenceTrace(7592);
await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("plan"));
    __cantripReferenceTrace(7593);
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
    __cantripReferenceTrace(7610);
const pendingPlan = await vi.waitFor(async () => {
      const state = await readPlanState();
      expect(state.question?.id).toBe("plan-question-1");
      return state;
    });
    __cantripReferenceTrace(7615);
expect(pendingPlan.steps).toMatchObject([
      { status: "completed" },
      { status: "inProgress" },
    ]);
    __cantripReferenceTrace(7619);
expect((await readPlanState()).question?.id).toBe("plan-question-1");
    __cantripReferenceTrace(7620);
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
    __cantripReferenceTrace(7632);
const planRequest =
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      );
    __cantripReferenceTrace(7637);
expect(planRequest).toMatchObject({ status: "pending" });
    __cantripReferenceTrace(7638);
const planAnswer = await protectAgentInteractionResponse({
      requestKey: "plan-question-1",
      service: chatEncryptionService,
      response: {
        kind: "userInput",
        answers: { topology: { answers: ["Four nodes"] } },
      },
    });
    __cantripReferenceTrace(7646);
const planAnswerResponse = await firstApp.inject({
      method: "POST",
      url: `/api/agent-requests/${planRequest!.id}/respond`,
      payload: planAnswer,
    });
    __cantripReferenceTrace(7651);
expect(planAnswerResponse.statusCode, planAnswerResponse.body).toBe(200);
    __cantripReferenceTrace(7652);
expect(
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      ),
    ).toMatchObject({
      status: "resolved",
      protectedResponse: planAnswer.protectedResponse,
    });
    __cantripReferenceTrace(7661);
expect(deliveredAgentInteractionResponses.at(-1)).toEqual({
      kind: "userInput",
      answers: { topology: { answers: ["Four nodes"] } },
    });
    __cantripReferenceTrace(7665);
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
    __cantripReferenceTrace(7682);
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
    __cantripReferenceTrace(7696);
expect(defaultTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7697);
expect(
      chatMessageOpaqueSummarySchema.parse(defaultTurn.json().message).mode,
    ).toBe("default");
    __cantripReferenceTrace(7700);
await vi.waitFor(() => expect(turnPlanModes.at(-1)).toBe("default"));
    __cantripReferenceTrace(7701);
expect((await readPlanState()).mode).toBe("default");

    __cantripReferenceTrace(7703);
const goalChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7712);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${goalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(7717);
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
    __cantripReferenceTrace(7729);
const createGoalResponse = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${goalChat.id}/goal`,
      payload: { objective: "Finish the long-running goal" },
    });
    __cantripReferenceTrace(7734);
expect(createGoalResponse.statusCode, createGoalResponse.body).toBe(202);
    __cantripReferenceTrace(7735);
expect(
      chatGoalResponseSchema.parse(createGoalResponse.json()).goal,
    ).toMatchObject({
      objective: "Finish the long-running goal",
      status: "active",
      tokenBudget: null,
    });
    __cantripReferenceTrace(7742);
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
    __cantripReferenceTrace(7756);
expect(goalTurn.statusCode).toBe(202);
    __cantripReferenceTrace(7757);
expect(
      chatMessageOpaqueSummarySchema.parse(goalTurn.json().message).mode,
    ).toBe("goal");
    __cantripReferenceTrace(7760);
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
    __cantripReferenceTrace(7772);
expect(createdGoal).toMatchObject({
      objective: "Finish the long-running goal",
      status: "active",
      tokenBudget: null,
    });
    __cantripReferenceTrace(7777);
await vi.waitFor(() =>
      expect(turnPrompts).toContain("Finish the long-running goal"),
    );
    __cantripReferenceTrace(7780);
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
    __cantripReferenceTrace(7795);
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
    __cantripReferenceTrace(7808);
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
    __cantripReferenceTrace(7819);
const turnsBeforeGoalResume = turnRequests;
    __cantripReferenceTrace(7820);
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
    __cantripReferenceTrace(7833);
expect(goalUpdateCommands.slice(-2).map(({ status }) => status)).toEqual([
      "paused",
      "active",
    ]);
    __cantripReferenceTrace(7837);
expect(goalUpdateCommands.at(-1)).toMatchObject({
      chatId: goalChat.id,
      status: "active",
      session: expect.any(Object),
    });
    __cantripReferenceTrace(7842);
expect(turnRequests).toBe(turnsBeforeGoalResume);
    __cantripReferenceTrace(7843);
expect(turnPolicyContexts).toHaveLength(turnRequests);
    __cantripReferenceTrace(7844);
expect(
      turnPolicyContexts.every((context) => context.policies.length === 0),
    ).toBe(true);
    __cantripReferenceTrace(7847);
expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/chats/${goalChat.id}/goal`,
        })
      ).json(),
    ).toEqual({ cleared: true });
    __cantripReferenceTrace(7855);
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

    __cantripReferenceTrace(7866);
deliveredAgentInteractionResponses.length = 0;
    __cantripReferenceTrace(7867);
const bridgedApprovalChat = chatWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: protectedChatFields(),
        })
      ).json(),
    );
    __cantripReferenceTrace(7876);
const approvalLiveEvents: AppLiveServerMessage[] = [];
    __cantripReferenceTrace(7877);
let approvalLiveClient: WebSocket | null = null;
    __cantripReferenceTrace(7878);
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
    __cantripReferenceTrace(7892);
if (!approvalLiveClient) {
      throw new Error("Approval live socket did not initialize.");
    }
    __cantripReferenceTrace(7895);
approvalLiveClient.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "approval", name: "Foundation test", version: "1" },
        resume: null,
      }),
    );
    __cantripReferenceTrace(7903);
await vi.waitFor(() =>
      expect(approvalLiveEvents.at(-1)).toMatchObject({ type: "ready" }),
    );
    __cantripReferenceTrace(7906);
approvalLiveClient.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "approval-chat",
        scopes: [{ kind: "chat", chatId: bridgedApprovalChat.id }],
      }),
    );
    __cantripReferenceTrace(7913);
await vi.waitFor(() =>
      expect(approvalLiveEvents.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "approval-chat",
      }),
    );
    __cantripReferenceTrace(7919);
await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${bridgedApprovalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    __cantripReferenceTrace(7924);
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
    __cantripReferenceTrace(7942);
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
    __cantripReferenceTrace(7954);
expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          bridgedApprovalChat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    __cantripReferenceTrace(7962);
expect(deliveredAgentInteractionResponses).toEqual([]);
    __cantripReferenceTrace(7963);
await vi.waitFor(() =>
      expect(
        approvalLiveEvents.filter(
          (event) =>
            event.type === "event" && event.resource === "agent-interaction",
        ),
      ).toHaveLength(1),
    );
    __cantripReferenceTrace(7971);
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
    __cantripReferenceTrace(7991);
expect(deliveredAgentInteractionResponses).toEqual([
      {
        kind: "commandExecution",
        decision: "decline",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      },
    ]);
    __cantripReferenceTrace(7999);
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
    __cantripReferenceTrace(8009);
await vi.waitFor(() =>
      expect(
        approvalLiveEvents.filter(
          (event) =>
            event.type === "event" && event.resource === "agent-interaction",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    __cantripReferenceTrace(8017);
approvalLiveSocket.terminate();

    __cantripReferenceTrace(8019);
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
    __cantripReferenceTrace(8034);
const secondaryPath = path.join(
      dataDirectory,
      "secondary-repositories",
      "Cantrip",
    );
    __cantripReferenceTrace(8039);
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
    __cantripReferenceTrace(8052);
expect(completedSecondary?.replicas).toHaveLength(2);
    __cantripReferenceTrace(8053);
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
    __cantripReferenceTrace(8080);
const replicatedProjects = projectWireListSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    __cantripReferenceTrace(8083);
expect(replicatedProjects).toHaveLength(1);
    __cantripReferenceTrace(8084);
const replicatedProject = replicatedProjects[0]!;
    __cantripReferenceTrace(8085);
expect(replicatedProject.source?.workerId).toBe("test-worker");
    __cantripReferenceTrace(8086);
expect(replicatedProject.replicas).toHaveLength(2);
    __cantripReferenceTrace(8087);
const replicas = projectReplicaListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/replicas`,
        })
      ).json(),
    );
    __cantripReferenceTrace(8095);
expect(replicas.map(({ workerId }) => workerId)).toEqual([
      "test-worker",
      "test-worker-secondary",
    ]);
    __cantripReferenceTrace(8099);
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
    __cantripReferenceTrace(8116);
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

    __cantripReferenceTrace(8136);
const layoutBeforeRestart = projectTabLayoutWireSummarySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(8144);
await firstApp.close();

    __cantripReferenceTrace(8146);
const secondDatabase = await connectDatabase(config);
    __cantripReferenceTrace(8147);
const secondApp = await buildApp({
      config,
      database: secondDatabase,
      logger: false,
      workerBridge,
    });

    __cantripReferenceTrace(8154);
const projects = projectWireListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    __cantripReferenceTrace(8157);
const workers = workerListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/workers" })).json(),
    );
    __cantripReferenceTrace(8160);
const restoredSettings = settingsBundleWireSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    __cantripReferenceTrace(8163);
const messages = await readChatMessages(chat.id, secondApp);
    __cantripReferenceTrace(8164);
const restoredRichMessages = await readChatMessages(richChat.id, secondApp);

    __cantripReferenceTrace(8166);
expect(projects).toHaveLength(1);
    __cantripReferenceTrace(8167);
expect(workers).toHaveLength(2);
    __cantripReferenceTrace(8168);
expect(workers[0]?.codexRuntime).toEqual(unprobedCodexRuntimeReport);
    __cantripReferenceTrace(8169);
const restoredTabLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(8177);
expect(restoredTabLayout).toEqual(layoutBeforeRestart);
    __cantripReferenceTrace(8178);
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
    __cantripReferenceTrace(8209);
expect(restoredRichMessages).toHaveLength(7);
    __cantripReferenceTrace(8210);
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
    __cantripReferenceTrace(8220);
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
    __cantripReferenceTrace(8263);
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
    __cantripReferenceTrace(8280);
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
    __cantripReferenceTrace(8297);
expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/browsers/${browser.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(8303);
const layoutAfterBrowserDelete = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(8311);
expect(
      layoutAfterBrowserDelete.panes.flatMap(({ members }) =>
        members.map(({ tabKey }) => tabKey),
      ),
    ).not.toContain(`browser:${browser.id}`);
    __cantripReferenceTrace(8316);
expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(8322);
const layoutAfterSurfaceDeletes = projectTabLayoutWireSummarySchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/panes`,
        })
      ).json(),
    );
    __cantripReferenceTrace(8330);
expect(
      layoutAfterSurfaceDeletes.panes.find(({ members }) =>
        members.some(({ tabKey }) => tabKey === `view:${groupedIssuesView.id}`),
      ),
    ).toMatchObject({
      anchorTabKey: `view:${groupedIssuesView.id}`,
      titleProtection: null,
      members: [{ tabKey: `view:${groupedIssuesView.id}` }],
    });
    __cantripReferenceTrace(8339);
for (const region of ["center", "right", "bottom"] as const) {
      const panes = layoutAfterSurfaceDeletes.panes.filter(
        (pane) => pane.region === region,
      );
      expect(panes.map(({ position }) => position)).toEqual(
        panes.map((_, position) => position),
      );
    }

    __cantripReferenceTrace(8348);
const unlinkResponse = await secondApp.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: false },
    });
    __cantripReferenceTrace(8353);
expect(unlinkResponse.statusCode).toBe(204);
    __cantripReferenceTrace(8354);
expect(deletedProjectPaths).toEqual([]);
    __cantripReferenceTrace(8355);
expect(
      projectWireListSchema.parse(
        (
          await secondApp.inject({ method: "GET", url: "/api/projects" })
        ).json(),
      ),
    ).toEqual([]);

    __cantripReferenceTrace(8363);
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
    __cantripReferenceTrace(8376);
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
    __cantripReferenceTrace(8387);
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
    __cantripReferenceTrace(8399);
expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/projects/${relinked.id}`,
        payload: { deleteLocalFiles: true },
      }),
    ).toMatchObject({ statusCode: 204 });
    __cantripReferenceTrace(8406);
expect(deletedProjectPaths).toEqual([relinked.source!.path, secondaryPath]);

    __cantripReferenceTrace(8408);
await secondApp.close();

__cantripReferenceTrace(-1);
}, 15_000);
});
