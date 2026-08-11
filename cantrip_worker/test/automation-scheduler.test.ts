import { describe, expect, it, vi } from "vitest";

import { ProjectAutomationScheduler } from "../src/automation-scheduler.js";

const dueAutomation = {
  id: "automation-one",
  projectId: "project-one",
  chatId: "chat-one",
  chatTitle: "Daily review",
  workerId: "worker-one",
  name: "Review",
  prompt: "Review the project.",
  schedule: {
    kind: "interval" as const,
    every: 5,
    unit: "minute" as const,
    startsAt: "2026-08-11T12:00:00.000Z",
  },
  enabled: true,
  revision: 3,
  nextRunAt: "2026-08-11T12:05:00.000Z",
  lastRunAt: null,
  lastStatus: "idle" as const,
  lastError: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("ProjectAutomationScheduler", () => {
  it("pulls schedules and dispatches due occurrences", async () => {
    const requests: Array<{ method: string; url: URL }> = [];
    const fetcher = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = input instanceof URL ? input : new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (method === "GET") {
          return Response.json([dueAutomation]);
        }
        expect(JSON.parse(String(init?.body))).toEqual({
          revision: 3,
          scheduledFor: dueAutomation.nextRunAt,
        });
        return Response.json(
          {
            accepted: true,
            status: "started",
            nextRunAt: "2026-08-11T12:10:00.000Z",
          },
          { status: 202 },
        );
      },
    );
    const scheduler = new ProjectAutomationScheduler({
      fetch: fetcher as typeof fetch,
      serverUrl: "http://127.0.0.1:4310",
      token: "secret",
      workerId: "worker-one",
    });

    await scheduler.tick(new Date("2026-08-11T12:05:01.000Z"));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.pathname).toBe("/api/internal/workers/automations");
    expect(requests[0]?.url.searchParams.get("workerId")).toBe("worker-one");
    expect(requests[1]?.url.pathname).toBe(
      "/api/internal/workers/automations/automation-one/dispatch",
    );
  });

  it("does not dispatch future occurrences", async () => {
    const fetcher = vi.fn(async () => Response.json([dueAutomation]));
    const scheduler = new ProjectAutomationScheduler({
      fetch: fetcher as typeof fetch,
      serverUrl: "http://127.0.0.1:4310",
      token: "secret",
      workerId: "worker-one",
    });

    await scheduler.tick(new Date("2026-08-11T12:04:59.000Z"));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
