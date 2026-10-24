import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  type WorkspaceAction,
} from "@cantrip/protocol";
import { expect, it, vi } from "vitest";
import { detachWorkspaceViews } from "./workspace-transfer-source";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import type { createWorkspaceTransferChannel } from "./workspace-transfer-channel";

function setup(returning = false) {
  let layout = workspaceOwnershipSchema.parse({
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
        centerRoot: { kind: "pane", paneId: "pane" },
        panes: [
          {
            id: "pane",
            region: "center",
            titleProtection: null,
            activeTabId: "tab",
            tabs: [
              {
                id: "tab",
                preview: false,
                resource: { kind: "builtin", definitionId: "project.tasks" },
                titleProtection: null,
                builtInState: {
                  definitionId: "project.tasks",
                  worktreeId: null,
                },
                dockPresentation: null,
              },
            ],
          },
        ],
      },
    ],
  });
  const sourceWindowId = returning ? "popout" : "main";
  if (returning) {
    layout.windows[0]!.id = sourceWindowId;
    layout.windows.push({
      id: "main",
      attachmentGeneration: 0,
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
  }
  const events: string[] = [];
  const listeners = new Set<() => void>();
  let serial = 0;
  function apply(action: WorkspaceAction, windowId = sourceWindowId) {
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
  }
  const dispatch = vi.fn(async (action: WorkspaceAction) => {
    events.push(action.type);
    return apply(action);
  });
  const controller = {
    dispatch,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({ authoritative: layout, disposed: false }),
  } as unknown as Pick<
    WorkspaceCommandClient,
    "dispatch" | "getSnapshot" | "subscribe"
  >;
  let callbacks!: Extract<
    Parameters<typeof createWorkspaceTransferChannel>[0],
    { side: "source" }
  >;
  const bytes = new Uint8Array([12, 34]);
  const lease = {
    capture: vi.fn(async () => {
      events.push("capture");
      return bytes;
    }),
    retire: vi.fn(async () => {
      events.push("retire");
    }),
    resume: vi.fn(async () => {
      events.push("resume");
    }),
  };
  const input = {
    controller,
    windowId: sourceWindowId,
    returnToMain: returning,
    paneId: "pane",
    title: "Tasks",
    identity: { serverId: "server", ownerId: "owner" },
    prepare: vi.fn(async (_ids: readonly string[]) => {
      events.push("prepare");
      return lease;
    }),
    activate: vi.fn(async (_id: string) => {
      events.push("activate");
      if (returning && layout.pendingTransfers?.length) {
        apply(
          { type: "transfer-ready", transferId: callbacks.binding.transferId },
          "main",
        );
        callbacks.onReady();
      }
    }),
  };
  const channel = {
    dispose: vi.fn(),
    announceReady: vi.fn(async () => {}),
    resendSnapshot: vi.fn(),
    sendSnapshot: vi.fn(async () => {
      events.push("snapshot");
      apply(
        {
          type: "transfer-state-ready",
          transferId: callbacks.binding.transferId,
        },
        callbacks.binding.destinationWindowId,
      );
      callbacks.onRestored();
    }),
  };
  const dependencies = {
    allocateId: () => `identity-${++serial}`,
    watch: vi.fn(async (_id: string, _onClosed: () => void) => vi.fn()),
    open: vi.fn(async () => {
      events.push("open");
      apply(
        { type: "transfer-ready", transferId: callbacks.binding.transferId },
        callbacks.binding.destinationWindowId,
      );
      callbacks.onReady();
      return "created" as const;
    }),
    channel: ((options) => {
      if (options.side !== "source") throw new Error("Expected source");
      callbacks = options;
      return channel;
    }) satisfies typeof createWorkspaceTransferChannel,
  };
  return {
    input,
    dependencies,
    lease,
    events,
    bytes,
    channel,
    dispatch,
    layout: () => layout,
    apply,
    reject: (error: Error) => callbacks.onError(error),
    acknowledge: () => {
      apply(
        {
          type: "transfer-state-ready",
          transferId: callbacks.binding.transferId,
        },
        callbacks.binding.destinationWindowId,
      );
      callbacks.onRestored();
    },
  };
}

it("resumes a live return source after authoritative destination replacement", async () => {
  const f = setup(true);
  f.channel.sendSnapshot.mockImplementation(async () => {});
  const transfer = detachWorkspaceViews(f.input, f.dependencies);
  const outcome = expect(transfer).rejects.toThrow(
    "cancelled during attachment recovery",
  );
  await vi.waitFor(() => expect(f.channel.sendSnapshot).toHaveBeenCalledOnce());
  f.apply({ type: "replace-attachment", rendererId: "replacement" }, "main");
  await outcome;
  expect(f.lease.resume).toHaveBeenCalledOnce();
  expect(f.lease.retire).not.toHaveBeenCalled();
  expect(f.events).not.toContain("cancel-transfer");
  expect(
    f.layout().windows.find(({ id }) => id === "popout")!.panes[0]!.tabs[0]!.id,
  ).toBe("tab");
});

it("never resumes the old source after its attachment is replaced", async () => {
  const f = setup();
  f.channel.sendSnapshot.mockImplementation(async () => {});
  const transfer = detachWorkspaceViews(f.input, f.dependencies);
  const outcome = expect(transfer).rejects.toThrow(
    "source state remains retained",
  );
  await vi.waitFor(() => expect(f.channel.sendSnapshot).toHaveBeenCalledOnce());
  f.apply({ type: "replace-attachment", rendererId: "replacement" });
  await outcome;
  expect(f.lease.resume).not.toHaveBeenCalled();
  expect(f.lease.retire).not.toHaveBeenCalled();
});

it("returns a pane through the encrypted handshake without opening a new window", async () => {
  const f = setup(true);
  expect(await detachWorkspaceViews(f.input, f.dependencies)).toBe("main");
  expect(f.dependencies.open).not.toHaveBeenCalled();
  expect(f.events).toEqual([
    "prepare-return",
    "prepare",
    "activate",
    "capture",
    "snapshot",
    "retire",
    "commit-transfer",
    "activate",
  ]);
  expect(
    f.layout().windows.find(({ id }) => id === "main")!.panes[0]!.tabs[0]!.id,
  ).toBe("tab");
  expect(f.layout().windows.find(({ id }) => id === "popout")!.panes).toEqual(
    [],
  );
  expect(f.lease.resume).not.toHaveBeenCalled();
  expect([...f.bytes]).toEqual([0, 0]);
});

it("moves ownership only after exact snapshot acknowledgement and source retirement", async () => {
  const f = setup();
  const destination = await detachWorkspaceViews(f.input, f.dependencies);
  // Native capability matching uses this prefix; the unique identity is not
  // derived from the pane and therefore survives independent pane moves.
  expect(destination).toBe("cantrip-pane-workspace-identity-2");
  expect(f.events).toEqual([
    "prepare-detach",
    "prepare",
    "open",
    "capture",
    "snapshot",
    "retire",
    "commit-transfer",
    "activate",
  ]);
  expect(f.input.prepare).toHaveBeenCalledWith(["tab"]);
  expect(f.layout().windows.find(({ id }) => id === "main")?.panes).toEqual([]);
  expect(
    f.layout().windows.find(({ id }) => id === destination)?.panes[0]?.tabs[0]
      ?.id,
  ).toBe("tab");
  expect(f.bytes).toEqual(new Uint8Array(2));
  expect(f.channel.dispose).toHaveBeenCalledOnce();
});

it("cancels a failed native startup before resuming source inputs", async () => {
  const f = setup();
  f.dependencies.open.mockRejectedValueOnce(new Error("native startup failed"));
  await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
    "native startup failed",
  );
  expect(f.events).toEqual([
    "prepare-detach",
    "prepare",
    "cancel-transfer",
    "resume",
  ]);
  expect(f.layout().windows).toHaveLength(1);
  expect(f.lease.capture).not.toHaveBeenCalled();
});

it.each(["readiness", "restoration"] as const)(
  "recovers source ownership when the destination closes before %s",
  async (phase) => {
    const f = setup();
    const unwatch = vi.fn();
    let close!: () => void;
    f.dependencies.watch.mockImplementation(async (_id, onClosed) => {
      close = onClosed;
      if (phase === "readiness") close();
      return unwatch;
    });
    if (phase === "readiness")
      f.dependencies.open.mockImplementation(async () => "created");
    else f.channel.sendSnapshot.mockImplementation(async () => close());

    await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
      "destination window closed",
    );
    expect(f.layout().windows[0]!.panes[0]!.tabs[0]!.id).toBe("tab");
    expect(f.layout().pendingTransfers ?? []).toEqual([]);
    expect(f.lease.retire).not.toHaveBeenCalled();
    expect(f.events.slice(-2)).toEqual(["cancel-transfer", "resume"]);
    expect(unwatch).toHaveBeenCalledOnce();
    expect(f.channel.dispose).toHaveBeenCalledOnce();
  },
);

it("reports observer installation failure and cancels without assuming destination death", async () => {
  const f = setup();
  f.dependencies.watch.mockRejectedValue(
    new Error("native observation denied"),
  );
  await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
    "native observation denied",
  );
  expect(f.lease.resume).toHaveBeenCalledOnce();
  expect(f.lease.retire).not.toHaveBeenCalled();
  expect(f.layout().windows[0]!.panes[0]!.tabs[0]!.id).toBe("tab");
});

it("releases the native observer after commit without resurrecting source ownership", async () => {
  const f = setup(true);
  const unwatch = vi.fn();
  let closed!: () => void;
  f.dependencies.watch.mockImplementation(async (_id, onClosed) => {
    closed = onClosed;
    return unwatch;
  });
  await detachWorkspaceViews(f.input, f.dependencies);
  expect(f.dependencies.watch).toHaveBeenCalledWith(
    "main",
    expect.any(Function),
  );
  expect(unwatch).toHaveBeenCalledOnce();
  closed();
  expect(f.lease.resume).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "cancel-transfer" }),
  );
});

it("detaches only the requested inactive tab and leaves its selected sibling in place", async () => {
  const f = setup();
  const sourcePane = f.layout().windows[0]!.panes[0]!;
  sourcePane.tabs.push({ ...sourcePane.tabs[0]!, id: "inactive-tab" });
  const destination = await detachWorkspaceViews(
    { ...f.input, tabId: "inactive-tab" },
    f.dependencies,
  );
  expect(f.input.prepare).toHaveBeenCalledWith(["inactive-tab"]);
  const remaining = f.layout().windows.find(({ id }) => id === "main")!
    .panes[0]!;
  expect(remaining.tabs.map(({ id }) => id)).toEqual(["tab"]);
  expect(remaining.activeTabId).toBe("tab");
  const moved = f.layout().windows.find(({ id }) => id === destination)!
    .panes[0]!;
  expect(moved.id).not.toBe(remaining.id);
  expect(moved.tabs.map(({ id }) => id)).toEqual(["inactive-tab"]);
  expect(moved.activeTabId).toBe("inactive-tab");
});

it("does not resurrect source views when focusing the committed destination fails", async () => {
  const f = setup();
  f.input.activate.mockRejectedValueOnce(new Error("focus failed"));
  await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
    "focus failed",
  );
  expect(f.lease.resume).not.toHaveBeenCalled();
  expect(f.layout().windows[0]?.panes).toEqual([]);
  expect(f.events).not.toContain("cancel-transfer");
});

it("cancels destination rejection before resuming the retained source views", async () => {
  const f = setup();
  f.channel.sendSnapshot.mockImplementation(async () => {
    f.events.push("snapshot");
    f.reject(new Error("Destination could not restore the transferred views."));
  });
  await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
    /could not restore/,
  );
  expect(f.events).toEqual([
    "prepare-detach",
    "prepare",
    "open",
    "capture",
    "snapshot",
    "cancel-transfer",
    "resume",
  ]);
  expect(f.lease.retire).not.toHaveBeenCalled();
  expect(f.layout().windows).toHaveLength(1);
  expect(f.layout().windows[0]?.panes[0]?.tabs[0]?.id).toBe("tab");
  expect(f.bytes).toEqual(new Uint8Array(2));
  expect(f.channel.dispose).toHaveBeenCalledOnce();
});

it("retains suspended source state when cancellation cannot be confirmed", async () => {
  const f = setup();
  const original = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (action) => {
    if (action.type === "cancel-transfer")
      throw new Error("attachment revoked");
    return original(action);
  });
  f.dependencies.open.mockRejectedValueOnce(new Error("native startup failed"));
  await expect(detachWorkspaceViews(f.input, f.dependencies)).rejects.toThrow(
    /retained pending ownership recovery/,
  );
  expect(f.lease.resume).not.toHaveBeenCalled();
  expect(f.layout().pendingTransfers).toHaveLength(1);
});

it("keeps source ownership while the destination has not acknowledged the snapshot", async () => {
  const f = setup();
  let sent!: () => void;
  const snapshotSent = new Promise<void>((resolve) => {
    sent = resolve;
  });
  f.channel.sendSnapshot.mockImplementation(async () => {
    sent();
  });
  const transfer = detachWorkspaceViews(f.input, f.dependencies);
  await snapshotSent;
  expect(f.lease.retire).not.toHaveBeenCalled();
  expect(f.layout().windows[0]?.panes[0]?.tabs[0]?.id).toBe("tab");
  f.acknowledge();
  await transfer;
  expect(f.lease.retire).toHaveBeenCalledOnce();
});

it("allows explicit cancellation while waiting for destination readiness", async () => {
  const f = setup();
  const abort = new AbortController();
  f.dependencies.open.mockImplementation(async () => {
    abort.abort(new Error("user cancelled"));
    return "created";
  });
  await expect(
    detachWorkspaceViews({ ...f.input, signal: abort.signal }, f.dependencies),
  ).rejects.toThrow("user cancelled");
  expect(f.lease.resume).toHaveBeenCalledOnce();
  expect(f.lease.capture).not.toHaveBeenCalled();
  expect(f.layout().windows).toHaveLength(1);
});
