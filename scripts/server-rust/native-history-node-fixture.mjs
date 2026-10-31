// Calls the unchanged production history repository against disposable storage.
import { nativeHistoryPayloadDigest } from "../../cantrip_server/src/db/repository/native-history-digest.ts";
import { reconcileNativeHistoryUsage } from "../../packages/protocol/dist/index.js";
export async function nativeHistoryFixture(repository, request) {
  if (request.op === "native-history-publications")
    return repository.nativeHistoryPublications.listPending(
      request.limit ?? 64,
    );
  if (request.op === "native-history-publication-ack")
    return repository.nativeHistoryPublications.acknowledge(request.entry);
  if (request.op === "native-history-publication-defer")
    return repository.nativeHistoryPublications.defer(
      request.entry,
      new Date(request.at),
    );
  if (request.op === "native-history-archive")
    return repository.nativeHistoryArchive.read(request.owner, request.input);
  if (request.op === "native-history-archive-turns")
    return repository.nativeHistoryArchive.readTurns(
      request.owner,
      request.input,
    );
  if (request.op === "native-history-archive-batches")
    return repository.nativeHistoryArchive.readBatches(
      request.owner,
      request.input,
    );
  if (request.op === "native-history-ingest")
    return repository.nativeHistoryIngestion.ingest(
      request.owner,
      request.input,
    );
  if (request.op === "native-history-reconcile-usage")
    return reconcileNativeHistoryUsage(
      request.previous ?? undefined,
      request.input,
    );
  if (request.op === "native-history-digest")
    return nativeHistoryPayloadDigest(request.input);
  if (request.op === "native-history-resolve")
    return repository.nativeHistoryItems.resolve(request.owner, request.input);
  if (request.op === "native-history-binding-open")
    return repository.nativeHistoryBindings.open(request.owner, request.input);
  if (request.op === "native-history-binding-owned")
    return repository.nativeHistoryBindings.withBinding(
      request.owner,
      request.worker,
      request.chat,
      request.binding,
      async (_transaction, binding) => binding,
    );
  throw new Error("Unknown native history fixture operation");
}
