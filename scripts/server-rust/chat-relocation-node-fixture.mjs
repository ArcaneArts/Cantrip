import { encodeChatRelocationPayload } from "../../cantrip_server/src/db/chat-relocation-jobs.ts";
import { createHash } from "node:crypto";
import { chatHydrationFixture } from "./chat-hydration-node-fixture.mjs";
export async function chatRelocationFixture(repo, r) {
  switch (r.op) {
    case "relocation-hydrate":
    case "relocation-skills":
      return chatHydrationFixture(r);
    case "relocation-create":
      return repo.create(r.owner, r.chat, r.target, r.key);
    case "relocation-get":
      return repo.get(r.owner, r.job);
    case "relocation-list":
      return repo.list(r.owner, r.chat);
    case "relocation-snapshot":
      return repo.getSnapshot(r.owner, r.job);
    case "relocation-claim":
      return repo.claimNext();
    case "relocation-renew":
      return repo.renewLease(r.job, r.command, r.attempt);
    case "relocation-advance":
      return repo.advance(
        r.job,
        r.command,
        r.attempt,
        r.from,
        r.to,
        r.progress,
        r.options,
      );
    case "relocation-fail":
      return repo.fail(r.job, r.command, r.attempt, r.error);
    case "relocation-commit":
      return repo.commit(r.job, r.command, r.attempt);
    case "relocation-cancel":
      return repo.cancel(r.owner, r.job, r.revision);
    case "relocation-retry":
      return repo.retry(r.owner, r.job, r.revision);
    case "relocation-recover":
      return repo.recoverInterrupted(r.force, new Date(r.now));
    case "relocation-requeue":
      return repo.requeueRetryableForWorker(r.worker);
    case "relocation-attachment":
      return repo.isAttachmentAvailable(r.attachment, r.worker);
    case "relocation-mark-attachment":
      await repo.markAttachmentAvailable(r.attachment, r.worker);
      return null;
    case "relocation-encode": {
      const bytes = encodeChatRelocationPayload(r.payload);
      return {
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    default:
      throw new Error("Unknown relocation fixture operation " + r.op);
  }
}
