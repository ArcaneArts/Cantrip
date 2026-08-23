import type { EndpointContentOpaque } from "@cantrip/protocol/endpoint-content";

import {
  openEndpointContent,
  protectEndpointContent,
} from "./endpoint-content-encryption";

type ContentSchema<T> = { parse(value: unknown): T };

function context(input: {
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  direction: "request" | "response" | "event" | "stored";
  sequence?: number;
}) {
  return {
    domain: "run-content" as const,
    workerId: null,
    scopeId: JSON.stringify([input.projectId, input.worktreeId]),
    operationId: input.operationId,
    operation: input.operation,
    direction: input.direction,
    sequence: input.sequence ?? 0,
  };
}

export function protectRunContent<T>(input: {
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  content: T;
  schema: ContentSchema<T>;
}): Promise<EndpointContentOpaque> {
  return protectEndpointContent({
    context: context({ ...input, direction: "request" }),
    content: input.content,
    schema: input.schema,
  });
}

export function openRunContent<T>(input: {
  projectId: string;
  worktreeId: string;
  operationId: string;
  operation: string;
  opaque: unknown;
  schema: ContentSchema<T>;
  direction?: "response" | "event" | "stored";
  sequence?: number;
}): Promise<T> {
  return openEndpointContent({
    context: context({
      ...input,
      direction: input.direction ?? "response",
    }),
    opaque: input.opaque,
    schema: input.schema,
  });
}
