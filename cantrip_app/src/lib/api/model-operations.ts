import {
  embeddingInputSchema,
  embeddingOutcomeSchema,
  decisionInputSchema,
  decisionOutcomeSchema,
  modelOperationContentContext,
  modelOperationScopeSchema,
  protectedEmbeddingRequestSchema,
  protectedEmbeddingResponseSchema,
  type EmbeddingInput,
  type EmbeddingResult,
  type DecisionInput,
  type DecisionResult,
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

type Routing = {
  workerId: string;
  modelId?: string | null;
  routeId?: string | null;
  signal?: AbortSignal;
};
type Outcome<T> =
  | { status: "succeeded"; value: T }
  | {
      status: "failed";
      error: { code: string; message: string; httpStatus?: number | null };
    };

async function execute<T>(
  operation: "embedding" | "decision",
  input: Routing,
  content: unknown,
  contentSchema: { parse(value: unknown): unknown },
  outcomeSchema: { parse(value: unknown): Outcome<T> },
): Promise<T> {
  const session = getClientSession(),
    identity = getClientSessionIdentitySnapshot();
  if (!session || !identity)
    throw new CantripApiError(
      "Sign in before requesting model inference.",
      401,
    );
  input.signal?.throwIfAborted();
  const scope = modelOperationScopeSchema.parse({
    workerId: input.workerId,
    modelId: input.modelId ?? null,
    routeId: input.routeId ?? null,
  });
  const snapshot = clientEncryption.getSnapshot();
  if (!snapshot.masterKeyRevision)
    throw new CantripApiError(
      "Unlock encryption before requesting model inference.",
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
  const context = { serverId: session.serverId, operationId, scope, operation };
  const protectedRequest = await protectEndpointContent({
    context: modelOperationContentContext({ ...context, direction: "request" }),
    content,
    schema: contentSchema,
    options: { session: () => session },
  });
  const cancel = () => {
    void request(
      `/api/model-operations/${operation}/cancel`,
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
      `/api/model-operations/${operation}`,
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
        "Model response belongs to another operation.",
        502,
      );
    const outcome = await openEndpointContent({
      context: modelOperationContentContext({
        ...context,
        direction: "response",
      }),
      opaque: response.protectedResponse,
      schema: outcomeSchema,
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

/** Pin expectedSpace when extending/querying existing vectors. */
export async function embed(
  input: EmbeddingInput & Routing,
): Promise<EmbeddingResult> {
  const content = embeddingInputSchema.parse({
    items: input.items,
    options: input.options,
    expectedSpace: input.expectedSpace,
  });
  return execute(
    "embedding",
    {
      ...input,
      modelId: input.modelId ?? input.expectedSpace?.modelId ?? null,
      routeId: input.routeId ?? input.expectedSpace?.routeId ?? null,
    },
    content,
    embeddingInputSchema,
    embeddingOutcomeSchema,
  );
}

/** Native typed decisions; no ordinary-chat emulation or implicit preprocessing. */
export async function decide(
  input: DecisionInput & Routing,
): Promise<DecisionResult> {
  const content = decisionInputSchema.parse({
    state: input.state,
    media: input.media,
    questions: input.questions,
    options: input.options,
  });
  return execute(
    "decision",
    input,
    content,
    decisionInputSchema,
    decisionOutcomeSchema,
  );
}
