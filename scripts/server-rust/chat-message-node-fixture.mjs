import { chatMessagePageQuerySchema } from "../../packages/protocol/dist/index.js";
export async function chatMessageFixture(repository, input) {
  const { owner, chat } = input;
  switch (input.op) {
    case "message-history":
      return repository.nativeHistoryArchive.readForChat(
        owner,
        chat,
        input.input,
      );
    case "message-append":
    case "message-upsert":
      return repository[
        {
          plain:
            input.op === "message-append" ? "appendMessage" : "upsertMessage",
          encrypted:
            input.op === "message-append"
              ? "appendEncryptedMessage"
              : "upsertEncryptedMessage",
          task:
            input.op === "message-append"
              ? "appendTaskMessage"
              : "upsertTaskMessage",
        }[input.kind]
      ](owner, chat, input.input, input.attribution ?? undefined);
    case "message-key":
      return repository[
        {
          plain: "getMessageByIdempotencyKey",
          encrypted: "getEncryptedMessageByIdempotencyKey",
          task: "getTaskMessageByIdempotencyKey",
        }[input.kind]
      ](owner, chat, input.key);
    case "message-model":
      return repository[
        {
          plain: "setMessageModelRoute",
          encrypted: "setEncryptedMessageModelRoute",
          task: "setTaskMessageModelRoute",
        }[input.kind]
      ](
        owner,
        input.message,
        input.modelId,
        input.runtime,
        input.reasoning ?? undefined,
      );
    case "message-list":
      return repository[
        {
          plain: "listMessages",
          encrypted: "listEncryptedMessages",
          task: "listTaskMessages",
          wire: "listAgentMessageWire",
        }[input.kind]
      ](owner, chat);
    case "message-page":
      return repository[
        input.task ? "listTaskMessagePage" : "listEncryptedMessagePage"
      ](owner, chat, chatMessagePageQuerySchema.parse(input.query));
    case "message-latest":
      return repository.getLatestEncryptedUserMessage(owner, chat);
    case "message-trim":
      return repository.trimLatestEncryptedTurn(owner, chat, input.message);
    case "message-headers":
      return repository.listMessageHeaders(owner, chat);
    default:
      throw new Error("Unknown message fixture operation: " + input.op);
  }
}
