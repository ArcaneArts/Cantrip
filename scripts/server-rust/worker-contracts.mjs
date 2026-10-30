// Explicit registrations for the actual incoming worker protocol. This module
// runs only during development export; the Rust executable embeds its result.
import * as protocol from "../../packages/protocol/dist/index.js";

const variant = (schema, type, key = "type") => {
  const result = schema.options.find(
    (option) => option.shape[key].value === type,
  );
  if (!result) throw new Error("Missing worker contract variant: " + type);
  return result;
};
const inner = (schema) => {
  while (["optional", "nullable", "default"].includes(schema._zod.def.type))
    schema = schema._zod.def.innerType;
  return schema;
};

export function registerWorkerContracts(register) {
  const event = (type) =>
    variant(protocol.workerEventEnvelopeSchema.shape.event, type);
  const notification = (type) =>
    variant(protocol.workerNotificationSchema, type);
  const activity = (type) => variant(protocol.agentActivitySchema, type);
  register(protocol.providerAuthStatusObservationSchema, [
    "worker-wire-provider-observation",
  ]);
  register(protocol.providerAuthSafeStatusSchema, [
    "worker-wire-provider-status",
  ]);
  register(
    notification("project.run-configuration-runtime.observed").shape
      .observation,
    ["worker-wire-runtime-observation"],
  );
  register(protocol.repositoryRelativePathSchema, [
    "worker-wire-repository-path",
  ]);
  register(notification("chat.turn.outcome"), ["worker-wire-chat-turn-root"]);
  register(protocol.workerLinkPeerCandidateAdvertisementSchema, [
    "worker-wire-link-candidates",
  ]);
  register(protocol.workerLinkPeerSignalNotificationSchema, [
    "worker-wire-link-signal",
  ]);
  register(protocol.cuaIdSchema, [
    "worker-wire-utf8-256",
    "worker-wire-cua-id",
  ]);
  register(protocol.encryptedAgentInteractionResolutionCreateSchema, [
    "worker-wire-interaction-storage",
  ]);
  register(protocol.agentInteractionResolutionCreateSchema, [
    "worker-wire-interaction-storage",
  ]);
  for (const schema of [
    protocol.encryptedInteractionResponseContentSchema,
    protocol.encryptedInteractionRequestContentSchema,
    protocol.encryptedChatPlanProtectedContentSchema,
    protocol.encryptedChatMessageProtectedContentSchema,
  ])
    register(schema, ["worker-wire-communication-envelope"]);
  register(protocol.encryptedTaskMessageProtectedContentSchema, [
    "worker-wire-task-envelope",
  ]);
  register(
    variant(
      protocol.agentInteractionRequestPayloadSchema,
      "permissions",
      "kind",
    ),
    ["worker-wire-permission-cwd"],
  );
  register(
    variant(
      event("computer-use.activity").shape.event,
      "agent.protected-task-message",
    ).shape.message.shape.classification.shape.attachmentIds,
    ["worker-wire-attachment-ids"],
  );
  register(protocol.inferenceProgressSnapshotSchema, [
    "worker-wire-inference-progress",
  ]);
  const raw = inner(activity("turnSummary").shape.raw);
  register(raw.shape.metadata, ["worker-wire-raw-metadata"]);
  register(inner(inner(raw.shape.request).shape.text), [
    "worker-wire-raw-request",
  ]);
  register(inner(inner(raw.shape.response).shape.text), [
    "worker-wire-raw-response",
  ]);
  register(inner(activity("command").shape.outputTail), [
    "worker-wire-command-output",
  ]);
  register(activity("computerUse"), ["worker-wire-computer-use-activity"]);
  register(protocol.cuaImageSchema, ["worker-wire-image-pixels"]);
  register(inner(protocol.cuaCursorAppearanceSchema.shape.label), [
    "worker-wire-utf8-256",
    "worker-wire-cursor-label",
  ]);
  register(protocol.workspaceRepositoryDiscoveryProgressSchema, [
    "worker-wire-discovery-progress",
  ]);
  register(event("computer-use.snapshot.chunk").shape.protectedContent, [
    "endpoint-protected-bytes",
    "worker-wire-computer-use-content",
  ]);
  register(protocol.encryptedAgentInteractionRequestCreateSchema, [
    "worker-wire-protected-interaction-owner",
    "worker-wire-interaction-storage",
  ]);

  // These are the eight known z.json() sites, not an inference about arbitrary
  // lazy callbacks. Preserve ordinary wrappers through the normal exporter.
  const request = protocol.agentInteractionRequestPayloadSchema;
  const response = protocol.agentInteractionResponseSchema;
  const json = new Set(
    [
      variant(request, "commandExecution", "kind").shape.commandActions,
      variant(request, "commandExecution", "kind").shape.additionalPermissions,
      variant(request, "permissions", "kind").shape.requestedPermissions,
      variant(request, "mcpElicitation", "kind").shape.requestedSchema,
      variant(request, "mcpElicitation", "kind").shape.metadata,
      variant(response, "permissions", "kind").shape.permissions,
      variant(response, "mcpElicitation", "kind").shape.content,
      variant(response, "mcpElicitation", "kind").shape.metadata,
    ].map(inner),
  );
  for (const schema of json) {
    const definition = schema._zod.def;
    const resolved = definition.type === "lazy" && definition.getter();
    const options = resolved?._zod.def.options;
    if (
      definition.checks?.length ||
      resolved?._zod.def.type !== "union" ||
      resolved._zod.def.checks?.length ||
      JSON.stringify(options.map((option) => option._zod.def.type)) !==
        JSON.stringify([
          "string",
          "number",
          "boolean",
          "null",
          "array",
          "record",
        ]) ||
      options.some(
        (option) => option._zod.def.checks?.length || option._zod.def.coerce,
      ) ||
      options[4]._zod.def.element !== schema ||
      options[5]._zod.def.valueType !== schema ||
      options[5]._zod.def.keyType._zod.def.type !== "string" ||
      options[5]._zod.def.keyType._zod.def.checks?.length ||
      options[5]._zod.def.keyType._zod.def.coerce
    )
      throw new Error(
        "The native recursive JSON operation no longer matches its protocol schema.",
      );
  }
  return json;
}
