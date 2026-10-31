export async function interactionFixture(repository, request) {
  const { action, input, owner, requestId, key, chat, worker, lane } = request;
  switch (action) {
    case "record":
      return repository.recordAgentInteractionRequest(input);
    case "record-protected":
      return repository.recordEncryptedAgentInteractionRequest(input);
    case "get":
      return repository.getAgentInteractionRequest(owner, requestId);
    case "get-key":
      return repository.getAgentInteractionRequestByKey(owner, key);
    case "list":
      return repository.listAgentInteractionRequests(owner, input);
    case "resolve":
      return repository.resolveAgentInteractionRequest(
        owner,
        requestId,
        input,
        request.accepted ?? false,
      );
    case "resolve-protected":
      return repository.resolveEncryptedAgentInteractionRequest(
        owner,
        requestId,
        input,
        request.accepted ?? false,
      );
    case "validate":
      return repository.validateAgentInteractionResolution(
        owner,
        requestId,
        input,
      );
    case "validate-protected":
      return repository.validateEncryptedAgentInteractionResolution(
        owner,
        requestId,
        input,
      );
    case "expire":
      return repository.expireAgentInteractionRequests(
        request.now ? new Date(request.now) : undefined,
      );
    case "interrupt":
      return repository.interruptAgentInteractionRequests(chat, lane);
    case "terminalize":
      return repository.terminalizeAgentInteractionRequestFromWorker(
        key,
        chat,
        worker,
        request.status,
        request.resolution,
      );
    default:
      throw new Error("Unknown interaction fixture action: " + action);
  }
}
