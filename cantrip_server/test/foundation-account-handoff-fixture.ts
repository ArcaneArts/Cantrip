import { expect } from "vitest";
import type { WorkerCommand } from "@cantrip/protocol";
import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import {
  protectNativeSettingsSnapshot,
  openNativeSettingsSnapshot,
} from "../../cantrip_worker/src/native-settings-content.js";

/** The foundation test controls its worker boundary. Advance the actual durable
 * handoff and verify protected settings/history; native file transfer has its own
 * real-Codex acceptance suite. No routing or persistence implementation is mocked. */
export async function foundationAccountHandoff(options: {
  repository: ServerRepository;
  ownerId: string;
  chatId: string;
  targetAccountId: string;
  encryption: Pick<
    WorkerEncryptionService,
    "ownerId" | "serverIdentity" | "componentKey"
  >;
}) {
  const { repository, ownerId, chatId, targetAccountId, encryption } = options;
  const original = (await repository.getChatExecutionContext(ownerId, chatId))!;
  expect(original.contextKind).toBe("project");
  expect(original.experience).toBe("agent");
  expect(original.threadId).toBeTruthy();
  expect(original.executionLaneId).toBeNull();
  const snapshot = async (
    runtimeGeneration: string,
    accountId: string | null,
  ) => {
    const runtime = (await repository.getModelRuntimeByRoute(
      ownerId,
      original.modelRouteId!,
    ))!;
    const context = {
      chatId,
      workerId: original.workerId,
      threadId: original.threadId!,
      runtimeGeneration,
      settingsVersion: { epoch: runtimeGeneration, revision: "0" },
    };
    const settings = {
      settingsVersion: context.settingsVersion,
      cwd: original.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspace-write" },
      activePermissionProfile: null,
      model: runtime.model.providerModelId ?? runtime.model.name,
      modelProvider: runtime.provider.kind,
      effort: original.reasoningEffort,
      serviceTier: null,
      summary: null,
      collaborationMode: { mode: original.planMode, settings: {} },
      personality: null,
    };
    const sealed = await protectNativeSettingsSnapshot({
      service: encryption,
      context,
      settings,
      modelAttribution: {
        status: "resolved",
        workerId: original.workerId,
        providerId: runtime.provider.id,
        providerAccountId: accountId,
        modelId: runtime.model.id,
        routeId: original.modelRouteId!,
      },
    });
    expect(
      await openNativeSettingsSnapshot({
        service: encryption,
        context,
        snapshot: sealed,
      }),
    ).toEqual(settings);
    return sealed;
  };
  const initial = await repository.nativeCommands.refreshSettingsState(
    ownerId,
    chatId,
    async () => snapshot("foundation-pool-source", original.providerAccountId),
  );
  expect(initial.binding).toMatchObject({
    threadId: original.threadId,
    modelRouteId: original.modelRouteId,
    providerAccountId: original.providerAccountId,
    runtimeGeneration: "foundation-pool-source",
  });
  let completed = 0;
  return {
    count: () => completed,
    async run(
      command: Extract<WorkerCommand, { type: "chat.runtime.handoff" }>,
    ) {
      expect(command.chatId).toBe(chatId);
      expect(command.intent).toBe("continue");
      const state = (await repository.nativeRuntimeHandoffs.get(
        ownerId,
        chatId,
        command.operationId,
      ))!;
      expect(state).toMatchObject({
        phase: "preparing",
        source: initial.binding,
        targetModelRouteId: original.modelRouteId,
        targetProviderAccountId: targetAccountId,
      });
      const messages = await repository.listEncryptedMessages(ownerId, chatId);
      expect(messages.length).toBeGreaterThan(0);
      const prepared = await repository.nativeRuntimeHandoffs.prepared(
        ownerId,
        original.workerId,
        command.operationId,
        {
          threadId: original.threadId!,
          runtimeGeneration: "foundation-pool-destination",
          reasoningEffort: original.reasoningEffort,
          snapshot: await snapshot(
            "foundation-pool-destination",
            targetAccountId,
          ),
        },
      );
      expect(prepared.phase).toBe("prepared");
      const committed = await repository.nativeRuntimeHandoffs.commit(
        ownerId,
        original.workerId,
        command.operationId,
      );
      expect(committed.phase).toBe("committed");
      const settled = await repository.nativeRuntimeHandoffs.finish(
        ownerId,
        original.workerId,
        command.operationId,
        "completed",
      );
      expect(settled.phase).toBe("completed");
      expect(
        await repository.getChatExecutionContext(ownerId, chatId),
      ).toMatchObject({
        threadId: original.threadId,
        modelRouteId: original.modelRouteId,
        providerAccountId: targetAccountId,
        status: "idle",
        executionLaneId: null,
      });
      expect(await repository.listEncryptedMessages(ownerId, chatId)).toEqual(
        messages,
      );
      completed++;
    },
  };
}
