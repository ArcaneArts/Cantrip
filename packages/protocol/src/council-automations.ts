import { z } from "zod";

import {
  councilAutomationWireSchema,
  encryptedProjectAutomationCreateSchema,
  encryptedProjectAutomationUpdateSchema,
  projectAutomationCreateSchema,
  projectAutomationCronScheduleSchema,
  projectAutomationIntervalScheduleSchema,
  projectAutomationUpdateSchema,
  projectAutomationWeeklyScheduleSchema,
} from "./automations.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";

// The tool advertises the accepted input. Core normalizes weekly day order
// with the same schedule schema as the browser.
const toolSchedule = z.discriminatedUnion("kind", [
  projectAutomationIntervalScheduleSchema,
  projectAutomationWeeklyScheduleSchema.extend({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  projectAutomationCronScheduleSchema,
]);

export const councilAutomationListInputSchema = z
  .object({
    agentId: z.uuid().optional(),
    offset: z.number().int().min(0).max(2_147_483_647).default(0),
    limit: z.number().int().min(1).max(40).default(20),
  })
  .strict();

export const councilAutomationReadInputSchema = z
  .object({
    automationId: z.uuid(),
  })
  .strict();

export const councilAutomationCreateInputSchema = projectAutomationCreateSchema
  .omit({ chatId: true, condition: true })
  .extend({
    operationId: z.uuid(),
    agentId: z.uuid().optional(),
    schedule: toolSchedule,
  })
  .strict();

export const councilAutomationUpdateInputSchema = z
  .object({
    operationId: z.uuid(),
    automationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    changes: z
      .object({
        name: projectAutomationUpdateSchema.shape.name,
        prompt: projectAutomationUpdateSchema.shape.prompt,
        schedule: toolSchedule.optional(),
        enabled: projectAutomationUpdateSchema.shape.enabled,
      })
      .strict(),
  })
  .strict();

export const councilAutomationCreateWireSchema = z
  .object({
    operationId: z.uuid(),
    routine: encryptedProjectAutomationCreateSchema,
  })
  .strict();

export const councilAutomationUpdateWireSchema =
  councilAutomationUpdateInputSchema
    .omit({ changes: true })
    .extend({ changes: encryptedProjectAutomationUpdateSchema })
    .strict();

const routineSummary = councilAutomationWireSchema
  .omit({ projectId: true, content: true })
  .extend({
    name: projectAutomationCreateSchema.shape.name,
    schedule: toolSchedule,
  });

export const councilAutomationListOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: z
      .object({
        routines: z.array(routineSummary).max(40),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  });

export const councilAutomationReadOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: routineSummary.extend({
      prompt: projectAutomationCreateSchema.shape.prompt,
    }),
  });

export const councilAutomationMutationReceiptSchema =
  councilAutomationWireSchema
    .pick({
      id: true,
      chatId: true,
      enabled: true,
      revision: true,
      nextRunAt: true,
    })
    .extend({ operationId: z.uuid() });

export const councilAutomationMutationOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.boolean(),
    data: councilAutomationMutationReceiptSchema,
  });
