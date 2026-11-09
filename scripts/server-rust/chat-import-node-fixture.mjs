import {
  ChatImportJobRepository,
  chatImportAttachmentId,
} from "../../tests/reference-node-server/src/db/chat-import-jobs.ts";
export async function chatImportFixture(repo, r) {
  if (r.batchSize !== undefined)
    repo = new ChatImportJobRepository(repo.database, r.batchSize);
  switch (r.op) {
    case "chat-import-create":
      return repo.create(r.owner, r.project, r.input);
    case "chat-import-get":
      return repo.get(r.owner, r.job);
    case "chat-import-list":
      return repo.list(r.owner, r.project);
    case "chat-import-references":
      return repo.listSourceReferences(r.owner, r.workers);
    case "chat-import-claim":
      return repo.claimNext();
    case "chat-import-renew":
      return repo.renewLease(r.job, r.command, r.attempt);
    case "chat-import-mark":
      return repo.markImporting(r.job, r.command, r.attempt);
    case "chat-import-read":
      return repo.readContext(r.job, r.command);
    case "chat-import-hydration":
      return repo.hydrationContext(r.job, r.command);
    case "chat-import-complete":
      return repo.completeHydration(r.job, r.command, r.attempt, r.input);
    case "chat-import-without":
      return repo.completeWithoutHydration(r.job, r.command, r.attempt);
    case "chat-import-unsupported":
      return repo.completeUnsupportedHydrationImports();
    case "chat-import-settle":
      return repo[r.state === "blocked" ? "block" : "fail"](
        r.job,
        r.command,
        r.error,
      );
    case "chat-import-retry":
      return repo.retry(r.owner, r.job, r.revision);
    case "chat-import-requeue":
      return repo.requeueRetryableForWorker(r.worker);
    case "chat-import-recover":
      return repo.recoverInterrupted(r.force, new Date(r.now));
    case "chat-import-attachment-id": {
      return chatImportAttachmentId(r.job, r.external);
    }
    case "chat-import-canonical": {
      const protectionCalls = [];
      const job = await repo.completeCanonicalImport(
        r.job,
        r.command,
        r.attempt,
        r.transcript,
        r.attachments,
        async (messages, attachments) => {
          protectionCalls.push({ messages, attachments });
          if (r.protection === "throw")
            throw new Error("Controlled import protection failure");
          const protectedMessages = messages.map((m) => ({
            id: m.id,
            classification: {
              role: m.role,
              mode: m.mode ?? "default",
              attachmentIds: m.content.flatMap((i) =>
                i.type === "attachment" ? [i.attachment.id] : [],
              ),
            },
            protectedContent: {
              formatVersion: 1,
              keyRevision: 1,
              envelope: {
                version: 1,
                algorithm: "AES-256-GCM",
                keyRevision: 1,
                nonce: "AAAAAAAAAAAAAAAA",
                ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            },
            reasoningEffort: m.reasoningEffort ?? null,
            idempotencyKey: m.idempotencyKey,
          }));
          if (r.protection === "truncate") protectedMessages.pop();
          if (r.protection === "duplicate-after-first-batch")
            protectedMessages[600].id = protectedMessages[0].id;
          if (r.protection === "bad-key" && protectedMessages[0])
            protectedMessages[0].idempotencyKey = "wrong";
          return protectedMessages;
        },
      );
      return { job, protectionCalls };
    }
    default:
      throw new Error("Unknown Chat import fixture operation " + r.op);
  }
}
