import type { EndpointContentOpaque } from "@cantrip/protocol/endpoint-content";

import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
  type EndpointContentSchema,
} from "./endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

function context(input: {
  serverId: string;
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  direction: "request" | "response" | "event" | "stored";
  sequence?: number;
}) {
  return {
    domain: "run-content" as const,
    serverId: input.serverId,
    workerId: null,
    scopeId: JSON.stringify([input.projectId, input.worktreeId]),
    operationId: input.operationId,
    operation: input.operation,
    direction: input.direction,
    sequence: input.sequence ?? 0,
  };
}

export function protectWorkerRunContent<T>(input: {
  serverId: string;
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  content: T;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
  direction?: "request" | "response" | "event" | "stored";
  sequence?: number;
}): Promise<EndpointContentOpaque> {
  return protectWorkerEndpointContent({
    context: context({
      ...input,
      direction: input.direction ?? "response",
    }),
    content: input.content,
    schema: input.schema,
    service: input.service,
  });
}

export function openWorkerRunContent<T>(input: {
  serverId: string;
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  opaque: unknown;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
  direction?: "request" | "response" | "event" | "stored";
  sequence?: number;
}): Promise<T> {
  return openWorkerEndpointContent({
    context: context({ ...input, direction: input.direction ?? "request" }),
    opaque: input.opaque,
    schema: input.schema,
    service: input.service,
  });
}
