import { standaloneChatSummarySchema } from "@cantrip/protocol";
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
  loadStandaloneChatFileMedia: vi.fn(),
  saveStandaloneChatFile: vi.fn(),
}));
const desktop = vi.hoisted(() => ({
  openDesktopStandaloneChatFile: vi.fn(async () => "created" as const),
}));

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
vi.mock("@/components/explorer/monaco-file-editor", () => ({
  MonacoFileEditor: () => createElement("div", { "data-editor": true }),
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

async function renderPanel(desktopRuntime: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <StandaloneChatFilesPanel
          chat={chat}
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
  beforeEach(() => desktop.openDesktopStandaloneChatFile.mockClear());

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
