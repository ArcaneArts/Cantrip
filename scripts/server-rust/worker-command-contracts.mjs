// Explicit native registrations for the outgoing worker protocol. Schema
// locators are mechanical; the native tags are authored from actual callbacks.
import * as p from "../../packages/protocol/dist/index.js";
import {
  gitBranchNameInputSchema,
  gitRevisionInputSchema,
} from "../../packages/protocol/dist/git-contracts.js";
import { boundedJsonObjectSchema } from "../../packages/protocol/dist/bounded-json.js";
const variant = (schema, key, value) => {
  const result = schema.options.find(
    (option) => option.shape?.[key]?.value === value,
  );
  if (!result) throw new Error("Missing command contract variant: " + value);
  return result;
};
const command = (type) => variant(p.workerCommandSchema, "type", type);
function at(schema, path) {
  for (const token of path) {
    if (typeof token === "string") schema = schema.shape[token];
    else if (token[0] === "variant")
      schema = variant(schema, token[1], token[2]);
    else if (token[0] === "option") schema = schema.options[token[1]];
    else if (token[0] === "item") schema = schema._zod.def.items[token[1]];
    else schema = schema._zod.def[token[1]];
  }
  return schema;
}
export function registerWorkerCommandContracts(register) {
  register(
    p.protectedSecretEnvelopeSchema,
    0,
    "worker-command-protected-bytes:2097152",
  );
  register(
    p.encryptedTaskProtectedContentSchema,
    0,
    "worker-wire-task-envelope",
  );
  register(
    at(command("label.generate"), [
      "input",
      ["variant", "kind", "task"],
      "task",
      "draftAttachmentIds",
    ]),
    0,
    "worker-command-unique",
  );
  register(
    p.taskWorkerModelConfigurationSchema,
    1,
    "worker-command-task-model",
  );
  register(p.taskAutomaticRetrySchema, 0, "worker-command-retry");
  register(at(command("chat.steer"), []), 0, "worker-command-steer");
  register(
    p.attachmentProtectedMetadataSchema,
    0,
    "worker-command-attachment-envelope",
  );
  register(p.taskOperationRelayGoalSchema, 0, "worker-command-task-goal");
  register(p.encryptedTaskGoalObjectiveSchema, 0, "worker-wire-task-envelope");
  register(
    p.queuedPromptOpaqueContentSchema,
    0,
    "worker-command-queued-prompt",
  );
  register(
    p.encryptedQueuedPromptProtectedContentSchema,
    0,
    "worker-wire-communication-envelope",
  );
  register(
    at(command("chat.native-control"), [
      "control",
      ["variant", "kind", "reply"],
    ]),
    0,
    "worker-command-interaction-response",
  );
  register(at(command("chat.turn"), []), 0, "worker-command-chat-turn");
  register(p.taskOperationRelayRequestSchema, 0, "worker-command-task-relay");
  register(
    p.encryptedTaskPlanningRoundProtectedContentSchema,
    0,
    "worker-wire-task-envelope",
  );
  register(p.chatMessageOpaqueSummarySchema, 0, "worker-command-chat-root");
  register(
    p.encryptedPolicyBodyContentSchema,
    0,
    "worker-command-protected-bytes:131072",
  );
  register(
    p.encryptedPolicySummaryContentSchema,
    0,
    "worker-command-protected-bytes:8192",
  );
  register(
    at(command("surface.configure"), []),
    0,
    "worker-command-surface-command",
  );
  register(
    p.remoteDesktopPrivateStateOpaqueSchema,
    0,
    "worker-command-surface-kind:remote-desktop-state",
  );
  register(
    p.encryptedSurfacePrivateStateSchema,
    0,
    "worker-command-surface-envelope",
  );
  register(
    p.browserPrivateStateOpaqueSchema,
    0,
    "worker-command-surface-kind:browser-state",
  );
  register(
    at(command("surface.attach"), []),
    0,
    "worker-command-surface-command",
  );
  register(
    p.terminalPrivateStateOpaqueSchema,
    0,
    "worker-command-surface-kind:terminal-state",
  );
  register(
    p.codeGraphObservationTargetsSchema,
    0,
    "worker-command-observation-targets:codegraph",
  );
  register(
    p.worktreeObservationTargetsSchema,
    0,
    "worker-command-observation-targets:worktree",
  );
  register(
    p.fileDocumentPrivateStateOpaqueSchema,
    0,
    "worker-command-surface-kind:file-document-state",
  );
  register(p.gitConflictResolutionRequestSchema, 0, "worker-command-conflict");
  register(
    p.gitInteractiveRebaseTodoItemSchema,
    0,
    "worker-command-rebase-todo",
  );
  register(p.gitTagActionSchema, 0, "worker-command-tag-action");
  register(p.gitStashCreateSchema, 0, "worker-command-stash");
  register(p.gitCommitSearchQuerySchema, 0, "worker-command-commit-search");
  register(
    at(command("git.graph.metrics"), ["revision", ["edge", "innerType"]]),
    0,
    "worker-command-safe-revision",
  );
  register(p.gitHistoryFilterSchema, 0, "worker-command-history-filter");
  register(
    p.protectedTunnelContentRecordSchema,
    0,
    "worker-command-tunnel-domain",
  );
  register(
    at(command("project.export.chat.begin"), []),
    0,
    "worker-command-chat-title",
  );
  register(
    p.runConfigurationProtectedSecretListSchema,
    0,
    "worker-command-secret-references",
  );
  register(
    p.runConfigurationSecretProtectedValueSchema,
    1,
    "worker-command-protected-bytes:65664",
  );
  register(
    at(command("project.run-configuration-runtime.restart"), [
      "protectedSecrets",
      ["edge", "element"],
      "reference",
    ]),
    0,
    "worker-command-secret-path",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "options",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-cargo-features",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "options",
      ["edge", "innerType"],
      "profile",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "options",
      ["edge", "innerType"],
      "targetTriple",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "options",
      ["edge", "innerType"],
      "features",
      ["edge", "innerType"],
      ["edge", "element"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "options",
      ["edge", "innerType"],
      "toolchain",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "options",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-cargo-features",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "environment",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-environment-names",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "environment",
      ["edge", "innerType"],
      "variables",
      ["edge", "innerType"],
      ["edge", "element"],
      "value",
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "environment",
      ["edge", "innerType"],
      "files",
      ["edge", "innerType"],
      ["edge", "element"],
    ]),
    0,
    "worker-command-portable-path",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "arguments",
      ["edge", "innerType"],
      ["edge", "element"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "commandOverride",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "commandOverride",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    1,
    "worker-command-not-blank",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "workingDirectory",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-portable-directory",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "rust"],
      "environment",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-environment-names",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-dart-defines",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "dartDefines",
      ["edge", "innerType"],
      ["edge", "element"],
      "value",
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "dartDefines",
      ["edge", "innerType"],
      ["edge", "element"],
      "name",
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "dartDefines",
      ["edge", "innerType"],
      ["edge", "element"],
      "name",
    ]),
    1,
    "worker-command-no-equals",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "flavor",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "deviceId",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "options",
      ["edge", "innerType"],
      "sdkHome",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "platformOverrides",
      ["edge", "innerType"],
      "linux",
      ["edge", "innerType"],
      "options",
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-dart-defines",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "flutter"],
      "target",
      "path",
    ]),
    1,
    "worker-command-dart-path",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "dart"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "dart"],
      "options",
      ["edge", "innerType"],
      "sdkHome",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "dart"],
      "target",
      "path",
    ]),
    1,
    "worker-command-dart-path",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "java"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "java"],
      "options",
      ["edge", "innerType"],
      "jdkHome",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "node"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "shell"],
    ]),
    0,
    "worker-command-run-document",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "shell"],
      "target",
      ["variant", "kind", "script"],
      "interpreter",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.run-configuration-definitions.write"), [
      "request",
      "document",
      ["variant", "provider", "shell"],
      "target",
      ["variant", "kind", "script"],
      "interpreter",
      ["edge", "innerType"],
      ["edge", "innerType"],
    ]),
    1,
    "worker-command-not-blank",
  );
  register(
    at(command("project.run-configuration-definitions.paths"), ["query"]),
    0,
    "worker-command-nul-free",
  );
  register(
    at(command("project.folder-conversion.execute"), []),
    0,
    "worker-command-source-path-pair",
  );
  register(
    at(command("project.folder-conversion.preflight"), []),
    0,
    "worker-command-source-path-pair",
  );
  register(
    p.githubActionsWorkflowDispatchSchema,
    0,
    "worker-command-workflow-inputs",
  );
  register(
    at(command("github.pull-request.review.mutate"), [
      "action",
      ["variant", "type", "set-file-viewed"],
      "path",
    ]),
    0,
    "worker-command-review-path",
  );
  register(
    p.githubPullRequestInlineCommentCreateSchema,
    0,
    "worker-command-inline-comment",
  );
  register(
    p.githubPullRequestReviewSubmitSchema,
    0,
    "worker-command-review-reason",
  );
  register(p.githubPullRequestCreateSchema, 0, "worker-command-pull-branches");
  register(
    at(command("github.pull-request.create"), ["request", "head"]),
    0,
    "worker-command-no-controls",
  );
  register(
    at(command("github.pull-request.create"), ["request", "base"]),
    0,
    "worker-command-no-controls",
  );
  register(
    at(command("automation.dispatch.protect"), [
      "content",
      "protectedCondition",
    ]),
    0,
    "worker-command-protected-bytes:4194304",
  );
  register(
    at(command("github.repositories.create"), ["request", "name"]),
    0,
    "worker-command-not-dot",
  );
  register(
    at(command("web-runtime.action"), []),
    0,
    "worker-command-runtime-profiles",
  );
  register(
    p.standaloneChatScratchReconciliationTargetSchema,
    0,
    "worker-command-scratch-reconcile",
  );
  register(
    p.standaloneChatScratchArchiveCommandSchema,
    0,
    "worker-command-scratch-archive",
  );
  register(p.workerLinkLeaseSchema, 0, "worker-command-link-lease");
  register(
    p.workerLinkPeerConfigurationSchema,
    0,
    "worker-command-link-configuration",
  );
  register(
    at(command("worker-link.peer.install"), ["configuration", "stunUrls"]),
    0,
    "worker-command-unique",
  );
  register(
    at(command("worker-link.peer.install"), [
      "configuration",
      "stunUrls",
      ["edge", "element"],
    ]),
    0,
    "worker-command-stun-url",
  );
  register(p.installedWorkerLinkGrantSchema, 0, "worker-command-link-grant");
  register(
    at(command("worker-link.grant.install"), [
      "grant",
      "observation",
      ["edge", "innerType"],
      "topics",
    ]),
    0,
    "worker-command-unique",
  );
  register(
    at(command("worker-link.grant.install"), [
      "grant",
      "binding",
      "operations",
    ]),
    0,
    "worker-command-unique",
  );
  register(
    at(command("worker-link.grant.install"), ["grant", "binding", "lanes"]),
    0,
    "worker-command-unique",
  );
  register(p.workerLinkSessionSchema, 0, "worker-command-link-session");
  register(
    at(command("worker-link.session.install"), [
      "session",
      "routePolicy",
      "enabled",
    ]),
    0,
    "worker-command-unique",
  );
  register(
    at(command("computer-use.operation"), ["request", "protectedContent"]),
    1,
    "worker-command-control-content:16777216",
  );
  const forwards = new Map();
  for (const type of ["createBranch", "restoreBranch", "reset"]) {
    const shape = variant(p.gitRecoveryActionSchema, "type", type).shape;
    if (shape.branch) forwards.set(shape.branch, gitBranchNameInputSchema);
    forwards.set(shape.target, gitRevisionInputSchema);
  }
  for (const [lazy, target] of forwards) {
    if (
      lazy._zod.def.type !== "lazy" ||
      lazy._zod.def.getter() !== target ||
      lazy._zod.def.checks?.length
    )
      throw new Error("Git recovery forward reference changed");
  }
  return {
    forwards,
    transforms: [[boundedJsonObjectSchema._zod.def.out, "bounded-json-object"]],
  };
}
