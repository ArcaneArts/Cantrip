import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bootstrapWorkspace,
  type WorkspaceBootstrapDependencies,
} from "./workspace-bootstrap";
import { setClientSession, clearClientSession } from "./client-session";
import { emptyWorkspaceSelection } from "./workspace-selection";
import type {
  WorkspaceSeedRequest,
  WorkspaceOwnership,
} from "@cantrip/protocol";
import { WorkspaceCommandClient } from "./workspace-command-client";
import { WorkspaceWindowRetiredError } from "./workspace-renderer-attachment";

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
  let seed: WorkspaceSeedRequest | undefined;
  const dispose = vi.fn();
  const io = {
    retire: vi.fn(async (_windowId: string) => {}),
    renderer: vi.fn(async () => ({
      rendererId: "renderer",
      signal: new AbortController().signal,
    })),
    device: vi.fn(async () => ({
      workspaceId: "device-project",
      mainWindowId: "main",
    })),
    legacy: vi.fn(async () => ({ projectId: "p", panes: [{ id: "pane" }] })),
    detached: vi.fn(async () => [{ paneId: "pane", windowId: "native-pane" }]),
    connect: vi.fn(
      async (
        _p: string,
        _w: string,
        _window: string,
        prepare: () => Promise<WorkspaceSeedRequest>,
      ) => {
        seed = await prepare();
        const layout: WorkspaceOwnership = {
          version: 1,
          id: _w,
          projectId: _p,
          revision: 0,
          mainWindowId: "main",
          windows: [...new Set(["main", _window])].map((id) => ({
            id,
            attachmentGeneration: 0,
            panes: [],
            centerRoot: null,
            focusedPaneId: null,
            recentPaneIds: [],
          })),
        };
        const controller = new WorkspaceCommandClient(layout, _window, 0, {
          read: async () => layout,
          execute: async () => {
            throw new Error("unused");
          },
          classify: () => "rejected",
        });
        dispose.mockImplementation(() => controller.dispose());
        return { controller, dispose };
      },
    ),
  };
  return {
    io: io as unknown as WorkspaceBootstrapDependencies,
    mocks: io,
    dispose,
    seed: () => seed,
  };
}
it("imports actual native owners and current-project selection", async () => {
  const f = fixture();
  const result = await bootstrapWorkspace(
    "p",
    {
      ...emptyWorkspaceSelection("p"),
      destination: "surface",
      focusedPaneId: "pane",
      activeTabByPane: { pane: "tab" },
    },
    "native-pane",
    f.io,
  );
  expect(f.seed()).toEqual({
    mainWindowId: "main",
    detachedPanes: [{ paneId: "pane", windowId: "native-pane" }],
    focusedPaneId: "pane",
    activeTabByPane: { pane: "tab" },
  });
  expect(result.windowId).toBe("native-pane");
  expect(f.mocks.detached).toHaveBeenCalledWith(["pane"]);
  expect(result.presentation.getSnapshot().presentation?.layout.projectId).toBe(
    "p",
  );
  result.dispose();
  expect(result.presentation.getSnapshot().presentation).toBeNull();
  expect(result.controller.getSnapshot().disposed).toBe(true);
});
it.each(["native-pane", "main"])(
  "closes only an authoritatively retired popout (%s)",
  async (windowId) => {
    const f = fixture();
    f.mocks.connect.mockRejectedValue(
      new WorkspaceWindowRetiredError(windowId),
    );
    await expect(
      bootstrapWorkspace("p", emptyWorkspaceSelection("p"), windowId, f.io),
    ).rejects.toThrow("no longer belongs");
    expect(f.mocks.retire).toHaveBeenCalledTimes(windowId === "main" ? 0 : 1);
  },
);

it("does not close a window on an ordinary attachment read failure", async () => {
  const f = fixture();
  f.mocks.connect.mockRejectedValue(new Error("network unavailable"));
  await expect(
    bootstrapWorkspace("p", emptyWorkspaceSelection("p"), "native-pane", f.io),
  ).rejects.toThrow("network unavailable");
  expect(f.mocks.retire).not.toHaveBeenCalled();
});

it("does not import another project's selection", async () => {
  const f = fixture();
  const result = await bootstrapWorkspace(
    "p",
    emptyWorkspaceSelection("other"),
    undefined,
    f.io,
  );
  expect(result.windowId).toBe("main");
  expect(f.seed()).not.toHaveProperty("activeTabByPane");
  result.dispose();
});
it("propagates failed native observation without assuming no windows", async () => {
  const f = fixture();
  f.mocks.detached.mockRejectedValue(new Error("native observation failed"));
  await expect(
    bootstrapWorkspace("p", emptyWorkspaceSelection("p"), undefined, f.io),
  ).rejects.toThrow("native observation failed");
  expect(f.seed()).toBeUndefined();
});
it("does not connect under a new account after a delayed installation read", async () => {
  const f = fixture();
  f.mocks.device.mockImplementation(async () => {
    clearClientSession();
    return { workspaceId: "w", mainWindowId: "main" };
  });
  await expect(
    bootstrapWorkspace("p", emptyWorkspaceSelection("p"), undefined, f.io),
  ).rejects.toThrow("session changed");
  expect(f.mocks.connect).not.toHaveBeenCalled();
});
