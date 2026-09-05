import {
  clearSensitiveBytes,
  decryptInteractionResponseContent,
  encryptInteractionRequestContent,
} from "@cantrip/crypto";
import {
  agentInteractionResponseSchema,
  encryptedAgentInteractionRuntimeRequestSchema,
  type AgentInteractionResponse,
  type AgentInteractionRuntimeRequest,
  type EncryptedAgentInteractionRuntimeRequest,
} from "@cantrip/protocol";
import {
  interactionResponseOpaqueContentSchema,
  type InteractionResponseOpaqueContent,
} from "@cantrip/protocol/communication-content";

import type { WorkerEncryptionService } from "./worker-encryption.js";
import type { WorkerEndpointEncryptionService } from "./endpoint-content-encryption.js";

export async function protectAgentInteractionRequest(input: {
  request: AgentInteractionRuntimeRequest;
  service: WorkerEncryptionService;
}): Promise<EncryptedAgentInteractionRuntimeRequest> {
  const component = input.service.componentKey("interaction-content");
  const classification = { kind: input.request.payload.kind };
  try {
    return encryptedAgentInteractionRuntimeRequestSchema.parse({
      requestKey: input.request.requestKey,
      threadId: input.request.threadId,
      turnId: input.request.turnId,
      itemId: input.request.itemId,
      classification,
      protectedPayload: await encryptInteractionRequestContent({
        ownerId: input.service.ownerId(),
        requestKey: input.request.requestKey,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        content: {
          version: 1,
          classification,
          payload: input.request.payload,
        },
      }),
      expiresAt: input.request.expiresAt,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openAgentInteractionResponse(input: {
  requestKey: string;
  response: InteractionResponseOpaqueContent;
  service: WorkerEndpointEncryptionService;
}): Promise<AgentInteractionResponse> {
  const response = interactionResponseOpaqueContentSchema.parse(input.response);
  const component = input.service.componentKey("interaction-content");
  try {
    if (component.keyRevision !== response.protectedResponse.keyRevision) {
      throw new Error(
        "The protected interaction response uses an unavailable key revision.",
      );
    }
    const opened = await decryptInteractionResponseContent({
      ownerId: input.service.ownerId(),
      requestKey: input.requestKey,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      encrypted: response.protectedResponse,
      publicClassification: response.classification,
    });
    const parsed = agentInteractionResponseSchema.parse(opened.response);
    if (parsed.kind !== response.classification.kind) {
      throw new Error("The protected interaction response kind is invalid.");
    }
    return parsed;
  } finally {
    clearSensitiveBytes(component.key);
  }
}
