import { workspaceOwnershipSchema } from "@cantrip/protocol";
import { expect, it, vi } from "vitest";
import {
  destinationTransferBinding,
  startWorkspaceTransferDestination,
} from "./workspace-transfer-destination";
import type { createWorkspaceTransferChannel } from "./workspace-transfer-channel";
import type { WorkspaceCommandClient } from "./workspace-command-client";

function fixture() {
  const window = {
    attachmentGeneration: 0,
    panes: [],
    centerRoot: null,
    focusedPaneId: null,
    recentPaneIds: [],
  };
  const layout = workspaceOwnershipSchema.parse({
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      { ...window, id: "main" },
      { ...window, id: "destination" },
    ],
    pendingTransfers: [
      {
        id: "transfer",
        sourceWindowId: "main",
        sourceGeneration: 0,
        sourcePaneId: "pane",
        sourcePlacement: {
          panePosition: 0,
          tabPosition: 0,
          region: "center",
          centerRoot: null,
        },
        tabIds: ["tab"],
        wholePane: true,
        destinationWindowId: "destination",
        destinationGeneration: 0,
        destinationPaneId: "pane",
        phase: "preparing",
      },
    ],
  });
  const target = {
    kind: "pane" as const,
    projectId: "project",
    paneId: "pane",
    activeTabKey: "tab",
    transfer: {
      id: "transfer",
      workspaceId: "workspace",
      windowId: "destination",
      generation: 0,
    },
  };
  const identity = { serverId: "server", ownerId: "owner" };
  return { layout, target, identity };
}

it("binds only the native destination's authoritative reservation", () => {
  const { layout, target, identity } = fixture();
  expect(
    destinationTransferBinding(layout, "destination", target, identity),
  ).toMatchObject({
    transferId: "transfer",
    sourceWindowId: "main",
    destinationWindowId: "destination",
  });
  expect(() =>
    destinationTransferBinding(layout, "main", target, identity),
  ).toThrow(/does not own/);
  target.transfer.generation++;
  expect(() =>
    destinationTransferBinding(layout, "destination", target, identity),
  ).toThrow(/does not own/);
});

function setup() {
  const f = fixture();
  const dispatch = vi.fn(async () => undefined);
  const controller = {
    getSnapshot: () => ({ authoritative: f.layout, disposed: false }),
    dispatch,
  } as unknown as Pick<WorkspaceCommandClient, "getSnapshot" | "dispatch">;
  let receiver!: Extract<
    Parameters<typeof createWorkspaceTransferChannel>[0],
    { side: "destination" }
  >;
  const channel = {
    dispose: vi.fn(),
    announceReady: vi.fn(async () => {}),
    sendSnapshot: vi.fn(async () => {}),
    resendSnapshot: vi.fn(async () => {}),
  };
  const factory: typeof createWorkspaceTransferChannel = (options) => {
    if (options.side !== "destination") throw new Error("Expected destination");
    receiver = options;
    return channel;
  };
  const restore = vi.fn(async (_bytes: Uint8Array) => {});
  const start = () =>
    startWorkspaceTransferDestination(
      {
        controller,
        windowId: "destination",
        target: f.target,
        identity: f.identity,
        restore,
        onError: vi.fn(),
      },
      factory,
    );
  return { ...f, dispatch, channel, restore, start, receiver: () => receiver };
}

it("records readiness before announcing, and stages state before acknowledging restoration", async () => {
  const f = setup();
  const destination = f.start();
  expect(f.channel.announceReady).not.toHaveBeenCalled();
  await destination.ready;
  expect(f.dispatch.mock.calls).toEqual([
    [{ type: "transfer-ready", transferId: "transfer" }],
  ]);
  await f.receiver().restore(new Uint8Array([1]));
  expect(f.restore).toHaveBeenCalledWith(new Uint8Array([1]));
  expect(f.dispatch.mock.calls.at(-1)).toEqual([
    { type: "transfer-state-ready", transferId: "transfer" },
  ]);
  destination.dispose();
});

it("does not acknowledge a reservation cancelled while staging state", async () => {
  const f = setup();
  f.restore.mockImplementation(async () => {
    f.layout.pendingTransfers = [];
  });
  const destination = f.start();
  await destination.ready;
  await expect(f.receiver().restore(new Uint8Array())).rejects.toThrow(
    /does not own/,
  );
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  destination.dispose();
});

it("closes its receiver when authoritative readiness fails", async () => {
  const f = setup();
  f.dispatch.mockRejectedValueOnce(new Error("rejected"));
  const destination = f.start();
  await expect(destination.ready).rejects.toThrow("rejected");
  expect(f.channel.dispose).toHaveBeenCalledOnce();
  expect(f.channel.announceReady).not.toHaveBeenCalled();
  await expect(f.receiver().restore(new Uint8Array())).rejects.toThrow(
    /disposed/,
  );
  expect(f.restore).not.toHaveBeenCalled();
});
