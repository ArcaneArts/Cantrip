export async function taskRetryFixture(repository, input) {
  const task = repository.taskRetries;
  let value;
  switch (input.action) {
    case "list":
      value = await task.listCandidates(input.now);
      break;
    case "note":
      value = await task.noteFailure(
        input.owner,
        input.chat,
        input.key,
        input.kind,
        input.now,
      );
      break;
    case "reset":
      value = await task.reset(input.owner, input.chat);
      break;
    case "clear":
      value = await task.clearPending(input.owner, input.chat);
      break;
    case "claim":
      value = await task.claimDue(input.owner, input.chat, input.now);
      break;
    case "finish":
      value = await task.finish(
        input.owner,
        input.chat,
        input.claim,
        input.failure,
        input.now,
      );
      break;
    default:
      throw new Error("Retry fixture action");
  }
  return { value };
}
