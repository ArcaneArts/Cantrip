// Calls the actual source repository. Mutations run while its worker callback
// owns no read transaction, using only this driver's disposable connector.
export async function chatForkFixture(repo, request, trace, execute) {
  const protect = async (messages) => {
    trace.push(messages);
    for (const statement of request.mutations ?? []) await execute(statement);
    if ("throw" in request) throw new Error(request.throw);
    if ("copies" in request) return request.copies;
    return messages.map((message, index) => ({
      id: request.copyIds[index],
      classification: {
        role: message.role,
        mode: message.mode,
        attachmentIds: message.attachmentIds,
      },
      protectedContent: request.protectedContent ?? message.protectedContent,
      reasoningEffort: request.reasoningEffort ?? null,
      idempotencyKey: "fork:" + message.id,
    }));
  };
  const result =
    request.op === "fork-project"
      ? await repo.forkChat(request.owner, request.chat, request.input, protect)
      : await repo.forkStandaloneChat(
          request.owner,
          request.chat,
          request.input,
          (id) => request.connected.includes(id),
          protect,
        );
  return { result, trace };
}
