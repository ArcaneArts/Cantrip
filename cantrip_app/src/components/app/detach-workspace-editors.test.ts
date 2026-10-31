import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import type { ProjectSurface } from "@/lib/project-surface";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { clearClientSession, setClientSession } from "@/lib/client-session";
import {
  nativeCodeOwnerKey,
  setNativeCodeLifecycle,
} from "@/components/code/native-code-lifecycle";
import { detachWorkspaceEditors } from "./detach-workspace-editors";
import { registerTerminalTransferLifecycle } from "@/components/terminal/terminal-transfer-lifecycle";
import { registerChatTransferLifecycle } from "@/components/chat/chat-transfer-lifecycle";
import { registerRemoteDesktopTransferLifecycle } from "@/components/remote-desktop/remote-desktop-transfer-lifecycle";
import { getRemoteDesktop } from "@/lib/api";
vi.mock("@/lib/api", () => ({ getRemoteDesktop: vi.fn() }));

beforeEach(() =>
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
  }),
);
afterEach(() => clearClientSession());

function fixture() {
  const events: string[] = [];
  const tabs = ["file", "code"].map((id) => ({
    id,
    resource: {
      kind: "entity",
      definitionId: id === "file" ? "project.file" : "project.code",
      resourceId: id,
    },
  }));
  const surfaces = new Map(
    tabs.map((tab) => [
      tab.id,
      {
        kind: tab.id === "file" ? "explorer" : "code",
        entity: {
          id: tab.id,
          projectId: "project",
          activeWorkerId: "worker",
          worktreeId: "tree",
        },
      } as ProjectSurface,
    ]),
  );
  const lifecycles = tabs.map(
    ({ id }) =>
      ({
        suspendTransfer: vi.fn(() => {
          events.push(`suspend:${id}`);
          return () => {
            events.push(`resume:${id}`);
          };
        }),
        captureTransfer: vi.fn(async () => ({
          explorerId: id,
          projectId: "project",
          workerId: "worker",
          worktreeId: "tree",
          selectedPath: null,
          fileMode: "edit" as const,
          documents: { scope: '["server","owner"]', documents: [] },
        })),
        retireTransfer: vi.fn(() => {
          events.push(`retire:${id}`);
        }),
        save: vi.fn(),
        discard: vi.fn(),
      }) as unknown as ExplorerLifecycleActions,
  );
  const unsubscribe = vi.fn();
  const controller = {
    subscribe: () => unsubscribe,
    getSnapshot: () => ({
      authoritative: {
        projectId: "project",
        windows: [{ id: "main", panes: [{ id: "pane", tabs }] }],
      },
    }),
  } as unknown as WorkspaceCommandClient;
  const codeKey = nativeCodeOwnerKey("code");
  setNativeCodeLifecycle(codeKey, lifecycles[1]!);
  return {
    input: {
      controller,
      surfaces,
      explorers: new Map([["file", lifecycles[0]!]]),
      paneId: "pane",
      windowId: "main",
      title: "Files",
    },
    events,
    lifecycles,
    unsubscribe,
    cleanup: () => setNativeCodeLifecycle(codeKey, null),
  };
}

it.each([false, true])(
  "forwards caller cancellation to the coordinator (already aborted=%s)",
  async (alreadyAborted) => {
    const f = fixture();
    const cancellation = new AbortController();
    const reason = new Error("File window context changed.");
    if (alreadyAborted) cancellation.abort(reason);
    let forwarded!: AbortSignal;
    try {
      await expect(
        detachWorkspaceEditors(
          { ...f.input, signal: cancellation.signal },
          async (input) => {
            forwarded = input.signal!;
            if (!alreadyAborted) cancellation.abort(reason);
            forwarded.throwIfAborted();
            return "unreachable";
          },
        ),
      ).rejects.toBe(reason);
      expect(forwarded.aborted).toBe(true);
      expect(f.unsubscribe).toHaveBeenCalledOnce();
      expect(f.events).toEqual([]);
    } finally {
      f.cleanup();
    }
  },
);

it("uses the authorized remote desktop renderer in a mixed pane transfer", async () => {
  const f = fixture();
  const tab =
    f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!
      .tabs[1]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.remote-desktop",
    resourceId: "code",
  };
  f.input.surfaces.set("code", {
    kind: "remote-desktop",
    entity: { id: "code", projectId: "project" },
  } as ProjectSurface);
  vi.mocked(getRemoteDesktop).mockResolvedValue({
    id: "code",
    projectId: "project",
    workerId: "worker",
  } as never);
  const release = vi.fn();
  const retireTransfer = vi.fn(async () => {});
  const unregister = registerRemoteDesktopTransferLifecycle(
    {
      tabId: "code",
      desktopId: "code",
      projectId: "project",
      workerId: "worker",
    },
    {
      suspendTransfer: () => release,
      captureTransfer: async () => ({
        version: 1,
        desktopId: "code",
        projectId: "project",
        workerId: "worker",
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        fleetOpen: true,
        targetSearch: "Editor",
      }),
      retireTransfer,
    },
  );
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      const lease = await options.prepare(["file", "code"]);
      const payload = JSON.parse(
        new TextDecoder().decode(await lease.capture()),
      );
      expect(payload.editors).toHaveLength(1);
      expect(payload.desktops[0]).toMatchObject({
        tabId: "code",
        state: { desktopId: "code", targetSearch: "Editor" },
      });
      await lease.retire();
      expect(retireTransfer).toHaveBeenCalledOnce();
      await lease.resume();
      expect(release).toHaveBeenCalledOnce();
      return "destination";
    });
    vi.mocked(getRemoteDesktop).mockResolvedValue({
      id: "code",
      projectId: "other",
      workerId: "worker",
    } as never);
    await expect(
      detachWorkspaceEditors(f.input, async (options) => {
        await options.prepare(["code"]);
        return "destination";
      }),
    ).rejects.toThrow("remote desktop changed");
  } finally {
    unregister();
    f.cleanup();
  }
});

it("uses the registered terminal view for a mixed pane transfer", async () => {
  const f = fixture();
  const tab =
    f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!
      .tabs[1]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.terminal",
    resourceId: "code",
  };
  f.input.surfaces.set("code", {
    kind: "terminal",
    entity: { id: "code", projectId: "project", activeWorkerId: "worker" },
  } as ProjectSurface);
  const release = vi.fn();
  const retireTransfer = vi.fn(async () => {});
  const unregister = registerTerminalTransferLifecycle(
    {
      tabId: "code",
      projectId: "project",
      terminalId: "code",
      workerId: "worker",
    },
    {
      suspendTransfer: () => release,
      captureTransfer: async () => ({
        version: 1,
        terminalId: "code",
        workerId: "worker",
        buffer: "normal",
        cols: 80,
        viewportY: 0,
        followingOutput: true,
        selection: null,
      }),
      retireTransfer,
    },
  );
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      const lease = await options.prepare(["file", "code"]);
      const payload = JSON.parse(
        new TextDecoder().decode(await lease.capture()),
      );
      expect(payload.editors).toHaveLength(1);
      expect(payload.terminals[0].tabId).toBe("code");
      await lease.retire();
      expect(retireTransfer).toHaveBeenCalledOnce();
      await lease.resume();
      expect(release).toHaveBeenCalledOnce();
      return "destination";
    });
  } finally {
    unregister();
    f.cleanup();
  }
});

it.each(["rail", "direct"] as const)(
  "captures a %s chat alongside editors without stopping execution",
  async (placement) => {
    const f = fixture();
    const tab =
      f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!
        .tabs[1]!;
    tab.resource = {
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "chat",
    };
    if (placement === "direct") {
      const pane =
        f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!;
      pane.conversationView = tab;
      pane.tabs = pane.tabs.filter((view) => view.id !== tab.id);
    }
    f.input.surfaces.set("code", {
      kind: "chat",
      entity: { id: "chat", projectId: "project" },
    } as ProjectSurface);
    const release = vi.fn();
    const retire = vi.fn(async () => {});
    const unregister = registerChatTransferLifecycle(
      { tabId: "code", chatId: "chat", projectId: "project" },
      {
        suspendTransfer: () => release,
        captureTransfer: async () => ({
          version: 1,
          chatId: "chat",
          projectId: "project",
          draft: { text: "unsent", mode: "default", reasoningEffort: null },
          nativeModeIntent: null,
          composerSelection: { start: 2, end: 4, scrollTop: 0 },
          transcript: { scrollTop: 250, following: false },
          editingPrompt: null,
          editingSentMessage: null,
          inspectTab: "trajectory",
          trajectoryTargetKey: null,
          sidePanelView: { type: "inspect" },
        }),
        retireTransfer: retire,
      },
    );
    try {
      await detachWorkspaceEditors(f.input, async (options) => {
        const lease = await options.prepare(["file", "code"]);
        const payload = JSON.parse(
          new TextDecoder().decode(await lease.capture()),
        );
        expect(payload.editors).toHaveLength(1);
        expect(payload.chats).toMatchObject([
          {
            tabId: "code",
            state: {
              chatId: "chat",
              draft: { text: "unsent" },
              transcript: { scrollTop: 250 },
            },
          },
        ]);
        await lease.retire();
        expect(retire).toHaveBeenCalledOnce();
        await lease.resume();
        expect(release).toHaveBeenCalledOnce();
        return "destination";
      });
      unregister();
      await expect(
        detachWorkspaceEditors(f.input, async (options) => {
          await options.prepare(["code"]);
          return "destination";
        }),
      ).rejects.toThrow("chat view is not attached");
    } finally {
      unregister();
      f.cleanup();
    }
  },
);

it("captures and retires all reserved editors without save or discard", async () => {
  const f = fixture();
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      const lease = await options.prepare(["file", "code"]);
      expect(f.events).toEqual(["suspend:file", "suspend:code"]);
      const payload = JSON.parse(
        new TextDecoder().decode(await lease.capture()),
      );
      expect(
        payload.editors.map((entry: { tabId: string }) => entry.tabId),
      ).toEqual(["file", "code"]);
      await lease.retire();
      expect(f.events.slice(-2)).toEqual(["retire:file", "retire:code"]);
      await lease.resume();
      expect(f.events.slice(-2)).toEqual(["resume:code", "resume:file"]);
      return "destination";
    });
    for (const lifecycle of f.lifecycles) {
      expect(lifecycle.save).not.toHaveBeenCalled();
      expect(lifecycle.discard).not.toHaveBeenCalled();
    }
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  } finally {
    f.cleanup();
  }
});

it("captures a document by its tab lifecycle and binds the immutable location", async () => {
  const f = fixture();
  const tab =
    f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!
      .tabs[0]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "document",
  };
  f.input.surfaces.set("file", {
    kind: "file",
    entity: {
      id: "document",
      projectId: "project",
      workerId: "worker",
      worktreeId: "tree",
      path: "src/main.rs",
    },
  } as ProjectSurface);
  vi.mocked(f.lifecycles[0]!.captureTransfer!).mockResolvedValue({
    explorerId: "file",
    documentId: "document",
    projectId: "project",
    workerId: "worker",
    worktreeId: "tree",
    selectedPath: "src/main.rs",
    fileMode: "edit",
    documents: { scope: '["server","owner"]', documents: [] },
  });
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      const lease = await options.prepare(["file"]);
      const payload = JSON.parse(
        new TextDecoder().decode(await lease.capture()),
      );
      expect(payload.editors[0]).toMatchObject({
        tabId: "file",
        state: {
          documentId: "document",
          explorerId: "file",
          selectedPath: "src/main.rs",
        },
      });
      await lease.retire();
      await lease.resume();
      return "destination";
    });
    expect(f.lifecycles[0]!.save).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it("fails missing adapters before suspending any editor", async () => {
  const f = fixture();
  f.input.surfaces.delete("code");
  try {
    await expect(
      detachWorkspaceEditors(f.input, async (options) => {
        await options.prepare(["file", "code"]);
        return "destination";
      }),
    ).rejects.toThrow(/transfer adapter/);
    expect(f.events).toEqual([]);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  } finally {
    f.cleanup();
  }
});

it("aborts a waiting coordinator on logout and rejects later preparation", async () => {
  const f = fixture();
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      clearClientSession();
      expect(options.signal?.aborted).toBe(true);
      await expect(options.prepare(["file"])).rejects.toThrow(
        /account changed/,
      );
      return "cancelled";
    });
    expect(f.events).toEqual([]);
  } finally {
    f.cleanup();
  }
});

it.each([
  "project.tasks",
  "git.history",
  "git.graph",
  "github.issues",
  "github.pull-requests",
  "github.actions",
  "project.git-history",
  "project.git-graph",
  "project.github-issues",
  "project.github-pull-requests",
  "project.github-actions",
])(
  "includes %s in mixed panes without needing a live runtime adapter",
  async (definitionId) => {
    const f = fixture();
    const builtin =
      !definitionId.startsWith("project.git-") &&
      !definitionId.startsWith("project.github-");
    const panel = {
      id: "panel",
      resource: builtin
        ? { kind: "builtin", definitionId }
        : { kind: "entity", definitionId, resourceId: "panel-entity" },
      builtInState: builtin ? { definitionId, worktreeId: "tree" } : null,
    };
    const pane =
      f.input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!;
    pane.tabs.push(panel as never);
    try {
      await detachWorkspaceEditors(f.input, async (options) => {
        const lease = await options.prepare(["file", "panel"]);
        const payload = JSON.parse(
          new TextDecoder().decode(await lease.capture()),
        );
        expect(payload.panels).toEqual([
          {
            tabId: "panel",
            projectId: "project",
            resource: panel.resource,
            builtInState: panel.builtInState,
          },
        ]);
        expect(payload.editors).toHaveLength(1);
        await lease.retire();
        await lease.resume();
        return "destination";
      });
      expect(f.events).toEqual(["suspend:file", "retire:file", "resume:file"]);
    } finally {
      f.cleanup();
    }
  },
);

it("moves a Run configuration output without requiring a live PTY adapter", async () => {
  const f = fixture();
  const tab = {
    id: "run",
    resource: {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "runtime",
    },
    builtInState: null,
  };
  f.input.controller
    .getSnapshot()
    .authoritative.windows[0]!.panes[0]!.tabs.push(tab as never);
  f.input.surfaces.set("run", {
    kind: "terminal",
    entity: { id: "runtime", projectId: "project", kind: "run-configuration" },
  } as ProjectSurface);
  try {
    await detachWorkspaceEditors(f.input, async (options) => {
      const lease = await options.prepare(["run"]);
      const payload = JSON.parse(
        new TextDecoder().decode(await lease.capture()),
      );
      expect(payload.panels).toEqual([
        {
          tabId: "run",
          projectId: "project",
          resource: tab.resource,
          builtInState: null,
        },
      ]);
      await lease.retire();
      await lease.resume();
      return "destination";
    });
    expect(f.events).toEqual([]);
  } finally {
    f.cleanup();
  }
});
