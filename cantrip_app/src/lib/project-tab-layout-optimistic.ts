import type {
  ProjectTabLayoutSummary,
  TabGroupSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { TabLayoutCommand } from "./workspace-dnd-model";

function inserted<T>(items: readonly T[], item: T, position: number): T[] {
  const next = [...items];
  next.splice(Math.max(0, Math.min(position, next.length)), 0, item);
  return next;
}

function positionedGroups(groups: readonly TabGroupSummary[]) {
  return groups.map((group, position) => ({
    ...group,
    position,
    members: group.members.map((member, memberPosition) => ({
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

export function applyOptimisticTabLayoutCommand(
  layout: ProjectTabLayoutSummary,
  command: TabLayoutCommand,
): ProjectTabLayoutSummary {
  if (command.type === "reorder-groups") {
    const byId = new Map(layout.groups.map((group) => [group.id, group]));
    return {
      ...layout,
      groups: positionedGroups(
        command.groupIds.flatMap((id) => {
          const group = byId.get(id);
          return group ? [group] : [];
        }),
      ),
    };
  }
  if (command.type === "reorder-members") {
    return {
      ...layout,
      groups: positionedGroups(
        layout.groups.map((group) => {
          if (group.id !== command.groupId) return group;
          const byKey = new Map(
            group.members.map((member) => [member.tabKey, member]),
          );
          return {
            ...group,
            members: command.tabKeys.flatMap((tabKey) => {
              const member = byKey.get(tabKey);
              return member ? [member] : [];
            }),
          };
        }),
      ),
    };
  }

  const sourceGroup = layout.groups.find(({ members }) =>
    members.some(({ tabKey }) => tabKey === command.tabKey),
  );
  const movedMember = sourceGroup?.members.find(
    ({ tabKey }) => tabKey === command.tabKey,
  );
  if (!sourceGroup || !movedMember) return layout;

  if (command.targetGroupId === null && sourceGroup.members.length === 1) {
    const remaining = layout.groups.filter(({ id }) => id !== sourceGroup.id);
    return {
      ...layout,
      groups: positionedGroups(
        inserted(remaining, sourceGroup, command.targetGroupPosition ?? 0),
      ),
    };
  }

  const sourceMembers = sourceGroup.members.filter(
    ({ tabKey }) => tabKey !== command.tabKey,
  );
  let groups = layout.groups.flatMap((group) => {
    if (group.id !== sourceGroup.id) return [group];
    if (sourceMembers.length === 0) return [];
    return [
      {
        ...group,
        ...(sourceMembers.length === 1
          ? { title: sourceMembers[0]!.title }
          : {}),
        anchorTabKey:
          group.anchorTabKey === command.tabKey
            ? sourceMembers[0]!.tabKey
            : group.anchorTabKey,
        members: sourceMembers,
      },
    ];
  });

  if (command.targetGroupId === null) {
    const groupId = `optimistic:${command.tabKey}`;
    groups = inserted(
      groups,
      {
        id: groupId,
        projectId: layout.projectId,
        title: movedMember.title,
        position: command.targetGroupPosition ?? groups.length,
        anchorTabKey: command.tabKey,
        members: [{ ...movedMember, groupId, position: 0 }],
        createdAt: movedMember.createdAt,
        updatedAt: movedMember.updatedAt,
      },
      command.targetGroupPosition ?? groups.length,
    );
  } else {
    groups = groups.map((group) =>
      group.id === command.targetGroupId
        ? {
            ...group,
            members: inserted(
              group.members,
              { ...movedMember, groupId: group.id },
              command.targetMemberPosition,
            ),
          }
        : group,
    );
  }
  return { ...layout, groups: positionedGroups(groups) };
}
