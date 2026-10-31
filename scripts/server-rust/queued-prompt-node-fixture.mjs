export async function queuedPromptFixture(repository, input) {
  const { owner, chat, prompt, content, attachments, model } = input;
  const queued = repository.queuedPrompts;
  switch (input.action) {
    case "list-encrypted":
      return queued.listEncryptedQueuedPrompts(owner, chat);
    case "get-encrypted":
      return queued.getEncryptedQueuedPrompt(owner, prompt);
    case "create-encrypted":
      return queued.createEncryptedQueuedPrompt(
        owner,
        chat,
        content,
        attachments ?? [],
      );
    case "replace-encrypted":
      return queued.replaceEncryptedQueuedPrompt(
        owner,
        prompt,
        content,
        attachments ?? [],
      );
    case "list-visible":
      return queued.listQueuedPrompts(owner, chat);
    case "get-visible":
      return queued.getQueuedPrompt(owner, prompt);
    case "key-visible":
      return queued.getQueuedPromptByIdempotencyKey(owner, chat, input.key);
    case "create-visible":
      return queued.createQueuedPrompt(
        owner,
        chat,
        content,
        model,
        attachments ?? [],
      );
    case "update-visible":
      return queued.updateQueuedPrompt(owner, prompt, content, attachments);
    case "delete":
      return queued.deleteQueuedPrompt(owner, prompt);
    case "reorder":
      return queued.reorderQueuedPrompts(owner, chat, content);
    default:
      throw new Error("Unknown queued prompt operation");
  }
}
