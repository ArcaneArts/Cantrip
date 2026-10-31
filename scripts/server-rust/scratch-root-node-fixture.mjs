// Execute the actual reference repository against the disposable connector.
export async function scratchRootFixture(repo, request, catalog) {
  const {
    op,
    input,
    owner,
    root,
    kind,
    job,
    command,
    attempt,
    error,
    result,
    worker,
    roots,
    force,
    now,
    expiredBy,
  } = request;
  switch (op) {
    case "scratch-chat-create":
      return catalog.createStandaloneChat(owner, input, (id) =>
        request.connected.includes(id),
      );
    case "scratch-chat-list":
      return catalog.listStandaloneChats(owner);
    case "scratch-chat-archive-agent":
      return catalog.archiveAgentConversation(owner, request.chat);
    case "scratch-chat-delete":
      return catalog.deleteChat(owner, request.chat);
    case "scratch-chat-archive":
      return catalog.archiveStandaloneChat(owner, request.chat);
    case "scratch-chat-restore":
      return catalog.restoreStandaloneChat(owner, request.chat);
    case "scratch-chat-deletion-root":
      return catalog.getStandaloneChatRootForDeletion(owner, request.chat);
    case "scratch-chat-restore-project":
      return catalog.restoreArchivedChat(owner, request.chat, input);
    case "scratch-chat-permanent":
      return catalog.permanentlyDeleteArchivedChat(owner, request.chat);
    case "scratch-chat-purge-project":
      return catalog.purgeExpiredArchivedChats(owner, new Date(now));
    case "scratch-chat-update":
      return catalog.updateChat(owner, request.chat, input);
    case "scratch-chat-draft-get":
      return catalog.getChatComposerDraftWireState(owner, request.chat);
    case "scratch-chat-draft-put":
      return catalog.updateChatComposerDraft(
        owner,
        request.chat,
        request.state,
      );
    case "scratch-chat-ack":
      return catalog.acknowledgeChatCompletion(owner, request.chat);
    case "scratch-chat-archived":
      return catalog.listArchivedStandaloneChats(owner);
    case "scratch-enqueue-provision":
      return repo.enqueueProvision(input);
    case "scratch-enqueue-delete":
      return repo.enqueueDelete(input);
    case "scratch-purge":
      return repo.createDeletionTombstoneAndPurge(
        input,
        expiredBy ? { expiredBy: new Date(expiredBy) } : {},
      );
    case "scratch-purge-expired":
      return repo.purgeExpiredArchivedChats(owner, new Date(now));
    case "scratch-purge-all":
      return repo.purgeExpiredArchivedChatsForAllOwners(new Date(now));
    case "scratch-get":
      return repo.get(owner, root, kind);
    case "scratch-claim":
      return repo.claimNext();
    case "scratch-claims":
      return Promise.all(
        Array.from({ length: request.count }, () => repo.claimNext()),
      );
    case "scratch-renew":
      return repo.renewLease(job, command, attempt);
    case "scratch-block":
      return repo.block(job, command, error);
    case "scratch-fail":
      return repo.fail(job, command, error);
    case "scratch-complete-provision":
      return repo.completeProvision(job, command, result);
    case "scratch-complete-delete":
      return repo.completeDelete(job, command, result);
    case "scratch-recover":
      return repo.recoverInterrupted(force, new Date(now));
    case "scratch-requeue":
      return repo.requeueRetryableForWorker(worker);
    case "scratch-targets":
      return repo.reconciliationTargets(worker);
    case "scratch-missing":
      return repo.markMissingRoots(worker, roots);
    default:
      throw new Error("Unknown scratch fixture operation " + op);
  }
}
