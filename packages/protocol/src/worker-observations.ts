import { z } from "zod";
import { chatContextKindSchema } from "./chats.js";
import { workerObservationEventIdentitySchema } from "./agent-activity.js";
import {
  workerEventSchema,
  workerNotificationSchema,
  directWorkerNotificationTopics,
  workerEventIsProvisional,
} from "./worker-events.js";

export const workerObservationPayloadSchema = z.discriminatedUnion("topic", [
  z
    .object({
      topic: z.literal("chat-progress"),
      chatId: z.string().min(1).max(200),
      clientMessageId: z.string().min(1).max(200),
      executionLaneId: z.string().min(1).max(200),
      contextKind: chatContextKindSchema,
      worktreeId: z.string().min(1).max(200).nullable(),
      scratchRootId: z.string().min(1).max(200).nullable(),
      event: workerEventSchema,
    })
    .strict()
    .superRefine((payload, context) => {
      if (
        (payload.contextKind === "project" &&
          payload.worktreeId !== null &&
          payload.scratchRootId === null) ||
        (payload.contextKind === "standalone" &&
          payload.worktreeId === null &&
          payload.scratchRootId !== null)
      ) {
        // The observation retains the exact execution root needed to render a
        // provisional message before the server publishes its durable row.
      } else {
        context.addIssue({
          code: "custom",
          path: ["contextKind"],
          message: "The observation execution root is invalid.",
        });
      }
      if (!workerEventIsProvisional(payload.event)) {
        context.addIssue({
          code: "custom",
          path: ["event"],
          message:
            "Final messages, outcomes, approvals, and durable worker events cannot use the provisional observation channel.",
        });
      }
    }),
  z
    .object({
      topic: z.enum(["filesystem", "worktree", "runtime"]),
      notification: workerNotificationSchema,
    })
    .strict()
    .superRefine((payload, context) => {
      if (
        directWorkerNotificationTopics.get(payload.notification.type) !==
        payload.topic
      ) {
        context.addIssue({
          code: "custom",
          path: ["notification"],
          message:
            "This worker notification is not authorized for the selected provisional observation topic.",
        });
      }
    }),
]);

export const workerObservationEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    subscriptionId: z.string().uuid(),
    continuitySequence: z.number().int().nonnegative().safe(),
    observedAt: z.iso.datetime(),
    identity: workerObservationEventIdentitySchema,
    payload: workerObservationPayloadSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength >
      512 * 1_024
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker observation envelopes may contain at most 512 KiB.",
      });
    }
  });

export type WorkerObservationPayload = z.infer<
  typeof workerObservationPayloadSchema
>;
export type WorkerObservationEnvelope = z.infer<
  typeof workerObservationEnvelopeSchema
>;
