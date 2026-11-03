import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";

export function projectAutomationWireFixtures(timestamp) {
  const interval = {
    kind: "interval",
    every: 1,
    unit: "minute",
    startsAt: timestamp,
  };
  const weekly = {
    kind: "weekly",
    weekdays: [5, 1, 5, 0],
    hour: 9,
    minute: 30,
    timeZone: "UTC",
  };
  const cron = { kind: "cron", expression: "0 9 * * MON-FRI", timeZone: "UTC" };
  const opaque = {
    formatVersion: 1,
    keyRevision: 1,
    envelope: settingsSnapshot.protectedContent,
  };
  const content = {
    protectedName: opaque,
    protectedPrompt: opaque,
    protectedCondition: opaque,
  };
  const create = {
    id: "a0a0a0a0-1111-4111-8111-000000000001",
    chatId: "chat",
    schedule: interval,
    content,
  };
  const wire = {
    ...create,
    enabled: true,
    projectId: "project",
    workerId: "worker",
    revision: 1,
    nextRunAt: timestamp,
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const queuedPrompt = retainedPrompt();
  const turn = {
    message: queuedPrompt.pendingMessage,
    queuedPrompt,
    modelId: queuedPrompt.modelId,
  };
  return {
    projectAutomationIntervalScheduleSchema: [interval],
    projectAutomationWeeklyScheduleSchema: [weekly],
    projectAutomationCronScheduleSchema: [cron],
    projectAutomationScheduleSchema: [interval, weekly, cron],
    projectAutomationOpaqueContentSchema: [content],
    encryptedProjectAutomationCreateSchema: [create],
    encryptedProjectAutomationUpdateSchema: [
      { enabled: false },
      { content: { protectedName: opaque } },
      { chatId: "chat", schedule: weekly, enabled: true, content },
    ],
    projectAutomationWireSchema: [
      wire,
      {
        ...wire,
        nextRunAt: null,
        lastRunAt: timestamp,
        lastStatus: "failed",
        lastError: "Protected automation dispatch failed.",
      },
    ],
    projectAutomationWireListSchema: [[], [wire]],
    projectAutomationDispatchRequestSchema: [
      { revision: 1, scheduledFor: timestamp },
    ],
    projectAutomationDispatchResultSchema: [
      { accepted: false, status: "skipped", nextRunAt: null },
      { accepted: true, status: "started", nextRunAt: timestamp },
      { accepted: true, status: "queued", nextRunAt: timestamp },
    ],
    projectAutomationProtectedDispatchResultSchema: [
      { allowed: false, protectedTurn: null },
      { allowed: true, protectedTurn: turn },
    ],
  };
}

export function* projectAutomationWireCases(name, samples) {
  if (name === "projectAutomationCronScheduleSchema") {
    const tokens = [
      "",
      ",",
      "*",
      "**",
      "?",
      "??",
      "1*",
      "1W2",
      "1L3",
      "L,1W",
      "LW",
      "LW,1",
      "5#2",
      "5#L",
      "MON-FRI",
      "SUN-MON",
      "L",
      "*/0",
      "*/1",
      "*/99",
      "/2",
      "0/2",
      "1-2/0",
      "1-2/2",
      "9-1",
      "1-2-3",
      "x",
      "1#2#5",
      "1##2",
      "0x10",
      "999999999999999999999999999999999999999999999999999999999999",
      "0",
      "1",
      "7",
      "60",
      "1,",
      ",1",
      "1,,2",
      "1-",
      "-1",
      "*-2",
      "1-*",
      "1-2*",
      "1-2/",
      "1-2/1*",
      "*/2*",
      "*/01",
      "+MON",
      "+",
      "5#63",
      "5#0",
      "5#6",
      "5#01",
      "5#1.5",
      "5#",
      "5L",
      "L5",
      "1W,31W",
      "1w",
      "w1",
      "1W/2",
      "1W-2",
      "1W-2/3",
      "JAN",
      "JAN-DEC",
      "DEC-JAN",
      "\ud800",
      "🦀",
    ];
    for (let field = 0; field < 5; field++)
      for (const token of tokens) {
        const parts = ["0", "0", "*", "*", "*"];
        parts[field] = token;
        yield { ...samples[0], expression: parts.join(" ") };
        // Source checks illegal characters in every field before parsing bounds.
        parts[(field + 1) % 5] = "bad";
        yield { ...samples[0], expression: parts.join(" ") };
      }
    for (const expression of [
      "",
      "   ",
      "2026-11-04",
      "2026-11-04T05:00:00Z",
      "2026-11-04T05:00:00",
      "2026-11-04 05:00:00",
      "2026-02-31T05:00:00Z",
      "not:a-date",
      "@reboot",
      "@every 5m",
      "@yearly",
      " @DAILY ",
      "0 0 0 * * *",
      "0 0 0 * * * 2027",
      "? ? * * *",
      "\ufeff0\u00a00\t*\n*\r*\ufeff",
      "0 0 * * *".repeat(24),
    ])
      yield { ...samples[0], expression };
  }
  if (
    [
      "projectAutomationWeeklyScheduleSchema",
      "projectAutomationCronScheduleSchema",
    ].includes(name)
  ) {
    for (const timeZone of [
      ...Intl.supportedValuesOf("timeZone"),
      "UTC",
      "GMT",
      "utc",
      "america/new_york",
      "US/Pacific",
      "GMT0",
      "Etc/GMT+8",
      "EST",
      "CET",
      "MET",
      "EET",
      "WET",
      "UCT",
      "Universal",
      "Zulu",
      "Etc/Unknown",
      "Factory",
      "GMT+0",
      "posixrules",
      "SystemV/EST5EDT",
      "US/Eastern",
      "US/Pacific-New",
      "us/pacific-new",
      "SystemV/AST4",
      "SystemV/AST4ADT",
      "SystemV/CST6",
      "SystemV/CST6CDT",
      "SystemV/EST5",
      "systemv/est5edt",
      "SystemV/HST10",
      "SystemV/MST7",
      "SystemV/MST7MDT",
      "SystemV/PST8",
      "SystemV/PST8PDT",
      "SystemV/YST9",
      "SystemV/YST9YDT",
      "HST",
      "MST",
      "PST8PDT",
      "CST6CDT",
      "+05",
      "+0530",
      "+05:30",
      "-00",
      "+23:59",
      "-23:59",
      "+24:00",
      "+5:30",
      "+05:60",
      "Z",
      "local",
      "Mars/Olympus",
      "",
      " ",
      "\ud800",
      "\ufeff UTC \ufeff",
    ])
      yield { ...samples[0], timeZone };
  }
  if (name === "projectAutomationWeeklyScheduleSchema") {
    for (const weekdays of [
      [],
      [0],
      [6],
      [6, 5, 4, 3, 2, 1, 0],
      [6, 6, 6, 6, 6, 6, 6],
      [0, 1, 2, 3, 4, 5, 6, 6],
      [-1],
      [7],
      [1.5],
      ["1"],
      [null],
    ])
      yield { ...samples[0], weekdays };
  }
  if (name === "encryptedProjectAutomationUpdateSchema")
    for (const input of [
      {},
      { content: {} },
      { content: {}, enabled: false },
      { content: null },
      { enabled: null },
      { chatId: "" },
      { schedule: {} },
      { content: { unknown: true } },
    ])
      yield input;
  if (name === "projectAutomationProtectedDispatchResultSchema")
    for (const allowed of [true, false])
      for (const protectedTurn of [null, samples[1].protectedTurn])
        yield { allowed, protectedTurn };
}
