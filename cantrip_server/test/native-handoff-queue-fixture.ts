import { createManagedQueueDelivery } from "../src/app/runtime/managed-queue-delivery.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { NativeCommandSession } from "@cantrip/protocol";
import type { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { LOCAL_USER_ID as ownerId } from "../src/db/repository.js";
import { createChatRecoveryRuntime } from "../src/app/runtime/chat-recovery-runtime.js";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { protectNativeCommandContent } from "../../cantrip_worker/src/native-command-content.js";
import type { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import type { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.js";
import type { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.js";
import type { HandoffRuntime } from "../../cantrip_worker/src/codex/managed-runtime-handoff.js";

type Fixture = Awaited<ReturnType<typeof createNativeSettingsFixture>>;
/** Canonical queue claim/dispatch, encrypted input and admitted native execution.
 * The test provider owns the response; this fixture never invents a successful turn. */
export async function createHandoffQueueFixture(options: {
  fixture: Fixture;
  client: NativeCommandClient;
  encryption: Pick<
    WorkerEncryptionService,
    "ownerId" | "serverIdentity" | "componentKey"
  >;
  target(): {
    runtime: CodexAppServer;
    configuration: HandoffRuntime["configuration"];
    adapter: ManagedNativeCommandSession;
    session: NativeCommandSession;
  };
  completed(turnId: string): void;
  failed(error: unknown): void;
}) {
  const { fixture: f } = options;
  const { repository, chatId, workerId } = f;
  const initial = options.target();
  const context = (await repository.getChatExecutionContext(ownerId, chatId))!;
  const codec = createManagedQueueInputCodec({
    encryption: options.encryption as WorkerEncryptionService,
    chatId,
    defaults: () => ({
      mode: "default",
      modelId: initial.configuration.model.id,
      reasoningEffort: null,
      worktreeId: context.worktreeId,
    }),
  });
  const input = await codec.preparePrompt({
    id: randomUUID(),
    request: {
      method: "thread/queue/add",
      params: {
        threadId: context.threadId,
        input: [
          { type: "text", text: "Execute QUEUED_HANDOFF_INPUT exactly once" },
        ],
        clientUserMessageId: "handoff-queue-user",
        managed: { action: "literal" },
      },
      identity: {
        serverId: options.encryption.serverIdentity(),
        ownerId,
        workerId,
        ...initial.session,
      },
      connectionId: "handoff-queue-view",
      signal: new AbortController().signal,
      assertCurrent() {},
    },
  });
  const prompt = (await repository.createEncryptedQueuedPrompt(
    ownerId,
    chatId,
    input.prompt,
    input.attachments,
  ))!;
  expect(prompt).not.toBeNull();
  const runs: Promise<void>[] = [];
  let launches = 0;
  const beginTurn = async (_context: unknown, request: any, launch: any) => {
    const target = options.target();
    const { runtime, configuration, adapter, session } = target;
    expect(request.modelId).toBe(configuration.model.id);
    expect(session.modelRouteId).toBe(
      (await repository.getChatExecutionContext(ownerId, chatId))!.modelRouteId,
    );
    const run = (async () => {
      const opened = await codec.openNativeInput({
        promptId: launch.queuedPromptId,
        payload: launch.protectedNativeInput,
      });
      const operationId = `queued-execution:${launch.managedQueueClaim.id}`;
      const sealed = await protectNativeCommandContent({
        service: options.encryption,
        context: { chatId, operationId, direction: "request" },
        content: {
          input: opened.input,
          clientUserMessageId: launch.nativeClientUserMessageId,
        },
      });
      const grant = await options.client.admit({
        operationId,
        origin: "gui",
        session: { ...session, runtimeGeneration: null, connectionId: null },
        method: "turn/start",
        queueClaim: launch.managedQueueClaim,
        expectedActivationGeneration: null,
        payloadDigest: sealed.digest,
        protectedPayload: sealed.envelope,
        intent: {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: null,
          permissionProfileId: ":workspace",
        },
      });
      expect(grant.receipt.status).toBe("accepted");
      launches++;
      const receipt = grant.receipt;
      const actualSession = {
        ...session,
        connectionId: `gui:${receipt.operationGeneration}`,
      };
      const result = await runtime.runTurn({
        ...configuration,
        threadId: session.threadId!,
        operationGeneration: receipt.operationGeneration,
        chatId,
        captureProtectedDiagnostics: false,
        clientMessageId: launch.encryptedChatMessages.userMessage.id,
        executionProfile: "ide",
        isPrimary: true,
        automationPaused: false,
        policyContext: null,
        prompt: opened.displayText,
        nativeInput: opened.input,
        nativeClientUserMessageId: launch.nativeClientUserMessageId,
        rootKind: context.rootKind,
        skillNames: [],
        subagentProtocolVersion: undefined,
        worktreeMode: context.worktreeMode,
        worktreePolicy: context.worktreePolicy,
        onBeforeNativeDispatch: () =>
          adapter.dispatchGui(receipt, actualSession, receipt),
        onNativeReceipt: (actual) =>
          adapter.guiReceipt(receipt, actualSession, actual),
      });
      adapter.markGuiFinished(receipt.operationId, receipt.operationGeneration);
      expect(
        await repository.nativeCommands.finishLogicalGui(
          ownerId,
          workerId,
          receipt.operationId,
          receipt.operationGeneration,
          "idle",
        ),
      ).toBe(true);
      adapter.completeGuiLogical(
        receipt.operationId,
        receipt.operationGeneration,
      );
      options.completed(result.turnId!);
    })();
    runs.push(run);
    void run.catch(options.failed);
  };
  const unused = async () => {
    throw new Error("Unexpected unrelated queue fixture dependency");
  };
  const recovery = createChatRecoveryRuntime({
    app: {
      log: {
        info() {},
        warn() {},
        error(error: unknown) {
          options.failed(error);
        },
      },
    },
    applicationOwnerId: () => ownerId,
    repository,
    beginTurn,
    bridge: { isConnected: () => true, request: unused },
    availableModelRuntimes: async () => {
      const selected = options.target().configuration;
      return [
        {
          routeId: selected.model.routeId,
          model: selected.model,
          provider: selected.provider,
        },
      ];
    },
    resolveModelId: async () => options.target().configuration.model.id,
    routePairsForConfiguration: unused,
    runAsOwner: (_owner: string, run: () => unknown) => run(),
    appendLiveChatMessage: unused,
    appendLiveEncryptedChatMessage: (
      ...args: Parameters<typeof repository.appendEncryptedMessage>
    ) => repository.appendEncryptedMessage(...args),
    appendLiveTaskMessage: unused,
    deleteLiveQueuedPrompt: unused,
    failTaskGoalLaunch: unused,
    interruptLiveAgentInteractionRequests: unused,
    launchPreparedTaskGoal: unused,
    publishChatInvalidation() {},
    publishChatTurnBoundary() {},
    queueTaskScheduleTick() {},
    upsertLiveChatMessage: unused,
  } as any);
  const delivery = createManagedQueueDelivery({
    repository: repository.managedQueue,
    publish() {},
    onError: options.failed,
    dispatch: (_owner, chatId) => recovery.dispatchNextQueuedPrompt(chatId),
    bridge: { request: async () => ({ acknowledged: true }) },
  });
  return {
    promptId: prompt.id,
    tick: delivery.runOnce,
    close: delivery.stop,
    async assertPending() {
      const current = await repository.getEncryptedQueuedPrompt(
        ownerId,
        prompt.id,
      );
      expect(current?.state).toBe("pending");
      expect(current?.protectedNativeInput).toEqual(
        prompt.protectedNativeInput,
      );
      expect(current?.pendingMessage).toEqual(prompt.pendingMessage);
      expect(current?.modelId).toBe(prompt.modelId);
    },
    get launches() {
      return launches;
    },
    dispatch: () => recovery.dispatchNextQueuedPrompt(chatId),
    async settled() {
      await Promise.all(runs);
    },
  };
}
