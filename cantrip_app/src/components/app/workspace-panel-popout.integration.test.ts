import {
  EditorSessionStore,
  editorDocumentId,
} from "@/components/editor/document-session";
import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  type WorkspaceAction,
} from "@cantrip/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setClientSession, clearClientSession } from "@/lib/client-session";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import type { ProjectSurface } from "@/lib/project-surface";
import type { createWorkspaceTransferChannel } from "@/lib/workspace-transfer-channel";
import { detachWorkspaceViews } from "@/lib/workspace-transfer-source";
import { detachWorkspaceEditors } from "./detach-workspace-editors";
import { stageWorkspaceViewTransferBatch } from "./workspace-view-transfer-batch";
import { workspacePanelTransfer } from "./workspace-panel-transfer";

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
      email: "owner@example.invalid",
      role: "member",
    },
  }),
);
afterEach(() => clearClientSession());

it.each([
  { returning: false, single: false, reject: false },
  { returning: true, single: false, reject: false },
  { returning: false, single: true, reject: false },
  { returning: true, single: true, reject: false },
  { returning: false, single: false, reject: true },
])(
  "moves Tasks alone or with History, Run output, and a dirty editor (return=$returning, single=$single, rejected=$reject)",
  async ({ returning, single, reject }) => {
    const source = returning ? "popout" : "main";
    const tasks = {
      id: "tasks",
      preview: false,
      titleProtection: null,
      resource: { kind: "builtin", definitionId: "project.tasks" },
      builtInState: { definitionId: "project.tasks", worktreeId: null },
      dockPresentation: null,
    };
    const history = {
      id: "history",
      preview: false,
      titleProtection: null,
      resource: {
        kind: "entity",
        definitionId: "project.git-history",
        resourceId: "history-resource",
      },
      builtInState: null,
      dockPresentation: null,
    };
    const run = {
      id: "run",
      preview: false,
      titleProtection: null,
      resource: {
        kind: "entity",
        definitionId: "project.terminal",
        resourceId: "run-resource",
      },
      builtInState: null,
      dockPresentation: null,
    };
    const file = {
      id: "file",
      preview: false,
      titleProtection: null,
      resource: {
        kind: "entity",
        definitionId: "project.explorer",
        resourceId: "editor",
      },
      builtInState: null,
      dockPresentation: null,
    };
    let layout = workspaceOwnershipSchema.parse({
      version: 1,
      id: "workspace",
      projectId: "project",
      revision: 0,
      mainWindowId: "main",
      windows: [
        {
          id: source,
          attachmentGeneration: 0,
          focusedPaneId: "pane",
          recentPaneIds: ["pane"],
          centerRoot: { kind: "pane", paneId: "pane" },
          panes: [
            {
              id: "pane",
              region: "center",
              titleProtection: null,
              activeTabId: "history",
              tabs: [tasks, history, run, file],
            },
          ],
        },
        ...(returning
          ? [
              {
                id: "main",
                attachmentGeneration: 0,
                panes: [],
                centerRoot: null,
                focusedPaneId: null,
                recentPaneIds: [],
              },
            ]
          : []),
      ],
    });
    const original = structuredClone(layout.windows[0]!.panes[0]!);
    const listeners = new Set<() => void>();
    let serial = 0;
    const apply = (action: WorkspaceAction, windowId = source) => {
      const result = applyWorkspaceCommand(layout, {
        action,
        windowId,
        attachmentGeneration: 0,
        workspaceId: "workspace",
        projectId: "project",
        operationId: `operation-${++serial}`,
        expectedRevision: layout.revision,
      });
      layout = result.layout;
      for (const listener of listeners) listener();
      return { ...result, appliedRevision: layout.revision, replayed: false };
    };
    const controller = {
      getSnapshot: () => ({ authoritative: layout, disposed: false }),
      dispatch: async (action: WorkspaceAction) => apply(action),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as WorkspaceCommandClient;
    const release = vi.fn();
    const retire = vi.fn();
    const store = new EditorSessionStore();
    store.resetScope('["server","owner"]');
    const document = store.open(
      editorDocumentId({
        server: "server",
        account: "owner",
        project: "project",
        worker: "worker",
        worktree: "tree",
        path: "src/main.ts",
      }),
      "saved baseline",
      "version-one",
    );
    document.editExternal("unsaved buffer survives mixed panel transfer");
    const state = {
      explorerId: "editor",
      projectId: "project",
      workerId: "worker",
      worktreeId: "tree",
      selectedPath: "src/main.ts",
      fileMode: "edit",
      documents: await store.captureTransfer(),
    };
    const lifecycle = {
      suspendTransfer: () => release,
      captureTransfer: async () => state,
      retireTransfer: retire,
    };
    let callbacks!: Extract<
      Parameters<typeof createWorkspaceTransferChannel>[0],
      { side: "source" }
    >;
    const ready = () => {
      apply(
        { type: "transfer-ready", transferId: callbacks.binding.transferId },
        callbacks.binding.destinationWindowId,
      );
      callbacks.onReady();
    };
    let restored = false;
    const dependencies = {
      allocateId: () => `identity-${++serial}`,
      open: vi.fn(async () => {
        ready();
        return "created" as const;
      }),
      watch: async () => () => {},
      destroyCancelled: vi.fn(async () => {}),
      channel: ((options) => {
        if (options.side !== "source") throw Error("Expected source channel");
        callbacks = options;
        return {
          dispose: () => {},
          announceReady: async () => {},
          resendSnapshot: () => {},
          sendSnapshot: async (bytes: Uint8Array) => {
            const expected = (single ? [tasks] : [tasks, history, run]).map(
              (tab) => workspacePanelTransfer(tab as never, "project"),
            );
            if (reject) {
              const corrupted = JSON.parse(new TextDecoder().decode(bytes));
              corrupted.panels[0].projectId = "another-project";
              bytes = new TextEncoder().encode(JSON.stringify(corrupted));
            }
            const staged = stageWorkspaceViewTransferBatch(
              bytes,
              single
                ? []
                : [
                    {
                      tabId: "file",
                      scope: {
                        serverId: "server",
                        ownerId: "owner",
                        explorerId: "editor",
                        projectId: "project",
                        workerId: "worker",
                        worktreeId: "tree",
                      },
                    },
                  ],
              [],
              [],
              [],
              [],
              expected,
            );
            expect(staged.panels).toEqual(expected);
            if (single) expect(staged.editors).toEqual([]);
            else {
              expect(staged.editors[0]!.state.selectedPath).toBe("src/main.ts");
              expect(
                staged.editors[0]!.state.documents.documents[0]!.text,
              ).toBe(document.text);
            }
            expect(document.dirty).toBe(true);
            expect(retire).not.toHaveBeenCalled();
            apply(
              {
                type: "transfer-state-ready",
                transferId: callbacks.binding.transferId,
              },
              callbacks.binding.destinationWindowId,
            );
            restored = true;
            callbacks.onRestored();
          },
        } as ReturnType<typeof createWorkspaceTransferChannel>;
      }) satisfies typeof createWorkspaceTransferChannel,
    };
    const activate = vi.fn(async () => {
      if (returning && !restored) ready();
    });
    const transfer = detachWorkspaceEditors(
      {
        controller,
        windowId: source,
        paneId: "pane",
        returnToMain: returning,
        tabId: single ? "tasks" : undefined,
        title: "Mixed pane",
        surfaces: new Map([
          [
            "run",
            {
              kind: "terminal",
              entity: {
                id: "run-resource",
                projectId: "project",
                kind: "run-configuration",
              },
            } as ProjectSurface,
          ],
          [
            "file",
            {
              kind: "explorer",
              entity: {
                id: "editor",
                projectId: "project",
                activeWorkerId: "worker",
                worktreeId: "tree",
              },
            } as ProjectSurface,
          ],
        ]),
        explorers: new Map([["editor", lifecycle as never]]),
      },
      (input) => detachWorkspaceViews({ ...input, activate }, dependencies),
    );
    if (reject) {
      await expect(transfer).rejects.toThrow(
        "Transferred panel does not match its reservation",
      );
      expect(layout.windows.find((w) => w.id === source)!.panes[0]).toEqual(
        original,
      );
      expect(layout.pendingTransfers ?? []).toEqual([]);
      expect(restored).toBe(false);
      expect(retire).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(dependencies.destroyCancelled).toHaveBeenCalledOnce();
      return;
    }
    const destination = await transfer;
    expect(restored).toBe(true);
    expect(layout.pendingTransfers ?? []).toEqual([]);
    const moved = layout.windows.find((w) => w.id === destination)!.panes[0]!;
    const retained = layout.windows.find((w) => w.id === source)?.panes ?? [];
    if (single) {
      expect(moved.tabs).toEqual([original.tabs[0]]);
      expect(moved.activeTabId).toBe("tasks");
      expect(retained[0]!.tabs).toEqual(original.tabs.slice(1));
      expect(retained[0]!.activeTabId).toBe("history");
      expect(retire).not.toHaveBeenCalled();
    } else {
      expect(moved).toEqual(original);
      expect(retained).toEqual([]);
      expect(retire).toHaveBeenCalledOnce();
    }
    expect(release).not.toHaveBeenCalled();
    expect(dependencies.open).toHaveBeenCalledTimes(returning ? 0 : 1);
  },
);
