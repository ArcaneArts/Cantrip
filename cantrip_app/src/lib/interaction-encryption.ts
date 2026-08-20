import {
  clearSensitiveBytes,
  decryptInteractionRequestContent,
  decryptInteractionResponseContent,
  encryptInteractionResponseContent,
} from "@cantrip/crypto";
import {
  agentInteractionRequestPayloadSchema,
  agentInteractionRequestSchema,
  agentInteractionResponseSchema,
  encryptedAgentInteractionRequestSchema,
  encryptedAgentInteractionResolutionCreateSchema,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type EncryptedAgentInteractionRequest,
  type EncryptedAgentInteractionResolutionCreate,
} from "@cantrip/protocol";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    identity: { ownerId: session.user.id, serverId: session.serverId },
    keyRevision: snapshot.masterKeyRevision,
    service,
  };
}

export async function openEncryptedAgentInteractionRequest(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<AgentInteractionRequest> {
  const request = encryptedAgentInteractionRequestSchema.parse(raw);
  const context = encryptionContext(options);
  const requestKey = context.service.componentKey({
    component: "interaction-content",
    identity: context.identity,
    keyRevision: request.protectedPayload.keyRevision,
  });
  let payload: ReturnType<typeof agentInteractionRequestPayloadSchema.parse>;
  try {
    const opened = await decryptInteractionRequestContent({
      ownerId: context.identity.ownerId,
      requestKey: request.requestKey,
      keyRevision: request.protectedPayload.keyRevision,
      componentKey: requestKey,
      encrypted: request.protectedPayload,
      publicClassification: request.classification,
    });
    payload = agentInteractionRequestPayloadSchema.parse(opened.payload);
  } finally {
    clearSensitiveBytes(requestKey);
  }

  let response: AgentInteractionResponse | null = null;
  if (request.protectedResponse) {
    const responseKey = context.service.componentKey({
      component: "interaction-content",
      identity: context.identity,
      keyRevision: request.protectedResponse.keyRevision,
    });
    try {
      const opened = await decryptInteractionResponseContent({
        ownerId: context.identity.ownerId,
        requestKey: request.requestKey,
        keyRevision: request.protectedResponse.keyRevision,
        componentKey: responseKey,
        encrypted: request.protectedResponse,
        publicClassification: request.classification,
      });
      response = agentInteractionResponseSchema.parse(opened.response);
    } finally {
      clearSensitiveBytes(responseKey);
    }
  }
  return agentInteractionRequestSchema.parse({
    ...request,
    payload,
    response,
    classification: undefined,
    protectedPayload: undefined,
    protectedResponse: undefined,
  });
}

export async function createEncryptedAgentInteractionResponse(
  request: EncryptedAgentInteractionRequest,
  input: { idempotencyKey: string; response: AgentInteractionResponse },
  options: TrustedOptions = {},
): Promise<EncryptedAgentInteractionResolutionCreate> {
  const context = encryptionContext(options);
  const response = agentInteractionResponseSchema.parse(input.response);
  if (response.kind !== request.classification.kind) {
    throw new Error("Response kind does not match the pending request.");
  }
  const componentKey = context.service.componentKey({
    component: "interaction-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    return encryptedAgentInteractionResolutionCreateSchema.parse({
      idempotencyKey: input.idempotencyKey,
      classification: request.classification,
      protectedResponse: await encryptInteractionResponseContent({
        ownerId: context.identity.ownerId,
        requestKey: request.requestKey,
        keyRevision: context.keyRevision,
        componentKey,
        content: {
          version: 1,
          classification: request.classification,
          response,
        },
      }),
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
