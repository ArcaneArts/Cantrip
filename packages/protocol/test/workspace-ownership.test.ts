import { describe, expect, it } from "vitest";
import {
  projectTabLayoutWireSummarySchema,
  seedWorkspaceOwnership,
  workspaceOwnershipSchema,
  type WorkspaceOwnership,
} from "../src/index.js";

const titleProtection = {
  classification: { recordKind: "terminal" as const },
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

function legacy() {
  const timestamp = "2026-10-23T00:00:00.000Z";
  return projectTabLayoutWireSummarySchema.parse({
    projectId: "project",
    revision: 19,
    panes: ["a", "b", "dock"].map((id, index) => ({
      id,
      projectId: "project",
      region: id === "dock" ? "right" : "center",
      position: index,
      anchorTabKey: `terminal:${id}-1`,
      titleProtection: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [1, 2].map((n, position) => ({
        tabKey: `terminal:${id}-${n}`,
        tabId: `${id}-${n}`,
        tabKind: "terminal",
        paneId: id,
        projectId: "project",
        position,
        titleProtection,
        createdAt: timestamp,
        updatedAt: timestamp,
        dockPresentation:
          id === "dock"
            ? {
                preferredMode: "split",
                splitFraction: 0.3,
                restoreFraction: 0.4,
              }
            : null,
      })),
    })),
    centerRoot: {
      kind: "split",
      id: "split",
      direction: "horizontal",
      fraction: 0.35,
      first: { kind: "pane", paneId: "a" },
      second: { kind: "pane", paneId: "b" },
    },
  });
}

function seed(workspaceId = "desktop") {
  return seedWorkspaceOwnership({
    workspaceId,
    mainWindowId: "main",
    legacy: legacy(),
    focusedPaneId: "b",
    activeTabByPane: { b: "terminal:b-2" },
  });
}

function detached() {
  const value = seed();
  const main = value.windows[0]!;
  const pane = main.panes.splice(1, 1)[0]!;
  main.centerRoot = { kind: "pane", paneId: "a" };
  main.focusedPaneId = "a";
  main.recentPaneIds = ["a"];
  value.windows.push({
    id: "popout",
    attachmentGeneration: 1,
    panes: [pane],
    centerRoot: { kind: "pane", paneId: "b" },
    focusedPaneId: "b",
    recentPaneIds: ["b"],
  });
  return value;
}

describe("workspace ownership contract", () => {
  it("represents a moved pane in exactly one window with stable tab identities", () => {
    const value = detached();
    expect(workspaceOwnershipSchema.parse(value)).toEqual(value);
    expect(value.windows[0]!.panes.map((pane) => pane.id)).toEqual([
      "a",
      "dock",
    ]);
    expect(value.windows[1]!.panes[0]!.tabs).toEqual(
      seed().windows[0]!.panes[1]!.tabs,
    );
  });

  it.each<[string, (value: WorkspaceOwnership) => void]>([
    [
      "duplicate windows",
      (value) => {
        value.windows[1]!.id = "main";
      },
    ],
    [
      "duplicate panes across windows",
      (value) => {
        value.windows[1]!.panes.push(value.windows[0]!.panes[0]!);
      },
    ],
    [
      "duplicate tabs across panes",
      (value) => {
        value.windows[1]!.panes[0]!.tabs.push(
          value.windows[0]!.panes[0]!.tabs[0]!,
        );
      },
    ],
    [
      "cross-window focus",
      (value) => {
        value.windows[0]!.focusedPaneId = "b";
      },
    ],
    [
      "cross-window history",
      (value) => {
        value.windows[0]!.recentPaneIds.push("b");
      },
    ],
    [
      "duplicate recent panes",
      (value) => {
        value.windows[0]!.recentPaneIds.push("a");
      },
    ],
    [
      "nonmember active tab",
      (value) => {
        value.windows[0]!.panes[0]!.activeTabId = "missing";
      },
    ],
    [
      "cross-window tree leaf",
      (value) => {
        value.windows[0]!.centerRoot = { kind: "pane", paneId: "b" };
      },
    ],
    [
      "dock pane in center tree",
      (value) => {
        value.windows[0]!.centerRoot = { kind: "pane", paneId: "dock" };
      },
    ],
    [
      "missing tree",
      (value) => {
        value.windows[0]!.centerRoot = null;
      },
    ],
    [
      "missing main window",
      (value) => {
        value.mainWindowId = "missing";
      },
    ],
    [
      "empty pane",
      (value) => {
        value.windows[0]!.panes[0]!.tabs = [];
      },
    ],
    [
      "negative attachment generation",
      (value) => {
        value.windows[0]!.attachmentGeneration = -1;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = detached();
    mutate(value);
    expect(workspaceOwnershipSchema.safeParse(value).success).toBe(false);
  });

  it("allows an explicitly separate view of the same resource without conflating identities", () => {
    const value = seed();
    const pane = value.windows[0]!.panes[0]!;
    pane.tabs.push({ ...pane.tabs[0]!, id: "explicit-new-view" });
    expect(workspaceOwnershipSchema.safeParse(value).success).toBe(true);
  });

  it("rejects plaintext content in the ownership transport", () => {
    const value = seed();
    Object.assign(value.windows[0]!.panes[0]!.tabs[0]!, {
      path: "/private/file",
      text: "unsaved text",
    });
    expect(workspaceOwnershipSchema.safeParse(value).success).toBe(false);
  });

  it("rejects repeated leaves and split identities", () => {
    const value = seed();
    const root = value.windows[0]!.centerRoot!;
    value.windows[0]!.centerRoot = {
      kind: "split",
      id: "split",
      direction: "vertical",
      fraction: 0.5,
      first: root,
      second: { kind: "pane", paneId: "a" },
    };
    const result = workspaceOwnershipSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Split identities must be unique.",
          "Tree leaves must reference each local center pane exactly once.",
        ]),
      );
    }
  });

  it("rejects entity views carrying built-in state", () => {
    const value = seed();
    value.windows[0]!.panes[0]!.tabs[0]!.builtInState = {
      definitionId: "project.tasks",
      worktreeId: null,
    };
    expect(workspaceOwnershipSchema.safeParse(value).success).toBe(false);
  });
});

describe("legacy workspace seeding", () => {
  it("preserves built-in references and worktree selection without manufacturing entities", () => {
    const source = legacy();
    const member = source.panes[0]!.members[0]!;
    member.tabKind = "builtin";
    member.tabId = "project.tasks";
    member.tabKey = "builtin:project:project.tasks";
    member.titleProtection = null;
    member.builtInState = {
      definitionId: "project.tasks",
      worktreeId: "worktree",
    };
    source.panes[0]!.anchorTabKey = member.tabKey;
    const value = seedWorkspaceOwnership({
      workspaceId: "desktop",
      mainWindowId: "main",
      legacy: source,
    });
    const tab = value.windows[0]!.panes[0]!.tabs[0]!;
    expect(tab.resource).toEqual({
      kind: "builtin",
      definitionId: "project.tasks",
    });
    expect(tab.builtInState).toEqual(member.builtInState);
    tab.builtInState!.definitionId = "git.history";
    expect(workspaceOwnershipSchema.safeParse(value).success).toBe(false);
  });

  it("rejects invalid legacy membership rather than silently dropping a view", () => {
    const source = legacy();
    source.panes[0]!.members[0]!.paneId = "other-pane";
    expect(() =>
      seedWorkspaceOwnership({
        workspaceId: "desktop",
        mainWindowId: "main",
        legacy: source,
      }),
    ).toThrow();
  });
  it("preserves order, split sizes, resources, protected titles, dock preferences and known selection", () => {
    const source = legacy();
    const value = seed();
    const main = value.windows[0]!;
    expect(main.centerRoot).toEqual(source.centerRoot);
    expect(main.panes.map((pane) => pane.id)).toEqual(["a", "b", "dock"]);
    expect(main.panes[0]!.tabs.map((tab) => tab.resource)).toEqual([
      { kind: "entity", definitionId: "project.terminal", resourceId: "a-1" },
      { kind: "entity", definitionId: "project.terminal", resourceId: "a-2" },
    ]);
    expect(main.panes[0]!.tabs[0]!.titleProtection).toEqual(titleProtection);
    expect(main.panes[2]!.tabs[0]!.dockPresentation).toEqual(
      source.panes[2]!.members[0]!.dockPresentation,
    );
    expect(main.focusedPaneId).toBe("b");
    expect(main.panes[1]!.activeTabId).toBe(main.panes[1]!.tabs[1]!.id);
    expect(main.panes[0]!.activeTabId).toBe(main.panes[0]!.tabs[0]!.id);
    expect(value.revision).toBe(0);
  });

  it("creates independent device views referencing the same resources", () => {
    const desktop = seed("desktop");
    const mobile = seed("mobile");
    expect(desktop.windows[0]!.panes[0]!.tabs[0]!.id).not.toBe(
      mobile.windows[0]!.panes[0]!.tabs[0]!.id,
    );
    expect(desktop.windows[0]!.panes[0]!.tabs[0]!.resource).toEqual(
      mobile.windows[0]!.panes[0]!.tabs[0]!.resource,
    );
    mobile.windows[0]!.panes[0]!.tabs.pop();
    expect(desktop.windows[0]!.panes[0]!.tabs).toHaveLength(2);
    expect(seed("desktop")).toEqual(desktop);
  });

  it("never overwrites an initialized workspace when the legacy layout changes", () => {
    const existing = detached();
    existing.revision = 3;
    const updatedLegacy = legacy();
    updatedLegacy.revision++;
    updatedLegacy.panes[0]!.members.pop();
    expect(
      seedWorkspaceOwnership({
        workspaceId: existing.id,
        mainWindowId: existing.mainWindowId,
        legacy: updatedLegacy,
        existing,
      }),
    ).toEqual(existing);
  });

  it.each(["workspace", "project", "main-window"])(
    "rejects accidental reseeding across %s identity",
    (kind) => {
      const source = legacy();
      if (kind === "project") source.projectId = "other";
      expect(() =>
        seedWorkspaceOwnership({
          workspaceId: kind === "workspace" ? "other" : "desktop",
          mainWindowId: kind === "main-window" ? "other" : "main",
          legacy: source,
          existing: seed(),
        }),
      ).toThrow(/Cannot seed/);
    },
  );

  it("supports an empty project without manufacturing panes", () => {
    const value = seedWorkspaceOwnership({
      workspaceId: "empty",
      mainWindowId: "main",
      legacy: {
        projectId: "project",
        revision: 0,
        panes: [],
        centerRoot: null,
      },
    });
    expect(value.windows[0]).toMatchObject({
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
  });

  it("does not mutate the source layout and drops stale focus hints", () => {
    const source = legacy();
    const before = structuredClone(source);
    const value = seedWorkspaceOwnership({
      workspaceId: "desktop",
      mainWindowId: "main",
      legacy: source,
      focusedPaneId: "gone",
      activeTabByPane: { a: "gone" },
    });
    expect(source).toEqual(before);
    expect(value.windows[0]!.focusedPaneId).toBeNull();
    expect(value.windows[0]!.panes[0]!.activeTabId).toBe(
      value.windows[0]!.panes[0]!.tabs[0]!.id,
    );
  });
});
