// Reviewed native integration contracts. "Public" means readable by the
// authorized server, not anonymously accessible. Routing IDs, generations,
// policy claims and lifecycle receipts accompany endpoint-encrypted content.
export const nativeTableClassifications = {
  managedChatPreparations: "minimized-operational-metadata",
  nativeCommands: "endpoint-protected",
  nativeCommandActivations: "minimized-operational-metadata",
  nativeCommandTurns: "minimized-operational-metadata",
  nativePendingRequests: "minimized-operational-metadata",
  nativeLogicalCompletions: "minimized-operational-metadata",
  nativeRuntimeHandoffs: "endpoint-protected",
  nativeSettingsStates: "endpoint-protected",
  nativeSettingsEvidence: "endpoint-protected",
  managedQueueStates: "minimized-operational-metadata",
  managedQueueClaims: "minimized-operational-metadata",
  managedQueueInputSnapshots: "endpoint-protected",
  managedQueueImports: "endpoint-protected",
  nativeHistoryBindings: "minimized-operational-metadata",
  nativeHistoryStreams: "minimized-operational-metadata",
  nativeHistoryRejections: "minimized-operational-metadata",
  nativeHistoryReceipts: "endpoint-protected",
  nativeHistoryPublications: "minimized-operational-metadata",
  nativeHistoryTurns: "endpoint-protected",
  nativeHistoryItems: "endpoint-protected",
};

const classified = (classification, rationale) => ({
  classification,
  rationale,
});
const protectedContract = (rationale) =>
  classified("endpoint-protected", rationale);
const control = (rationale) =>
  classified("intentionally-public-control-plane", rationale);

export function nativeRouteContentClassification({ path }) {
  if (path === "/api/chats/:chatId/preparation")
    return control(
      "owner-scoped chat preparation IDs, phase and generation; no CLI output or synthetic prompt",
    );
  if (path === "/api/settings/computer-use/workers/:workerId/effects")
    return control(
      "owner-resolved worker presentation preferences and bounded effect status; window frames and native input remain worker-local",
    );
  if (
    path === "/api/internal/native-model-inventory" ||
    path === "/api/chats/:chatId/native-settings/models"
  )
    return control(
      "owner/worker/provider/account-scoped eligible model and route inventory; no provider credentials or native configuration contents",
    );
  if (
    /^\/api\/chats\/:chatId\/(?:native-settings(?:\/|$)|native-account-defaults$)/u.test(
      path,
    )
  )
    return protectedContract(
      "owner-resolved current native binding; encrypted settings patches, snapshots and account-default results; revisions and policy/model attribution are control metadata",
    );
  if (
    /^\/api\/chats\/:chatId\/runtime-handoffs(?:\/|$)/u.test(path) ||
    /^\/api\/internal\/native-runtime-handoffs(?:\/|$)/u.test(path)
  )
    return protectedContract(
      "owner/chat/worker-bound migration reservation and generations; prepared settings snapshots and provider configuration contain protected envelopes; native artifacts stay on the worker",
    );
  if (path === "/api/chats/:chatId/native-history/turns/read")
    return protectedContract(
      "owner-scoped archived native turns retain encrypted metadata and public timing, usage and model attribution",
    );
  if (path === "/api/chats/:chatId/queue/operations/:operationId")
    return protectedContract(
      "owner/chat-bound operation receipt may contain the accepted encrypted queued prompt; acceptance and correlation IDs are control metadata",
    );
  if (/^\/api\/internal\/native-history\/open$/u.test(path))
    return control(
      "worker-authenticated owner/chat/thread binding and stable item identity reservations; neither dispatches input nor grants active-turn authority",
    );
  if (
    /^\/api\/internal\/native-history\/(?:resolve|archive|archive-turns|archive-batches|ingest)$/u.test(
      path,
    )
  )
    return protectedContract(
      "worker-authenticated owned binding; endpoint-encrypted preserved input, attachment descriptors and history batches/items/turn metadata with sequence, digest, timing and acknowledgement metadata; ingestion persists before acknowledging",
    );
  if (
    /^\/api\/internal\/native-queue\/(?:lookup|read|mutate|start-receipt|import|import-ack)$/u.test(
      path,
    )
  )
    return protectedContract(
      "worker-authenticated owned queue; encrypted prompt/input/source/result envelopes with revision, claim and native-removal acknowledgement metadata",
    );
  if (
    /^\/api\/internal\/native-commands\/(?:pending|permission-transition)$/u.test(
      path,
    )
  )
    return control(
      "worker-authenticated exact native command/activation/request identity or explicit permission policy claim; request bodies and response content remain separately protected",
    );
  if (
    /^\/api\/internal\/native-commands\/(?:admit|bind-preparation|continue|dispatch|events|receipt|settings-evidence|settings-observation|settings-refresh)$/u.test(
      path,
    )
  )
    return protectedContract(
      "worker-authenticated owner/chat command admission and receipts; protected input, results, events or settings accompany immutable operation identity and server-derived exact-turn authority",
    );
  return undefined;
}

export function nativeWorkerCommandContentClassification(command) {
  if (
    [
      "chat.account-defaults",
      "chat.settings.update",
      "chat.settings.read",
    ].includes(command)
  )
    return protectedContract(
      "current native binding and operation IDs route encrypted settings/default patches and results; native writes still require durable command admission",
    );
  if (command === "chat.permissions.update")
    return control(
      "server-resolved native binding and explicit permission transition; worker requests durable admission before applying native policy",
    );
  if (
    [
      "chat.native-control",
      "chat.queue.prepare",
      "chat.queue.execute",
      "chat.automation.resume",
    ].includes(command)
  )
    return protectedContract(
      "server-routed native control or execution with protected prompt/interaction/input/configuration envelopes and public operation, policy and provider routing metadata",
    );
  if (
    [
      "chat.native-logical.cancel",
      "chat.native-logical.complete",
      "chat.queue.changed",
      "chat.runtime.handoff",
    ].includes(command)
  )
    return control(
      "chat-bound operation/generation, queue revision or handoff intent only; no transcript, native artifact or credentials",
    );
  if (command === "computer-use.effects.sync")
    return control(
      "trusted presentation preferences and bounded effect status; no capture pixels, cursor labels or native input",
    );
  if (command === "terminal.prepare-state")
    return protectedContract(
      "server/terminal IDs request worker-created encrypted terminal private state; no native inference or terminal output",
    );
  return undefined;
}
