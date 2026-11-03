import { settingsSnapshot } from "./native-settings-fixtures.mjs";
export function chatCustomizationWireFixtures() {
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scope = {
      workerId: "alpha",
      projectId: "github",
      chatId: "chat",
      providerId: "provider",
    },
    opaque = {
      formatVersion: 1,
      domain: "customization-content",
      keyRevision: 1,
      envelope: settingsSnapshot.protectedContent,
    },
    capability = {
      available: true,
      profiles: [
        { id: ":workspace", description: "Workspace writes", allowed: true },
      ],
      reason: null,
    },
    transition = {
      selectedId: null,
      resolvedSelectedId: ":workspace",
      effectiveId: ":workspace",
      expectedRevision: "0",
    };
  return {
    customizationContentScopeSchema: [
      scope,
      { ...scope, projectId: null, chatId: null, providerId: null },
    ],
    protectedCustomizationRequestSchema: [
      {
        operationId,
        operation: "customization.skill.configure",
        scope,
        protectedRequest: opaque,
      },
    ],
    protectedCustomizationResponseSchema: [
      {
        operationId,
        operation: "customization.skill.configure",
        scope,
        result: "succeeded",
        lifecycle: null,
        protectedResponse: opaque,
      },
      {
        operationId,
        operation: "customization.external.apply",
        scope,
        result: "failed",
        lifecycle: "pending",
        protectedResponse: opaque,
      },
    ],
    customizationOperationIdSchema: [operationId],
    permissionProfileCapabilitySchema: [
      capability,
      { ...capability, available: false, reason: "Worker offline" },
    ],
    chatPermissionProfileStateSchema: [
      {
        ...capability,
        selectedId: ":workspace",
        effectiveId: ":workspace",
        forcedByWorktreePolicy: false,
      },
      ...["accepted", "dispatched", "applied", "rejected", "uncertain"].map(
        (status) => ({
          ...capability,
          selectedId: ":workspace",
          effectiveId: ":read-only",
          forcedByWorktreePolicy: true,
          policyRevision: "9007199254740993",
          confirmed: true,
          transition: { ...transition, operationId, status },
        }),
      ),
    ],
    chatPermissionProfileUpdateSchema: [
      { id: null },
      {
        id: ":workspace",
        operationId,
        bindingId: "binding",
        expectedRevision: "0",
      },
    ],
    configurablePermissionProfileIdSchema: [
      ":workspace",
      ":read-only",
      ":yolo",
      ":danger-full-access",
    ],
    chatModelUpdateSchema: [{ modelId: "model" }],
    chatReasoningUpdateSchema: [
      { reasoningEffort: null },
      { reasoningEffort: "high" },
    ],
  };
}
