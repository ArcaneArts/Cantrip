import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  useWorkspaceConnection,
  WORKSPACE_REFRESH_INTERVAL_MS,
} from "./use-workspace-connection";
import { clearClientSession, setClientSession } from "@/lib/client-session";
import {
  emptyWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";
import { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { WorkspacePresentationStore } from "@/lib/workspace-presentation-store";
import { WorkspaceRecoveryBanner } from "./workspace-recovery-banner";
import type { bootstrapWorkspace } from "@/lib/workspace-bootstrap";
import {
  applyWorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";

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

it("automatically replaces a disposed window attachment after the banner countdown", async () => {
  vi.useFakeTimers();
  const first = connection("a");
  const replacement = connection("a");
  const connect = vi
    .fn<typeof bootstrapWorkspace>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(replacement);
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const Probe = () => {
    current = useWorkspaceConnection(
      "a",
      emptyWorkspaceSelection("a"),
      undefined,
      connect,
    );
    return createElement(WorkspaceRecoveryBanner, { workspace: current });
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    await act(async () => first.controller.dispose());
    expect(current.controllerState?.disposed).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(current.connection).toBe(replacement);
    expect(current.controllerState?.disposed).toBe(false);
    expect(renderer!.toJSON()).toBeNull();
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    vi.useRealTimers();
  }
});

it("refreshes on interval, focus and reconnect, then removes observers on unmount", async () => {
  vi.useFakeTimers();
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  const active = connection("a");
  const refresh = vi.spyOn(active.controller, "refresh");
  const connect = vi.fn<typeof bootstrapWorkspace>().mockResolvedValue(active);
  const Probe = () => {
    useWorkspaceConnection(
      "a",
      emptyWorkspaceSelection("a"),
      undefined,
      connect,
    );
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_INTERVAL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      events.dispatchEvent(new Event("focus"));
      events.dispatchEvent(new Event("online"));
    });
    expect(refresh).toHaveBeenCalledTimes(3);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      events.dispatchEvent(new Event("focus"));
      events.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_INTERVAL_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

function connection(
  projectId: string,
): Awaited<ReturnType<typeof bootstrapWorkspace>> {
  let layout: WorkspaceOwnership = {
    version: 1,
    id: projectId,
    projectId,
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      },
    ],
  };
  const controller = new WorkspaceCommandClient(layout, "main", 0, {
    read: async () => layout,
    execute: async (command) => {
      const result = applyWorkspaceCommand(layout, command);
      layout = result.layout;
      return { ...result, appliedRevision: layout.revision, replayed: false };
    },
    classify: () => "rejected",
  });
  const presentation = new WorkspacePresentationStore(controller, "main");
  return {
    controller,
    presentation,
    windowId: "main",
    mainWindowId: "main",
    workspaceId: projectId,
    dispose: vi.fn(() => {
      presentation.dispose();
      controller.dispose();
    }),
  };
}
function deferred() {
  let resolve!: (value: Awaited<ReturnType<typeof bootstrapWorkspace>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof bootstrapWorkspace>>>(
    (yes) => {
      resolve = yes;
    },
  );
  return { promise, resolve };
}

it("disposes late bootstrap results and never exposes another project's connection", async () => {
  const first = deferred();
  const second = deferred();
  const connect = vi
    .fn<typeof bootstrapWorkspace>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const seen: (string | undefined)[] = [];
  const Probe = ({ project }: { project: string }) => {
    current = useWorkspaceConnection(
      project,
      emptyWorkspaceSelection(project),
      undefined,
      connect,
    );
    seen.push(current.connection?.workspaceId);
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, { project: "a" }));
  });
  await act(async () =>
    renderer.update(createElement(Probe, { project: "b" })),
  );
  const a = connection("a");
  const b = connection("b");
  await act(async () => {
    second.resolve(b);
    first.resolve(a);
  });
  expect(current.connection).toBe(b);
  expect(seen).not.toContain("a");
  expect(a.dispose).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
  expect(b.dispose).toHaveBeenCalledOnce();
});

it("projects owned selection and fences retained setters across project changes", async () => {
  const a = connection("a");
  const b = connection("b");
  const connect = vi
    .fn<typeof bootstrapWorkspace>()
    .mockImplementation(async (project) => (project === "a" ? a : b));
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const Probe = ({ project }: { project: string }) => {
    current = useWorkspaceConnection(
      project,
      emptyWorkspaceSelection(project),
      undefined,
      connect,
    );
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, { project: "a" }));
  });
  await act(async () => {
    await a.controller.openResource({
      kind: "builtin",
      definitionId: "project.tasks",
    });
  });
  expect(current.workspaceSelection.destination).toBe("surface");
  const activeTabByPane = current.workspaceSelection.activeTabByPane;
  await act(async () => {
    await current.setSelection((selection) => ({
      ...selection,
      destination: "overview",
      focusedPaneId: null,
    }));
  });
  expect(current.workspaceSelection).toMatchObject({
    projectId: "a",
    destination: "overview",
    activeTabByPane,
  });
  const oldSetter = current.setSelection;
  const oldRecovery = [
    current.retry,
    current.refresh,
    current.retryCommand,
    current.retryLabels,
  ];
  const oldRefresh = vi.spyOn(a.controller, "refresh");
  const oldRetry = vi.spyOn(a.controller, "retry");
  const oldLabels = vi.spyOn(a.presentation, "retryLabels");
  await act(async () => {
    renderer.update(createElement(Probe, { project: "b" }));
  });
  const update = vi.fn((selection: WorkspaceSelection) => selection);
  await expect(oldSetter(update)).rejects.toThrow("context changed");
  expect(update).not.toHaveBeenCalled();
  await act(async () => oldRecovery.forEach((recover) => recover()));
  expect(oldRefresh).not.toHaveBeenCalled();
  expect(oldRetry).not.toHaveBeenCalled();
  expect(oldLabels).not.toHaveBeenCalled();
  expect(current.workspaceSelection).toEqual(emptyWorkspaceSelection("b"));
  const beforeLogout = current.setSelection;
  await act(async () => clearClientSession());
  await expect(beforeLogout(update)).rejects.toThrow("context changed");
  expect(update).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

it("does not execute a selection update while initialization is pending", async () => {
  const pending = deferred();
  const connect = vi
    .fn<typeof bootstrapWorkspace>()
    .mockReturnValue(pending.promise);
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const Probe = () => {
    current = useWorkspaceConnection(
      "a",
      emptyWorkspaceSelection("a"),
      undefined,
      connect,
    );
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  const update = vi.fn((selection: WorkspaceSelection) => selection);
  await expect(current.setSelection(update)).rejects.toThrow("not ready");
  expect(update).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  const late = connection("a");
  await act(async () => pending.resolve(late));
  expect(late.dispose).toHaveBeenCalledOnce();
});

it("does not reconnect for selection changes or retry a healthy connection by replacing it", async () => {
  const active = connection("a");
  const connect = vi.fn<typeof bootstrapWorkspace>().mockResolvedValue(active);
  const retry = vi.spyOn(active.controller, "retry");
  const refresh = vi.spyOn(active.controller, "refresh");
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const Probe = ({ selection }: { selection: WorkspaceSelection }) => {
    current = useWorkspaceConnection("a", selection, undefined, connect);
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(Probe, { selection: emptyWorkspaceSelection("a") }),
    );
  });
  await act(async () =>
    renderer.update(
      createElement(Probe, {
        selection: {
          ...emptyWorkspaceSelection("a"),
          activeTabByPane: { pane: "tab" },
        },
      }),
    ),
  );
  await act(async () => current.refresh());
  expect(refresh).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  await act(async () => current.retryCommand());
  expect(retry).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => current.retry());
  expect(connect).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledTimes(2);
  await act(async () => clearClientSession());
  expect(current.connection).toBeUndefined();
  expect(current.presentation.presentation).toBeNull();
  expect(active.dispose).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});

it("reports an initialization failure and permits explicit retry without legacy fallback", async () => {
  const failure = new Error("Storage unavailable");
  const active = connection("a");
  const connect = vi
    .fn<typeof bootstrapWorkspace>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(active);
  let current!: ReturnType<typeof useWorkspaceConnection>;
  const Probe = () => {
    current = useWorkspaceConnection(
      "a",
      emptyWorkspaceSelection("a"),
      undefined,
      connect,
    );
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  expect(current.error).toBe(failure);
  expect(current.connection).toBeUndefined();
  expect(current.loading).toBe(false);
  await act(async () => current.retry());
  expect(current.connection).toBe(active);
  expect(current.error).toBeNull();
  await act(async () => renderer.unmount());
});
