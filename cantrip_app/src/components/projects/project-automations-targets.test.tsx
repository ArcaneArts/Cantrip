// @vitest-environment jsdom
import type { ChatSummary } from "@cantrip/protocol";
import type { ProjectAutomation } from "@cantrip/protocol/automations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectAutomationsSettings } from "./project-automations-settings";

const api = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "created" }),
  update: vi.fn().mockResolvedValue({ id: "existing" }),
}));
vi.mock("@/lib/project-automation-api", () => ({
  getProjectAutomations: vi.fn().mockResolvedValue([]),
  createProjectAutomation: api.create,
  updateProjectAutomation: api.update,
  deleteProjectAutomation: vi.fn(),
}));
vi.mock("@/lib/chat-worker-encryption", () => ({
  ensureChatWorkerEncryption: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));

const timestamp = "2026-10-08T00:00:00Z";
function chat(id: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: id,
    experience: "agent",
    projectId: "project",
    position: 0,
    status: "idle",
    activeWorkerId: "worker",
    activeWorktreeId: "worktree",
    worktreeMode: "agent-managed",
    placementRevision: 1,
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: false,
    automationPaused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
const task = chat("Completed archived task", { experience: "task" });
Object.assign(task, { archivedAt: timestamp, taskStatus: "completed" });
const agent = chat("Offline agent", { status: "offline" });
const missing = chat("Agent without worker", { activeWorkerId: null });
const existing: ProjectAutomation = {
  id: "existing",
  projectId: "project",
  chatId: "removed",
  workerId: "worker",
  name: "Existing schedule",
  prompt: "Review",
  enabled: false,
  revision: 1,
  schedule: {
    kind: "interval",
    every: 5,
    unit: "minute",
    startsAt: "2099-01-01T00:00:00Z",
  },
  condition: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  )!;
const select = () =>
  document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function render(chats: ChatSummary[], rows: ProjectAutomation[] = []) {
  client.setQueryData(["project-automations", "project"], rows);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProjectAutomationsSettings
          chats={chats}
          githubAvailable={false}
          projectId="project"
          workers={[]}
        />
      </QueryClientProvider>,
    );
  });
}
async function fill(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.create.mockClear();
  api.update.mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("automation targets", () => {
  it("excludes Tasks and foreign/standalone chats, disables missing context, and submits an offline Agent", async () => {
    const standalone = {
      ...chat("Standalone"),
      contextKind: "standalone",
      projectId: null,
      activeWorktreeId: null,
    } as unknown as ChatSummary;
    await render([
      task,
      chat("Running task", { experience: "task", status: "running" }),
      missing,
      standalone,
      chat("Other project", { projectId: "other" }),
      agent,
    ]);
    await click("New automation");
    expect([...select().options].map((option) => option.textContent)).toEqual([
      "Agent without worker (execution context unavailable)",
      "Offline agent",
    ]);
    expect(select().options[0]!.disabled).toBe(true);
    expect(select().value).toBe(agent.id);
    expect(document.body.textContent).toContain(
      "project worktree and assigned worker",
    );
    await fill(
      document.querySelector<HTMLInputElement>(
        '[placeholder="Review open pull requests"]',
      )!,
      "QA schedule",
    );
    await fill(
      document.querySelector<HTMLTextAreaElement>("textarea")!,
      "Review only",
    );
    await click("Create automation");
    expect(api.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        chatId: agent.id,
        name: "QA schedule",
        prompt: "Review only",
      }),
    );
  });
  it("does not offer a new automation when only Tasks exist", async () => {
    await render([task]);
    expect(button("New automation").disabled).toBe(true);
    expect(document.body.textContent).toContain("Create an Agent");
  });
  it("explains missing execution context without enabling creation", async () => {
    await render([
      missing,
      chat("Agent without worktree", { activeWorktreeId: "" }),
    ]);
    expect(button("New automation").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "project worktree and assigned worker",
    );
  });
  it("requires an explicit replacement when an edited target is no longer available", async () => {
    await render([task, agent], [existing]);
    await click("Edit Existing schedule");
    expect(select().value).toBe("removed");
    expect(select().selectedOptions[0]!.disabled).toBe(true);
    expect(select().selectedOptions[0]!.textContent).toContain(
      "Target unavailable",
    );
    expect(button("Save changes").disabled).toBe(true);
    expect(api.update).not.toHaveBeenCalled();
    await act(async () => {
      select().value = agent.id;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Save changes");
    expect(api.update).toHaveBeenCalledWith(
      "existing",
      expect.objectContaining({ chatId: agent.id }),
    );
  });
});
