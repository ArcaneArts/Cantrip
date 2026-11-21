import { randomUUID } from "node:crypto";
import type { NativeRuntimeHandoffState } from "@cantrip/protocol";

export function nativeRuntimeHandoffFixture(
  overrides: Partial<NativeRuntimeHandoffState> = {},
): NativeRuntimeHandoffState {
  const state: NativeRuntimeHandoffState = {
    operationId: randomUUID(),
    chatId: "chat",
    workerId: "worker",
    phase: "committed",
    source: {
      chatId: "chat",
      workerId: "worker",
      threadId: "native-thread",
      contextKind: "project",
      projectId: "project",
      placementId: "worktree",
      modelRouteId: "old-route",
      providerAccountId: "old-account",
      bindingId: "source-binding",
      runtimeGeneration: "source-runtime",
      nativeEpoch: "source-epoch",
    },
    targetModelRouteId: "target-route",
    targetProviderAccountId: "target-account",
    prepared: {
      threadId: "native-thread",
      runtimeGeneration: "destination-runtime",
      snapshot: {
        context: {
          chatId: "chat",
          workerId: "worker",
          threadId: "native-thread",
          runtimeGeneration: "destination-runtime",
          settingsVersion: { epoch: "destination-epoch", revision: "0" },
        },
        contentFingerprint: "a".repeat(64),
        modelAttribution: {
          fingerprint: "b".repeat(64),
          selection: {
            status: "resolved",
            workerId: "worker",
            providerId: "target-provider",
            providerAccountId: "target-account",
            modelId: "target-model",
            routeId: "target-route",
          },
        },
        protectedContent: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    },
    errorCode: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return { ...state, ...overrides };
}
