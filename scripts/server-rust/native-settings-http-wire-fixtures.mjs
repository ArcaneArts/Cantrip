import { settingsSnapshot } from "./native-settings-fixtures.mjs";
export function nativeSettingsHttpWireFixtures() {
  const envelope = settingsSnapshot.protectedContent;
  return {
    nativeSettingsRefreshRequestSchema: [{ workerId: "alpha", chatId: "chat" }],
    nativeSettingsUpdateRequestSchema: [
      {
        operationId: "operation",
        bindingId: "binding",
        protectedPatch: envelope,
      },
    ],
    nativeSettingsUpdateReceiptSchema: [
      ...["requesting", "queued", "applied", "rejected", "uncertain"].map(
        (status) => ({
          operationId: "operation",
          submissionId: status === "requesting" ? null : "submission",
          status,
        }),
      ),
    ],
    nativeAccountDefaultsRequestSchema: [
      { action: "read", bindingId: "binding", operationId: "operation" },
      {
        action: "write",
        bindingId: "binding",
        operationId: "operation",
        protectedWrite: envelope,
      },
    ],
    nativeAccountDefaultsResponseSchema: [
      {
        operationId: "operation",
        bindingId: "binding",
        protectedResult: envelope,
      },
    ],
  };
}
