import { describe, expect, it } from "vitest";
import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  WorkspaceCommandError,
  workspaceActionSchema,
  type WorkspaceAction,
  type WorkspaceCommand,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "../src/index.js";

function tab(id: string): WorkspaceTab {
  return {
    id,
    resource: {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: `resource-${id}`,
    },
    titleProtection: null,
    preview: false,
    builtInState: null,
    dockPresentation: null,
  };
}
function fixture(): WorkspaceOwnership {
  return workspaceOwnershipSchema.parse({
    version: 1,
    id: "desktop",
    projectId: "project",
    revision: 4,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 2,
        panes: [
          {
            id: "a",
            region: "center",
            titleProtection: null,
            tabs: [tab("a1"), tab("a2"), tab("a3")],
            activeTabId: "a2",
          },
          {
            id: "b",
            region: "center",
            titleProtection: null,
            tabs: [tab("b1")],
            activeTabId: "b1",
          },
          {
            id: "dock",
            region: "right",
            titleProtection: null,
            tabs: [tab("d1")],
            activeTabId: "d1",
          },
        ],
        centerRoot: {
          kind: "split",
          id: "split-ab",
          direction: "horizontal",
          fraction: 0.35,
          first: { kind: "pane", paneId: "a" },
          second: { kind: "pane", paneId: "b" },
        },
        focusedPaneId: "a",
        recentPaneIds: ["a", "dock", "b"],
      },
      {
        id: "popout",
        attachmentGeneration: 3,
        panes: [
          {
            id: "p",
            region: "center",
            titleProtection: null,
            tabs: [tab("p1")],
            activeTabId: "p1",
          },
        ],
        centerRoot: { kind: "pane", paneId: "p" },
        focusedPaneId: "p",
        recentPaneIds: ["p"],
      },
    ],
  });
}

it.each([true, false])(
  "prepares a detach without moving source ownership (whole pane=%s)",
  (wholePane) => {
    const initial = fixture();
    const action: WorkspaceAction = {
      type: "prepare-detach",
      transferId: "transfer",
      paneId: "a",
      ...(wholePane ? {} : { tabId: "a2" }),
      destinationWindowId: "new-window",
      destinationPaneId: wholePane ? "a" : "new-pane",
    };
    const prepared = applyWorkspaceCommand(
      initial,
      command(initial, action),
    ).layout;
    expect(prepared.windows.slice(0, 2)).toEqual(initial.windows);
    expect(prepared.windows.at(-1)?.panes).toEqual([]);
    expect(prepared.pendingTransfers?.[0]).toMatchObject({
      phase: "preparing",
      tabIds: wholePane ? ["a1", "a2", "a3"] : ["a2"],
    });
    expect(() =>
      applyWorkspaceCommand(
        prepared,
        command(prepared, { type: "transfer-ready", transferId: "transfer" }),
      ),
    ).toThrow("Only the destination");
    const readyCommand = {
      ...command(prepared, { type: "transfer-ready", transferId: "transfer" }),
      windowId: "new-window",
      attachmentGeneration: 0,
    };
    const ready = applyWorkspaceCommand(prepared, readyCommand).layout;
    expect(ready.pendingTransfers?.[0]?.phase).toBe("destination-ready");
    expect(ready.windows[0]).toEqual(initial.windows[0]);
    expect(() =>
      applyWorkspaceCommand(ready, {
        ...readyCommand,
        expectedRevision: ready.revision,
        action: { type: "home" },
      }),
    ).toThrow("reserved");
    const cancelled = applyWorkspaceCommand(
      ready,
      command(ready, { type: "cancel-transfer", transferId: "transfer" }),
    ).layout;
    expect(cancelled.windows).toEqual(initial.windows);
    expect(cancelled.pendingTransfers).toEqual([]);
    expect(initial.pendingTransfers).toBeUndefined();
  },
);

it("rejects overlapping transfer reservations and stale destination generations", () => {
  const initial = fixture();
  const action: WorkspaceAction = {
    type: "prepare-detach",
    transferId: "transfer",
    paneId: "a",
    tabId: "a2",
    destinationWindowId: "new-window",
    destinationPaneId: "new-pane",
  };
  const prepared = applyWorkspaceCommand(
    initial,
    command(initial, action),
  ).layout;
  expect(() =>
    applyWorkspaceCommand(
      prepared,
      command(prepared, {
        ...action,
        transferId: "other",
        destinationWindowId: "other-window",
        destinationPaneId: "other-pane",
      }),
    ),
  ).toThrow("already in use");
  expect(() =>
    applyWorkspaceCommand(prepared, {
      ...command(prepared, { type: "transfer-ready", transferId: "transfer" }),
      windowId: "new-window",
      attachmentGeneration: 1,
    }),
  ).toThrow("renderer");
  expect(() =>
    applyWorkspaceCommand(
      prepared,
      command(prepared, {
        ...action,
        transferId: "other",
        tabId: "missing",
        destinationWindowId: "other-window",
      }),
    ),
  ).toThrow("source pane");
});

it.each(["main", "popout"])(
  "pins an existing preview in %s without replacing its identity",
  (ownerId) => {
    const initial = fixture();
    const owner = initial.windows.find((window) => window.id === ownerId)!;
    const original = owner.panes[0]!.tabs[0]!;
    original.preview = true;
    const opened = applyWorkspaceCommand(
      initial,
      command(initial, {
        type: "open",
        tab: { ...original, id: "unused-new-id", preview: false },
        target: { kind: "pane", paneId: "a" },
      }),
    );
    const surviving = opened.layout.windows.find(
      (window) => window.id === ownerId,
    )!.panes[0]!.tabs[0]!;
    expect(surviving.id).toBe(original.id);
    expect(surviving.preview).toBe(false);
    expect(
      opened.layout.windows
        .flatMap((window) => window.panes)
        .flatMap((pane) => pane.tabs)
        .some((tab) => tab.id === "unused-new-id"),
    ).toBe(false);
    const previewAgain = applyWorkspaceCommand(
      opened.layout,
      command(opened.layout, {
        type: "open",
        tab: { ...original, id: "another-unused-id", preview: true },
        target: { kind: "pane", paneId: "a" },
      }),
    );
    expect(
      previewAgain.layout.windows.find((window) => window.id === ownerId)!
        .panes[0]!.tabs[0]!.preview,
    ).toBe(false);
  },
);
function command(
  layout: WorkspaceOwnership,
  action: WorkspaceAction,
  windowId = "main",
): WorkspaceCommand {
  return {
    operationId: "operation",
    workspaceId: layout.id,
    projectId: layout.projectId,
    windowId,
    attachmentGeneration: layout.windows.find(
      (window) => window.id === windowId,
    )!.attachmentGeneration,
    expectedRevision: layout.revision,
    action,
  };
}
function run(action: WorkspaceAction, layout = fixture(), windowId = "main") {
  return applyWorkspaceCommand(layout, command(layout, action, windowId));
}

describe("prepared return to main", () => {
  const prepare: WorkspaceAction = {
    type: "prepare-return",
    transferId: "return",
    paneId: "p",
    splitId: "return-split",
  };
  function ready(layout: WorkspaceOwnership) {
    layout = run(
      { type: "transfer-ready", transferId: "return" },
      layout,
    ).layout;
    return run({ type: "transfer-state-ready", transferId: "return" }, layout)
      .layout;
  }
  it("keeps source ownership until ready and preserves main when cancelled", () => {
    const initial = fixture();
    const prepared = run(prepare, initial, "popout").layout;
    expect(prepared.windows).toEqual(initial.windows);
    expect(() =>
      run(
        { type: "commit-transfer", transferId: "return" },
        prepared,
        "popout",
      ),
    ).toThrow(/restoration/);
    const cancelled = run(
      { type: "cancel-transfer", transferId: "return" },
      prepared,
      "popout",
    );
    expect(cancelled.layout.windows).toEqual(initial.windows);
    expect(cancelled.emptyWindowIds).toEqual([]);
  });
  it("preserves concurrent main changes and appends only the surviving source pane", () => {
    let layout = run(prepare, fixture(), "popout").layout;
    layout = run({ type: "close-tab", tabId: "a1" }, layout).layout;
    const result = run(
      { type: "commit-transfer", transferId: "return" },
      ready(layout),
      "popout",
    );
    expect(result.layout.windows[0]!.panes.map(({ id }) => id)).toEqual([
      "a",
      "b",
      "dock",
      "p",
    ]);
    expect(
      result.layout.windows[0]!.panes[0]!.tabs.map(({ id }) => id),
    ).toEqual(["a2", "a3"]);
    expect(result.layout.windows[1]!.panes).toEqual([]);
    expect(result.emptyWindowIds).toEqual(["popout"]);
    expect(result.layout.pendingTransfers).toEqual([]);
  });
  it("returns a detached single tab to its surviving original pane", () => {
    const initial = fixture();
    initial.windows[1]!.returnPlacement = {
      detachedPaneId: "p",
      sourceWindowId: "main",
      sourcePaneId: "a",
      wholePane: false,
      sourcePlacement: {
        panePosition: 0,
        tabPosition: 1,
        region: "center",
        centerRoot: null,
      },
    };
    const result = run(
      { type: "commit-transfer", transferId: "return" },
      ready(run(prepare, initial, "popout").layout),
      "popout",
    );
    expect(
      result.layout.windows[0]!.panes[0]!.tabs.map(({ id }) => id),
    ).toEqual(["a1", "p1", "a2", "a3"]);
    expect(result.layout.windows[0]!.panes.map(({ id }) => id)).toEqual([
      "a",
      "b",
      "dock",
    ]);
  });
  it("rejects returning main to itself and rejects overlapping reservations", () => {
    expect(() => run({ ...prepare, paneId: "a" })).toThrow(/itself/);
    const prepared = run(prepare, fixture(), "popout").layout;
    expect(() =>
      run({ ...prepare, transferId: "other" }, prepared, "popout"),
    ).toThrow(/already in use/);
  });
});

describe("prepared ownership commit", () => {
  function prepare(wholePane = false) {
    return run({
      type: "prepare-detach",
      transferId: "transfer",
      paneId: "a",
      ...(wholePane ? {} : { tabId: "a2" }),
      destinationWindowId: "destination",
      destinationPaneId: wholePane ? "a" : "new-pane",
    }).layout;
  }
  function acknowledge(layout: WorkspaceOwnership) {
    const ready = run(
      { type: "transfer-ready", transferId: "transfer" },
      layout,
      "destination",
    ).layout;
    return run(
      { type: "transfer-state-ready", transferId: "transfer" },
      ready,
      "destination",
    ).layout;
  }
  const commit: WorkspaceAction = {
    type: "commit-transfer",
    transferId: "transfer",
  };

  it("moves recent ownership only at commit and records only the destination activation", () => {
    const prepared = prepare(true);
    prepared.windows[0]!.recentTabIds = ["a3", "d1", "a2", "a1"];
    const acknowledged = acknowledge(prepared);
    expect(acknowledged.windows[0]!.recentTabIds).toEqual([
      "a3",
      "d1",
      "a2",
      "a1",
    ]);
    const transferred = run(commit, acknowledged).layout;
    expect(transferred.windows[0]!.recentTabIds).toEqual(["d1"]);
    expect(
      transferred.windows.find(({ id }) => id === "destination")!.recentTabIds,
    ).toEqual(["a2"]);
    expect(
      transferred.windows.find(({ id }) => id === "popout")!.recentTabIds,
    ).toBeUndefined();
  });

  it("restores the original split geometry when returning an unchanged whole pane", () => {
    const originalTree = fixture().windows[0]!.centerRoot;
    let layout = run(commit, acknowledge(prepare(true))).layout;
    layout = run(
      {
        type: "prepare-return",
        transferId: "return",
        paneId: "a",
        splitId: "fallback",
      },
      layout,
      "destination",
    ).layout;
    layout = run(
      { type: "transfer-ready", transferId: "return" },
      layout,
    ).layout;
    layout = run(
      { type: "transfer-state-ready", transferId: "return" },
      layout,
    ).layout;
    const result = run(
      { type: "commit-transfer", transferId: "return" },
      layout,
      "destination",
    );
    expect(result.layout.windows[0]!.centerRoot).toEqual(originalTree);
    expect(result.layout.windows[0]!.panes.map(({ id }) => id)).toEqual([
      "a",
      "b",
      "dock",
    ]);
  });

  it.each([true, false])(
    "moves ownership atomically without changing tab identities (whole pane=%s)",
    (wholePane) => {
      const ready = acknowledge(prepare(wholePane));
      const before = structuredClone(ready);
      const result = run(commit, ready);
      expect(ready).toEqual(before);
      const source = result.layout.windows.find(({ id }) => id === "main")!;
      const destination = result.layout.windows.find(
        ({ id }) => id === "destination",
      )!;
      expect(destination.panes[0]!.tabs).toEqual(
        wholePane ? [tab("a1"), tab("a2"), tab("a3")] : [tab("a2")],
      );
      expect(destination.panes[0]!.id).toBe(wholePane ? "a" : "new-pane");
      expect(
        source.panes.find(({ id }) => id === "a")?.tabs.map(({ id }) => id),
      ).toEqual(wholePane ? undefined : ["a1", "a3"]);
      expect(source.panes.find(({ id }) => id === "b")).toEqual(
        fixture().windows[0]!.panes[1],
      );
      expect(destination.returnPlacement?.sourcePaneId).toBe("a");
      expect(result.layout.pendingTransfers).toEqual([]);
      expect(result.focusWindowId).toBe("destination");
      expect(workspaceOwnershipSchema.safeParse(result.layout).success).toBe(
        true,
      );
      expect(() => run(commit, result.layout)).toThrow();
    },
  );

  it("requires application readiness before restored-state acknowledgement and commit", () => {
    const prepared = prepare();
    expect(() => run(commit, prepared)).toThrow(/restoration/);
    expect(() =>
      run(
        { type: "transfer-state-ready", transferId: "transfer" },
        prepared,
        "destination",
      ),
    ).toThrow(/application readiness/);
    const ready = run(
      { type: "transfer-ready", transferId: "transfer" },
      prepared,
      "destination",
    ).layout;
    expect(() => run(commit, ready)).toThrow(/restoration/);
    expect(() =>
      run({ type: "transfer-state-ready", transferId: "transfer" }, ready),
    ).toThrow(/Only the destination/);
    expect(() => run(commit, acknowledge(prepared), "popout")).toThrow(
      /Only the source/,
    );
  });

  it("does not regress restored state on a repeated application-ready acknowledgement", () => {
    const ready = acknowledge(prepare());
    const repeated = run(
      { type: "transfer-ready", transferId: "transfer" },
      ready,
      "destination",
    ).layout;
    expect(repeated.pendingTransfers?.[0]?.phase).toBe("state-ready");
    expect(() => run(commit, repeated)).not.toThrow();
  });

  it.each([true, false])(
    "does not resurrect a tab closed during transfer (whole pane=%s)",
    (wholePane) => {
      const ready = acknowledge(prepare(wholePane));
      const closed = run({ type: "close-tab", tabId: "a2" }, ready).layout;
      const before = structuredClone(closed);
      expect(() => run(commit, closed)).toThrow(/no longer belongs/);
      expect(closed).toEqual(before);
      const cancelled = run(
        { type: "cancel-transfer", transferId: "transfer" },
        closed,
      ).layout;
      expect(cancelled.windows.some(({ id }) => id === "destination")).toBe(
        false,
      );
      expect(cancelled.windows[0]!.panes[0]!.tabs.map(({ id }) => id)).toEqual([
        "a1",
        "a3",
      ]);
    },
  );
});

describe("window-local pane operations", () => {
  it("renames and resets only the owned pane using an opaque title", () => {
    const titleProtection = {
      classification: { recordKind: "tab-group" as const },
      protectedLabel: {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    const source = fixture();
    const named = run(
      { type: "rename-pane", paneId: "a", titleProtection },
      source,
    ).layout;
    expect(named.windows[0]!.panes[0]!.titleProtection).toEqual(
      titleProtection,
    );
    expect(named.windows[1]).toEqual(source.windows[1]);
    expect(
      run({ type: "rename-pane", paneId: "a", titleProtection: null }, named)
        .layout.windows[0]!.panes[0]!.titleProtection,
    ).toBeNull();
    expect(() =>
      run({ type: "rename-pane", paneId: "p", titleProtection }),
    ).toThrow(WorkspaceCommandError);
    expect(
      workspaceActionSchema.safeParse({
        type: "rename-pane",
        paneId: "a",
        title: "plaintext",
      }).success,
    ).toBe(false);
    expect(
      workspaceActionSchema.safeParse({
        type: "rename-pane",
        paneId: "a",
        titleProtection: {
          ...titleProtection,
          classification: { recordKind: "chat" },
        },
      }).success,
    ).toBe(false);
  });
  it("updates dock presentation without changing focus or other tabs", () => {
    const presentation = {
      preferredMode: "split" as const,
      splitFraction: 0.3,
      restoreFraction: 0.4,
    };
    const source = fixture();
    const updated = run(
      { type: "dock-presentation", tabId: "d1", presentation },
      source,
    ).layout;
    expect(updated.windows[0]!.panes[2]!.tabs[0]!.dockPresentation).toEqual(
      presentation,
    );
    expect(updated.windows[0]!.focusedPaneId).toBe("a");
    expect(updated.windows[0]!.panes[0]).toEqual(source.windows[0]!.panes[0]);
    expect(() =>
      run({ type: "dock-presentation", tabId: "a1", presentation }),
    ).toThrow(WorkspaceCommandError);
    expect(() =>
      run({ type: "dock-presentation", tabId: "p1", presentation }),
    ).toThrow(WorkspaceCommandError);
  });
  it("reorders center leaves without replacing split geometry or focus", () => {
    const source = fixture();
    const result = run(
      { type: "reorder-panes", region: "center", paneIds: ["b", "a"] },
      source,
    ).layout;
    expect(result.windows[0]!.panes.map((p) => p.id)).toEqual([
      "b",
      "a",
      "dock",
    ]);
    expect(result.windows[0]!.centerRoot).toEqual({
      ...source.windows[0]!.centerRoot!,
      first: { kind: "pane", paneId: "b" },
      second: { kind: "pane", paneId: "a" },
    });
    expect(result.windows[0]!.focusedPaneId).toBe("a");
    expect(result.windows[1]).toEqual(source.windows[1]);
    expect(source.windows[0]!.panes[0]!.id).toBe("a");
  });
  it.each([["a"], ["a", "a"], ["a", "p"], ["a", "dock"]])(
    "rejects incomplete, duplicate or foreign pane order %j",
    (...paneIds) => {
      expect(() =>
        run({ type: "reorder-panes", region: "center", paneIds }),
      ).toThrow(WorkspaceCommandError);
    },
  );
  it("moves a tab into a new dock pane without changing its identity or siblings", () => {
    const result = run({
      type: "move-new-pane",
      tabId: "a2",
      paneId: "new-dock",
      region: "right",
      position: 0,
      splitId: "unused",
    }).layout;
    const window = result.windows[0]!;
    expect(
      window.panes.find((p) => p.id === "a")!.tabs.map((t) => t.id),
    ).toEqual(["a1", "a3"]);
    expect(window.panes.find((p) => p.id === "a")!.activeTabId).toBe("a3");
    expect(
      window.panes.filter((p) => p.region === "right").map((p) => p.id),
    ).toEqual(["new-dock", "dock"]);
    expect(window.panes.find((p) => p.id === "new-dock")!.tabs).toEqual([
      tab("a2"),
    ]);
    expect(window.focusedPaneId).toBe("new-dock");
  });
  it("collapses an emptied source and inserts a new center leaf at the requested position", () => {
    const result = run({
      type: "move-new-pane",
      tabId: "b1",
      paneId: "new-center",
      region: "center",
      position: 0,
      splitId: "replacement",
    }).layout;
    expect(result.windows[0]!.panes.some((p) => p.id === "b")).toBe(false);
    expect(result.windows[0]!.centerRoot).toEqual({
      kind: "split",
      id: "replacement",
      direction: "horizontal",
      fraction: 0.5,
      first: { kind: "pane", paneId: "new-center" },
      second: { kind: "pane", paneId: "a" },
    });
  });
  it("rejects invalid insertion and duplicate pane identity atomically", () => {
    const source = fixture();
    const before = structuredClone(source);
    for (const change of [{ position: 3 }, { paneId: "p" }, { tabId: "p1" }]) {
      expect(() =>
        run(
          {
            type: "move-new-pane",
            tabId: "a2",
            paneId: "new",
            region: "right",
            position: 0,
            splitId: "new-split",
            ...change,
          },
          source,
        ),
      ).toThrow(WorkspaceCommandError);
      expect(source).toEqual(before);
    }
  });
});

describe("workspace command scope and atomicity", () => {
  it.each<[string, Partial<WorkspaceCommand>, string]>([
    ["another device", { workspaceId: "mobile" }, "scope"],
    ["another project", { projectId: "other" }, "scope"],
    ["stale revision", { expectedRevision: 3 }, "revision"],
    ["future revision", { expectedRevision: 5 }, "revision"],
    ["stale renderer", { attachmentGeneration: 1 }, "attachment"],
    ["unknown window", { windowId: "missing" }, "missing"],
  ])("rejects %s without changing the input", (_name, patch, code) => {
    const input = fixture();
    const before = structuredClone(input);
    expect(() =>
      applyWorkspaceCommand(input, {
        ...command(input, { type: "close-tab", tabId: "a2" }),
        ...patch,
      }),
    ).toThrow(expect.objectContaining({ code }));
    expect(input).toEqual(before);
  });

  it("advances one revision, returns the operation identity, and does not mutate its inputs", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = run({ type: "select", tabId: "b1" }, input);
    expect(result.layout.revision).toBe(5);
    expect(result.operationId).toBe("operation");
    expect(input).toEqual(before);
    expect(result.layout.windows[0]!.recentPaneIds).toEqual(["b", "a", "dock"]);
  });

  it.each<WorkspaceAction>([
    { type: "select", tabId: "p1" },
    { type: "close-tab", tabId: "p1" },
    { type: "close-pane", paneId: "p" },
    { type: "move", tabId: "a1", targetPaneId: "p", position: 0 },
    { type: "resize", splitId: "missing", fraction: 0.5 },
  ])("rejects a nonlocal or missing target for $type", (action) => {
    expect(() => run(action)).toThrow(WorkspaceCommandError);
  });

  it("does not leave partial edits when a generated identity conflicts", () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(() =>
      run(
        {
          type: "split",
          tabId: "a1",
          targetPaneId: "b",
          paneId: "p",
          splitId: "new-split",
          edge: "right",
          fraction: 0.5,
        },
        input,
      ),
    ).toThrow();
    expect(input).toEqual(before);
  });
});

describe("tab activation history", () => {
  it("records actual selection without changing tab order or other windows", () => {
    let layout = fixture();
    const other = structuredClone(layout.windows[1]);
    for (const tabId of ["a3", "a1", "a3"])
      layout = applyWorkspaceCommand(
        layout,
        command(layout, { type: "select", tabId }),
      ).layout;
    expect(layout.windows[0]!.recentTabIds).toEqual(["a3", "a1"]);
    expect(layout.windows[0]!.panes[0]!.tabs.map(({ id }) => id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(layout.windows[1]).toEqual(other);
    layout = applyWorkspaceCommand(
      layout,
      command(layout, {
        type: "reorder",
        paneId: "a",
        tabIds: ["a3", "a2", "a1"],
      }),
    ).layout;
    expect(layout.windows[0]!.recentTabIds).toEqual(["a3", "a1"]);
  });

  it("prunes inactive closed views without manufacturing an activation", () => {
    const layout = fixture();
    layout.windows[0]!.recentTabIds = ["d1", "a1", "a2"];
    const result = applyWorkspaceCommand(
      layout,
      command(layout, { type: "close-tab", tabId: "a1" }),
    ).layout;
    expect(result.windows[0]!.recentTabIds).toEqual(["d1", "a2"]);
    expect(result.windows[0]!.panes[0]!.activeTabId).toBe("a2");
  });

  it("records the adjacent replacement, not the MRU tab, after active close", () => {
    const layout = fixture();
    layout.windows[0]!.recentTabIds = ["a2", "d1", "a1"];
    const result = applyWorkspaceCommand(
      layout,
      command(layout, { type: "close-tab", tabId: "a2" }),
    ).layout;
    expect(result.windows[0]!.panes[0]!.activeTabId).toBe("a3");
    expect(result.windows[0]!.recentTabIds).toEqual(["a3", "d1", "a1"]);
  });

  it("does not infer tab history when reading legacy layouts", () => {
    expect(
      workspaceOwnershipSchema.parse(fixture()).windows[0]!.recentTabIds,
    ).toBeUndefined();
  });

  it.each([["a1", "a1"], ["p1"], ["missing"]])(
    "rejects duplicate or foreign recent entries %j",
    (...ids) => {
      const layout = fixture();
      layout.windows[0]!.recentTabIds = ids;
      expect(workspaceOwnershipSchema.safeParse(layout).success).toBe(false);
    },
  );
});

describe("close selection", () => {
  it("does not close an unrelated empty destination that may still be preparing a transfer", () => {
    const input = fixture();
    input.windows.push({
      id: "preparing",
      attachmentGeneration: 0,
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
    expect(
      run({ type: "close-tab", tabId: "a1" }, input).emptyWindowIds,
    ).toEqual([]);
  });
  it.each([
    ["a1", "a2"],
    ["a2", "a3"],
    ["a3", "a2"],
  ])("closing %s selects or retains %s", (tabId, expected) => {
    expect(
      run({ type: "close-tab", tabId }).layout.windows[0]!.panes[0]!
        .activeTabId,
    ).toBe(expected);
  });

  it("closing the active rightmost tab selects its left neighbor", () => {
    const input = fixture();
    input.windows[0]!.panes[0]!.activeTabId = "a3";
    expect(
      run({ type: "close-tab", tabId: "a3" }, input).layout.windows[0]!
        .panes[0]!.activeTabId,
    ).toBe("a2");
  });

  it("removes an empty pane and its split, then uses local focus history", () => {
    const result = run({ type: "close-pane", paneId: "a" });
    const main = result.layout.windows[0]!;
    expect(main.panes.map((pane) => pane.id)).toEqual(["b", "dock"]);
    expect(main.centerRoot).toEqual({ kind: "pane", paneId: "b" });
    expect(main.focusedPaneId).toBe("dock");
    expect(main.recentPaneIds).toEqual(["dock", "b"]);
    expect(result.layout.windows[1]).toEqual(fixture().windows[1]);
  });

  it("closing another pane preserves current focus", () => {
    expect(
      run({ type: "close-tab", tabId: "b1" }).layout.windows[0]!.focusedPaneId,
    ).toBe("a");
  });

  it("closing the final popout tab reports an empty window without resurrecting tabs in main", () => {
    const result = run({ type: "close-tab", tabId: "p1" }, fixture(), "popout");
    expect(result.emptyWindowIds).toEqual(["popout"]);
    expect(result.layout.windows[1]).toMatchObject({
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
    expect(result.layout.windows[0]).toEqual(fixture().windows[0]);
  });

  it("keeps the main window when its last pane closes", () => {
    let input = fixture();
    for (const paneId of ["a", "b", "dock"])
      input = run({ type: "close-pane", paneId }, input).layout;
    expect(input.windows[0]).toMatchObject({
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
    });
    expect(run({ type: "home" }, input).emptyWindowIds).toEqual([]);
  });
});

describe("ordinary tab and pane operations", () => {
  it("pins a preview without replacing its identity or resource", () => {
    const input = fixture();
    input.windows[0]!.panes[0]!.tabs[0]!.preview = true;
    expect(
      run({ type: "pin", tabId: "a1" }, input).layout.windows[0]!.panes[0]!
        .tabs[0],
    ).toEqual(tab("a1"));
  });

  it("reorders without changing selection", () => {
    const pane = run({
      type: "reorder",
      paneId: "a",
      tabIds: ["a3", "a1", "a2"],
    }).layout.windows[0]!.panes[0]!;
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["a3", "a1", "a2"]);
    expect(pane.activeTabId).toBe("a2");
  });

  it.each([
    ["a1", "a1", "a3"],
    ["a1", "a2"],
    ["a1", "a2", "missing"],
  ])("rejects an incomplete or duplicated order %j", (...tabIds) => {
    expect(() => run({ type: "reorder", paneId: "a", tabIds })).toThrow(
      WorkspaceCommandError,
    );
  });

  it("moves a view and removes its now-empty source pane without reminting the view", () => {
    const main = run({
      type: "move",
      tabId: "b1",
      targetPaneId: "a",
      position: 1,
    }).layout.windows[0]!;
    expect(main.panes.map((pane) => pane.id)).toEqual(["a", "dock"]);
    expect(main.panes[0]!.tabs.map((tab) => tab.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "a3",
    ]);
    expect(main.panes[0]!.tabs[1]).toEqual(tab("b1"));
    expect(main.panes[0]!.activeTabId).toBe("b1");
    expect(main.centerRoot).toEqual({ kind: "pane", paneId: "a" });
  });

  it("supports same-pane moves including a one-tab pane", () => {
    expect(
      run({
        type: "move",
        tabId: "a1",
        targetPaneId: "a",
        position: 2,
      }).layout.windows[0]!.panes[0]!.tabs.map((tab) => tab.id),
    ).toEqual(["a2", "a3", "a1"]);
    expect(
      run({ type: "move", tabId: "b1", targetPaneId: "b", position: 0 }).layout
        .windows[0]!.panes[1]!.tabs,
    ).toEqual([tab("b1")]);
    expect(() =>
      run({ type: "move", tabId: "b1", targetPaneId: "b", position: 1 }),
    ).toThrow(WorkspaceCommandError);
  });

  it.each(["left", "right", "top", "bottom"] as const)(
    "splits toward %s while preserving identity and existing topology",
    (edge) => {
      const main = run({
        type: "split",
        tabId: "a1",
        targetPaneId: "a",
        paneId: "new",
        splitId: "new-split",
        edge,
        fraction: 0.4,
      }).layout.windows[0]!;
      expect(main.panes.find((pane) => pane.id === "new")!.tabs).toEqual([
        tab("a1"),
      ]);
      expect(
        main.panes.find((pane) => pane.id === "a")!.tabs.map((tab) => tab.id),
      ).toEqual(["a2", "a3"]);
      expect(main.focusedPaneId).toBe("new");
      expect(main.centerRoot).toMatchObject({
        id: "split-ab",
        fraction: 0.35,
        first: {
          id: "new-split",
          fraction: 0.4,
          direction:
            edge === "left" || edge === "right" ? "horizontal" : "vertical",
          first: { paneId: edge === "left" || edge === "top" ? "new" : "a" },
        },
      });
    },
  );

  it("does not split away the target's only tab or split a dock target", () => {
    for (const targetPaneId of ["b", "dock"])
      expect(() =>
        run({
          type: "split",
          tabId: "b1",
          targetPaneId,
          paneId: "new",
          splitId: "new-split",
          edge: "right",
          fraction: 0.5,
        }),
      ).toThrow(WorkspaceCommandError);
  });

  it("resizes only the specified split", () => {
    expect(
      run({ type: "resize", splitId: "split-ab", fraction: 0.7 }).layout
        .windows[0]!.centerRoot,
    ).toMatchObject({ id: "split-ab", fraction: 0.7 });
    expect(() =>
      run({ type: "resize", splitId: "split-ab", fraction: 1 }),
    ).toThrow();
  });
});

describe("resource opening", () => {
  it("focuses an existing view without duplicating it or altering its metadata", () => {
    const duplicate = { ...tab("a2"), id: "new-view", preview: true };
    const result = run({
      type: "open",
      tab: duplicate,
      target: { kind: "pane", paneId: "b" },
    });
    expect(result.layout.windows[0]!.panes[0]!.tabs).toEqual(
      fixture().windows[0]!.panes[0]!.tabs,
    );
    expect(result.layout.windows[0]!.panes[1]!.tabs).toHaveLength(1);
  });

  it("requests focus of an existing other-window view instead of making a disabled local copy", () => {
    const result = run({
      type: "open",
      tab: { ...tab("p1"), id: "new-view" },
      target: { kind: "pane", paneId: "a" },
    });
    expect(result.focusWindowId).toBe("popout");
    expect(result.layout.windows[0]).toEqual(fixture().windows[0]);
    expect(result.layout.windows[1]!.panes[0]!.tabs).toEqual([tab("p1")]);
  });

  it("opens into an explicit pane with a stable supplied tab identity", () => {
    const pane = run({
      type: "open",
      tab: tab("new"),
      target: { kind: "pane", paneId: "a" },
    }).layout.windows[0]!.panes[0]!;
    expect(pane.tabs.at(-1)).toEqual(tab("new"));
    expect(pane.activeTabId).toBe("new");
  });

  it("creates an explicit center pane without leaving an unrepresented split slot", () => {
    const main = run({
      type: "open",
      tab: tab("new"),
      target: {
        kind: "new-pane",
        paneId: "new-pane",
        region: "center",
        splitId: "new-split",
      },
    }).layout.windows[0]!;
    expect(main.panes.at(-1)).toMatchObject({
      id: "new-pane",
      activeTabId: "new",
    });
    expect(main.centerRoot).toMatchObject({
      id: "new-split",
      first: fixture().windows[0]!.centerRoot,
      second: { kind: "pane", paneId: "new-pane" },
    });
  });
});
