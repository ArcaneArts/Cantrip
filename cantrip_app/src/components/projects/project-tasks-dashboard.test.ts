import type { ChatSummary, TaskDetail } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { taskCanBeDeleted } from "../tasks/task-deletion";
import {
  projectTaskDashboardQueriesEnabled,
  projectTaskIsUnqueuedDraft,
  projectTaskWorkloadPresentation,
  ProjectTasksDashboard,
  sortProjectTaskWorkload,
  type ProjectTaskWorkloadItem,
} from "./project-tasks-dashboard";

function task(input: {
  chatId: string;
  createdAt: string;
  priority?: number;
  state: TaskDetail["state"];
  completedAt?: string;
}): TaskDetail {
  return {
    chatId: input.chatId,
    planGoalEnabled: false,
    priority: input.priority ?? 0,
    requestedTaskWorkerId: null,
    continuityFamily: null,
    lastTaskWorkerId: null,
    dispatch: null,
    state: input.state,
    stableStateBeforeFailure: null,
    activeOperationId: null,
    activeOperationKind: null,
    briefMarkdown: input.chatId,
    draftAttachmentIds: [],
    planMarkdown: null,
    planAuthorship: "agent",
    currentQuestions: [],
    currentAnswers: [],
    additionalDirection: "",
    finalPlanMarkdown: null,
    goalPrompt: null,
    planningRound: 0,
    implementationStartedAt: null,
    completedAt: input.completedAt ?? null,
    lastError: null,
    schedulerRevision: 1,
    rowVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.completedAt ?? input.createdAt,
  };
}

function item(value: TaskDetail): ProjectTaskWorkloadItem {
  return {
    task: value,
    plan: { mode: "default", explanation: null, question: null, steps: [] },
    messages: [],
  };
}

function dispatch(
  value: TaskDetail,
  state: NonNullable<TaskDetail["dispatch"]>["state"],
): TaskDetail {
  value.dispatch = {
    id: "00000000-0000-4000-8000-000000000001",
    chatId: value.chatId,
    operationId: "operation",
    operationKind: "direct",
    state,
    fifoCreatedAt: value.createdAt,
    requestedTaskWorkerId: null,
    selectedTaskWorkerId: null,
    taskWorkerRevision: null,
    continuityFamily: null,
    modelConfiguration: null,
    modelRouteId: null,
    providerAccountId: null,
    physicalWorkerId: null,
    worktreeId: null,
    codexThreadId: null,
    turnId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    fencingToken: 0,
    attemptCount: 0,
    eligibilityCode: state === "queued" ? "project-paused" : null,
    queuedAt: value.createdAt,
    claimedAt: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
  };
  return value;
}

function renderTaskList(
  items: ProjectTaskWorkloadItem[],
  options: {
    creatingTask?: boolean;
    paused?: boolean;
    taskCreationError?: unknown;
  } = {},
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["task-workers"],
    [{ id: "worker-1", name: "Main" }],
  );
  queryClient.setQueryData(["project-task-workload", "project-1"], { items });
  queryClient.setQueryData(["project-task-pause", "project-1"], {
    paused: options.paused ?? false,
    rowVersion: 1,
  });
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectTasksDashboard, {
          active: true,
          activeTaskChatId: null,
          chats: [],
          creatingTask: options.creatingTask ?? false,
          onConfigureWorkers: () => undefined,
          onCreateTask: () => undefined,
          onCloseTask: () => undefined,
          onOpenTask: () => undefined,
          onRenameTask: () => undefined,
          projectId: "project-1",
          settings: undefined,
          taskCreationError: options.taskCreationError ?? null,
          workers: [],
        }),
      ),
    ),
  );
}

describe("flat Task list", () => {
  it.each([false, true])(
    "keeps icon-only actions alongside the title when paused=%s",
    (paused) => {
      const markup = renderTaskList([], { paused });
      const header = markup.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
      expect(header).toContain(">Tasks</h1>");
      expect(header).toContain("ml-auto");
      expect(header).not.toContain("flex-wrap");
      expect(header).not.toMatch(/<p(?:\s|>)/);
      expect(header).not.toContain("FIFO");
      expect(header).not.toContain("capacity is released");
      const buttons = [
        ...header!.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g),
      ].map((match) => match[0]);
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toContain('aria-label="Add Task"');
      expect(buttons[1]).toContain(
        `aria-label="${paused ? "Resume Tasks" : "Pause Tasks"}"`,
      );
      expect(buttons[1]).toContain(paused ? "lucide-play" : "lucide-pause");
      for (const button of buttons) {
        expect(button).toContain("size-8");
        expect(button.replace(/<[^>]+>/g, "").trim()).toBe("");
      }
    },
  );

  it("keeps the Add icon accessible and disabled during task creation", () => {
    const markup = renderTaskList([], { creatingTask: true });
    const header = markup.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
    const addButton = header?.match(
      /<button\b[^>]*aria-label="Add Task"[^>]*>/,
    )?.[0];
    expect(addButton).toContain('aria-busy="true"');
    expect(addButton).toContain('disabled=""');
    expect(header).toContain("lucide-loader-circle");
  });

  it("retains actionable errors without restoring the header description", () => {
    const markup = renderTaskList([], {
      taskCreationError: new Error("Could not create this task"),
    });
    expect(markup).toContain("Could not create this task");
    expect(markup).not.toContain("workers claim eligible queued Tasks FIFO");
  });

  it("renders tasks beneath separate headers without section cards or inner horizontal gutters", () => {
    const markup = renderTaskList([
      item(
        task({
          chatId: "active-task",
          createdAt: "2026-08-24T12:00:00.000Z",
          state: "implementing",
        }),
      ),
      item(
        task({
          chatId: "completed-task",
          createdAt: "2026-08-24T12:00:00.000Z",
          state: "complete",
        }),
      ),
    ]);

    for (const label of ["Active", "Completed"]) {
      const section = markup.match(
        new RegExp(`<section aria-label="${label}">([\\s\\S]*?)</section>`),
      )?.[1];
      expect(section).toContain(`>${label}</h2>`);
      expect(section).not.toMatch(/rounded-xl|bg-card|shadow-sm/);
      const rowClass = section?.match(
        /<div class="([^"]*)" role="button"/,
      )?.[1];
      expect(rowClass).toContain("border-b");
      expect(rowClass).toContain("py-3");
      expect(rowClass).not.toMatch(/(?:^|\s)(?:\w+:)*(?:p|px|pl|pr)-/);
    }
    expect(markup.indexOf('aria-label="Active"')).toBeLessThan(
      markup.indexOf('aria-label="Completed"'),
    );
    expect(markup).toContain("active-task");
    expect(markup).toContain("completed-task");
  });

  it.each(["implementing", "complete"] as const)(
    "only renders the populated section for a %s task",
    (state) => {
      const markup = renderTaskList([
        item(
          task({
            chatId: "only-task",
            createdAt: "2026-08-24T12:00:00.000Z",
            state,
          }),
        ),
      ]);

      expect(markup).toContain(
        `aria-label="${state === "complete" ? "Completed" : "Active"}"`,
      );
      expect(markup).not.toContain(
        `aria-label="${state === "complete" ? "Active" : "Completed"}"`,
      );
    },
  );

  it("keeps the creation suggestion without empty section cards when no tasks exist", () => {
    const markup = renderTaskList([]);

    expect(markup).toContain("Create a task");
    expect(markup).not.toContain('aria-label="Active"');
    expect(markup).not.toContain('aria-label="Completed"');
  });
});

describe("project Task workload", () => {
  it.each(["running", "waiting-for-approval"] as const)(
    "labels a stopped direct Task as paused while its resident turn is %s",
    (status) => {
      const stoppedTask = dispatch(
        task({
          chatId: "stopped",
          createdAt: "2026-10-06T12:00:00.000Z",
          state: "implementing",
        }),
        "running",
      );
      const chat = { status, automationPaused: true } as ChatSummary;
      expect(projectTaskWorkloadPresentation(stoppedTask, chat, false)).toEqual(
        {
          band: "running",
          label: "Paused",
          paused: true,
          tone: "muted",
        },
      );
      expect(
        projectTaskWorkloadPresentation(
          stoppedTask,
          { ...chat, automationPaused: false },
          false,
        ),
      ).toMatchObject({
        label: status === "running" ? "Running" : "Needs approval",
        paused: false,
      });
      expect(
        projectTaskWorkloadPresentation(
          stoppedTask,
          { ...chat, status: "failed" },
          false,
        ),
      ).toMatchObject({ label: "Failed", paused: false });
    },
  );

  it("distinguishes an unqueued draft from a queued Task", () => {
    const draft = task({
      chatId: "draft",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    const queued = dispatch(
      task({
        chatId: "queued",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "draft",
      }),
      "queued",
    );

    expect(projectTaskIsUnqueuedDraft(draft)).toBe(true);
    expect(projectTaskIsUnqueuedDraft(queued)).toBe(false);
    expect(projectTaskIsUnqueuedDraft(undefined)).toBe(false);
  });

  it("allows the owner to delete every Task lifecycle state", () => {
    const draft = task({
      chatId: "draft",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    const queued = dispatch(
      task({
        chatId: "queued",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "draft",
      }),
      "queued",
    );
    const failed = task({
      chatId: "failed",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "failed",
    });
    const staleFailed = dispatch(
      task({
        chatId: "stale-failed",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "failed",
      }),
      "running",
    );
    const running = dispatch(
      task({
        chatId: "running",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "planning",
      }),
      "running",
    );
    const complete = task({
      chatId: "complete",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "complete",
    });

    expect(taskCanBeDeleted(draft)).toBe(true);
    expect(taskCanBeDeleted(queued)).toBe(true);
    expect(taskCanBeDeleted(failed)).toBe(true);
    expect(taskCanBeDeleted(staleFailed)).toBe(true);
    expect(taskCanBeDeleted(running)).toBe(true);
    expect(taskCanBeDeleted(complete)).toBe(true);
    expect(taskCanBeDeleted(undefined)).toBe(false);
  });

  it("loads dashboard-only queries only while the task list is visible", () => {
    expect(projectTaskDashboardQueriesEnabled(true, null)).toBe(true);
    expect(projectTaskDashboardQueriesEnabled(false, null)).toBe(false);
    expect(projectTaskDashboardQueriesEnabled(true, "active-task")).toBe(false);
  });

  it("puts attention before running and queued while sorting each band by priority then newest creation", () => {
    const items = [
      item(
        dispatch(
          task({
            chatId: "queued-new",
            createdAt: "2026-08-24T12:00:00.000Z",
            state: "draft",
          }),
          "queued",
        ),
      ),
      item(
        dispatch(
          task({
            chatId: "running",
            createdAt: "2026-08-24T13:00:00.000Z",
            state: "planning",
          }),
          "running",
        ),
      ),
      item(
        task({
          chatId: "attention-high",
          createdAt: "2026-08-23T12:00:00.000Z",
          priority: 10,
          state: "review",
        }),
      ),
      item(
        task({
          chatId: "attention-new",
          createdAt: "2026-08-24T12:00:00.000Z",
          state: "review",
        }),
      ),
      item(
        task({
          chatId: "complete-old",
          completedAt: "2026-08-20T12:00:00.000Z",
          createdAt: "2026-08-19T12:00:00.000Z",
          state: "complete",
        }),
      ),
      item(
        task({
          chatId: "complete-new",
          completedAt: "2026-08-24T12:00:00.000Z",
          createdAt: "2026-08-18T12:00:00.000Z",
          state: "complete",
        }),
      ),
    ];

    const sorted = sortProjectTaskWorkload(items, new Map(), false);

    expect(sorted.active.map(({ task: value }) => value.chatId)).toEqual([
      "attention-high",
      "attention-new",
      "running",
      "queued-new",
    ]);
    expect(sorted.completed.map(({ task: value }) => value.chatId)).toEqual([
      "complete-new",
      "complete-old",
    ]);
  });

  it("keeps a paused queued Task in its queued band with a paused overlay", () => {
    const value = task({
      chatId: "paused-queued",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    dispatch(value, "queued");

    expect(
      projectTaskWorkloadPresentation(value, undefined, true),
    ).toMatchObject({ band: "queued", label: "Paused · queued", paused: true });
  });

  it("labels a claimed Task as starting until its execution lane is running", () => {
    const value = task({
      chatId: "claimed",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "implementing",
    });
    dispatch(value, "claimed");

    expect(
      projectTaskWorkloadPresentation(value, undefined, false),
    ).toMatchObject({ band: "running", label: "Starting", paused: false });
  });

  it("surfaces an expired started cycle as needing recovery", () => {
    const value = task({
      chatId: "expired-running",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "planning",
    });
    dispatch(value, "expired");

    expect(
      projectTaskWorkloadPresentation(value, undefined, false),
    ).toMatchObject({ band: "attention", label: "Needs recovery" });
  });
});
