// Actual pause/Goal/Live/SQL services. The controlled worker admits, dispatches
// and settles real native pause controls before returning its boundary receipt.
import { createChatAutomationPauseRuntime } from "../../cantrip_server/src/app/runtime/chat-automation-pause-runtime.ts";
export async function pausePeer({
  repository,
  input,
  worker,
  command,
  index,
  trace,
  execute,
  held,
}) {
  const paused = command.control?.paused ?? command.paused;
  const selected = input.pauseByChat?.[command.chatId];
  const at = (key) =>
    selected && Object.hasOwn(selected, key)
      ? selected[key]
      : input[key]?.[index];
  const context = await repository.getChatExecutionContext(
    input.owner,
    command.chatId,
  );
  trace.push({
    kind: "pause-boundary",
    chat: command.chatId,
    paused: context?.automationPaused ?? null,
  });
  if (at("pauseErrors")) throw new Error(at("pauseErrors"));
  let request, grant;
  if (command.type === "chat.native-control") {
    request = {
      workerId: worker,
      operationId: `${input.pausePrefix ?? "fixture-pause"}:${index}`,
      origin: "gui",
      method: "turn/pause",
      session: {
        chatId: context.chatId,
        threadId: context.threadId,
        contextKind: context.contextKind,
        projectId: context.projectId,
        placementId: context.worktreeId ?? context.scratchRootId,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        runtimeGeneration: command.nativeRuntimeGeneration ?? null,
        connectionId: "pause-connection",
      },
      payloadDigest: "d".repeat(64),
      protectedPayload: input.pauseProtectedPayload,
      expectedActivationGeneration: command.nativeActivationGeneration,
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        paused,
        resumeAutonomy: !paused,
      },
    };
    grant = await repository.nativeCommands.admit(input.owner, request);
    if (grant.receipt.status !== "accepted")
      throw new Error(
        "Fixture native pause admission rejected: " +
          grant.receipt.rejectionCode,
      );
    await repository.nativeCommands.dispatch(input.owner, {
      workerId: worker,
      operationId: request.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      payloadDigest: request.payloadDigest,
      session: request.session,
    });
    trace.push({
      kind: "native-pause-dispatched",
      chat: command.chatId,
      paused,
    });
  }
  const sql = at("pauseBeforeReplySQL");
  for (const statement of Array.isArray(sql) ? sql : sql ? [sql] : [])
    await execute(statement);
  if (
    (input.holdPauseFirst && index === 0) ||
    input.holdPauseChats?.includes(command.chatId)
  )
    await held;
  if (at("pauseErrorsAfterDispatch"))
    throw new Error(at("pauseErrorsAfterDispatch"));
  if (grant)
    await repository.nativeCommands.settle(input.owner, {
      workerId: worker,
      operationId: request.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
  return (selected && Object.hasOwn(selected, "pauseReplies")) ||
    (input.pauseReplies && Object.hasOwn(input.pauseReplies, index))
    ? at("pauseReplies")
    : { paused, active: null };
}
export async function automationPauseFixture({
  repository,
  input,
  bridge,
  environment,
  runtime,
  app,
  trace,
  release,
  track,
}) {
  const set = createChatAutomationPauseRuntime(
    {
      repository,
      bridge,
      publishChatSummary: environment.runtime.publishChatSummary,
      resumeChatAutomation: runtime.resumeChatAutomation,
    },
    app,
  );
  try {
    if (input.overlap) {
      const older = track(
        set(
          input.owner,
          input.chat,
          input.paused,
          input.resumeAutomation === undefined
            ? {}
            : { resumeAutomation: input.resumeAutomation },
        ),
      );
      const deadline = Date.now() + 10000;
      while (!trace.some((t) => t.kind === "native-pause-dispatched")) {
        if (Date.now() >= deadline)
          throw new Error("Native pause dispatch observation timed out");
        await new Promise(setImmediate);
      }
      const newer = await set(input.owner, input.chat, !input.paused, {
        resumeAutomation: input.resumeAutomation ?? true,
      });
      release();
      return { older: await older, newer };
    }
    const operation = set(input.owner, input.chat, input.paused, {
      resumeAutomation: input.resumeAutomation ?? true,
    });
    if (input.detached) {
      track(operation);
      return null;
    }
    return await operation;
  } finally {
    release();
  }
}
