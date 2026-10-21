// @vitest-environment jsdom
import { standaloneChatSummarySchema } from "@cantrip/protocol";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteStandaloneChatFileEntry: vi.fn(),
  downloadStandaloneChatFiles: vi.fn(),
  getStandaloneChatFile: vi.fn(async () => ({
    content: "hello",
    markdown: false,
    path: "notes.txt",
    version: "version-one",
  })),
  getStandaloneChatFileDirectory: vi.fn(async () => ({
    entries: [
      {
        kind: "file",
        markdown: false,
        modifiedAt: "2026-08-30T12:00:00.000Z",
        name: "notes.txt",
        path: "notes.txt",
        size: 5,
        symbolicLink: false,
        viewable: true,
      },
    ],
    path: "",
    truncated: false,
  })),
  getWorkers: vi.fn(async () => [
    {
      online: true,
      standaloneChat: {
        files: {
          archive: true,
          download: true,
          list: true,
          networkShare: false,
          read: true,
          remove: true,
          write: true,
        },
      },
      workerId: "worker-one",
    },
  ]),
  getStandaloneChats: vi.fn(async () => []),
  loadStandaloneChatFileMedia: vi.fn(),
  saveStandaloneChatFile: vi.fn(),
}));
const desktop = vi.hoisted(() => ({
  openDesktopStandaloneChatFile: vi.fn(async () => "created" as const),
}));
const editor = vi.hoisted(() => ({ current: null as unknown }));
interface EditorProps {
  session: EditorDocumentSession;
  onChange(text: string): void;
  onSave(): void;
}

vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div", { "data-markdown": true }),
}));
vi.mock("@radix-ui/react-context-menu", () => ({
  Portal: ({ children }: { children?: ReactNode }) => children,
  Root: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/styled-menu", () => ({
  StyledContextMenuContent: ({ children }: { children?: ReactNode }) =>
    children,
  StyledContextMenuItem: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: (props: EditorProps) => {
    editor.current = props;
    return createElement("div", { "data-editor": true });
  },
}));
vi.mock("@/components/explorer/structured-file-visual", () => ({
  StructuredFileVisual: () => createElement("div", { "data-visual": true }),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/desktop-chat-files", () => ({
  chatFilesAreLocalToDesktop: () => false,
  chatScratchRevealUsesLocalFolder: () => false,
  desktopChatRevealLabel: () => null,
  revealChatScratchInNativeFileManager: vi.fn(),
}));
vi.mock("@/lib/desktop-worker", () => ({
  listDesktopWorkers: vi.fn(async () => []),
}));
vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: () => "http://127.0.0.1:4310",
}));
vi.mock("@/lib/desktop-popout", () => ({
  desktopPopoutTitlebarLeftInset: () => undefined,
  isMacosDesktopRuntime: () => false,
  openDesktopStandaloneChatFile: desktop.openDesktopStandaloneChatFile,
  updateDesktopWindowTitle: vi.fn(),
}));

import { StandaloneChatFilesPanel } from "./standalone-chat-files-panel";
import { chatEditorSessions } from "./standalone-chat-editor-sessions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chat = standaloneChatSummarySchema.parse({
  activeScratchRootId: "00000000-0000-4000-8000-000000000002",
  activeWorkerId: "worker-one",
  activeWorktreeId: null,
  automationPaused: false,
  contextKind: "standalone",
  createdAt: "2026-08-30T12:00:00.000Z",
  customSubagentModel: false,
  experience: "agent",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: false,
  id: "00000000-0000-4000-8000-000000000001",
  modelId: null,
  permissionProfileId: null,
  placementRevision: 1,
  planMode: "default",
  position: 0,
  projectId: null,
  reasoningEffort: null,
  status: "idle",
  subagentModelId: null,
  subagentReasoningEffort: null,
  title: "Scratch chat",
  updatedAt: "2026-08-30T12:00:00.000Z",
  worktreeMode: null,
});

async function renderPanel(desktopRuntime: boolean, selectedChat = chat) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <StandaloneChatFilesPanel
          chat={selectedChat}
          desktopRuntime={desktopRuntime}
          requestedPath={null}
        />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() =>
    expect(
      renderer.root.findAllByProps({ "data-chat-file-path": "notes.txt" }),
    ).toHaveLength(1),
  );
  return { client, renderer };
}

describe("standalone Chat files panel", () => {
  beforeEach(() => {
    chatEditorSessions.discardAll();
    desktop.openDesktopStandaloneChatFile.mockClear();
    api.saveStandaloneChatFile.mockReset();
    api.saveStandaloneChatFile.mockResolvedValue({
      path: "notes.txt",
      content: "saved",
      version: "version-two",
      markdown: false,
    });
  });

  it("saves an owned document against its exact worker and scratch root and confirms dirty close", async () => {
    const { client, renderer } = await renderPanel(false);
    await act(async () =>
      renderer.root
        .findByProps({ "data-chat-file-path": "notes.txt" })
        .props.onClick(),
    );
    await vi.waitFor(() =>
      expect(
        renderer.root.findAllByProps({ "data-editor": true }),
      ).toHaveLength(1),
    );
    await act(async () =>
      (editor.current as EditorProps).onChange("first draft"),
    );
    await act(async () => (editor.current as EditorProps).onSave());
    await vi.waitFor(() =>
      expect(api.saveStandaloneChatFile).toHaveBeenCalledWith(
        chat.id,
        { path: "notes.txt", content: "first draft", version: "version-one" },
        {
          workerId: chat.activeWorkerId,
          scratchRootId: chat.activeScratchRootId,
        },
      ),
    );
    await act(async () =>
      (editor.current as EditorProps).onChange("unsaved after save"),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Close Chat file" })
        .props.onClick(),
    );
    expect(renderer.root.findAllByProps({ "data-editor": true })).toHaveLength(
      1,
    );
    expect((editor.current as EditorProps).session.text).toBe(
      "unsaved after save",
    );
    confirm.mockReturnValue(true);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Close Chat file" })
        .props.onClick(),
    );
    expect(renderer.root.findAllByProps({ "data-editor": true })).toHaveLength(
      0,
    );
    confirm.mockRestore();
    await act(async () => renderer.unmount());
    client.clear();
  });

  it("renders only the file tree until a browser file is opened full screen", async () => {
    const { client, renderer } = await renderPanel(false);

    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "Select a file to preview or edit it.",
    );
    await act(async () => {
      renderer.root
        .findByProps({
          "data-chat-file-path": "notes.txt",
        })
        .props.onClick();
    });
    expect(
      renderer.root.findByProps({ "aria-label": "Close Chat file" }),
    ).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain("mobile-safe-top");
    expect(desktop.openDesktopStandaloneChatFile).not.toHaveBeenCalled();

    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Close Chat file" })
        .props.onClick(),
    );
    expect(
      renderer.root.findAllByProps({ "aria-label": "Close Chat file" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
    client.clear();
  });

  it("retains a Chat file draft across in-app unmounts and actually discards it on confirmed close", async () => {
    const first = await renderPanel(false);
    await act(async () =>
      first.renderer.root
        .findByProps({ "data-chat-file-path": "notes.txt" })
        .props.onClick(),
    );
    await vi.waitFor(() =>
      expect(
        first.renderer.root.findAllByProps({ "data-editor": true }),
      ).toHaveLength(1),
    );
    await act(async () =>
      (editor.current as EditorProps).onChange("retained navigation draft"),
    );
    const retained = (editor.current as EditorProps).session;
    retained.selection = { start: 2, end: 7, direction: "backward" };
    retained.scrollTop = 120;
    await act(async () => first.renderer.unmount());
    first.client.clear();

    const unloadWhileHidden = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadWhileHidden);
    expect(unloadWhileHidden.defaultPrevented).toBe(true);

    api.getStandaloneChatFile.mockRejectedValueOnce(
      new Error("worker disconnected"),
    );
    const second = await renderPanel(false, {
      ...chat,
      activeScratchRootId: "00000000-0000-4000-8000-000000000003",
    });
    await act(async () =>
      second.renderer.root
        .findByProps({ "data-chat-file-path": "notes.txt" })
        .props.onClick(),
    );
    await vi.waitFor(() =>
      expect(
        second.renderer.root.findAllByProps({ "data-editor": true }),
      ).toHaveLength(1),
    );
    expect((editor.current as EditorProps).session).toBe(retained);
    expect(retained.selection).toEqual({
      start: 2,
      end: 7,
      direction: "backward",
    });
    expect(retained.scrollTop).toBe(120);
    expect(api.getStandaloneChatFile).toHaveBeenLastCalledWith(
      chat.id,
      "notes.txt",
      {
        workerId: chat.activeWorkerId,
        scratchRootId: chat.activeScratchRootId,
      },
    );
    expect(retained.history.undo(retained.text)?.text).toBe("hello");
    api.saveStandaloneChatFile.mockRejectedValueOnce(
      new Error("scratch binding moved"),
    );
    await act(async () => (editor.current as EditorProps).onSave());
    await vi.waitFor(() =>
      expect(JSON.stringify(second.renderer.toJSON())).toContain(
        "scratch binding moved",
      ),
    );
    expect(api.saveStandaloneChatFile).toHaveBeenLastCalledWith(
      chat.id,
      {
        path: "notes.txt",
        content: "retained navigation draft",
        version: "version-one",
      },
      {
        workerId: chat.activeWorkerId,
        scratchRootId: chat.activeScratchRootId,
      },
    );
    expect(retained.text).toBe("retained navigation draft");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () =>
      second.renderer.root
        .findByProps({ "aria-label": "Close Chat file" })
        .props.onClick(),
    );
    await act(async () =>
      second.renderer.root
        .findByProps({ "data-chat-file-path": "notes.txt" })
        .props.onClick(),
    );
    await vi.waitFor(() =>
      expect(
        second.renderer.root.findAllByProps({ "data-editor": true }),
      ).toHaveLength(1),
    );
    expect((editor.current as EditorProps).session.text).toBe("hello");
    expect((editor.current as EditorProps).session).not.toBe(retained);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    confirm.mockRestore();
    await act(async () => second.renderer.unmount());
    second.client.clear();
  });

  it("opens Chat files in a native desktop window", async () => {
    const { client, renderer } = await renderPanel(true);

    await act(async () => {
      renderer.root
        .findByProps({
          "data-chat-file-path": "notes.txt",
        })
        .props.onClick();
    });
    expect(
      desktop.openDesktopStandaloneChatFile,
    ).toHaveBeenCalledExactlyOnceWith(
      { chatId: chat.id, path: "notes.txt" },
      "notes.txt",
    );
    expect(
      renderer.root.findAllByProps({ "aria-label": "Close Chat file" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
    client.clear();
  });
});
