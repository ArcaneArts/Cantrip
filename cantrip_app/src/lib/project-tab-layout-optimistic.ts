import type {
  ProjectPaneRegion,
  ProjectPaneSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";

import {
  appendCenterPaneToRoot,
  removeCenterPaneFromRoot,
  replaceCenterLeafOrder,
  replaceCenterSplitFraction,
  splitCenterPaneRoot,
} from "@/components/app/center-split-layout";
import type { TabLayoutCommand } from "./workspace-dnd-model";

function inserted<T>(items: readonly T[], item: T, position: number): T[] {
  const next = [...items];
  next.splice(Math.max(0, Math.min(position, next.length)), 0, item);
  return next;
}

const paneRegionOrder: readonly ProjectPaneRegion[] = [
  "center",
  "right",
  "bottom",
  "left",
  "detached",
];

function insertedInRegion(
  panes: readonly ProjectPaneSummary[],
  pane: ProjectPaneSummary,
  position: number,
): ProjectPaneSummary[] {
  const regionIndexes = panes.flatMap((candidate, index) =>
    candidate.region === pane.region ? [index] : [],
  );
  const clampedPosition = Math.max(0, Math.min(position, regionIndexes.length));
  if (regionIndexes.length > 0) {
    const insertionIndex =
      regionIndexes[clampedPosition] ?? regionIndexes.at(-1)! + 1;
    return inserted(panes, pane, insertionIndex);
  }

  const regionRank = paneRegionOrder.indexOf(pane.region);
  const insertionIndex = panes.findIndex(
    (candidate) => paneRegionOrder.indexOf(candidate.region) > regionRank,
  );
  return inserted(
    panes,
    pane,
    insertionIndex === -1 ? panes.length : insertionIndex,
  );
}

function positionedPanes(panes: readonly ProjectPaneSummary[]) {
  const positions = new Map<string, number>();
  return panes.map((pane) => ({
    ...pane,
    position: (() => {
      const position = positions.get(pane.region) ?? 0;
      positions.set(pane.region, position + 1);
      return position;
    })(),
    members: pane.members.map((member, memberPosition) => ({
      ...member,
      position: memberPosition,
    })),
  }));
}

export interface OptimisticTabLayoutSnapshot {
  previous: ProjectTabLayoutSummary | undefined;
  queryKey: readonly ["project-tab-layout", string];
}

export function applyOptimisticTabLayoutToCache(
  queryClient: QueryClient,
  projectId: string,
  command: TabLayoutCommand,
): OptimisticTabLayoutSnapshot {
  const queryKey = ["project-tab-layout", projectId] as const;
  const previous = queryClient.getQueryData<ProjectTabLayoutSummary>(queryKey);
  if (previous) {
    queryClient.setQueryData<ProjectTabLayoutSummary>(
      queryKey,
      applyOptimisticTabLayoutCommand(previous, command),
    );
  }
  return { previous, queryKey };
}

export function restoreOptimisticTabLayoutCache(
  queryClient: QueryClient,
  snapshot: OptimisticTabLayoutSnapshot | undefined,
): void {
  if (!snapshot) return;
  queryClient.setQueryData(snapshot.queryKey, snapshot.previous);
}

export function removeProjectTabFromLayout(
  layout: ProjectTabLayoutSummary,
  tabKey: string,
): ProjectTabLayoutSummary {
  let removed = false;
  const removedCenterPaneIds: string[] = [];
  const panes = layout.panes.flatMap((pane) => {
    const members = pane.members.filter((member) => member.tabKey !== tabKey);
    if (members.length === pane.members.length) return [pane];
    removed = true;
    if (members.length === 0) {
      if (pane.region === "center") removedCenterPaneIds.push(pane.id);
      return [];
    }
    return [
      {
        ...pane,
        ...(members.length === 1 ? { title: members[0]!.title } : {}),
        anchorTabKey:
          pane.anchorTabKey === tabKey ? members[0]!.tabKey : pane.anchorTabKey,
        members,
      },
    ];
  });
  if (!removed) return layout;
  const centerRoot =
    layout.centerRoot === undefined
      ? undefined
      : removedCenterPaneIds.reduce(
          (root, paneId) => removeCenterPaneFromRoot(root, paneId),
          layout.centerRoot,
        );
  return {
    ...layout,
    ...(centerRoot === undefined ? {} : { centerRoot }),
    panes: positionedPanes(panes),
  };
}

export function applyOptimisticTabLayoutCommand(
  layout: ProjectTabLayoutSummary,
  command: TabLayoutCommand,
): ProjectTabLayoutSummary {
  if (command.type === "resize-center-split") {
    return layout.centerRoot
      ? {
          ...layout,
          centerRoot: replaceCenterSplitFraction(
            layout.centerRoot,
            command.splitId,
            command.fraction,
          ),
        }
      : layout;
  }
  if (command.type === "reorder-panes") {
    const byId = new Map(layout.panes.map((pane) => [pane.id, pane]));
    const reorderedRegion = command.paneIds.flatMap((id) => {
      const pane = byId.get(id);
      return pane && pane.region === command.region ? [pane] : [];
    });
    let regionIndex = 0;
    const panes = positionedPanes(
      layout.panes.map((pane) =>
        pane.region === command.region
          ? (reorderedRegion[regionIndex++] ?? pane)
          : pane,
      ),
    );
    return {
      ...layout,
      ...(command.region === "center" && layout.centerRoot
        ? {
            centerRoot: replaceCenterLeafOrder(
              layout.centerRoot,
              panes
                .filter(({ region }) => region === "center")
                .map(({ id }) => id),
            ),
          }
        : {}),
      panes,
    };
  }
  if (command.type === "reorder-members") {
    return {
      ...layout,
      panes: positionedPanes(
        layout.panes.map((pane) => {
          if (pane.id !== command.paneId) return pane;
          const byKey = new Map(
            pane.members.map((member) => [member.tabKey, member]),
          );
          return {
            ...pane,
            members: command.tabKeys.flatMap((tabKey) => {
              const member = byKey.get(tabKey);
              return member ? [member] : [];
            }),
          };
        }),
      ),
    };
  }

  const sourcePane = layout.panes.find(({ members }) =>
    members.some(({ tabKey }) => tabKey === command.tabKey),
  );
  const movedMember = sourcePane?.members.find(
    ({ tabKey }) => tabKey === command.tabKey,
  );
  if (!sourcePane || !movedMember) return layout;

  if (command.type === "split-member") {
    const targetPane = layout.panes.find(
      ({ id, region }) => id === command.targetPaneId && region === "center",
    );
    if (
      !targetPane ||
      !layout.centerRoot ||
      (sourcePane.id === targetPane.id && sourcePane.members.length === 1)
    ) {
      return layout;
    }
    const sourceMembers = sourcePane.members.filter(
      ({ tabKey }) => tabKey !== command.tabKey,
    );
    const paneId = `optimistic:pane:${command.tabKey}`;
    const panes = layout.panes.flatMap((pane) => {
      if (pane.id !== sourcePane.id) return [pane];
      if (sourceMembers.length === 0) return [];
      return [
        {
          ...pane,
          ...(sourceMembers.length === 1
            ? { title: sourceMembers[0]!.title }
            : {}),
          anchorTabKey:
            pane.anchorTabKey === command.tabKey
              ? sourceMembers[0]!.tabKey
              : pane.anchorTabKey,
          members: sourceMembers,
        },
      ];
    });
    const newPane: ProjectPaneSummary = {
      id: paneId,
      projectId: layout.projectId,
      title: movedMember.title,
      position: panes.filter(({ region }) => region === "center").length,
      region: "center",
      anchorTabKey: command.tabKey,
      members: [
        {
          ...movedMember,
          paneId,
          dockPresentation: null,
          position: 0,
        },
      ],
      createdAt: movedMember.createdAt,
      updatedAt: movedMember.updatedAt,
    };
    const rootWithoutEmptySource =
      sourceMembers.length === 0 && sourcePane.region === "center"
        ? removeCenterPaneFromRoot(layout.centerRoot, sourcePane.id)
        : layout.centerRoot;
    if (!rootWithoutEmptySource) return layout;
    return {
      ...layout,
      centerRoot: splitCenterPaneRoot(rootWithoutEmptySource, {
        edge: command.edge,
        fraction: command.fraction ?? 0.5,
        newPaneId: paneId,
        splitId: `optimistic:split:${command.tabKey}`,
        targetPaneId: command.targetPaneId,
      }),
      panes: positionedPanes([...panes, newPane]),
    };
  }

  if (command.targetPaneId === null && sourcePane.members.length === 1) {
    const remaining = layout.panes.filter(({ id }) => id !== sourcePane.id);
    const targetRegion = command.targetRegion ?? sourcePane.region;
    const movedPane = command.targetRegion
      ? {
          ...sourcePane,
          region: targetRegion,
          members: sourcePane.members.map((member) => ({
            ...member,
            dockPresentation:
              targetRegion === "center" ? null : member.dockPresentation,
          })),
        }
      : sourcePane;
    let centerRoot = layout.centerRoot;
    if (centerRoot !== undefined && sourcePane.region !== targetRegion) {
      if (sourcePane.region === "center") {
        centerRoot = removeCenterPaneFromRoot(centerRoot, sourcePane.id);
      }
      if (targetRegion === "center") {
        centerRoot = appendCenterPaneToRoot(
          centerRoot,
          sourcePane.id,
          `optimistic:split:${command.tabKey}`,
        );
      }
    }
    const panes = positionedPanes(
      insertedInRegion(remaining, movedPane, command.targetPanePosition ?? 0),
    );
    if (
      centerRoot &&
      sourcePane.region === "center" &&
      targetRegion === "center"
    ) {
      centerRoot = replaceCenterLeafOrder(
        centerRoot,
        panes.filter(({ region }) => region === "center").map(({ id }) => id),
      );
    }
    return {
      ...layout,
      ...(centerRoot === undefined ? {} : { centerRoot }),
      panes,
    };
  }

  const sourceMembers = sourcePane.members.filter(
    ({ tabKey }) => tabKey !== command.tabKey,
  );
  let panes = layout.panes.flatMap((pane) => {
    if (pane.id !== sourcePane.id) return [pane];
    if (sourceMembers.length === 0) return [];
    return [
      {
        ...pane,
        ...(sourceMembers.length === 1
          ? { title: sourceMembers[0]!.title }
          : {}),
        anchorTabKey:
          pane.anchorTabKey === command.tabKey
            ? sourceMembers[0]!.tabKey
            : pane.anchorTabKey,
        members: sourceMembers,
      },
    ];
  });

  if (command.targetPaneId === null) {
    const paneId = `optimistic:${command.tabKey}`;
    panes = insertedInRegion(
      panes,
      {
        id: paneId,
        projectId: layout.projectId,
        title: movedMember.title,
        position: command.targetPanePosition ?? panes.length,
        region: command.targetRegion ?? sourcePane.region,
        anchorTabKey: command.tabKey,
        members: [
          {
            ...movedMember,
            paneId,
            dockPresentation:
              (command.targetRegion ?? sourcePane.region) === "center"
                ? null
                : movedMember.dockPresentation,
            position: 0,
          },
        ],
        createdAt: movedMember.createdAt,
        updatedAt: movedMember.updatedAt,
      },
      command.targetPanePosition ?? panes.length,
    );
  } else {
    panes = panes.map((pane) =>
      pane.id === command.targetPaneId
        ? {
            ...pane,
            members: inserted(
              pane.members,
              {
                ...movedMember,
                paneId: pane.id,
                dockPresentation:
                  pane.region === "center"
                    ? null
                    : movedMember.dockPresentation,
              },
              command.targetMemberPosition,
            ),
          }
        : pane,
    );
  }
  let centerRoot = layout.centerRoot;
  if (
    centerRoot !== undefined &&
    sourceMembers.length === 0 &&
    sourcePane.region === "center"
  ) {
    centerRoot = removeCenterPaneFromRoot(centerRoot, sourcePane.id);
  }
  if (centerRoot !== undefined && command.targetPaneId === null) {
    const newPane = panes.find(
      ({ anchorTabKey }) => anchorTabKey === command.tabKey,
    );
    if (newPane?.region === "center") {
      centerRoot = appendCenterPaneToRoot(
        centerRoot,
        newPane.id,
        `optimistic:split:${command.tabKey}`,
      );
    }
  }
  const positioned = positionedPanes(panes);
  if (centerRoot && command.targetPaneId === null) {
    centerRoot = replaceCenterLeafOrder(
      centerRoot,
      positioned
        .filter(({ region }) => region === "center")
        .map(({ id }) => id),
    );
  }
  return {
    ...layout,
    ...(centerRoot === undefined ? {} : { centerRoot }),
    panes: positioned,
  };
}
