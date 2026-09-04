import type { ProjectPaneRegion, ProjectPaneSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import {
  createKindsForPaneRegion,
  projectWorkspaceGridModel,
  partitionVisibleWorkspacePanes,
  railLauncherDisposition,
  responsiveProjectWorkspaceGridModel,
  visibleWorkspacePanes,
} from "./project-workspace-frame-model";

const timestamp = "2026-09-04T12:00:00.000Z";

function pane(
  id: string,
  region: ProjectPaneRegion,
  tabKey = `${id}:tab`,
): ProjectPaneSummary {
  return {
    id,
    projectId: "project-1",
    region,
    title: id,
    position: 0,
    anchorTabKey: tabKey,
    createdAt: timestamp,
    updatedAt: timestamp,
    members: [],
  };
}

function surface(tabKey: string): ProjectSurface {
  return { tabKey } as ProjectSurface;
}

function visible(
  panes: readonly ProjectPaneSummary[],
  options: {
    activeTabByPane?: Readonly<Record<string, string>>;
    centerRoot?: Parameters<typeof visibleWorkspacePanes>[0]["centerRoot"];
    focusedPaneId?: string | null;
    visiblePaneIdByRegion?: Readonly<
      Partial<Record<ProjectPaneRegion, string>>
    >;
  } = {},
) {
  return visibleWorkspacePanes({
    activeTabByPane: options.activeTabByPane ?? {},
    centerRoot: options.centerRoot,
    focusedPaneId: options.focusedPaneId ?? null,
    panes,
    surfaceByPaneId: new Map(
      panes.map((entry) => [
        entry.id,
        [surface(entry.anchorTabKey), surface(`${entry.id}:alternate`)],
      ]),
    ),
    visiblePaneIdByRegion: options.visiblePaneIdByRegion,
  });
}

describe("visible workspace panes", () => {
  it.each([
    {
      name: "center only",
      panes: [pane("center", "center")],
      expected: [["center", "center-body"]],
    },
    {
      name: "right only",
      panes: [pane("right", "right")],
      expected: [["right", "right-body"]],
    },
    {
      name: "bottom only",
      panes: [pane("bottom", "bottom")],
      expected: [["bottom", "bottom-body"]],
    },
    {
      name: "center, right, and bottom",
      panes: [
        pane("center", "center"),
        pane("right", "right"),
        pane("bottom", "bottom"),
      ],
      expected: [
        ["center", "center-body"],
        ["right", "right-body"],
        ["bottom", "bottom-body"],
      ],
    },
  ])("selects the $name topology", ({ panes, expected }) => {
    expect(
      visible(panes).map(({ gridArea, pane: entry }) => [entry.id, gridArea]),
    ).toEqual(expected);
  });

  it("keeps detached center, right, and bottom panes out of the live-owner set", () => {
    const presentations = visible([
      pane("center", "center"),
      pane("right", "right"),
      pane("bottom", "bottom"),
    ]);
    const ownership = partitionVisibleWorkspacePanes(
      presentations,
      (paneId) => paneId === "center" || paneId === "bottom",
    );

    expect(ownership.detached.map(({ pane: entry }) => entry.id)).toEqual([
      "center",
      "bottom",
    ]);
    expect(ownership.live.map(({ pane: entry }) => entry.id)).toEqual([
      "right",
    ]);
  });

  it("keeps the remembered pane visible in every region while another region is focused", () => {
    const panes = [
      pane("center-a", "center"),
      pane("center-b", "center"),
      pane("right-a", "right"),
      pane("bottom-a", "bottom"),
    ];

    expect(
      visible(panes, {
        focusedPaneId: "right-a",
        visiblePaneIdByRegion: {
          center: "center-b",
          bottom: "bottom-a",
        },
      }).map(({ focused, pane: entry }) => [entry.id, focused]),
    ).toEqual([
      ["center-a", false],
      ["center-b", false],
      ["right-a", true],
      ["bottom-a", false],
    ]);
  });

  it("uses a valid pane-local active tab and falls back to the anchor", () => {
    const panes = [pane("center", "center"), pane("right", "right")];

    expect(
      visible(panes, {
        activeTabByPane: {
          center: "center:alternate",
          right: "missing:tab",
        },
      }).map(({ activeTabKey }) => activeTabKey),
    ).toEqual(["center:alternate", "right:tab"]);
  });

  it("renders every recursive center leaf while retaining pane-local tabs", () => {
    const panes = [
      pane("left", "center"),
      pane("top-right", "center"),
      pane("bottom-right", "center"),
    ];
    expect(
      visible(panes, {
        activeTabByPane: { "top-right": "top-right:alternate" },
        centerRoot: {
          kind: "split",
          id: "root",
          direction: "horizontal",
          fraction: 0.6,
          first: { kind: "pane", paneId: "left" },
          second: {
            kind: "split",
            id: "right",
            direction: "vertical",
            fraction: 0.4,
            first: { kind: "pane", paneId: "top-right" },
            second: { kind: "pane", paneId: "bottom-right" },
          },
        },
      }).map(({ activeTabKey, pane: entry }) => [entry.id, activeTabKey]),
    ).toEqual([
      ["left", "left:tab"],
      ["top-right", "top-right:alternate"],
      ["bottom-right", "bottom-right:tab"],
    ]);
  });
});

describe("workspace region create capabilities", () => {
  it("offers only definitions that support the target region", () => {
    const centerAndDockKinds = new Set([
      "browser",
      "chat",
      "code",
      "explorer",
      "remote-desktop",
      "terminal",
    ]);
    expect(createKindsForPaneRegion("center")).toEqual(centerAndDockKinds);
    expect(createKindsForPaneRegion("right")).toEqual(centerAndDockKinds);
    expect(createKindsForPaneRegion("bottom")).toEqual(centerAndDockKinds);
    expect(createKindsForPaneRegion("left")).toEqual(new Set(["explorer"]));
  });
});

describe("workspace frame topology", () => {
  it.each([
    {
      center: true,
      right: false,
      bottom: false,
      area: "center-root",
      columns: "minmax(0, 1fr)",
    },
    {
      center: false,
      right: true,
      bottom: false,
      area: "right-body",
      columns: "minmax(0, 1fr)",
    },
    {
      center: false,
      right: false,
      bottom: true,
      area: "bottom-body",
      columns: "minmax(0, 1fr)",
    },
    {
      center: true,
      right: true,
      bottom: true,
      area: "bottom-body bottom-body bottom-body",
      columns: "minmax(0, calc(68% - 3px)) 6px minmax(0, calc(32% - 3px))",
    },
  ])(
    "lays out center=$center right=$right bottom=$bottom without residual tracks",
    ({ area, bottom, center, columns, right }) => {
      const model = projectWorkspaceGridModel({
        bottom,
        bottomFraction: 0.32,
        center,
        right,
        rightFraction: 0.32,
      });
      expect(model.gridTemplateAreas).toContain(area);
      expect(model.gridTemplateColumns).toBe(columns);
      expect(model.showRightDivider).toBe(center && right);
      expect(model.showBottomDivider).toBe(bottom && (center || right));
    },
  );

  it("measures the bottom dock against the full frame and spans every column", () => {
    const model = projectWorkspaceGridModel({
      bottom: true,
      bottomFraction: 0.32,
      center: true,
      right: true,
      rightFraction: 0.32,
    });
    expect(model.gridTemplateAreas).toContain(
      '"bottom-body bottom-body bottom-body"',
    );
    expect(model.gridTemplateRows).toContain("calc(32% - 43px)");
  });

  it("clamps a narrow three-pane workspace without rewriting saved desktop sizes", () => {
    const saved = Object.freeze({ bottom: 0.28, right: 0.36 });
    const mutation = { dock: 0, layout: 0 };

    const responsive = responsiveProjectWorkspaceGridModel({
      bottom: true,
      center: true,
      frameHeight: 320,
      frameWidth: 420,
      right: true,
      savedBottomFraction: saved.bottom,
      savedRightFraction: saved.right,
    });

    expect(responsive.bottomFraction).toBe(0.5);
    expect(responsive.rightFraction).toBe(0.5);
    expect(responsive.grid.visibleRegions).toEqual([
      "center",
      "right",
      "bottom",
    ]);
    expect(responsive.grid.gridTemplateAreas).toContain(
      '"bottom-body bottom-body bottom-body"',
    );
    expect(saved).toEqual({ bottom: 0.28, right: 0.36 });
    expect(mutation).toEqual({ dock: 0, layout: 0 });
  });

  it.each(["right", "bottom"] as const)(
    "renders only the %s pane in full mode with no residual split track",
    (fullRegion) => {
      const model = projectWorkspaceGridModel({
        bottom: true,
        bottomFraction: 0.32,
        center: true,
        fullRegion,
        right: true,
        rightFraction: 0.32,
      });
      expect(model.visibleRegions).toEqual([fullRegion]);
      expect(model.gridTemplateColumns).toBe("minmax(0, 1fr)");
      expect(model.gridTemplateRows).toBe("40px minmax(0, 1fr)");
      expect(model.showRightDivider).toBe(false);
      expect(model.showBottomDivider).toBe(false);
      expect(model.gridTemplateAreas).not.toContain("center");
      expect(model.gridTemplateAreas).not.toContain(
        fullRegion === "right" ? "bottom" : "right",
      );
    },
  );
});

describe("dock rail launchers", () => {
  const launcher = {
    id: "launcher:history",
    location: "right-rail",
    pinned: false,
    projectId: "project-1",
    target: { kind: "definition", definitionId: "git.history" },
  } as const;

  it("focuses an existing placement without moving it to the clicked rail", () => {
    expect(
      railLauncherDisposition(launcher, [
        {
          definition: { id: "git.history" },
          paneId: "center-pane",
          tabKey: "builtin:history",
        } as ProjectSurface,
      ]),
    ).toEqual({ type: "focus", tabKey: "builtin:history" });
  });

  it("opens a missing definition into the requested rail path", () => {
    expect(railLauncherDisposition(launcher, [])).toEqual({
      type: "open",
      definitionId: "git.history",
    });
  });
});
