import {
  customizationContentResultSchema,
  customizationContentScopeSchema,
  protectedCustomizationRequestSchema,
  protectedCustomizationResponseSchema,
  type CustomizationContentOperation,
  type CustomizationContentScope,
} from "@cantrip/protocol/customization-content";

import {
  openEndpointContent,
  protectEndpointContent,
} from "./endpoint-content-encryption";

type ContentSchema<T> = { parse(value: unknown): T };

function scopeId(scope: CustomizationContentScope): string {
  return JSON.stringify([
    scope.workerId,
    scope.projectId,
    scope.chatId,
    scope.providerId,
  ]);
}

function context(input: {
  scope: CustomizationContentScope;
  operationId: string;
  operation: CustomizationContentOperation;
  direction: "request" | "response";
}) {
  return {
    domain: "customization-content" as const,
    workerId: input.scope.workerId,
    scopeId: scopeId(input.scope),
    operationId: input.operationId,
    operation: input.operation,
    direction: input.direction,
    sequence: 0,
  };
}

export class CustomizationContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomizationContentError";
  }
}

export async function protectCustomizationRequest<T>(input: {
  scope: CustomizationContentScope;
  operationId: string;
  operation: CustomizationContentOperation;
  content: T;
  schema: ContentSchema<T>;
}) {
  const scope = customizationContentScopeSchema.parse(input.scope);
  return protectedCustomizationRequestSchema.parse({
    operationId: input.operationId,
    operation: input.operation,
    scope,
    protectedRequest: await protectEndpointContent({
      context: context({ ...input, scope, direction: "request" }),
      content: input.content,
      schema: input.schema,
    }),
  });
}

function matchesExpectedScope(
  actual: CustomizationContentScope,
  expected: Partial<CustomizationContentScope>,
): boolean {
  return (Object.keys(expected) as (keyof CustomizationContentScope)[]).every(
    (key) => actual[key] === expected[key],
  );
}

export async function openCustomizationResponse<T>(input: {
  raw: unknown;
  operationId: string;
  operation: CustomizationContentOperation;
  expectedScope: Partial<CustomizationContentScope>;
  schema: ContentSchema<T>;
}): Promise<T> {
  const wire = protectedCustomizationResponseSchema.parse(input.raw);
  if (
    wire.operationId !== input.operationId ||
    wire.operation !== input.operation ||
    !matchesExpectedScope(wire.scope, input.expectedScope)
  ) {
    throw new CustomizationContentError(
      "Protected customization content targets another operation.",
    );
  }
  const content = customizationContentResultSchema.parse(
    await openEndpointContent({
      context: context({
        scope: wire.scope,
        operationId: wire.operationId,
        operation: wire.operation,
        direction: "response",
      }),
      opaque: wire.protectedResponse,
      schema: customizationContentResultSchema,
    }),
  );
  if (content.status !== wire.result) {
    throw new CustomizationContentError(
      "Protected customization result classification is invalid.",
    );
  }
  if (content.status === "failed") {
    throw new CustomizationContentError(content.error.message);
  }
  return input.schema.parse(content.value);
}
