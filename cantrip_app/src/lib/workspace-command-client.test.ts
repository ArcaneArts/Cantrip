import {
  applyWorkspaceCommand,
  type WorkspaceAction,
  type WorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { expect, it, vi } from "vitest";
import {
  WorkspaceCommandClient,
  type WorkspaceReceipt,
  type WorkspaceTransport,
} from "./workspace-command-client";

function layout(): WorkspaceOwnership {
  return {
    version: 1,
    id: "workspace",
    projectId: "project",
    mainWindowId: "main",
    revision: 0,
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
}
function open(): WorkspaceAction {
  return {
    type: "open",
    tab: {
      id: "tab",
      resource: { kind: "builtin", definitionId: "project.tasks" },
      preview: true,
      titleProtection: null,
      dockPresentation: null,
      builtInState: { definitionId: "project.tasks", worktreeId: null },
    },
    target: {
      kind: "new-pane",
      paneId: "pane",
      region: "center",
      splitId: "split",
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function result(
  base: WorkspaceOwnership,
  command: WorkspaceCommand,
): WorkspaceReceipt {
  const next = applyWorkspaceCommand(base, command);
  return { ...next, appliedRevision: next.layout.revision, replayed: false };
}
function setup() {
  let server = layout();
  let serial = 0;
  const transport: WorkspaceTransport = {
    read: vi.fn(async () => structuredClone(server)),
    execute: vi.fn(async (command) => {
      const receipt = result(server, command);
      server = receipt.layout;
      return receipt;
    }),
    classify: (error) =>
      error === "conflict"
        ? "conflict"
        : error === "rejected"
          ? "rejected"
          : "uncertain",
  };
  const client = new WorkspaceCommandClient(
    server,
    "main",
    0,
    transport,
    () => `op-${++serial}`,
  );
  return {
    client,
    transport,
    server: () => server,
    setServer: (next: WorkspaceOwnership) => {
      server = next;
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it("projects immediately and serializes later operations against acknowledged revisions", async () => {
  const { client, transport, setServer } = setup();
  const first = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce(() => first.promise);
  const opened = client.dispatch(open());
  const pinned = client.dispatch({ type: "pin", tabId: "tab" });
  expect(
    client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.preview,
  ).toBe(false);
  expect(transport.execute).toHaveBeenCalledTimes(1);
  const committed = result(
    layout(),
    vi.mocked(transport.execute).mock.calls[0]![0],
  );
  setServer(committed.layout);
  first.resolve(committed);
  await opened;
  await pinned;
  expect(vi.mocked(transport.execute).mock.calls[1]![0].expectedRevision).toBe(
    1,
  );
  client.dispose();
});
it("commits open and pin with independent stable operation identities", async () => {
  const { client, transport } = setup();
  await client.dispatch(open());
  await client.dispatch({ type: "pin", tabId: "tab" });
  expect(client.getSnapshot().authoritative.revision).toBe(2);
  expect(client.getSnapshot().pendingCount).toBe(0);
  expect(
    vi.mocked(transport.execute).mock.calls.map(([c]) => c.operationId),
  ).toEqual(["op-1", "op-2"]);
});
it("ignores delayed old observations without removing pending intent", async () => {
  const { client } = setup();
  await client.dispatch(open());
  client.observe(layout());
  expect(client.getSnapshot().authoritative.revision).toBe(1);
  expect(client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.id).toBe(
    "tab",
  );
});
it("does not restore an old snapshot when a pending operation is rejected", async () => {
  const { client, transport } = setup();
  const request = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce(() => request.promise);
  const outcome = client.dispatch({ type: "home" }).catch((error) => error);
  const remote = { ...layout(), revision: 7 };
  client.observe(remote);
  request.reject("rejected");
  expect(await outcome).toBe("rejected");
  expect(client.getSnapshot().authoritative.revision).toBe(7);
  expect(client.getSnapshot().pendingCount).toBe(0);
});
it("retries exact sent bytes after a lost response even after newer observations", async () => {
  const { client, transport } = setup();
  vi.mocked(transport.execute).mockRejectedValueOnce(
    new Error("lost response"),
  );
  const outcome = client.dispatch(open());
  await tick();
  const sent = structuredClone(vi.mocked(transport.execute).mock.calls[0]![0]);
  const committed = result(layout(), sent);
  const newer = { ...committed.layout, revision: 5 };
  client.observe(newer);
  vi.mocked(transport.execute).mockResolvedValueOnce({
    ...committed,
    layout: newer,
    replayed: true,
  });
  client.retry();
  expect((await outcome).replayed).toBe(true);
  expect(vi.mocked(transport.execute).mock.calls[1]![0]).toEqual(sent);
  expect(client.getSnapshot().authoritative.revision).toBe(5);
});
it("rebases only after an explicit revision rejection", async () => {
  const { client, transport, setServer } = setup();
  setServer({ ...layout(), revision: 4 });
  vi.mocked(transport.execute).mockRejectedValueOnce("conflict");
  await client.dispatch(open());
  const [a, b] = vi.mocked(transport.execute).mock.calls.map(([c]) => c);
  expect(a!.operationId).toBe(b!.operationId);
  expect(b!.expectedRevision).toBe(4);
  expect(client.getSnapshot().authoritative.revision).toBe(5);
});
it("retains later intents when the uncertain head blocks delivery", async () => {
  const { client, transport } = setup();
  vi.mocked(transport.execute).mockRejectedValueOnce(new Error("offline"));
  const first = client.dispatch(open());
  const second = client.dispatch({ type: "pin", tabId: "tab" });
  await tick();
  expect(transport.execute).toHaveBeenCalledTimes(1);
  expect(client.getSnapshot().pendingCount).toBe(2);
  client.retry();
  await first;
  await second;
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!.preview,
  ).toBe(false);
});
it("bounds automatic revision retries and preserves intent for explicit retry", async () => {
  const { client, transport } = setup();
  vi.mocked(transport.execute).mockRejectedValue("conflict");
  const pending = client.dispatch(open()).catch((e) => e);
  await tick();
  await tick();
  expect(transport.execute).toHaveBeenCalledTimes(3);
  expect(client.getSnapshot().pendingCount).toBe(1);
  client.dispose("done");
  expect(await pending).toBe("done");
});
it("disposal rejects queued work and fences delayed acknowledgements", async () => {
  const { client, transport } = setup();
  const request = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce(() => request.promise);
  const outcome = client.dispatch(open()).catch((e) => e);
  const sent = vi.mocked(transport.execute).mock.calls[0]![0];
  client.dispose("signed out");
  expect(await outcome).toBe("signed out");
  request.resolve(result(layout(), sent));
  await tick();
  expect(client.getSnapshot().authoritative.revision).toBe(0);
  await expect(client.dispatch(open())).rejects.toThrow("disposed");
});
it("rejects observations from another workspace instead of adopting their state", async () => {
  const { client } = setup();
  client.observe({ ...layout(), id: "foreign", revision: 99 });
  expect(client.getSnapshot().authoritative.id).toBe("workspace");
  await expect(client.dispatch(open())).rejects.toThrow("disposed");
});
it("fences an observed replacement renderer generation", async () => {
  const { client } = setup();
  const next = layout();
  next.revision = 1;
  next.windows[0]!.attachmentGeneration = 1;
  client.observe(next);
  await expect(client.dispatch(open())).rejects.toThrow("disposed");
});
it("does not accept a receipt for another operation", async () => {
  const { client, transport } = setup();
  vi.mocked(transport.execute).mockImplementationOnce(async (command) => ({
    ...result(layout(), command),
    operationId: "other",
  }));
  const pending = client.dispatch(open()).catch((e) => e);
  await tick();
  expect(client.getSnapshot().authoritative.revision).toBe(0);
  expect(client.getSnapshot().pendingCount).toBe(1);
  client.dispose();
  await pending;
});

it("acknowledges delayed success without replaying stale window effects", async () => {
  const { client, transport } = setup();
  const request = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce(() => request.promise);
  const outcome = client.dispatch({ type: "home" });
  const sent = vi.mocked(transport.execute).mock.calls[0]![0];
  client.observe({ ...layout(), revision: 10 });
  request.resolve({
    ...result(layout(), sent),
    focusWindowId: "old-window",
    emptyWindowIds: ["old-window"],
  });
  const receipt = await outcome;
  expect(receipt.layout.revision).toBe(10);
  expect(receipt.appliedRevision).toBe(1);
  expect(receipt.focusWindowId).toBeNull();
  expect(receipt.emptyWindowIds).toEqual([]);
});

it("rejects a dependent intent when its prerequisite open was rejected", async () => {
  const { client, transport } = setup();
  const request = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce(() => request.promise);
  const opening = client.dispatch(open()).catch((e) => e);
  const pinning = client
    .dispatch({ type: "pin", tabId: "tab" })
    .catch((e) => e);
  request.reject("rejected");
  expect(await opening).toBe("rejected");
  expect(await pinning).toBeInstanceOf(Error);
  expect(transport.execute).toHaveBeenCalledTimes(1);
  expect(client.getSnapshot().projected.windows[0]!.panes).toEqual([]);
});
