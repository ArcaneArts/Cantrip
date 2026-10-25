import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearClientSession, setClientSession } from "@/lib/client-session";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { startWorkspaceTransferDestination } from "@/lib/workspace-transfer-destination";
import {
  getExplorers,
  getTerminals,
  getBrowsers,
  getChats,
  getRemoteDesktops,
} from "@/lib/api";
import { stageExplorerTransferBatch } from "@/components/explorer/explorer-transfer-batch";
import { useWorkspaceEditorTransfer } from "./use-workspace-editor-transfer";
import { getFileDocuments } from "@/lib/api/file-documents";
vi.mock("@/lib/api/file-documents", () => ({ getFileDocuments: vi.fn() }));
const editorPayload = new TextEncoder().encode(
  JSON.stringify({ version: 1, editors: [] }),
);

vi.mock("@/lib/api", () => ({
  getExplorers: vi.fn(),
  getCodeTabs: vi.fn(),
  getTerminals: vi.fn(),
  getBrowsers: vi.fn(),
  getChats: vi.fn(),
  getRemoteDesktops: vi.fn(),
}));
vi.mock("@/lib/workspace-transfer-destination", () => ({
  startWorkspaceTransferDestination: vi.fn(),
}));
vi.mock("@/components/explorer/explorer-transfer-batch", () => ({
  stageExplorerTransferBatch: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFileDocuments).mockResolvedValue([]);
  setClientSession({
    authMode: "accounts",
    csrfToken: null,
    expiresAt: null,
    serverId: "server",
    user: {
      id: "owner",
      kind: "account",
      displayName: "Owner",
      email: "a@b.com",
      role: "member",
    },
  });
});
afterEach(() => clearClientSession());

async function mount(returning = false) {
  const layout = {
    id: "workspace",
    projectId: "project",
    pendingTransfers: [
      {
        id: "transfer",
        sourceWindowId: "main",
        sourcePaneId: "pane",
        tabIds: ["tab"],
        destinationWindowId: "destination",
        ...(returning
          ? {
              returnSplitId: "split",
              destinationWindowId: "destination",
              destinationPaneId: "pane",
              destinationGeneration: 0,
            }
          : {}),
      },
    ],
    windows: [
      {
        id: "main",
        panes: [
          {
            id: "pane",
            tabs: [
              {
                id: "tab",
                resource: {
                  kind: "entity",
                  definitionId: "project.file",
                  resourceId: "editor",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const dispose = vi.fn();
  vi.mocked(startWorkspaceTransferDestination).mockReturnValue({
    ready: Promise.resolve(),
    dispose,
    announceReady: vi.fn(async () => {}),
  });
  const controller = {
    getSnapshot: () => ({ authoritative: layout }),
    subscribe: vi.fn(() => vi.fn()),
  } as unknown as WorkspaceCommandClient;
  const onError = vi.fn();
  let value!: ReturnType<typeof useWorkspaceEditorTransfer>;
  const Probe = () => {
    value = useWorkspaceEditorTransfer({
      connection: { controller, windowId: "destination" },
      target: returning
        ? null
        : {
            projectId: "project",
            paneId: "pane",
            activeTabKey: "tab",
            transfer: {
              id: "transfer",
              workspaceId: "workspace",
              windowId: "destination",
              generation: 0,
            },
          },
      onError,
    });
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  return {
    renderer,
    layout,
    dispose,
    onError,
    value: () => value,
    notify: () =>
      vi
        .mocked(controller.subscribe)
        .mock.calls.forEach(([listener]) => listener()),
    restore: vi.mocked(startWorkspaceTransferDestination).mock.calls[0]![0]
      .restore,
  };
}

it.each([false, true])(
  "stages remote desktop state until renderer acknowledgment or cancellation (cancel=%s)",
  async (cancel) => {
    const f = await mount();
    try {
      f.layout.windows[0]!.panes[0]!.tabs[0]!.resource = {
        kind: "entity",
        definitionId: "project.remote-desktop",
        resourceId: "desktop",
      };
      const desktop = {
        id: "desktop",
        projectId: "project",
        workerId: "worker",
      };
      vi.mocked(getRemoteDesktops).mockResolvedValue([desktop] as never);
      vi.mocked(stageExplorerTransferBatch).mockReturnValue([]);
      const state = {
        version: 1,
        desktopId: "desktop",
        projectId: "project",
        workerId: "worker",
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        fleetOpen: true,
        targetSearch: "Editor",
      };
      const payload = (state: unknown) =>
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            editors: [],
            desktops: [{ tabId: "tab", state }],
          }),
        );
      await expect(
        f.restore(payload({ ...state, workerId: "other" })),
      ).rejects.toThrow("reservation");
      expect(f.value().incomingRemoteDesktopViews).toBeUndefined();
      let completion!: Promise<unknown>;
      let completed = false;
      await act(async () => {
        completion = f
          .restore(payload(state))
          .then(() => {
            completed = true;
          })
          .catch((error) => error);
      });
      expect(getRemoteDesktops).toHaveBeenCalledWith("project");
      expect(completed).toBe(false);
      expect(f.value().incomingRemoteDesktopViews![0]).toMatchObject({
        tabId: "tab",
        desktop,
        state,
      });
      if (cancel) {
        f.layout.pendingTransfers = [];
        await act(async () => f.notify());
        expect(await completion).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("reservation ended"),
          }),
        );
        expect(completed).toBe(false);
      } else {
        await act(async () => {
          f.value().incomingRemoteDesktopViews![0]!.staging!.onRestored();
          await completion;
        });
        expect(completed).toBe(true);
        f.layout.pendingTransfers = [];
        f.layout.windows[0]!.id = "destination";
        await act(async () => f.notify());
        expect(
          f.value().incomingRemoteDesktopViews![0]!.staging,
        ).toBeUndefined();
        expect(f.value().incomingRemoteDesktopViews![0]!.state).toEqual(state);
        f.layout.windows[0]!.panes = [];
        await act(async () => f.notify());
      }
      expect(f.value().incomingRemoteDesktopViews).toEqual([]);
    } finally {
      await act(async () => f.renderer.unmount());
    }
  },
);

it.each([false, true])(
  "stages authorized chat state until restoration or cancellation (cancel=%s)",
  async (cancel) => {
    const f = await mount();
    try {
      f.layout.windows[0]!.panes[0]!.tabs[0]!.resource = {
        kind: "entity",
        definitionId: "project.agent",
        resourceId: "chat",
      };
      const chat = { id: "chat", projectId: "project" };
      vi.mocked(getChats).mockResolvedValue([chat] as never);
      vi.mocked(stageExplorerTransferBatch).mockReturnValue([]);
      const state = {
        version: 1,
        chatId: "chat",
        projectId: "project",
        draft: { text: "unsent", mode: "plan", reasoningEffort: null },
        nativeModeIntent: "plan",
        composerSelection: { start: 0, end: 6, scrollTop: 0 },
        transcript: { scrollTop: 240, following: false },
        editingPrompt: null,
        editingSentMessage: null,
        inspectTab: "trajectory",
        trajectoryTargetKey: null,
        sidePanelView: { type: "inspect" },
      };
      const payload = (snapshot: unknown) =>
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            editors: [],
            chats: [{ tabId: "tab", state: snapshot }],
          }),
        );
      await expect(
        f.restore(payload({ ...state, chatId: "other" })),
      ).rejects.toThrow("reservation");
      expect(f.value().incomingChatViews).toBeUndefined();
      let completion!: Promise<unknown>;
      let completed = false;
      await act(async () => {
        completion = f
          .restore(payload(state))
          .then(() => {
            completed = true;
          })
          .catch((error) => error);
      });
      expect(getChats).toHaveBeenCalledWith("project");
      expect(completed).toBe(false);
      expect(f.value().incomingChatViews![0]).toMatchObject({
        tabId: "tab",
        chat,
        state,
      });
      if (cancel) {
        f.layout.pendingTransfers = [];
        await act(async () => f.notify());
        expect(await completion).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("reservation ended"),
          }),
        );
        expect(completed).toBe(false);
      } else {
        await act(async () => {
          f.value().incomingChatViews![0]!.staging!.onRestored();
          await completion;
        });
        expect(completed).toBe(true);
        f.layout.pendingTransfers = [];
        f.layout.windows[0]!.id = "destination";
        await act(async () => f.notify());
        expect(f.value().incomingChatViews![0]!.staging).toBeUndefined();
        expect(f.value().incomingChatViews![0]!.state).toEqual(state);
        f.layout.windows[0]!.panes = [];
        await act(async () => f.notify());
      }
      expect(f.value().incomingChatViews).toEqual([]);
    } finally {
      await act(async () => f.renderer.unmount());
    }
  },
);

it("waits for actual browser restoration before acknowledging and removes closed incoming views", async () => {
  const f = await mount();
  try {
    f.layout.windows[0]!.panes[0]!.tabs[0]!.resource = {
      kind: "entity",
      definitionId: "project.browser",
      resourceId: "browser",
    };
    vi.mocked(getBrowsers).mockResolvedValue([
      { id: "browser", projectId: "project", workerId: "worker" },
    ] as never);
    vi.mocked(stageExplorerTransferBatch).mockReturnValue([]);
    const state = {
      version: 1,
      browserId: "browser",
      projectId: "project",
      workerId: "worker",
      address: "draft",
      addressDirty: true,
      currentUrl: "https://example.com/",
      invalidAddress: false,
      serviceSearch: "",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    };
    let completion!: Promise<void>;
    let complete = false;
    await act(async () => {
      completion = f
        .restore(
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              editors: [],
              browsers: [{ tabId: "tab", state }],
            }),
          ),
        )
        .then(() => {
          complete = true;
        });
      await Promise.resolve();
    });
    expect(complete).toBe(false);
    expect(f.value().incomingBrowserViews![0]!.state).toEqual(state);
    await act(async () => {
      f.value().incomingBrowserViews![0]!.staging!.onRestored();
      await completion;
    });
    f.layout.pendingTransfers = [];
    f.layout.windows[0]!.id = "destination";
    await act(async () => f.notify());
    expect(f.value().incomingBrowserViews![0]!.staging).toBeUndefined();
    f.layout.windows[0]!.panes = [];
    await act(async () => f.notify());
    expect(f.value().incomingBrowserViews).toEqual([]);
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it("stages terminal state by view identity and removes it when that view closes", async () => {
  const f = await mount();
  try {
    f.layout.windows[0]!.panes[0]!.tabs[0]!.resource = {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "terminal",
    };
    vi.mocked(getTerminals).mockResolvedValue([
      { id: "terminal", projectId: "project", activeWorkerId: "worker" },
    ] as never);
    vi.mocked(stageExplorerTransferBatch).mockReturnValue([]);
    const state = {
      version: 1,
      terminalId: "terminal",
      workerId: "worker",
      buffer: "normal",
      cols: 80,
      viewportY: 0,
      followingOutput: true,
      selection: null,
    };
    const payload = (snapshot: unknown) =>
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          editors: [],
          terminals: [{ tabId: "tab", state: snapshot }],
        }),
      );
    await expect(
      f.restore(payload({ ...state, workerId: "other" })),
    ).rejects.toThrow(/does not match/);
    expect(f.value().stagedTerminalTransfers).toBeUndefined();
    let completion!: Promise<void>;
    let restored = false;
    await act(async () => {
      completion = f.restore(payload(state)).then(() => {
        restored = true;
      });
      await Promise.resolve();
    });
    expect(restored).toBe(false);
    const incoming = f.value().incomingTerminalViews![0]!;
    expect(incoming.terminal.id).toBe("terminal");
    await act(async () => {
      incoming.staging!.onRestored();
      await completion;
    });
    expect(f.value().stagedTerminalTransfers?.get("tab")).toEqual(state);
    expect(f.value().stagedTerminalTransfers?.has("terminal")).toBe(false);
    f.layout.pendingTransfers = [];
    f.layout.windows[0]!.id = "destination";
    await act(async () => f.notify());
    expect(f.value().incomingTerminalViews![0]!.staging).toBeUndefined();
    expect(f.value().stagedTerminalTransfers?.get("tab")).toEqual(state);
    f.layout.windows[0]!.panes = [];
    await act(async () => f.notify());
    expect(f.value().stagedTerminalTransfers?.size).toBe(0);
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it("rejects a pending terminal restore when its reservation is cancelled", async () => {
  const f = await mount();
  try {
    f.layout.windows[0]!.panes[0]!.tabs[0]!.resource = {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "terminal",
    };
    vi.mocked(getTerminals).mockResolvedValue([
      { id: "terminal", projectId: "project", activeWorkerId: "worker" },
    ] as never);
    vi.mocked(stageExplorerTransferBatch).mockReturnValue([]);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        editors: [],
        terminals: [
          {
            tabId: "tab",
            state: {
              version: 1,
              terminalId: "terminal",
              workerId: "worker",
              buffer: "normal",
              cols: 80,
              viewportY: 0,
              followingOutput: true,
              selection: null,
            },
          },
        ],
      }),
    );
    let completion!: Promise<unknown>;
    await act(async () => {
      completion = f.restore(bytes).catch((error) => error);
      await Promise.resolve();
    });
    expect(f.value().incomingTerminalViews).toHaveLength(1);
    f.layout.pendingTransfers = [];
    await act(async () => f.notify());
    expect(await completion).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/reservation ended/),
      }),
    );
    expect(f.value().incomingTerminalViews).toHaveLength(0);
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it("stages a first-class document separately and waits for restoration acknowledgment", async () => {
  const f = await mount();
  const document = {
    id: "editor",
    projectId: "project",
    workerId: "worker",
    worktreeId: "tree",
    path: "src/main.rs",
    createdAt: "2026-10-24T00:00:00Z",
  };
  vi.mocked(getFileDocuments).mockResolvedValue([document]);
  vi.mocked(getExplorers).mockResolvedValue([]);
  const state = {
    explorerId: "tab",
    documentId: "editor",
    fileMode: "preview",
  } as never;
  vi.mocked(stageExplorerTransferBatch).mockReturnValue([
    { tabId: "tab", state },
  ]);
  try {
    let completion!: Promise<void>;
    let restored = false;
    await act(async () => {
      completion = f.restore(editorPayload).then(() => {
        restored = true;
      });
    });
    expect(restored).toBe(false);
    expect(f.value().incomingExplorerViews).toHaveLength(0);
    expect(f.value().incomingFileDocumentViews![0]).toMatchObject({
      tabId: "tab",
      resource: document,
      state,
    });
    expect(stageExplorerTransferBatch).toHaveBeenCalledWith(editorPayload, [
      {
        tabId: "tab",
        scope: {
          serverId: "server",
          ownerId: "owner",
          explorerId: "tab",
          documentId: "editor",
          documentPath: "src/main.rs",
          projectId: "project",
          worktreeId: "tree",
          workerId: "worker",
        },
      },
    ]);
    await act(async () => {
      f.value().incomingFileDocumentViews![0]!.staging!.onRestored();
      await completion;
    });
    expect(restored).toBe(true);
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it.each([false, true])(
  "stages authorized editor snapshots and retains them after ownership commits (return=%s)",
  async (returning) => {
    const f = await mount(returning);
    try {
      vi.mocked(getExplorers).mockResolvedValue([
        {
          id: "editor",
          projectId: "project",
          worktreeId: "tree",
          activeWorkerId: "worker",
        },
      ] as never);
      const snapshot = { explorerId: "editor" } as never;
      vi.mocked(stageExplorerTransferBatch).mockReturnValue([
        { tabId: "tab", state: snapshot },
      ]);
      let completion!: Promise<void>;
      let restored = false;
      await act(async () => {
        completion = f.restore(editorPayload).then(() => {
          restored = true;
        });
      });
      expect(restored).toBe(false);
      await act(async () => {
        f.value().incomingExplorerViews![0]!.staging!.onRestored();
        await completion;
      });
      expect(stageExplorerTransferBatch).toHaveBeenCalledWith(editorPayload, [
        {
          tabId: "tab",
          scope: {
            serverId: "server",
            ownerId: "owner",
            explorerId: "editor",
            projectId: "project",
            worktreeId: "tree",
            workerId: "worker",
          },
        },
      ]);
      expect(f.value().stagedExplorerTransfers?.get("editor")).toBe(snapshot);
      expect(f.value().stagedCodeTransfers?.size).toBe(0);
      f.layout.pendingTransfers = [];
      f.layout.windows[0]!.id = "destination";
      await act(async () => f.notify());
      expect(f.dispose).toHaveBeenCalled();
      expect(f.value().stagedExplorerTransfers?.get("editor")).toBe(snapshot);
      f.layout.windows[0]!.panes = [];
      await act(async () => f.notify());
      expect(f.value().stagedExplorerTransfers?.has("editor")).toBe(false);
    } finally {
      await act(async () => f.renderer.unmount());
    }
  },
);

it("drops cancelled snapshots and does not replay them into a new view of the same resource", async () => {
  const f = await mount();
  try {
    vi.mocked(getExplorers).mockResolvedValue([
      {
        id: "editor",
        projectId: "project",
        worktreeId: "tree",
        activeWorkerId: "worker",
      },
    ] as never);
    vi.mocked(stageExplorerTransferBatch).mockReturnValue([
      { tabId: "tab", state: { explorerId: "editor" } as never },
    ]);
    let completion!: Promise<unknown>;
    await act(async () => {
      completion = f.restore(editorPayload).catch((error) => error);
    });
    expect(f.value().stagedExplorerTransfers?.has("editor")).toBe(true);
    f.layout.pendingTransfers = [];
    await act(async () => f.notify());
    expect(await completion).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/reservation ended/),
      }),
    );
    expect(f.value().stagedExplorerTransfers?.has("editor")).toBe(false);
    f.layout.windows[0]!.id = "destination";
    f.layout.windows[0]!.panes[0]!.tabs[0]!.id = "new-tab";
    await act(async () => f.notify());
    expect(f.value().stagedExplorerTransfers?.has("editor")).toBe(false);
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it("rejects unavailable resources without exposing staged state", async () => {
  const f = await mount();
  try {
    vi.mocked(getExplorers).mockResolvedValue([]);
    await expect(f.restore(new Uint8Array())).rejects.toThrow(
      /resource is unavailable/,
    );
    expect(stageExplorerTransferBatch).not.toHaveBeenCalled();
    expect(f.value().stagedExplorerTransfers).toBeUndefined();
  } finally {
    await act(async () => f.renderer.unmount());
  }
});

it("rejects retained restore callbacks after unmount", async () => {
  const f = await mount();
  await act(async () => f.renderer.unmount());
  await expect(f.restore(new Uint8Array())).rejects.toThrow(/context changed/);
  expect(getExplorers).not.toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalled();
});

it("reannounces readiness for a late source subscriber only while the reservation exists", async () => {
  vi.useFakeTimers();
  const f = await mount(true);
  try {
    const receiver = vi.mocked(startWorkspaceTransferDestination).mock
      .results[0]!.value;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(receiver.announceReady).toHaveBeenCalledTimes(2);
    f.layout.pendingTransfers = [];
    await act(async () => f.notify());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(receiver.announceReady).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => f.renderer.unmount());
    vi.useRealTimers();
  }
});
