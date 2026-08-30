import { DndContext } from "@dnd-kit/core";
import {
  chatSummarySchema,
  projectTabMemberSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import { ProjectTabBar, projectTabRemovalDisposition } from "./project-tab-bar";

vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));
vi.mock("./project-surface-create-menu", () => ({
  ProjectSurfaceCreateMenu: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-08-23T12:00:00.000Z";

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    return textContent(
      (value as { props: { children?: unknown } }).props.children,
    );
  }
  return "";
}

function chatSurface(options: {
  running?: boolean;
  unreadCompletion?: boolean;
}): ProjectSurface {
  const chat = chatSummarySchema.parse({
    id: "chat-1",
    projectId: "project-1",
    experience: "agent",
    position: 0,
    status: options.running ? "running" : "idle",
    activeWorkerId: null,
    activeWorktreeId: "worktree-1",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: options.unreadCompletion ?? false,
    automationPaused: false,
    createdAt: now,
    updatedAt: now,
    title: "Agent",
  });
  const member = projectTabMemberSummarySchema.parse({
    tabKey: `chat:${chat.id}`,
    groupId: "group-1",
    projectId: chat.projectId,
    tabKind: "chat",
    tabId: chat.id,
    title: chat.title,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    entity: chat,
    groupId: member.groupId,
    kind: "chat",
    member,
    projectId: chat.projectId,
    tabId: chat.id,
    tabKey: member.tabKey,
    title: chat.title,
  };
}

function renderTabs(surface: ProjectSurface) {
  return renderToStaticMarkup(
    <DndContext>
      <ProjectTabBar
        activeTabKey=""
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
        onStopAndCloseRunTerminal={vi.fn()}
        surfaces={[surface]}
      />
    </DndContext>,
  );
}

function runSurface(running: boolean): ProjectSurface {
  const entity = {
    id: "run-terminal-1",
    projectId: "project-1",
    kind: "run-configuration" as const,
    title: "Development server",
    position: 0,
    status: running ? ("running" as const) : ("exited" as const),
    activeWorkerId: "worker-1",
    worktreeId: "worktree-1",
    linkedChatId: null,
    runConfigurationId: "15f6add0-873f-409f-a5ab-6e9e509359e2",
    runConfigurationRuntimeId: "a0b8f948-09b5-47e5-9a4f-2a3ce8025802",
    directoryPath: null,
    service: { enabled: false, command: "" },
    createdAt: now,
    updatedAt: now,
  };
  const member = projectTabMemberSummarySchema.parse({
    tabKey: `terminal:${entity.id}`,
    groupId: "group-1",
    projectId: entity.projectId,
    tabKind: "terminal",
    tabId: entity.id,
    title: entity.title,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    entity,
    groupId: member.groupId,
    kind: "terminal",
    member,
    projectId: entity.projectId,
    tabId: entity.id,
    tabKey: member.tabKey,
    title: entity.title,
  };
}

describe("project tab bar", () => {
  it("renders a left-clicked file as an italic filename preview in its target group", async () => {
    const onPin = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectTabBar
            activeTabKey=""
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            onStopAndCloseRunTerminal={vi.fn()}
            previewFile={{
              active: true,
              path: "src/preview-file.ts",
              projectId: "project-1",
              title: "preview-file.ts",
              onClose: vi.fn(),
              onPin,
              onSelect,
            }}
            surfaces={[]}
          />
        </DndContext>,
      );
    });

    const preview = renderer.root.findByProps({
      "data-preview-file-path": "src/preview-file.ts",
    });
    const previewButton = preview.findByProps({ role: "tab" });
    expect(textContent(previewButton.props.children)).toContain(
      "preview-file.ts",
    );
    expect(previewButton.props.className).toContain("italic");

    await act(async () => previewButton.props.onClick());
    expect(onSelect).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    await act(async () => previewButton.props.onDoubleClick(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onPin).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("closes a File preview tab on middle click", async () => {
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectTabBar
            activeTabKey=""
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            onStopAndCloseRunTerminal={vi.fn()}
            previewFile={{
              active: true,
              path: "src/file.ts",
              projectId: "project-1",
              title: "file.ts",
              onClose,
              onPin: vi.fn(),
              onSelect: vi.fn(),
            }}
            surfaces={[]}
          />
        </DndContext>,
      );
    });
    const preview = renderer.root.findByProps({
      "data-preview-file-path": "src/file.ts",
    });
    const mouseDown = { button: 1, preventDefault: vi.fn() };
    const auxiliaryClick = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    preview.props.onMouseDown(mouseDown);
    preview.props.onAuxClick(auxiliaryClick);

    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("shows the running and unread-completion states on top tabs", () => {
    const running = renderTabs(chatSurface({ running: true }));
    const completed = renderTabs(chatSurface({ unreadCompletion: true }));

    expect(running).toContain("animate-spin");
    expect(running).not.toContain("bg-sky-400");
    expect(completed).toContain("bg-sky-400");
    expect(completed).toContain("Agent turn finished; open to dismiss");
  });

  it("uses Run-specific icon, status, and stop-and-close disposition", () => {
    const running = runSurface(true);
    const exited = runSurface(false);
    const markup = renderTabs(running);

    expect(markup).toContain("lucide-play");
    expect(markup).toContain("bg-emerald-500");
    expect(projectTabRemovalDisposition(running)).toBe("stop-and-close-run");
    expect(projectTabRemovalDisposition(exited)).toBe("delete");
    expect(projectTabRemovalDisposition(chatSurface({ running: true }))).toBe(
      "blocked-active-agent",
    );
  });
});
