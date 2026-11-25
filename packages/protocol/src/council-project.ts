import { z } from "zod";

import {
  agentChatSendWireSchema,
  agentChatWireDescriptorSchema,
  cantripMcpChatSendInputSchema,
} from "./agent-chat-tools.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { cantripMcpTaskCreateInputSchema } from "./agent-task-tools.js";
import {
  councilProjectRequestSourceSchema,
  councilProjectResultSourceSchema,
} from "./council-input.js";
import {
  chatMessageOpaqueContentSchema,
  interactionRequestOpaqueContentSchema,
} from "./communication-content.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  taskMessageOpaqueContentSchema,
  taskOpaqueContentSchema,
} from "./tasks.js";

const projectId = z.string().min(1).max(255);
export const councilProjectChatCreateInputSchema = z
  .object({
    operationId: z.uuid(),
    projectId,
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const councilProjectChatCreateWireSchema =
  councilProjectChatCreateInputSchema.omit({ title: true }).extend({
    chatId: z.uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  });

export const councilProjectChatCreateOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: z
      .object({
        projectId,
        operationId: z.uuid(),
        chatId: z.uuid(),
        workerId: z.string().min(1),
      })
      .strict(),
  });

export const councilProjectTaskCreateInputSchema =
  cantripMcpTaskCreateInputSchema.extend({
    projectId,
    start: z.boolean().default(true),
  });

export const councilProjectTaskCreateWireSchema =
  councilProjectTaskCreateInputSchema
    .omit({ title: true, description: true })
    .extend({
      taskId: z.uuid(),
      titleProtection: privateDisplayLabelOpaqueSchema,
      task: taskOpaqueContentSchema,
    });

export const councilProjectTaskCreateOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: z
      .object({
        projectId,
        operationId: z.uuid(),
        taskId: z.uuid(),
        workerId: z.string().min(1),
        started: z.boolean(),
      })
      .strict(),
  });
const councilProjectInput = {
  chatId: z.string().uuid(),
  messageId: z.uuid(),
  promptId: z.uuid(),
  idempotencyKey: z.string().max(200).min(1),
  configuration: modelConfigurationSchema,
};

export const councilProjectResultPrepareCommandSchema = z
  .object({
    type: z.literal("council.project-result.prepare"),
    ...councilProjectInput,
    source: councilProjectResultSourceSchema,
    result: z
      .union([
        chatMessageOpaqueContentSchema.pick({
          id: true,
          classification: true,
          protectedContent: true,
        }),
        taskMessageOpaqueContentSchema.pick({
          id: true,
          classification: true,
          protectedContent: true,
        }),
      ])
      .nullable(),
  })
  .strict();

export const councilProjectRequestPrepareCommandSchema = z
  .object({
    type: z.literal("council.project-request.prepare"),
    ...councilProjectInput,
    source: councilProjectRequestSourceSchema,
    requestKey: z.string().min(1).max(255),
    request: interactionRequestOpaqueContentSchema,
  })
  .strict();

export const councilProjectSendInputSchema =
  cantripMcpChatSendInputSchema.extend({ projectId });

export const councilProjectSendExchangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("resolve"),
      projectId,
      chatId: agentChatWireDescriptorSchema.shape.id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("send"),
      projectId,
      delivery: agentChatSendWireSchema,
    })
    .strict(),
]);

export const councilProjectChatTargetWireSchema = z
  .object({
    chat: agentChatWireDescriptorSchema,
    sender: agentChatWireDescriptorSchema,
  })
  .strict();

export const councilProjectSendToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: z
      .object({
        chatId: agentChatWireDescriptorSchema.shape.id,
        sourceChatId: agentChatWireDescriptorSchema.shape.id,
        operationId: z.uuid(),
        messageId: z.string().min(1),
        inputMessageId: z.string().min(1),
        delivery: z.literal("queued"),
      })
      .strict(),
  });
