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
