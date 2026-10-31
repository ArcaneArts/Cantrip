import { createRequire } from "node:module";
import { ExecutionLaneConflictError } from "../../cantrip_server/src/db/repository/chat-execution-lanes.ts";
import { NativeCommandError } from "../../cantrip_server/src/db/repository/native-command-errors.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
export function laneFailure(error) {
  const result = {};
  if (error instanceof ExecutionLaneConflictError)
    result.laneError = error.constructor.name;
  if (error instanceof NativeCommandError) {
    result.commandError = error.code;
    result.commandStatus = error.statusCode;
  }
  let cause = error;
  while (cause) {
    if (/^[0-9A-Z]{5}$/.test(cause.code ?? "")) {
      result.databaseCode = cause.code;
      break;
    }
    cause = cause.cause;
  }
  if (!result.databaseCode) result.message = error.message;
  return result;
}
export async function executionLaneFixture(repository, input) {
  const lanes = repository.nativeCommands.lanes,
    db = repository.nativeCommands.database;
  const run = async (lane) => {
    if (input.action === "list-chat")
      return lane.listChatExecutionLanes(input.owner, input.chat);
    if (input.action === "list-project")
      return lane.listProjectExecutionLanes(input.owner, input.project, {
        includeHistory: input.includeHistory,
      });
    if (input.action === "context")
      return lane.getChatExecutionLaneContext(
        input.owner,
        input.chat,
        input.lane,
      );
    if (input.action === "recovery")
      return lane.getChatExecutionRecoveryContext(
        input.owner,
        input.chat,
        input.lane,
      );
    if (input.action === "reset") {
      await lane.resetInterruptedChatExecutions();
      return null;
    }
    if (input.action === "release")
      return lane.releaseChatExecutionLane(
        input.owner,
        input.chat,
        input.lane,
        input.returnToPrimary ?? false,
      );
    if (input.action === "schedule")
      return lane.scheduleChatWorktreeTransition(
        input.owner,
        input.chat,
        input.expectedLane,
        input.target,
        input.kind ?? "switch",
        input.purpose ?? "Transition fixture",
      );
    if (input.action === "pending")
      return lane.getPendingChatWorktreeTransition(input.owner, input.chat);
    if (input.action === "pending-chats")
      return lane.listPendingWorktreeTransitionChatIds(
        input.owner,
        input.worker,
      );
    if (input.action === "cancel")
      return lane.cancelChatWorktreeTransition(
        input.owner,
        input.chat,
        input.lane,
      );
    if (input.action === "apply")
      return lane.applyChatWorktreeTransition(
        input.owner,
        input.chat,
        input.lane,
      );
    if (input.action === "start")
      return lane.startChatExecutionLane(
        input.owner,
        input.chat,
        input.actor ?? "user",
        input.purpose ?? "Managed native command",
      );
    if (input.action === "finish")
      return lane.finishChatExecutionLane(
        input.chat,
        input.lane,
        input.status ?? "idle",
        input.options ?? {},
      );
    if (input.action === "runtime")
      return lane.updateChatExecutionLaneRuntime(
        input.chat,
        input.lane,
        input.thread ?? null,
        input.status ?? "running",
      );
    throw new Error("Unknown lane action");
  };
  if (input.op === "native-command-lane-nested")
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE chats SET managed_input_revision=managed_input_revision+7 WHERE id=${input.chat}`,
      );
      let result;
      try {
        result = { value: await run(lanes.inTransaction(tx)) };
      } catch (error) {
        result = { caught: laneFailure(error) };
      }
      await tx.execute(
        sql`UPDATE chats SET has_unread_completion=true WHERE id=${input.chat}`,
      );
      return result;
    });
  return run(lanes);
}
