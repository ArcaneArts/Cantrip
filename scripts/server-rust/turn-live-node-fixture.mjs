import { createLiveMutationRuntime } from "../../cantrip_server/src/app/runtime/live-mutation-runtime.ts";
import { TaskLiveInvalidationRouter } from "../../cantrip_server/src/live/task-live-routing.ts";
import { createRequire } from "node:module";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
import { createChatRecoveryRuntime } from "../../cantrip_server/src/app/runtime/chat-recovery-runtime.ts";

export function turnLiveEnvironment(repository, input, bridgeOverride) {
  const recovery = createChatRecoveryRuntime({
    repository,
    applicationOwnerId: () => input.owner,
  });
  const events = [],
    commands = [],
    logs = [],
    pending = new Set();
  const invalidate = (resource, fields = {}) =>
    events.push({
      ownerId: input.owner,
      scope: fields.projectId
        ? { kind: "project", projectId: fields.projectId }
        : { kind: "current-user" },
      resource,
      action: "invalidated",
      entityId: fields.entityId ?? null,
      revision: null,
      payload: null,
    });
  const taskRouter = new TaskLiveInvalidationRouter(
    (owner, chat) => repository.getChatLiveRouting(owner, chat),
    (record) =>
      invalidate(record.resource, {
        projectId: record.projectId,
        entityId: record.entityId,
      }),
  );
  const route = taskRouter.route.bind(taskRouter);
  taskRouter.route = (value) => {
    const promise = route(value);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const log = (level) => (context, message) => {
    const value = { level, message, error: Boolean(context.err) };
    for (const key of ["chatId", "messageId", "resource", "requestId"])
      if (key in context) value[key] = context[key];
    logs.push(value);
  };
  const runtime = createLiveMutationRuntime({
    app: { log: { error: log("error"), warn: log("warn") } },
    applicationOwnerId: () => input.owner,
    bridge: bridgeOverride ?? {
      isConnected: () => input.connected !== false,
      request: async (worker, command) => {
        commands.push({ ownerId: input.owner, worker, command });
        if (input.failRequest)
          throw new Error("Controlled live protection failure");
        return input.protectionReply === undefined
          ? {
              ...input.protectedMessage,
              id: command.message.id,
              idempotencyKey: command.message.idempotencyKey,
            }
          : input.protectionReply;
      },
    },
    liveHub: {
      publish: (event) => {
        if (input.failHub)
          throw new Error("Controlled live publication failure");
        events.push(event);
      },
    },
    livePublishingEnabled: () => input.enabled !== false,
    publishLiveInvalidation: invalidate,
    repository,
    taskLiveInvalidationRouter: taskRouter,
  });
  return {
    runtime,
    recovery,
    events,
    commands,
    logs,
    pending,
    settle: () => Promise.allSettled([...pending]),
  };
}
export async function turnLiveFixture(repository, input) {
  const {
    runtime,
    recovery,
    events,
    commands,
    logs,
    frames = [],
    results = [],
    pending,
  } = turnLiveEnvironment(repository, input);
  for (const step of input.steps ?? [input]) {
    if (step.beforeSQL)
      await repository.nativeCommands.database.execute(sql.raw(step.beforeSQL));
    const a = step.action,
      chat = step.chat ?? input.chat,
      kind = step.kind ?? input.kind ?? "encrypted";
    let result;
    try {
      if (a === "write")
        result = await runtime[
          step.upsert
            ? kind === "task"
              ? "upsertLiveTaskMessage"
              : kind === "plain"
                ? "upsertLiveChatMessage"
                : "upsertLiveEncryptedChatMessage"
            : kind === "task"
              ? "appendLiveTaskMessage"
              : kind === "plain"
                ? "appendLiveChatMessage"
                : "appendLiveEncryptedChatMessage"
        ](input.owner, chat, step.message, step.attribution, step.routing);
      else if (a === "route")
        result = await runtime[
          kind === "task"
            ? "setLiveTaskMessageModelRoute"
            : kind === "plain"
              ? "setLiveChatMessageModelRoute"
              : "setLiveEncryptedChatMessageModelRoute"
        ](
          input.owner,
          step.messageId,
          step.modelId,
          step.runtime,
          step.reasoning,
          step.routing,
        );
      else if (a === "boundary")
        runtime.publishChatTurnBoundary(
          chat,
          step.projectId ?? null,
          step.routing,
        );
      else if (a === "summary")
        runtime.publishChatSummary(chat, step.projectId ?? null);
      else if (a === "progress")
        runtime.publishInferenceProgress(chat, step.progress);
      else if (a === "plan-mode")
        result = await runtime.updateLiveChatPlanMode(
          input.owner,
          chat,
          step.mode,
        );
      else if (a === "plan")
        result = await runtime.updateLiveEncryptedChatPlanState(
          chat,
          step.plan,
        );
      else if (a === "interaction-record")
        result = await runtime[
          step.protected === false
            ? "recordLiveAgentInteractionRequest"
            : "recordLiveEncryptedAgentInteractionRequest"
        ](step.interaction);
      else if (a === "interaction-clear")
        result = await runtime.terminalizeLiveAgentInteractionRequest(
          step.requestKey,
          chat,
          step.worker,
          step.status,
          step.resolution,
        );
      else if (a === "interaction-interrupt")
        result = await runtime.interruptLiveAgentInteractionRequests(
          chat,
          step.laneId,
        );
      else if (a === "storage-plan")
        result = await repository.getEncryptedChatPlanState(input.owner, chat);
      else if (a === "storage-routing")
        result = await repository.getChatLiveRouting(input.owner, chat);
      else if (a === "storage-attachments")
        result = await recovery.resolvePromptAttachments(
          step.context,
          step.ids,
        );
      else if (a === "storage-audiences")
        result = await repository.listChatSkillAudienceKeys(
          input.owner,
          step.worker,
          step.provider,
        );
      else if (a === "stub")
        result = runtime.taskMessageServerStub(step.message);
      else throw new Error("Unknown turn Live fixture action");
    } catch (error) {
      if (!input.captureErrors) throw error;
      result = { failed: true };
    }
    results.push(result ?? null);
    frames.push(events.length);
    await Promise.allSettled([...pending]);
  }
  return { results, frames, events, commands, logs };
}
