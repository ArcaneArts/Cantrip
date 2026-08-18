import { z } from "zod";

import {
  decodeJsonMessage,
  encodeJsonMessage,
  type JsonMessageDecodeResult,
} from "./json-message.js";
import { workflowJsonObjectSchemaWithLimits } from "./workflows.js";

export const appLiveProtocolVersionSchema = z.literal(1);

const liveIdSchema = z.string().trim().min(1).max(200);
const liveRequestIdSchema = z.string().trim().min(1).max(200);
const liveCursorSchema = z.number().int().nonnegative().safe();

export const appLiveScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current-user") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: liveIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat"),
      chatId: liveIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow-run"),
      runId: liveIdSchema,
    })
    .strict(),
]);

export type AppLiveScope = z.infer<typeof appLiveScopeSchema>;

export function appLiveScopeKey(scope: AppLiveScope): string {
  switch (scope.kind) {
    case "current-user":
      return "current-user";
    case "project":
      return `project:${scope.projectId}`;
    case "chat":
      return `chat:${scope.chatId}`;
    case "workflow-run":
      return `workflow-run:${scope.runId}`;
  }
}

const appLiveScopesSchema = z
  .array(appLiveScopeSchema)
  .min(1)
  .max(128)
  .superRefine((scopes, context) => {
    const keys = new Set<string>();
    for (const [index, scope] of scopes.entries()) {
      const key = appLiveScopeKey(scope);
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Live subscription scopes must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const appLiveResourceSchema = z.enum([
  "server",
  "settings",
  "policy",
  "worker",
  "project",
  "project-folder-setup-job",
  "project-github-conversion-job",
  "project-replica-job",
  "project-tab-layout",
  "worktree",
  "worktree-status",
  "git-operation",
  "git-conflict",
  "chat",
  "chat-import-job",
  "chat-relocation-job",
  "chat-message",
  "chat-queue",
  "chat-goal",
  "chat-plan",
  "task",
  "agent-interaction",
  "terminal",
  "explorer",
  "browser",
  "code-tab",
  "project-view",
  "remote-desktop",
  "tunnel",
  "workflow-definition",
  "workflow-run",
  "workflow-node",
  "workflow-gate",
  "workflow-trigger",
  "customization",
]);

export const appLiveEventActionSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "reordered",
  "status",
  "invalidated",
]);

// A running agent command may retain a sanitized 256 KiB UTF-8 tail. JSON
// escaping can at most double that terminal text, so this leaves headroom for
// the surrounding message while remaining below the live hub's 1 MiB queue
// threshold.
const MAX_LIVE_EVENT_PAYLOAD_BYTES = 768 * 1_024;
const liveEventJsonObjectSchema = workflowJsonObjectSchemaWithLimits({
  maxBytes: MAX_LIVE_EVENT_PAYLOAD_BYTES,
  maxStringLength: 300_000,
});

export const appLiveEventPayloadSchema = liveEventJsonObjectSchema.superRefine(
  (payload, context) => {
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    if (encoded.byteLength > MAX_LIVE_EVENT_PAYLOAD_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Live event payloads may contain at most ${MAX_LIVE_EVENT_PAYLOAD_BYTES} encoded bytes.`,
      });
    }
  },
);

export const appLiveClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("initialize"),
      protocolVersion: appLiveProtocolVersionSchema,
      client: z
        .object({
          id: liveIdSchema,
          name: z.string().trim().min(1).max(100),
          version: z.string().trim().min(1).max(100),
        })
        .strict(),
      resume: z
        .object({
          serverEpoch: liveIdSchema,
          cursor: liveCursorSchema,
        })
        .strict()
        .nullable()
        .default(null),
    })
    .strict(),
  z
    .object({
      type: z.literal("subscribe"),
      requestId: liveRequestIdSchema,
      scopes: appLiveScopesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("unsubscribe"),
      requestId: liveRequestIdSchema,
      scopes: appLiveScopesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
      nonce: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("resync-ack"),
      requestId: liveRequestIdSchema,
      cursor: liveCursorSchema,
      scopes: appLiveScopesSchema,
    })
    .strict(),
]);

export const appLiveResyncReasonSchema = z.enum([
  "server-epoch-changed",
  "cursor-expired",
  "queue-overflow",
  "scope-changed",
  "client-requested",
]);

export const appLiveErrorCodeSchema = z.enum([
  "invalid-message",
  "not-initialized",
  "already-initialized",
  "unsupported-version",
  "unauthorized-scope",
  "subscription-limit",
  "payload-too-large",
  "rate-limited",
  "internal-error",
]);

export const appLiveServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      protocolVersion: appLiveProtocolVersionSchema,
      serverEpoch: liveIdSchema,
      connectionId: liveIdSchema,
      currentCursor: liveCursorSchema,
      heartbeatIntervalMs: z.number().int().min(5_000).max(120_000),
      resume: z.enum(["not-requested", "replaying", "resync-required"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("subscribed"),
      requestId: liveRequestIdSchema,
      scopes: appLiveScopesSchema,
      cursor: liveCursorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("unsubscribed"),
      requestId: liveRequestIdSchema,
      scopes: appLiveScopesSchema,
      cursor: liveCursorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      cursor: liveCursorSchema,
      scope: appLiveScopeSchema,
      resource: appLiveResourceSchema,
      action: appLiveEventActionSchema,
      entityId: liveIdSchema.nullable(),
      revision: z.number().int().nonnegative().safe().nullable(),
      payload: appLiveEventPayloadSchema.nullable(),
      occurredAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal("caught-up"),
      cursor: liveCursorSchema,
      replayedCount: z.number().int().nonnegative().max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      nonce: z.string().min(1).max(200),
      cursor: liveCursorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resync-required"),
      cursor: liveCursorSchema,
      reason: appLiveResyncReasonSchema,
      scopes: z.array(appLiveScopeSchema).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: liveRequestIdSchema.nullable(),
      code: appLiveErrorCodeSchema,
      message: z.string().trim().min(1).max(2_048),
      retryable: z.boolean(),
    })
    .strict(),
]);

export type AppLiveResource = z.infer<typeof appLiveResourceSchema>;
export type AppLiveEventAction = z.infer<typeof appLiveEventActionSchema>;
export type AppLiveEventPayload = z.infer<typeof appLiveEventPayloadSchema>;
export type AppLiveClientMessage = z.infer<typeof appLiveClientMessageSchema>;
export type AppLiveResyncReason = z.infer<typeof appLiveResyncReasonSchema>;
export type AppLiveErrorCode = z.infer<typeof appLiveErrorCodeSchema>;
export type AppLiveServerMessage = z.infer<typeof appLiveServerMessageSchema>;

export function decodeAppLiveClientMessage(
  encoded: string,
): JsonMessageDecodeResult<AppLiveClientMessage> {
  return decodeJsonMessage(encoded, appLiveClientMessageSchema);
}

export function decodeAppLiveServerMessage(
  encoded: string,
): JsonMessageDecodeResult<AppLiveServerMessage> {
  return decodeJsonMessage(encoded, appLiveServerMessageSchema);
}

export function encodeAppLiveClientMessage(
  message: AppLiveClientMessage,
): string {
  return encodeJsonMessage(message, appLiveClientMessageSchema);
}

export function encodeAppLiveServerMessage(
  message: AppLiveServerMessage,
): string {
  return encodeJsonMessage(message, appLiveServerMessageSchema);
}
