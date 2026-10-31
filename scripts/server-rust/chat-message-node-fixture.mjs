import { chatMessagePageQuerySchema } from "../../packages/protocol/dist/index.js";
export async function chatMessageFixture(repository, input) {
  const { owner, chat } = input;
  switch (input.op) {
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
