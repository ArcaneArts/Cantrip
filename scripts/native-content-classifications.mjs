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
  if (
    path.startsWith("/api/cantrip-os/backup") ||
    path === "/api/cantrip-os/:instanceId/backup-operations"
  )
    return protectedContract(
      "owner-resolved backup operations carry endpoint-encrypted request/result envelopes; instance, operation, revision and phase are routing metadata, and archives remain on authorized endpoints",
    );
  if (path === "/api/internal/native-commands/task-goal-cycle-dispatch")
    return control(
      "worker-authenticated current owner/server/process and canonical Task cycle, Goal epoch, route and FIFO identity; accepted metadata only, without Goal text, prompt replay or server-owned capacity",
    );
  if (path === "/api/internal/native-commands/suspension-execution")
    return protectedContract(
      "worker-authenticated exact native suspension and session identities with a digest and protected payload; the actual admitted native checkpoint governs resumption, not copied plaintext tool or prompt content",
    );
  if (path === "/api/tasks/:chatId/inference-route")
    return classified(
      "minimized-operational-metadata",
      "owner-scoped canonical Task input, revision, destination route/account and worker settlement; Task text, attachments and private account labels remain endpoint protected",
    );
  if (
    path === "/api/projects/:projectId/cantrip-os/bindings/:bindingId/provision"
  )
    return protectedContract(
      "owner-scoped source provisioning with operation and binding generations; repository URLs and private placement intent remain in the protectedRequest envelope",
    );
  if (
    [
      "/api/cantrip-os",
      "/api/cantrip-os/inspect",
      "/api/cantrip-os/attach",
      "/api/cantrip-os/:instanceId/recovery",
      "/api/cantrip-os/:instanceId/refresh",
      "/api/cantrip-os/:instanceId/workspaces",
      "/api/projects/:projectId/cantrip-os/bindings",
      "/api/projects/:projectId/cantrip-os/bindings/:bindingId/recover",
      "/api/projects/:projectId/cantrip-os/bindings/:bindingId/verify",
    ].includes(path)
  )
    return control(
      "owner-scoped OS attachment, workspace and source-binding routing, generations and worker-observed receipts; provisioning intent remains endpoint protected",
    );
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
  if (path === "/api/internal/native-commands/task-input-dispatch")
    return control(
      "worker-authenticated owner, server and current process generation; canonical Task round/input and dispatch-fence identities plus accepted/dispatch phase only; prompt content remains in the existing endpoint-encrypted Task round",
    );
  if (path === "/api/internal/native-commands/inference-recovery")
    return control(
      "worker-authenticated owner and current process generation; strict admission journal identities, lifecycle outcomes and recovery disposition only; prompt inputs remain in their existing endpoint-encrypted queues",
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
  if (command === "task.goal.source")
    return protectedContract(
      "owned chat/project/thread, provider route and canonical Task cycle identities only; the actual worker captures private-scope journal metadata and endpoint-encrypted native settings without preparing or granting inference",
    );
  if (
    [
      "cantrip-os.backup.capture",
      "cantrip-os.backup.restore",
      "cantrip-os.backup.rollback",
    ].includes(command)
  )
    return protectedContract(
      "server-derived owned instance/workspace dispatch and operation identities accompany endpoint-encrypted private backup intent and results; archive contents and native execution remain worker-local",
    );
  if (command === "cantrip-os.backup.observe")
    return protectedContract(
      "owned backup scope and operation identity select observation or recovery of an existing operation; result details remain in the endpoint-protected result envelope",
    );
  if (command === "chat.goal.claim-recover")
    return protectedContract(
      "owner-bound original Goal claim and managed session retain protected provider/MCP configuration; the worker recovers the actual native claim without replaying a Goal setter or prompt",
    );
  if (command === "task.goal.recover")
    return protectedContract(
      "canonical Task Goal recovery and FIFO identities plus protected model/MCP configuration; no Goal setter or prompt is replayed, and only the owning worker may obtain a provider ticket",
    );
  if (command === "cantrip-os.source.provision")
    return protectedContract(
      "server-derived owned source scope and durable admission accompany an opaque repository provision request; private intent is opened only by the authorized worker",
    );
  if (
    [
      "cantrip-os.inspect",
      "cantrip-os.attach",
      "cantrip-os.workspaces.list",
      "cantrip-os.workspaces.create",
      "cantrip-os.source.inspect",
      "cantrip-os.operation.inspect",
    ].includes(command)
  )
    return control(
      "authorized OS transport and workspace routing, canonical source scopes, lifecycle generations and receipts; source provision content uses a separate protected request",
    );
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
