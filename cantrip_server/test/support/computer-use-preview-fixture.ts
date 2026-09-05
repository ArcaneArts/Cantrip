import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import Fastify from "fastify";
import type {
  ComputerUseChunkEvent,
  EncryptedAgentInteractionRequest,
  ChatMessageOpaqueContent,
  TaskMessageOpaqueContent,
} from "@cantrip/protocol";
import { publishCuaPreviewActivity } from "../../../cantrip_worker/src/computer-use/activity-publication.js";
import type { WorkerEncryptionService } from "../../../cantrip_worker/src/worker-encryption.js";
import { CuaApprovalManager } from "../../../cantrip_worker/src/computer-use/approvals.js";
import type { CuaAgentCoordinator } from "../../../cantrip_worker/src/computer-use/agent.js";
import { CuaPreviewCoordinator } from "../../../cantrip_worker/src/computer-use/preview.js";
import { CantripCuaService } from "../../../cantrip_worker/src/computer-use/service.js";
import { launchCuaTransport } from "../../../cantrip_worker/src/computer-use/transport.js";
import {
  installAgentInteractionRoutes,
  type AgentInteractionRouteDependencies,
} from "../../src/app/routes/agent-interactions.js";
import {
  computerUsePreviewAuthority,
  createComputerUseApprovalPublications,
  installComputerUsePreviewRoutes,
  type ComputerUsePreviewRouteDependencies,
} from "../../src/app/routes/computer-use-preview.js";
import {
  installComputerUseRoutes,
  type ComputerUseRouteDependencies,
} from "../../src/app/routes/computer-use.js";
import type { ChatExecutionContext } from "../../src/db/repository.js";

/** Synthetic local QA fixture only. No application database, encryption profile,
 * keychain, real account, or RemoteDesktop machinery. Native capture requires
 * an explicit opt-in; ordinary tests always use the fake backend. */
export function createComputerUsePreviewFixture(options: {
  binary: string;
  permissionProfile?: string;
  backend?: "fake" | "native";
  agentObservations?: Pick<
    CuaAgentCoordinator,
    "listObservations" | "readObservation"
  >;
  onRevokeChat?: (chatId: string) => void;
  context?: Partial<ChatExecutionContext>;
  afterChunkPublished?: (event: ComputerUseChunkEvent) => Promise<void>;
  /** Real scoped worker keys for grant-boundary regressions; synthetic only. */
  scopedEncryption?: {
    service: WorkerEncryptionService;
    clientControlKey: Uint8Array;
  };
}) {
  const wire: string[] = [];
  const logs: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(line) } },
  });
  const credentials = {
    ownerId: options.scopedEncryption?.service.ownerId() ?? "fixture-owner",
    serverId:
      options.scopedEncryption?.service.serverIdentity() ?? "fixture-server",
    workerId: "fixture-worker",
    chatId: "fixture-chat",
    componentKey:
      options.scopedEncryption?.clientControlKey.slice() ??
      new Uint8Array(randomBytes(32)),
  };
  let launches = 0;
  const children: ChildProcess[] = [];
  const service = new CantripCuaService({
    workerId: credentials.workerId,
    binary: options.binary,
    args: options.backend === "native" ? [] : ["--backend", "fake"],
    launch: (binary, transportOptions) => {
      launches += 1;
      return launchCuaTransport(binary, {
        ...transportOptions,
        spawnProcess: ((...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          children.push(child);
          return child;
        }) as typeof spawn,
      });
    },
  });
  const encryption = options.scopedEncryption?.service ?? {
    ownerId: () => credentials.ownerId,
    serverIdentity: () => credentials.serverId,
    componentKey: () => ({
      key: credentials.componentKey.slice(),
      keyRevision: 1,
    }),
  };
  const approvals = new CuaApprovalManager({
    workerId: credentials.workerId,
    encryption,
  });
  const coordinator = new CuaPreviewCoordinator({
    workerId: credentials.workerId,
    encryption,
    approvals,
    service,
    publishActivity: (activity, contentDomain, emit) =>
      publishCuaPreviewActivity({
        encryption: encryption as WorkerEncryptionService,
        activity,
        contentDomain,
        emit,
      }),
    agentObservations: options.agentObservations,
    onRevokeChat: options.onRevokeChat,
  });
  const context = {
    chatId: credentials.chatId,
    experience: "agent",
    workerId: credentials.workerId,
    projectId: null,
    contextKind: "standalone",
    worktreeId: null,
    scratchRootId: "fixture-scratch",
    computerUseAuthorityGeneration: 1,
    isPrimary: true,
    worktreePolicy: null,
    permissionProfileId: options.permissionProfile ?? ":yolo",
    defaultPermissionProfileId: ":default",
    executionLaneId: "real-agent-lane",
    threadId: "real-agent-thread",
    status: "running",
    modelId: null,
    ...options.context,
  } as ChatExecutionContext;
  const records = new Map<string, EncryptedAgentInteractionRequest>();
  const resolutionKeys = new Map<string, string>();
  const getChatExecutionContext: ComputerUsePreviewRouteDependencies["repository"]["getChatExecutionContext"] =
    async (owner, chat) =>
      owner === credentials.ownerId && chat === credentials.chatId
        ? context
        : null;
  const getWorker: ComputerUsePreviewRouteDependencies["repository"]["getWorker"] =
    async (owner, worker) =>
      owner === credentials.ownerId && worker === credentials.workerId
        ? ({ workerId: worker } as NonNullable<
            Awaited<ReturnType<typeof getWorker>>
          >)
        : null;
  const request: ComputerUseRouteDependencies["bridge"]["request"] = async (
    worker,
    command,
    operation,
  ) => {
    if (
      worker !== credentials.workerId ||
      operation?.ownerId !== credentials.ownerId
    )
      throw new Error("Fixture routing owner mismatch.");
    wire.push(JSON.stringify(command));
    let result: unknown;
    switch (command.type) {
      case "computer-use.preview.open":
        result = coordinator.open(command.authority, command.contentDomain);
        break;
      case "computer-use.preview.stop":
        result = await coordinator.stop(command, async (event) => {
          wire.push(JSON.stringify(event));
          await operation?.onEvent?.(event);
        });
        break;
      case "computer-use.approval.respond":
        result = await coordinator.answer(command);
        break;
      case "computer-use.operation":
        if (command.executionLaneId !== null)
          throw new Error("Preview borrowed an agent lane.");
        result = await coordinator.execute(command, async (event) => {
          wire.push(JSON.stringify(event));
          await operation?.onEvent?.(event);
          if (event.type === "computer-use.snapshot.chunk")
            await options.afterChunkPublished?.(event);
        });
        break;
      default:
        throw new Error("Unexpected fixture command.");
    }
    wire.push(JSON.stringify(result));
    return result;
  };
  const terminalize: NonNullable<
    ComputerUseRouteDependencies["terminalizeLiveAgentInteractionRequest"]
  > = async (key, chat, worker, status) => {
    const record = [...records.values()].find(
      (entry) =>
        entry.requestKey === key &&
        entry.provenance.chatId === chat &&
        entry.provenance.workerId === worker,
    );
    if (!record || record.status !== "pending") return null;
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    return record;
  };
  const bridge = {
    request,
    isConnected: () => {
      throw new Error(
        "Fixture must attempt commands, not connectivity preflights.",
      );
    },
  };
  const chatActivities = new Map<string, ChatMessageOpaqueContent>();
  const taskActivities = new Map<string, TaskMessageOpaqueContent>();
  const activityPersistence = {
    upsertLiveEncryptedChatMessage: async (
      owner: string,
      chat: string,
      message: ChatMessageOpaqueContent,
    ) => {
      if (
        owner !== credentials.ownerId ||
        chat !== credentials.chatId ||
        context.experience !== "agent"
      )
        return null;
      chatActivities.set(message.id, structuredClone(message));
      return message;
    },
    upsertLiveTaskMessage: async (
      owner: string,
      chat: string,
      message: TaskMessageOpaqueContent,
    ) => {
      if (
        owner !== credentials.ownerId ||
        chat !== credentials.chatId ||
        context.experience !== "task"
      )
        return null;
      taskActivities.set(message.id, structuredClone(message));
      return message;
    },
  };
  installComputerUsePreviewRoutes(app, {
    ...activityPersistence,
    applicationOwnerId: () => credentials.ownerId,
    serverId: credentials.serverId,
    repository: { getChatExecutionContext, getWorker },
    bridge,
  });
  installComputerUseRoutes(app, {
    ...activityPersistence,
    applicationOwnerId: () => credentials.ownerId,
    serverId: credentials.serverId,
    repository: { getChatExecutionContext },
    bridge,
    requirePreviewLease: true,
    approvalPublications: createComputerUseApprovalPublications(),
    authorize: async ({ ownerId, context }) =>
      computerUsePreviewAuthority({
        ownerId,
        serverId: credentials.serverId,
        context,
      }),
    recordLiveEncryptedAgentInteractionRequest: async (input) => {
      const timestamp = new Date().toISOString();
      const record: EncryptedAgentInteractionRequest = {
        ...input,
        id: randomUUID(),
        status: "pending",
        protectedResponse: null,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: input.expiresAt ?? null,
      };
      records.set(record.id, record);
      return record;
    },
    terminalizeLiveAgentInteractionRequest: terminalize,
  });
  const repository: AgentInteractionRouteDependencies["repository"] = {
    getChatExecutionContext,
    listAgentInteractionRequests: async (owner, query) =>
      owner === credentials.ownerId
        ? [...records.values()].filter(
            (record) =>
              (!query.chatId || record.provenance.chatId === query.chatId) &&
              (!query.status || record.status === query.status),
          )
        : [],
    getAgentInteractionRequest: async (owner, id) =>
      owner === credentials.ownerId ? (records.get(id) ?? null) : null,
    validateEncryptedAgentInteractionResolution: async (owner, id, input) => {
      if (owner !== credentials.ownerId) return null;
      const record = records.get(id);
      if (!record) return null;
      if (
        record.status !== "pending" &&
        resolutionKeys.get(id) !== input.idempotencyKey
      )
        throw new Error("Fixture approval is not pending.");
      return record;
    },
    validateAgentInteractionResolution: async () => {
      throw new Error("Fixture CUA approvals require protected responses.");
    },
  };
  installAgentInteractionRoutes(app, {
    applicationOwnerId: () => credentials.ownerId,
    serverId: credentials.serverId,
    repository,
    bridge,
    runtimeForContext: async () => {
      throw new Error("CUA must not resolve or launch an agent model.");
    },
    resolveLiveAgentInteractionRequest: async () => {
      throw new Error("Plaintext resolution is not supported.");
    },
    resolveLiveEncryptedAgentInteractionRequest: async (owner, id, input) => {
      if (owner !== credentials.ownerId) return null;
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, {
        status: "resolved",
        protectedResponse: input.protectedResponse,
        resolvedByUserId: owner,
        resolvedAt: new Date().toISOString(),
      });
      resolutionKeys.set(id, input.idempotencyKey);
      return record;
    },
  });
  return {
    app,
    credentials,
    encryption,
    context,
    service,
    children,
    coordinator,
    approvals,
    wire,
    logs,
    records,
    chatActivities,
    taskActivities,
    activityPersistence,
    get launchCount() {
      return launches;
    },
    async close() {
      coordinator.close();
      approvals.close();
      await Promise.all([app.close(), service.close()]);
      credentials.componentKey.fill(0);
    },
  };
}
