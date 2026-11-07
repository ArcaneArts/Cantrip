import {
  embeddingInputSchema,
  embeddingOutcomeSchema,
  modelOperationContentContext,
  modelOperationScopeSchema,
  protectedEmbeddingRequestSchema,
  protectedEmbeddingResponseSchema,
  type EmbeddingInput,
  type EmbeddingResult,
} from "@cantrip/protocol";
import { CantripApiError, request } from "@/lib/api-client";
import {
  getClientSession,
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import {
  openEndpointContent,
  protectEndpointContent,
} from "@/lib/endpoint-content-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";
import { refreshWorkerEncryption } from "./worker-wire";

/** Direct model inference with protected payloads. Pin expectedSpace when using
 * existing vectors; a changed default never overrides its model/route identity. */
export async function embed(
  input: EmbeddingInput & {
    workerId: string;
    modelId?: string | null;
    routeId?: string | null;
    signal?: AbortSignal;
  },
): Promise<EmbeddingResult> {
  const session = getClientSession(),
    identity = getClientSessionIdentitySnapshot();
  if (!session || !identity)
    throw new CantripApiError("Sign in before requesting embeddings.", 401);
  const content = embeddingInputSchema.parse({
    items: input.items,
    options: input.options,
    expectedSpace: input.expectedSpace,
  });
  input.signal?.throwIfAborted();
  const scope = modelOperationScopeSchema.parse({
    workerId: input.workerId,
    modelId: input.modelId ?? input.expectedSpace?.modelId ?? null,
    routeId: input.routeId ?? input.expectedSpace?.routeId ?? null,
  });
  const snapshot = clientEncryption.getSnapshot();
  if (!snapshot.masterKeyRevision)
    throw new CantripApiError(
      "Unlock encryption before requesting embeddings.",
      409,
    );
  await authorizeWorkerEncryption({
    components: ["model-operation-content", "provider-credential"],
    assertCurrent: () => {
      if (!clientSessionIdentityMatches(identity))
        throw new CantripApiError(
          "The account changed during model operation authorization.",
          409,
        );
    },
    identity: { ownerId: session.user.id, serverId: session.serverId },
    keyRevision: snapshot.masterKeyRevision,
    service: clientEncryption,
    workerId: scope.workerId,
  });
  await refreshWorkerEncryption(scope.workerId, {
    component: "model-operation-content",
    keyRevision: snapshot.masterKeyRevision,
  });
  const operationId = crypto.randomUUID();
  const context = { serverId: session.serverId, operationId, scope };
  const protectedRequest = await protectEndpointContent({
    context: modelOperationContentContext({ ...context, direction: "request" }),
    content,
    schema: embeddingInputSchema,
    options: { session: () => session },
  });
  const cancel = () => {
    void request(
      "/api/model-operations/embedding/cancel",
      {
        method: "POST",
        body: JSON.stringify({ operationId, scope }),
      },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    ).catch(() => {});
  };
  input.signal?.throwIfAborted();
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const raw = await request(
      "/api/model-operations/embedding",
      {
        method: "POST",
        signal: input.signal,
        body: JSON.stringify(
          protectedEmbeddingRequestSchema.parse({
            operationId,
            scope,
            protectedRequest,
          }),
        ),
      },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    );
    const response = protectedEmbeddingResponseSchema.parse(raw);
    if (
      response.operationId !== operationId ||
      JSON.stringify(response.scope) !== JSON.stringify(scope)
    )
      throw new CantripApiError(
        "Embedding response belongs to another operation.",
        502,
      );
    const outcome = await openEndpointContent({
      context: modelOperationContentContext({
        ...context,
        direction: "response",
      }),
      opaque: response.protectedResponse,
      schema: embeddingOutcomeSchema,
      options: { session: () => session },
    });
    if (outcome.status === "failed")
      throw new CantripApiError(
        outcome.error.message,
        outcome.error.httpStatus ?? 409,
        outcome.error.code,
      );
    return outcome.value;
  } finally {
    input.signal?.removeEventListener("abort", cancel);
  }
}
