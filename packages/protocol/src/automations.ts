import { Cron } from "croner";
import { z } from "zod";

import { projectAutomationContentOpaqueSchema } from "./project-automation-content.js";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime();

export const projectAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

export const projectAutomationIntervalScheduleSchema = z.object({
  kind: z.literal("interval"),
  every: z.number().int().min(1).max(1_000_000),
  unit: projectAutomationIntervalUnitSchema,
  startsAt: timestampSchema,
});

export const projectAutomationCronScheduleSchema = z
  .object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1).max(200),
    timeZone: z.string().trim().min(1).max(100),
  })
  .superRefine(({ expression, timeZone }, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    } catch {
      context.addIssue({
        code: "custom",
        message: "Choose a valid IANA time zone.",
        path: ["timeZone"],
      });
      return;
    }
    try {
      new Cron(expression, {
        mode: "5-part",
        paused: true,
        timezone: timeZone,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid cron expression.",
        path: ["expression"],
      });
    }
  });

export const projectAutomationWeeklyScheduleSchema = z.object({
  kind: z.literal("weekly"),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) =>
      [...new Set(days)].sort((left, right) => left - right),
    ),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(
      (timeZone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
          return true;
        } catch {
          return false;
        }
      },
      { message: "Choose a valid IANA time zone." },
    ),
});

export const projectAutomationScheduleSchema = z.discriminatedUnion("kind", [
  projectAutomationIntervalScheduleSchema,
  projectAutomationWeeklyScheduleSchema,
  projectAutomationCronScheduleSchema,
]);

export const projectAutomationConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("script"),
    script: z
      .string()
      .min(1)
      .max(100_000)
      .refine((value) => value.trim().length > 0, {
        message: "Condition script is required.",
      }),
  }),
  z.object({
    type: z.literal("open-issues"),
    minimum: z.number().int().min(1).max(1_000_000).default(1),
  }),
]);

export const projectAutomationConditionResultSchema = z.object({
  allowed: z.boolean(),
  detail: z.string().trim().min(1).max(5_000),
});

export const projectAutomationCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  chatId: idSchema,
  prompt: z.string().trim().min(1).max(100_000),
  schedule: projectAutomationScheduleSchema,
  condition: projectAutomationConditionSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});

export const projectAutomationProtectedNameSchema = z
  .object({
    version: z.literal(1),
    name: projectAutomationCreateSchema.shape.name,
  })
  .strict();

export const projectAutomationProtectedPromptSchema = z
  .object({
    version: z.literal(1),
    prompt: projectAutomationCreateSchema.shape.prompt,
  })
  .strict();

export const projectAutomationProtectedConditionSchema = z
  .object({
    version: z.literal(1),
    condition: projectAutomationConditionSchema.nullable(),
  })
  .strict();

export const projectAutomationOpaqueContentSchema = z
  .object({
    protectedName: projectAutomationContentOpaqueSchema,
    protectedPrompt: projectAutomationContentOpaqueSchema,
    protectedCondition: projectAutomationContentOpaqueSchema,
  })
  .strict();

export const encryptedProjectAutomationCreateSchema = z
  .object({
    id: z.uuid(),
    chatId: idSchema,
    schedule: projectAutomationScheduleSchema,
    enabled: z.boolean().default(true),
    content: projectAutomationOpaqueContentSchema,
  })
  .strict();

export const encryptedProjectAutomationUpdateSchema = z
  .object({
    chatId: idSchema.optional(),
    schedule: projectAutomationScheduleSchema.optional(),
    enabled: z.boolean().optional(),
    content: projectAutomationOpaqueContentSchema.partial().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.chatId !== undefined ||
      input.schedule !== undefined ||
      input.enabled !== undefined ||
      (input.content !== undefined && Object.keys(input.content).length > 0),
    { message: "Provide at least one encrypted automation update." },
  );

export const projectAutomationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    chatId: idSchema.optional(),
    prompt: z.string().trim().min(1).max(100_000).optional(),
    schedule: projectAutomationScheduleSchema.optional(),
    condition: projectAutomationConditionSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "Provide at least one automation update.",
  });

export const projectAutomationStatusSchema = z.enum([
  "idle",
  "dispatching",
  "started",
  "queued",
  "skipped",
  "failed",
]);

export const projectAutomationSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  chatId: idSchema,
  workerId: idSchema,
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  schedule: projectAutomationScheduleSchema,
  condition: projectAutomationConditionSchema.nullable().default(null),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  nextRunAt: timestampSchema.nullable(),
  lastRunAt: timestampSchema.nullable(),
  lastStatus: projectAutomationStatusSchema,
  lastError: z.string().max(5_000).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const projectAutomationWireSchema = projectAutomationSchema
  .omit({ name: true, prompt: true, condition: true })
  .extend({ content: projectAutomationOpaqueContentSchema })
  .strict();

export const projectAutomationWireListSchema = z.array(
  projectAutomationWireSchema,
);

export const projectAutomationListSchema = z.array(projectAutomationSchema);

export const projectAutomationDispatchRequestSchema = z.object({
  revision: z.number().int().positive(),
  scheduledFor: timestampSchema,
});

export const projectAutomationDispatchResultSchema = z.object({
  accepted: z.boolean(),
  status: z.enum(["started", "queued", "skipped"]),
  nextRunAt: timestampSchema.nullable(),
});

export type ProjectAutomationIntervalUnit = z.infer<
  typeof projectAutomationIntervalUnitSchema
>;
export type ProjectAutomationSchedule = z.infer<
  typeof projectAutomationScheduleSchema
>;
export type ProjectAutomationCondition = z.infer<
  typeof projectAutomationConditionSchema
>;
export type ProjectAutomationConditionResult = z.infer<
  typeof projectAutomationConditionResultSchema
>;
export type ProjectAutomationCreate = z.infer<
  typeof projectAutomationCreateSchema
>;
export type ProjectAutomationUpdate = z.infer<
  typeof projectAutomationUpdateSchema
>;
export type ProjectAutomation = z.infer<typeof projectAutomationSchema>;
export type ProjectAutomationWire = z.infer<typeof projectAutomationWireSchema>;
export type ProjectAutomationOpaqueContent = z.infer<
  typeof projectAutomationOpaqueContentSchema
>;
export type EncryptedProjectAutomationCreate = z.infer<
  typeof encryptedProjectAutomationCreateSchema
>;
export type EncryptedProjectAutomationUpdate = z.infer<
  typeof encryptedProjectAutomationUpdateSchema
>;
export type ProjectAutomationDispatchRequest = z.infer<
  typeof projectAutomationDispatchRequestSchema
>;
export type ProjectAutomationDispatchResult = z.infer<
  typeof projectAutomationDispatchResultSchema
>;

export function describeProjectAutomationCondition(
  condition: ProjectAutomationCondition | null,
): string {
  if (!condition) return "No condition";
  if (condition.type === "script") return "Script must exit with code 0";
  return `At least ${condition.minimum} open ${condition.minimum === 1 ? "issue" : "issues"}`;
}

const fixedIntervalMilliseconds: Partial<
  Record<ProjectAutomationIntervalUnit, number>
> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
};

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addCalendarIntervals(
  startsAt: Date,
  count: number,
  unit: "month" | "year",
): Date | null {
  const months = unit === "month" ? count : count * 12;
  const targetMonth = startsAt.getUTCMonth() + months;
  const targetYear = startsAt.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  if (targetYear > 275_000) return null;
  const targetDay = Math.min(
    startsAt.getUTCDate(),
    daysInUtcMonth(targetYear, normalizedMonth),
  );
  const result = new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      targetDay,
      startsAt.getUTCHours(),
      startsAt.getUTCMinutes(),
      startsAt.getUTCSeconds(),
      startsAt.getUTCMilliseconds(),
    ),
  );
  return Number.isNaN(result.getTime()) ? null : result;
}

function nextIntervalRun(
  schedule: Extract<ProjectAutomationSchedule, { kind: "interval" }>,
  after: Date,
): Date | null {
  const startsAt = new Date(schedule.startsAt);
  if (after.getTime() < startsAt.getTime()) return startsAt;
  const fixedMilliseconds = fixedIntervalMilliseconds[schedule.unit];
  if (fixedMilliseconds) {
    const interval = fixedMilliseconds * schedule.every;
    const elapsed = after.getTime() - startsAt.getTime();
    const occurrences = Math.max(1, Math.floor(elapsed / interval) + 1);
    const next = new Date(startsAt.getTime() + occurrences * interval);
    return Number.isNaN(next.getTime()) ? null : next;
  }
  if (schedule.unit !== "month" && schedule.unit !== "year") return null;

  const roughPeriods =
    schedule.unit === "month"
      ? (after.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 +
        after.getUTCMonth() -
        startsAt.getUTCMonth()
      : after.getUTCFullYear() - startsAt.getUTCFullYear();
  let occurrence = Math.max(1, Math.floor(roughPeriods / schedule.every));
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const candidate = addCalendarIntervals(
      startsAt,
      occurrence * schedule.every,
      schedule.unit,
    );
    if (!candidate) return null;
    if (candidate.getTime() > after.getTime()) return candidate;
    occurrence += 1;
  }
  return null;
}

export function nextProjectAutomationRunAt(
  schedule: ProjectAutomationSchedule,
  after: Date,
): Date | null {
  if (schedule.kind === "interval") return nextIntervalRun(schedule, after);
  if (schedule.kind === "weekly") {
    return new Cron(
      `${schedule.minute} ${schedule.hour} * * ${schedule.weekdays.join(",")}`,
      {
        mode: "5-part",
        paused: true,
        timezone: schedule.timeZone,
      },
    ).nextRun(after);
  }
  return new Cron(schedule.expression, {
    mode: "5-part",
    paused: true,
    timezone: schedule.timeZone,
  }).nextRun(after);
}

export function firstProjectAutomationRunAt(
  schedule: ProjectAutomationSchedule,
  now: Date,
): Date | null {
  if (schedule.kind === "interval") {
    const startsAt = new Date(schedule.startsAt);
    if (startsAt.getTime() >= now.getTime()) return startsAt;
  }
  return nextProjectAutomationRunAt(schedule, now);
}

export function describeProjectAutomationSchedule(
  schedule: ProjectAutomationSchedule,
): string {
  if (schedule.kind === "cron") {
    return `${schedule.expression} · ${schedule.timeZone}`;
  }
  if (schedule.kind === "weekly") {
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
    return `${schedule.weekdays.map((day) => weekdays[day]).join(", ")} at ${time}`;
  }
  const plural = schedule.every === 1 ? schedule.unit : `${schedule.unit}s`;
  return `Every ${schedule.every === 1 ? "" : `${schedule.every} `}${plural}`;
}
