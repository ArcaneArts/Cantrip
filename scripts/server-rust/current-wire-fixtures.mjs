import * as p from "../../packages/protocol/dist/index.js";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import { modelOperationWireFixtures } from "./model-operation-wire-fixtures.mjs";
import { taskGoalWireFixtures } from "./task-goal-wire-fixtures.mjs";
import { chatRelocationWireFixtures } from "./chat-relocation-wire-fixtures.mjs";

export function currentWireFixtures(fixtures, at) {
  const availableAttachment =
    fixtures.externalChatAttachmentReadResultSchema.find(
      ({ status }) => status === "available",
    );
  return {
    ...modelOperationWireFixtures(fixtures, at),
    ...taskGoalWireFixtures(fixtures),
    ...chatRelocationWireFixtures(fixtures, at),
    chatPlanUpdateSchema: p.planModeSchema.options.map((mode) => ({ mode })),
    // The streaming workerRequestEnvelope oracle exercises every command and
    // nested alternative. Keep this alias-root probe bounded in memory.
    workerCommandSchema: [
      fixtures.workerRequestEnvelopeSchema[0].command,
      fixtures.workerRequestEnvelopeSchema.find(
        ({ command }) => command.type === "chat.turn",
      ).command,
    ],
    workerEventSchema: workerIngressFixtures
      .filter(({ kind }) => kind === "event")
      .map(({ event }) => event),
    workerNotificationSchema: workerIngressFixtures
      .filter(({ kind }) => kind === "notification")
      .map(({ notification }) => notification),
    workerLinkResourceKindSchema: p.workerLinkResourceKindSchema.options,
    remoteSurfaceFrameHeaderSchema: p.remoteSurfaceChannelSchema.options.map(
      (channel) => ({
        protocolVersion: 1,
        surfaceId: "surface",
        attachmentId: "attachment",
        sequence: 0,
        channel,
      }),
    ),
    workerAttachmentReadResultSchema: [
      {
        sizeBytes: availableAttachment.sizeBytes,
        chunk: availableAttachment.chunk,
      },
    ],
    workerAttachmentUploadResultSchema: [{ sizeBytes: 128, verified: true }],
  };
}
