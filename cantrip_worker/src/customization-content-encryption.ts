import {
  customizationContentResultSchema,
  customizationContentScopeSchema,
  protectedCustomizationResponseSchema,
  type CustomizationContentOperation,
  type CustomizationContentScope,
} from "@cantrip/protocol/customization-content";

import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
  type EndpointContentSchema,
} from "./endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const MAX_REPLAY_RECORDS = 20_000;

function scopeId(scope: CustomizationContentScope): string {
  return JSON.stringify([
    scope.workerId,
    scope.projectId,
    scope.chatId,
    scope.providerId,
  ]);
}

function context(input: {
  serverId: string;
  scope: CustomizationContentScope;
  operationId: string;
  operation: CustomizationContentOperation;
  direction: "request" | "response";
}) {
  return {
    domain: "customization-content" as const,
    serverId: input.serverId,
    workerId: input.scope.workerId,
    scopeId: scopeId(input.scope),
    operationId: input.operationId,
    operation: input.operation,
    direction: input.direction,
    sequence: 0,
  };
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.trim() || "The customization operation failed.";
  return normalized.slice(0, 2_000);
}

export class CustomizationContentReplayGuard {
  readonly #completed = new Map<string, true>();

  reserve(input: {
    serverId: string;
    scope: CustomizationContentScope;
    operationId: string;
    operation: CustomizationContentOperation;
  }): void {
    const key = JSON.stringify([
      input.serverId,
      scopeId(input.scope),
      input.operationId,
      input.operation,
    ]);
    if (this.#completed.has(key)) {
      throw new Error(
        "Protected customization operation was already completed.",
      );
    }
    this.#completed.set(key, true);
    while (this.#completed.size > MAX_REPLAY_RECORDS) {
      const oldest = this.#completed.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#completed.delete(oldest);
    }
  }
}

export function openWorkerCustomizationRequest<T>(input: {
  serverId: string;
  workerId: string;
  scope: CustomizationContentScope;
  operationId: string;
  operation: CustomizationContentOperation;
  opaque: unknown;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<T> {
  const scope = customizationContentScopeSchema.parse(input.scope);
  if (scope.workerId !== input.workerId) {
    throw new Error("Protected customization scope targets another worker.");
  }
  return openWorkerEndpointContent({
    context: context({ ...input, scope, direction: "request" }),
    opaque: input.opaque,
    schema: input.schema,
    service: input.service,
  });
}

export async function protectWorkerCustomizationResponse<T>(input: {
  serverId: string;
  workerId: string;
  scope: CustomizationContentScope;
  operationId: string;
  operation: CustomizationContentOperation;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
  lifecycle?: (value: T) => "pending" | "completed" | "unknown" | null;
  execute(): Promise<T> | T;
}) {
  const scope = customizationContentScopeSchema.parse(input.scope);
  if (scope.workerId !== input.workerId) {
    throw new Error("Protected customization scope targets another worker.");
  }
  let content;
  let lifecycle: "pending" | "completed" | "unknown" | null = null;
  try {
    const value = input.schema.parse(await input.execute());
    content = customizationContentResultSchema.parse({
      status: "succeeded",
      value,
    });
    lifecycle = input.lifecycle?.(value) ?? null;
  } catch (error) {
    content = customizationContentResultSchema.parse({
      status: "failed",
      error: { message: message(error) },
    });
  }
  return protectedCustomizationResponseSchema.parse({
    operationId: input.operationId,
    operation: input.operation,
    scope,
    result: content.status,
    lifecycle,
    protectedResponse: await protectWorkerEndpointContent({
      context: context({ ...input, scope, direction: "response" }),
      content,
      schema: customizationContentResultSchema,
      service: input.service,
    }),
  });
}
