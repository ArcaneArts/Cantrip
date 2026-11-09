import { record as suspension } from "./native-suspension-oracle.mjs";
import { osCommands } from "./cantrip-os-dispatch-fixtures.mjs";

// Reuse the domain fixtures exercised by the focused wire/product suites.
export function currentWorkerCommandFixtures(fixtures) {
  const configuration =
    fixtures.nativeRuntimeHandoffConfigurationSchema[0].configuration;
  const runtime = Object.fromEntries(
    [
      "session",
      "cwd",
      "model",
      "provider",
      "permissionProfileId",
      "planMode",
      "subagentDefaults",
      "mcpServers",
    ].map((key) => [key, configuration[key]]),
  );
  const protectedRequest = fixtures.protectedEmbeddingRequestSchema[0];
  const route = fixtures.modelOperationRouteSchema[0];
  const claim = fixtures.nativeGoalClaimRecoverySchema[0];
  return [
    ...["embedding", "decision"].map((operation) => ({
      ...protectedRequest,
      type: `model.${operation}`,
      serverId: "server",
      route: {
        ...route,
        adapter:
          operation === "embedding" ? "openai-embeddings" : "openai-decisions",
      },
    })),
    {
      type: "model.operation.cancel",
      serverId: "server",
      ...fixtures.modelOperationCancelSchema[0],
    },
    ...["resume", "stop"].map((action) => ({
      ...runtime,
      type: `chat.suspension.${action}`,
      chatId: runtime.session.chatId,
      threadId: suspension.active.threadId,
      controlId: suspension.controlId,
      checkpoint: suspension.checkpoint,
      nativeActivationGeneration: null,
      nativeRuntimeGeneration: null,
      executionProfile: "ide",
    })),
    {
      ...runtime,
      type: "chat.goal.claim-recover",
      chatId: runtime.session.chatId,
      threadId: claim.threadId,
      claim,
    },
    ...fixtures.cantripOsPackageWorkerCommandSchema,
    ...fixtures.cantripOsSystemWorkerCommandSchema,
    ...fixtures.cantripOsDesktopWorkerCommandSchema,
    ...osCommands.filter(({ type }) => type === "cantrip-os.backup.reset"),
  ];
}
