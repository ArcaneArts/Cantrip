import type { ChatSummary, TaskDetail } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, createRef, type ComponentProps } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskAttachments: vi.fn(),
  getTaskWorkers: vi.fn(),
  getChatPermissionProfiles: vi.fn(),
  updateTaskDraft: vi.fn(),
  startTaskDirectly: vi.fn(),
  startTaskPlanning: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: { subscribe: () => () => {}, getSnapshot: () => null },
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));
vi.mock("@/lib/use-chat-message-history", () => ({
  useChatMessageHistory: () => ({ messages: [] }),
}));
vi.mock("@/lib/task-worker-encryption", () => ({
  taskWorkerEncryptionReadiness: () => "offline",
  taskWorkerEncryptionMessage: () => null,
  taskWorkerEncryptionCanAttempt: () => false,
}));
vi.mock("@/components/chat/attachment-preview", () => ({
  AttachmentPreview: () => null,
  AttachmentViewerDialog: () => null,
}));
vi.mock("@/components/chat/permission-profile-control", () => ({
  PermissionProfileControl: () => null,
}));
vi.mock("@/components/chat/agent-inspect-content", () => ({
  AgentInspectContent: () => null,
}));
vi.mock("./task-interaction-requests", () => ({
  TaskInteractionRequests: () => null,
}));
vi.mock("./task-plan-review", () => ({ TaskPlanReview: () => null }));
vi.mock("./task-implementation-dashboard", () => ({
  TaskImplementationDashboard: () => null,
}));
vi.mock("./task-markdown-editor", () => ({
  TaskMarkdownEditor: (props: Record<string, unknown>) =>
    createElement("textarea", { ...props, "aria-label": props.ariaLabel }),
}));

import { TaskSurface, type TaskSurfaceHandle } from "./task-surface";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;
let current: TaskDetail;
let surfaceRef = createRef<TaskSurfaceHandle>();
const chat = {
  id: "task",
  projectId: "project",
  title: "Forge",
  status: "idle",
} as ChatSummary;
const failedTask = (): TaskDetail => ({
  chatId: "task",
  state: "failed",
  stableStateBeforeFailure: "draft",
  briefMarkdown: "Support Forge",
  planGoalEnabled: false,
  priority: -1,
  requestedTaskWorkerId: null,
  continuityFamily: null,
  lastTaskWorkerId: null,
  dispatch: null,
  activeOperationId: null,
  activeOperationKind: "direct",
  draftAttachmentIds: [],
  planMarkdown: null,
  planAuthorship: "agent",
  currentQuestions: [],
  currentAnswers: [],
  additionalDirection: "",
  finalPlanMarkdown: null,
  goalPrompt: null,
  planningRound: 1,
  implementationStartedAt: null,
  completedAt: null,
  lastError: null,
  schedulerRevision: 1,
  rowVersion: 10,
  createdAt: "2026-10-07T01:00:00Z",
  updatedAt: "2026-10-07T01:20:00Z",
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
const retryButton = () =>
  renderer!.root
    .findAllByType("button")
    .find((node) =>
      node
        .findAllByType("span")
        .some((span) => span.children.includes("Retry Task")),
    )!;
const editor = () => renderer!.root.findByType("textarea");
async function mount(status: ChatSummary["status"] = "idle", visible = true) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["task", "task"], current);
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskSurface, {
          visible,
          chat: { ...chat, status },
          onRename: vi.fn(),
          settings: undefined,
          surfaceRef,
        }),
      ),
    );
  });
  await settle();
}
beforeEach(() => {
  surfaceRef = createRef<TaskSurfaceHandle>();
  vi.clearAllMocks();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  current = failedTask();
  api.getTask.mockImplementation(async () => current);
  api.getTaskAttachments.mockResolvedValue([]);
  api.getTaskWorkers.mockResolvedValue([]);
  api.getChatPermissionProfiles.mockResolvedValue(undefined);
  api.updateTaskDraft.mockImplementation(async (_id, input) => ({
    ...current,
    ...input,
    rowVersion: input.rowVersion + 1,
  }));
  api.startTaskDirectly.mockImplementation(async () => current);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client?.clear();
  vi.unstubAllGlobals();
});

describe("failed Task recovery", () => {
  it("keeps a hidden Task's local editor but suspends reads until it is visible again", async () => {
    await mount("running", false);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["task", "task"] });
      await client.invalidateQueries({
        queryKey: ["task-attachments", "task"],
      });
      await client.invalidateQueries({ queryKey: ["task-workers"] });
    });
    expect(api.getTask).not.toHaveBeenCalled();
    expect(api.getTaskAttachments).not.toHaveBeenCalled();
    expect(api.getTaskWorkers).not.toHaveBeenCalled();
    expect(editor().props.value).toBe("Support Forge");
    const props = renderer!.root.findByType(TaskSurface)
      .props as ComponentProps<typeof TaskSurface>;
    await act(async () => {
      renderer!.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(TaskSurface, { ...props, visible: true }),
        ),
      );
    });
    await settle();
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect(api.getTaskAttachments).toHaveBeenCalledTimes(1);
    expect(api.getTaskWorkers).toHaveBeenCalledTimes(1);
    expect(editor().props.value).toBe("Support Forge");
  });

  it("flushes unsaved draft edits before a dialog dismissal", async () => {
    await mount();
    await act(async () => editor().props.onChange("Save before dismissing"));
    await act(async () => surfaceRef.current!.prepareClose());
    expect(api.updateTaskDraft).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({
        briefMarkdown: "Save before dismissing",
        rowVersion: 10,
      }),
    );
  });

  it("reports save failures to the dialog so it can retain unsaved edits", async () => {
    await mount();
    const failure = new Error("Task save failed");
    api.updateTaskDraft.mockRejectedValueOnce(failure);
    await act(async () => editor().props.onChange("Keep these unsaved edits"));
    await act(async () => {
      await expect(surfaceRef.current!.prepareClose()).rejects.toBe(failure);
    });
    expect(editor().props.value).toBe("Keep these unsaved edits");
  });

  it("serializes a dismissal save behind an in-flight autosave using the returned revision", async () => {
    await mount();
    let finish!: () => void;
    api.updateTaskDraft.mockImplementationOnce(
      (_id, input) =>
        new Promise<TaskDetail>((resolve) => {
          finish = () => resolve({ ...current, ...input, rowVersion: 11 });
        }),
    );
    await act(async () => editor().props.onChange("Autosaving"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(api.updateTaskDraft).toHaveBeenCalledTimes(1);
    await act(async () => editor().props.onChange("Latest edits at dismissal"));
    let closing!: Promise<void>;
    await act(async () => {
      closing = surfaceRef.current!.prepareClose();
    });
    expect(api.updateTaskDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await closing;
    });
    expect(api.updateTaskDraft).toHaveBeenLastCalledWith(
      "task",
      expect.objectContaining({
        briefMarkdown: "Latest edits at dismissal",
        rowVersion: 11,
      }),
    );
  });

  it("allows retry with priority -1 despite cached worker unavailability and stale chat status", async () => {
    await mount("running");
    expect(editor().props.readOnly).toBe(false);
    expect(retryButton().props.disabled).toBe(false);
    await act(async () => {
      retryButton().props.onClick();
    });
    await settle();
    expect(api.startTaskDirectly).toHaveBeenCalledWith("task", {
      operationId: expect.any(String),
      rowVersion: 10,
    });
  });

  it("copies the current failed-task brief, including unsaved edits", async () => {
    await mount();
    await act(async () => editor().props.onChange("Updated Forge brief"));
    const copy = renderer!.root.findByProps({
      "aria-label": "Copy Task brief",
    });
    await act(async () => copy.props.onClick());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Updated Forge brief",
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("Brief copied");
  });

  it("saves edits with the failure's new row version before retrying", async () => {
    current = {
      ...current,
      state: "draft",
      stableStateBeforeFailure: null,
      rowVersion: 1,
    };
    await mount();
    current = failedTask();
    await act(async () => {
      client.setQueryData(["task", "task"], current);
    });
    await settle();
    await act(async () => editor().props.onChange("Retry with this brief"));
    await act(async () => retryButton().props.onClick());
    await settle();
    expect(api.updateTaskDraft).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({
        briefMarkdown: "Retry with this brief",
        priority: -1,
        rowVersion: 10,
      }),
    );
    expect(api.startTaskDirectly).toHaveBeenCalledWith("task", {
      operationId: expect.any(String),
      rowVersion: 11,
    });
  });

  it("autosaves edits to failed drafts", async () => {
    await mount();
    await act(async () => editor().props.onChange("Recovered brief"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(api.updateTaskDraft).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({
        briefMarkdown: "Recovered brief",
        rowVersion: 10,
      }),
    );
  });
});
