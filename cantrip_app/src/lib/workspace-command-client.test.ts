import {
  applyWorkspaceCommand,
  WorkspaceCommandError,
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
function open(): Extract<WorkspaceAction, { type: "open" }> {
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
      error === "conflict" ||
      (error instanceof WorkspaceCommandError && error.code === "revision")
        ? "conflict"
        : error === "rejected" || error instanceof WorkspaceCommandError
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

it.each(["success", "rejected"] as const)(
  "retains the legacy renderer until migration settles: %s",
  async (outcome) => {
    const { client, transport, server } = setup();
    const source = open();
    source.tab.resource = {
      kind: "entity",
      definitionId: "project.explorer",
      resourceId: "legacy",
    };
    source.tab.builtInState = null;
    await client.dispatch(source);
    const before = client.getSnapshot().projected;
    const gate = deferred<WorkspaceReceipt>();
    vi.mocked(transport.execute).mockImplementationOnce(() => gate.promise);
    const pending = client.dispatch({
      type: "migrate-explorer-file",
      tabId: "tab",
      explorerId: "legacy",
      expectedWorkerId: "worker",
      expectedWorktreeId: "worktree",
      expectedStateProtection: {
        classification: { recordKind: "explorer-state" },
        protectedState: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "A".repeat(16),
            ciphertext: "A".repeat(43),
          },
        },
      },
      documentId: "document",
      mode: "edit",
      retainedViews: [],
    });
    const failure = pending.catch((error) => error);
    expect(client.getSnapshot().projected).toEqual(before);
    await vi.waitFor(() => expect(transport.execute).toHaveBeenCalledTimes(2));
    if (outcome === "success") {
      gate.resolve(
        result(server(), vi.mocked(transport.execute).mock.calls[1]![0]),
      );
      await pending;
      expect(
        client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.resource
          .definitionId,
      ).toBe("project.file");
    } else {
      gate.reject("rejected");
      expect(await failure).toBe("rejected");
      expect(client.getSnapshot().projected).toEqual(before);
    }
  },
);

it.each(["success", "rejected", "uncertain"] as const)(
  "retains a reserved preview until replacement settles: %s",
  async (outcome) => {
    const { client, transport, server } = setup();
    const oldResource = {
      kind: "entity",
      definitionId: "project.file",
      resourceId: "old",
    } as const;
    await client.openResource(oldResource, { preview: true });
    const oldId = server().windows[0]!.panes[0]!.tabs[0]!.id;
    const gate = deferred<WorkspaceReceipt>();
    vi.mocked(transport.execute).mockImplementationOnce(() => gate.promise);
    const release = vi.fn();
    const reserve = vi.fn(() => release);
    const opening = client.openResource(
      { ...oldResource, resourceId: "new" },
      { preview: true, reservePreview: reserve },
    );
    const failed =
      outcome === "rejected" ? expect(opening).rejects.toBe("rejected") : null;
    expect(reserve).toHaveBeenCalledWith("old");
    expect(
      client
        .getSnapshot()
        .projected.windows[0]!.panes[0]!.tabs.map((t) => t.id),
    ).toEqual([oldId]);
    expect(release).not.toHaveBeenCalled();
    const sent = vi.mocked(transport.execute).mock.calls.at(-1)![0];
    if (outcome === "success") gate.resolve(result(server(), sent));
    else gate.reject(outcome);
    if (outcome === "uncertain") {
      await vi.waitFor(() =>
        expect(client.getSnapshot().error).toBe("uncertain"),
      );
      expect(release).not.toHaveBeenCalled();
      expect(
        client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.id,
      ).toBe(oldId);
      client.retry();
    }
    if (failed) await failed;
    else await opening;
    expect(release).toHaveBeenCalledOnce();
    expect(
      client.getSnapshot().projected.windows[0]!.panes[0]!.tabs,
    ).toHaveLength(1);
    expect(
      client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.resource,
    ).toEqual(
      outcome === "rejected"
        ? oldResource
        : { ...oldResource, resourceId: "new" },
    );
  },
);

it("releases the preview reservation when command construction throws", async () => {
  const { client, transport, server } = setup();
  const resource = {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "old",
  } as const;
  await client.openResource(resource, { preview: true });
  const before = structuredClone(server());
  const failure = new Error("ID allocation failed");
  const failingClient = new WorkspaceCommandClient(
    before,
    "main",
    0,
    transport,
    () => {
      throw failure;
    },
  );
  const release = vi.fn();
  const reserve = vi.fn(() => release);
  vi.mocked(transport.execute).mockClear();
  await expect(
    failingClient.openResource(
      { ...resource, resourceId: "new" },
      { preview: true, reservePreview: reserve },
    ),
  ).rejects.toBe(failure);
  expect(reserve).toHaveBeenCalledWith("old");
  expect(release).toHaveBeenCalledOnce();
  expect(transport.execute).not.toHaveBeenCalled();
  expect(failingClient.getSnapshot().projected).toEqual(before);
});

it("keeps an unreservable preview when opening another file", async () => {
  const { client } = setup();
  const resource = {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "old",
  } as const;
  await client.openResource(resource, { preview: true });
  await client.openResource(
    { ...resource, resourceId: "new" },
    { preview: true, reservePreview: () => null },
  );
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs,
  ).toHaveLength(2);
});

it("pins local file previews once while leaving remote views and focus untouched", async () => {
  const { client, transport, server, setServer } = setup();
  await client.openResource(
    { kind: "entity", definitionId: "project.file", resourceId: "file" },
    { preview: true },
  );
  const base = structuredClone(server());
  const local = base.windows[0]!;
  base.windows.push({
    ...structuredClone(local),
    id: "remote",
    panes: local.panes.map((pane) => ({
      ...structuredClone(pane),
      id: "remote-pane",
      activeTabId: "remote-tab",
      tabs: pane.tabs.map((tab) => ({ ...tab, id: "remote-tab" })),
    })),
    centerRoot: { kind: "pane", paneId: "remote-pane" },
    focusedPaneId: "remote-pane",
    recentPaneIds: ["remote-pane"],
    recentTabIds: ["remote-tab"],
  });
  base.revision++;
  setServer(base);
  await client.refresh();
  const focus = client.getSnapshot().projected.windows[0]!.focusedPaneId;
  const ack = deferred<WorkspaceReceipt>();
  vi.mocked(transport.execute).mockImplementationOnce((command) => {
    const receipt = result(server(), command);
    setServer(receipt.layout);
    return ack.promise;
  });
  const first = client.pinFilePreviews("file");
  await client.pinFilePreviews("file");
  expect(transport.execute).toHaveBeenCalledTimes(2); // open plus one pin
  expect(
    client.getSnapshot().projected.windows[0]!.panes[0]!.tabs[0]!.preview,
  ).toBe(false);
  expect(
    client.getSnapshot().projected.windows[1]!.panes[0]!.tabs[0]!.preview,
  ).toBe(true);
  const command = vi.mocked(transport.execute).mock.calls[1]![0];
  ack.resolve({
    layout: server(),
    operationId: command.operationId,
    appliedRevision: server().revision,
    replayed: false,
    focusWindowId: null,
    emptyWindowIds: [],
  });
  await first;
  expect(client.getSnapshot().authoritative.windows[0]!.focusedPaneId).toBe(
    focus,
  );
  await client.pinFilePreviews("missing-file");
  expect(transport.execute).toHaveBeenCalledTimes(2);
  client.dispose();
  await expect(client.pinFilePreviews("file")).rejects.toThrow("disposed");
});
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it("coalesces refresh reads and refuses to roll back a newer command receipt", async () => {
  const { client, transport } = setup();
  const read = deferred<WorkspaceOwnership>();
  vi.mocked(transport.read).mockReturnValueOnce(read.promise);
  const first = client.refresh();
  expect(client.refresh()).toBe(first);
  await tick();
  expect(transport.read).toHaveBeenCalledOnce();
  await client.dispatch(open());
  const before = client.getSnapshot();
  read.resolve(layout());
  await first;
  expect(client.getSnapshot()).toBe(before);
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!.id,
  ).toBe("tab");
  client.dispose();
});

it("retains layout and uncertain commands across failed observations", async () => {
  const { client, transport, server, setServer } = setup();
  await client.dispatch(open());
  vi.mocked(transport.execute).mockRejectedValueOnce("uncertain");
  const pending = client.dispatch({ type: "home" });
  await tick();
  const before = client.getSnapshot();
  vi.mocked(transport.read).mockRejectedValueOnce("offline");
  await expect(client.refresh()).rejects.toBe("offline");
  expect(client.getSnapshot()).toMatchObject({
    error: "uncertain",
    refreshError: "offline",
    pendingCount: 1,
    disposed: false,
  });
  expect(client.getSnapshot().authoritative).toBe(before.authoritative);
  setServer({ ...server(), revision: server().revision + 1 });
  await client.refresh();
  expect(client.getSnapshot().refreshError).toBeNull();
  expect(client.getSnapshot().error).toBe("uncertain");
  expect(transport.execute).toHaveBeenCalledTimes(2);
  const rejected = expect(pending).rejects.toThrow("disposed");
  client.dispose();
  await rejected;
});

it("fences a changed renderer generation discovered by refresh", async () => {
  const { client, setServer } = setup();
  const changed = layout();
  changed.revision = 1;
  changed.windows[0]!.attachmentGeneration = 1;
  setServer(changed);
  await expect(client.refresh()).rejects.toThrow("attachment changed");
  expect(client.getSnapshot().disposed).toBe(true);
});

it("routes selection through owned commands and avoids duplicate writes", async () => {
  const { client, transport } = setup();
  await client.dispatch(open());
  await client.openResource(
    {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "terminal",
    },
    { targetPaneId: "pane" },
  );
  await client.updateSelection((current) => ({
    ...current,
    activeTabByPane: { ...current.activeTabByPane, pane: "tab" },
  }));
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.activeTabId,
  ).toBe("tab");
  const count = vi.mocked(transport.execute).mock.calls.length;
  expect(await client.updateSelection((current) => current)).toBeNull();
  expect(transport.execute).toHaveBeenCalledTimes(count);
  await client.updateSelection((current) => ({
    ...current,
    destination: "overview",
    focusedPaneId: null,
  }));
  expect(
    client.getSnapshot().authoritative.windows[0]!.focusedPaneId,
  ).toBeNull();
  client.dispose();
});

it("rejects foreign or stale selections without changing authoritative focus", async () => {
  const { client, transport } = setup();
  await client.dispatch(open());
  await expect(
    client.updateSelection((current) => ({ ...current, projectId: "other" })),
  ).rejects.toThrow("another project");
  await expect(
    client.updateSelection((current) => ({
      ...current,
      activeTabByPane: { pane: "missing" },
    })),
  ).rejects.toThrow("does not belong");
  expect(transport.execute).toHaveBeenCalledTimes(1);
  await client.openResource(
    {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "terminal",
    },
    { targetPaneId: "pane" },
  );
  await client.dispatch({ type: "close-tab", tabId: "tab" });
  expect(await client.updateSelection((current) => current)).toBeNull();
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.activeTabId,
  ).not.toBe("tab");
  client.dispose();
  await expect(client.updateSelection((current) => current)).rejects.toThrow(
    "disposed",
  );
});

it("opens resources with independent tab identity and focuses an existing view on repeat", async () => {
  const { client, transport } = setup();
  const resource = { kind: "builtin", definitionId: "project.tasks" } as const;
  const first = await client.openResource(resource);
  const tab = first.layout.windows[0]!.panes[0]!.tabs[0]!;
  expect(tab.id).not.toBe(resource.definitionId);
  expect(tab.resource).toEqual(resource);
  const second = await client.openResource(resource);
  expect(second.layout.windows[0]!.panes).toHaveLength(1);
  expect(second.layout.windows[0]!.panes[0]!.tabs).toEqual([tab]);
  expect(second.layout.windows[0]!.panes[0]!.activeTabId).toBe(tab.id);
  expect(transport.execute).toHaveBeenCalledTimes(2);
  client.dispose();
});

it("opens another resource in the requested local region without a legacy placement", async () => {
  const { client } = setup();
  await client.openResource({ kind: "builtin", definitionId: "project.tasks" });
  const result = await client.openResource(
    {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: "terminal-resource",
    },
    { targetRegion: "bottom" },
  );
  const pane = result.layout.windows[0]!.panes.find(
    (p) => p.region === "bottom",
  )!;
  expect(pane.tabs[0]!.resource).toEqual({
    kind: "entity",
    definitionId: "project.terminal",
    resourceId: "terminal-resource",
  });
  expect(pane.tabs[0]!.id).not.toBe("terminal-resource");
  client.dispose();
  await expect(
    client.openResource({ kind: "builtin", definitionId: "project.tasks" }),
  ).rejects.toThrow("disposed");
});

it("queues shell layout intent with stable generated identities across uncertain retries", async () => {
  const { client, transport } = setup();
  await client.dispatch(open());
  vi.mocked(transport.execute).mockRejectedValueOnce("uncertain");
  const moving = client.dispatchLayout({
    type: "move-member",
    tabKey: "tab",
    targetPaneId: null,
    targetMemberPosition: 0,
    targetRegion: "right",
    targetPanePosition: 0,
  });
  await tick();
  const sent = vi.mocked(transport.execute).mock.calls[1]![0];
  expect(sent.action).toMatchObject({
    type: "move-new-pane",
    tabId: "tab",
    region: "right",
    position: 0,
  });
  client.retry();
  await moving;
  expect(vi.mocked(transport.execute).mock.calls[2]![0]).toEqual(sent);
  expect(client.getSnapshot().authoritative.windows[0]!.panes[0]!.region).toBe(
    "right",
  );
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!.id,
  ).toBe("tab");
  client.dispose();
});

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

it("uses server rejection for a dependent intent whose prerequisite open was rejected", async () => {
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
  expect(transport.execute).toHaveBeenCalledTimes(2);
  expect(client.getSnapshot().projected.windows[0]!.panes).toEqual([]);
});

it("commits restored transfers when the destination update has not reached the source", async () => {
  const { client, transport, server, setServer } = setup();
  await client.dispatch(open());
  await client.dispatch({
    type: "prepare-detach",
    transferId: "transfer",
    paneId: "pane",
    tabId: "tab",
    destinationWindowId: "popout",
    destinationPaneId: "destination-pane",
  });
  for (const type of ["transfer-ready", "transfer-state-ready"] as const) {
    const receipt = result(server(), {
      operationId: type,
      projectId: "project",
      workspaceId: "workspace",
      windowId: "popout",
      attachmentGeneration: 0,
      expectedRevision: server().revision,
      action: { type, transferId: "transfer" },
    });
    setServer(receipt.layout);
  }
  expect(client.getSnapshot().authoritative.pendingTransfers?.[0]?.phase).toBe(
    "preparing",
  );
  const receipt = await client.dispatch({
    type: "commit-transfer",
    transferId: "transfer",
  });
  expect(transport.read).toHaveBeenCalledTimes(1);
  expect(receipt.layout.windows.find(({ id }) => id === "main")?.panes).toEqual(
    [],
  );
  expect(
    receipt.layout.windows.find(({ id }) => id === "popout")?.panes[0]?.tabs[0]
      ?.id,
  ).toBe("tab");
});

it("opens tab-free conversations and checkpoints replacement before changing ownership", async () => {
  const { client, transport } = setup();
  await client.openConversation("first");
  const first =
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.conversationView!;
  expect(client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs).toEqual(
    [],
  );
  const pending = deferred<() => void>();
  const checkpoint = vi.fn(() => pending.promise);
  const release = vi.fn();
  const replacement = client.openConversation("second", { checkpoint });
  expect(checkpoint).toHaveBeenCalledWith({
    tabId: first.id,
    chatId: "first",
    projectId: "project",
  });
  expect(transport.execute).toHaveBeenCalledTimes(1);
  expect(
    client.getSnapshot().projected.windows[0]!.panes[0]!.conversationView?.id,
  ).toBe(first.id);
  pending.resolve(release);
  await replacement;
  expect(release).toHaveBeenCalledTimes(1);
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.conversationView
      ?.resource,
  ).toMatchObject({ resourceId: "second" });
});

it("failed draft checkpoint retains the current conversation and sends no replacement", async () => {
  const { client, transport } = setup();
  await client.openConversation("first");
  const before = client.getSnapshot().authoritative;
  await expect(
    client.openConversation("second", {
      checkpoint: async () => {
        throw new Error("draft save failed");
      },
    }),
  ).rejects.toThrow("draft save failed");
  expect(client.getSnapshot().authoritative).toBe(before);
  expect(transport.execute).toHaveBeenCalledTimes(1);
});

it("does not overwrite a different conversation selected while a checkpoint is pending", async () => {
  const { client } = setup();
  await client.openConversation("first");
  const pending = deferred<() => void>();
  const replacement = client.openConversation("second", {
    checkpoint: () => pending.promise,
  });
  await client.openConversation("intervening");
  const release = vi.fn();
  pending.resolve(release);
  await expect(replacement).rejects.toThrow("Conversation selection changed");
  expect(release).toHaveBeenCalledTimes(1);
  expect(
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.conversationView
      ?.resource,
  ).toMatchObject({ resourceId: "intervening" });
});

it("emits Agent activation for deliberate navigation but not passive observations or view closure", async () => {
  const { client } = setup();
  const activated = vi.fn();
  const unsubscribe = client.subscribeAgentActivation(activated);
  await client.openConversation("chat-one");
  expect(activated).toHaveBeenLastCalledWith("chat-one");
  activated.mockClear();
  client.observe(client.getSnapshot().authoritative);
  await client.refresh();
  expect(activated).not.toHaveBeenCalled();
  await client.updateSelection((current) => current);
  expect(activated).not.toHaveBeenCalled();
  activated.mockClear();
  await client.dispatch(open());
  expect(activated).not.toHaveBeenCalled();
  const window = client.getSnapshot().projected.windows[0]!;
  const pane = window.panes.find((pane) => pane.conversationView)!;
  await client.dispatch({ type: "select", tabId: pane.conversationView!.id });
  expect(activated).toHaveBeenCalledExactlyOnceWith("chat-one");
  activated.mockClear();
  await client.dispatch({
    type: "close-conversation",
    viewId: pane.conversationView!.id,
  });
  expect(activated).not.toHaveBeenCalled();
  unsubscribe();
  await client.openConversation("chat-two");
  expect(activated).not.toHaveBeenCalled();
});

it.each(["center", "right", "bottom"] as const)(
  "places a direct conversation into the %s rail with its existing view identity",
  async (region) => {
    const { client } = setup();
    await client.openConversation("chat");
    const before =
      client.getSnapshot().authoritative.windows[0]!.panes[0]!
        .conversationView!;
    const release = vi.fn();
    const checkpoint = vi.fn(async () => release);
    const transfer = vi.fn();
    await client.placeConversation(
      "chat",
      { region, position: 0 },
      { checkpoint, transfer },
    );
    const panes = client.getSnapshot().authoritative.windows[0]!.panes;
    expect(panes.flatMap((pane) => pane.tabs).map((tab) => tab.id)).toEqual([
      before.id,
    ]);
    expect(
      panes.find((pane) => pane.tabs.some((tab) => tab.id === before.id))
        ?.region,
    ).toBe(region);
    expect(panes.every((pane) => !pane.conversationView)).toBe(true);
    expect(checkpoint).toHaveBeenCalledWith({
      tabId: before.id,
      chatId: "chat",
      projectId: "project",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
  },
);
it("places a catalog-only conversation at the requested index without duplicating its resource", async () => {
  const { client } = setup();
  await client.dispatch(open());
  const options = {
    checkpoint: vi.fn(async () => () => {}),
    transfer: vi.fn(),
  };
  await client.placeConversation(
    "chat",
    { paneId: "pane", region: "center", position: 0 },
    options,
  );
  const first =
    client.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!;
  expect(first.resource).toEqual({
    kind: "entity",
    definitionId: "project.agent",
    resourceId: "chat",
  });
  await client.placeConversation(
    "chat",
    { paneId: "pane", region: "center", position: 2 },
    options,
  );
  expect(
    client
      .getSnapshot()
      .authoritative.windows[0]!.panes[0]!.tabs.map((tab) => tab.id),
  ).toEqual(["tab", first.id]);
});
it("retains direct ownership when placement checkpoint fails", async () => {
  const { client } = setup();
  await client.openConversation("chat");
  const before = structuredClone(client.getSnapshot().authoritative);
  await expect(
    client.placeConversation(
      "chat",
      { region: "bottom" },
      {
        checkpoint: async () => {
          throw new Error("Draft unavailable");
        },
        transfer: vi.fn(),
      },
    ),
  ).rejects.toThrow("Draft unavailable");
  expect(client.getSnapshot().authoritative).toEqual(before);
});

it("fences catalog-only placement after an awaited ownership refresh", async () => {
  const { client, transport } = setup();
  const options = {
    checkpoint: vi.fn(),
    transfer: vi.fn(),
    assertCurrent: () => {
      throw new Error("Account changed");
    },
  };
  await expect(
    client.placeConversation("chat", { region: "right" }, options),
  ).rejects.toThrow("Account changed");
  expect(transport.execute).not.toHaveBeenCalled();
});
