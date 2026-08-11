import { describe, expect, it } from "vitest";

import {
  describeProjectAutomationCondition,
  describeProjectAutomationSchedule,
  firstProjectAutomationRunAt,
  nextProjectAutomationRunAt,
  projectAutomationConditionSchema,
  projectAutomationCreateSchema,
  projectAutomationScheduleSchema,
} from "../src/automations.js";

describe("project automation schedules", () => {
  it("anchors arbitrary minute intervals", () => {
    const schedule = projectAutomationScheduleSchema.parse({
      kind: "interval",
      every: 5,
      unit: "minute",
      startsAt: "2026-09-27T14:00:00.000Z",
    });

    expect(
      firstProjectAutomationRunAt(
        schedule,
        new Date("2026-09-27T13:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-09-27T14:00:00.000Z");
    expect(
      nextProjectAutomationRunAt(
        schedule,
        new Date("2026-09-27T14:06:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-09-27T14:10:00.000Z");
  });

  it("supports calendar-anchored multi-year schedules", () => {
    const schedule = projectAutomationScheduleSchema.parse({
      kind: "interval",
      every: 2,
      unit: "year",
      startsAt: "2026-09-27T14:00:00.000Z",
    });

    expect(
      nextProjectAutomationRunAt(
        schedule,
        new Date("2027-10-01T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2028-09-27T14:00:00.000Z");
    expect(describeProjectAutomationSchedule(schedule)).toBe("Every 2 years");
  });

  it("calculates selected weekdays in the configured time zone", () => {
    const schedule = projectAutomationScheduleSchema.parse({
      kind: "weekly",
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 30,
      timeZone: "UTC",
    });

    expect(
      nextProjectAutomationRunAt(
        schedule,
        new Date("2026-08-07T10:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-10T09:30:00.000Z");
  });

  it("rejects invalid cron expressions and time zones", () => {
    expect(
      projectAutomationScheduleSchema.safeParse({
        kind: "cron",
        expression: "not cron",
        timeZone: "America/Chicago",
      }).success,
    ).toBe(false);
    expect(
      projectAutomationScheduleSchema.safeParse({
        kind: "cron",
        expression: "0 9 * * 1-5",
        timeZone: "Mars/Olympus",
      }).success,
    ).toBe(false);
  });
});

describe("project automation conditions", () => {
  it("supports one script or open-issue condition", () => {
    expect(
      projectAutomationConditionSchema.parse({
        type: "script",
        script: "pnpm test",
      }),
    ).toEqual({ type: "script", script: "pnpm test" });
    expect(
      projectAutomationConditionSchema.parse({ type: "open-issues" }),
    ).toEqual({ type: "open-issues", minimum: 1 });
    expect(
      projectAutomationConditionSchema.safeParse({
        type: "open-issues",
        minimum: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps conditions optional for existing automations", () => {
    const input = projectAutomationCreateSchema.parse({
      name: "Review",
      chatId: "chat-one",
      prompt: "Review the project.",
      schedule: {
        kind: "interval",
        every: 1,
        unit: "hour",
        startsAt: "2026-08-11T12:00:00.000Z",
      },
    });

    expect(input.condition).toBeNull();
    expect(
      describeProjectAutomationCondition({
        type: "open-issues",
        minimum: 2,
      }),
    ).toBe("At least 2 open issues");
  });
});
