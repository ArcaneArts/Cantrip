import { randomUUID } from "node:crypto";

import type {
  ProjectBuiltInSurfaceDefinitionId,
  ProjectSurfaceLauncher,
  ProjectSurfaceLauncherPin,
  ProjectSurfaceDefinitionId,
  ProjectSurfaceResourceRef,
  ProjectSurfaceViewClose,
  ProjectSurfaceViewCloseResult,
  ProjectSurfaceViewOpen,
  ProjectSurfaceViewOpenResult,
  ProjectDockPresentationPreference,
  ProjectDockPresentationUpdate,
  ProjectTabKind,
  ProjectTabLayoutWireSummary,
  LegacyProjectTabLayoutWireSummary,
  ProjectTabMemberWireSummary,
  ProjectPaneRegion,
  ProjectCenterLayoutNode,
  ProjectCenterSplitResize,
  ProjectPaneMemberSplit,
  OrderedIds,
  EncryptedProjectPaneUpdate,
  ProjectPaneMemberMove,
  ProjectPaneMemberOrder,
  ProjectPaneOrder,
  WorkspaceLayoutProfile,
} from "@cantrip/protocol";
import {
  projectSurfaceTabKind,
  projectSurfaceViewId,
  workspaceLayoutProfilePlacement,
} from "@cantrip/protocol";
import {
  PROJECT_SURFACE_DEFINITIONS,
  projectCenterLayoutNodeSchema,
  projectBuiltinSurfaceDefinitionIdSchema,
  projectSurfaceLauncherId,
} from "@cantrip/protocol";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  appendCenterPaneLeaf,
  assertCenterLayoutExact,
  persistCenterLayoutRoot,
  readCenterLayoutRoot,
  removeCenterPaneFromLayout,
  replaceCenterLeafOrder,
  replaceCenterPaneWithSplit,
  resizeCenterSplit,
} from "./center-layouts.js";
import * as schema from "./schema.js";
import {
  TabLayoutConflictError,
  TabLayoutInvariantError,
} from "./tab-layout-errors.js";

export {
  TabLayoutConflictError,
  TabLayoutInvariantError,
} from "./tab-layout-errors.js";

type TabLayoutDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export type TabLayoutExecutor = Pick<
  TabLayoutDatabase,
  "delete" | "insert" | "select" | "update"
>;

function surfaceDefinitionIdForTab(
  tabKind: ProjectTabKind,
  tabId: string,
): ProjectSurfaceDefinitionId {
  switch (tabKind) {
    case "chat":
      return "project.agent";
    case "terminal":
      return "project.terminal";
    case "explorer":
      return "project.explorer";
    case "browser":
      return "project.browser";
    case "code":
      return "project.code";
    case "history":
      return "project.git-history";
    case "issues":
      return "project.github-issues";
    case "remote-desktop":
      return "project.remote-desktop";
    case "builtin":
      return projectBuiltinSurfaceDefinitionIdSchema.parse(tabId);
  }
}

function definitionForTab(
  tabKind: ProjectTabKind,
  tabId: string,
  definitionId = surfaceDefinitionIdForTab(tabKind, tabId),
): (typeof PROJECT_SURFACE_DEFINITIONS)[number] {
  const definition = PROJECT_SURFACE_DEFINITIONS.find(
    ({ id }) => id === definitionId,
  );
  if (!definition) {
    throw new TabLayoutInvariantError(
      `Surface definition ${definitionId} is unavailable.`,
    );
  }
  return definition;
}

async function suggestedPlacementForTab(
  database: TabLayoutExecutor,
  projectId: string,
  tabKind: ProjectTabKind,
  tabId: string,
  definitionId = surfaceDefinitionIdForTab(tabKind, tabId),
): Promise<ProjectPaneRegion> {
  const definition = definitionForTab(tabKind, tabId, definitionId);
  const rows = await database
    .select({ profile: schema.userSettings.workspaceLayoutProfile })
    .from(schema.projects)
    .innerJoin(
      schema.userSettings,
      eq(schema.userSettings.userId, schema.projects.ownerId),
    )
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  const profile = (rows[0]?.profile ?? "hybrid") as WorkspaceLayoutProfile;
  return workspaceLayoutProfilePlacement(profile, definition.id);
}

function assertTabSupportsRegion(
  tabKind: ProjectTabKind,
  tabId: string,
  region: ProjectPaneRegion,
  definitionId = surfaceDefinitionIdForTab(tabKind, tabId),
): void {
  const definition = PROJECT_SURFACE_DEFINITIONS.find(
    ({ id }) => id === definitionId,
  );
  if (!definition?.supportedPlacements.includes(region)) {
    throw new TabLayoutInvariantError(
      `${definitionId} does not support the ${region} region.`,
    );
  }
}

function isSinglePaneDockRegion(
  region: ProjectPaneRegion,
): region is "right" | "bottom" {
  return region === "right" || region === "bottom";
}

const DEFAULT_DOCK_PRESENTATION = {
  preferredMode: "split",
  splitFraction: 0.32,
  restoreFraction: 0.32,
} as const satisfies ProjectDockPresentationPreference;

function dockPresentationKey(
  tabKey: string,
  region: ProjectPaneRegion,
): string {
  return `${region}:${tabKey}`;
}

async function panesInRegion(
  database: TabLayoutExecutor,
  projectId: string,
  region: ProjectPaneRegion,
) {
  return database
    .select()
    .from(schema.tabGroups)
    .where(
      and(
        eq(schema.tabGroups.projectId, projectId),
        eq(schema.tabGroups.region, region),
      ),
    )
    .orderBy(asc(schema.tabGroups.position), asc(schema.tabGroups.id));
}

function assertSingleDockPane(
  panes: Awaited<ReturnType<typeof panesInRegion>>,
  region: ProjectPaneRegion,
): void {
  if (isSinglePaneDockRegion(region) && panes.length > 1) {
    throw new TabLayoutInvariantError(
      `The ${region} dock contains more than one pane.`,
    );
  }
}

export function legacyTabLayoutFromPaneLayout(
  layout: ProjectTabLayoutWireSummary,
): LegacyProjectTabLayoutWireSummary {
  return {
    projectId: layout.projectId,
    revision: layout.revision,
    groups: layout.panes.map(({ region: _region, members, ...pane }) => ({
      ...pane,
      members: members.map(({ paneId, ...member }) => ({
        ...member,
        groupId: paneId,
      })),
    })),
  };
}

export function projectTabKey(
  kind: ProjectTabKind,
  tabId: string,
  projectId?: string,
): string {
  if (kind === "builtin") {
    if (!projectId) {
      throw new TabLayoutInvariantError(
        "A project id is required for a built-in surface.",
      );
    }
    const definitionId = projectBuiltinSurfaceDefinitionIdSchema.parse(tabId);
    return projectSurfaceViewId({
      projectId,
      resource: { kind: "builtin", definitionId },
    });
  }
  const prefix =
    kind === "history" || kind === "issues" || kind === "remote-desktop"
      ? "view"
      : kind;
  return `${prefix}:${tabId}`;
}

async function bumpRevision(
  database: TabLayoutExecutor,
  projectId: string,
): Promise<void> {
  await database
    .update(schema.projects)
    .set({
      tabLayoutRevision: sql`${schema.projects.tabLayoutRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.projects.id, projectId));
}

async function lockProjectLayout(
  database: TabLayoutExecutor,
  projectId: string,
): Promise<void> {
  const projects = await database
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .for("update")
    .limit(1);
  if (!projects[0]) {
    throw new TabLayoutInvariantError("The project no longer exists.");
  }
}

async function claimRevision(
  database: TabLayoutExecutor,
  ownerId: string,
  projectId: string,
  revision: number,
): Promise<void> {
  const claimed = await database
    .update(schema.projects)
    .set({
      tabLayoutRevision: sql`${schema.projects.tabLayoutRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.ownerId, ownerId),
        eq(schema.projects.tabLayoutRevision, revision),
      ),
    )
    .returning({ id: schema.projects.id });
  if (!claimed[0]) {
    throw new TabLayoutConflictError(
      "The project tab layout changed. Refresh it and try again.",
    );
  }
}

async function attachProjectTabPlacement(
  database: TabLayoutExecutor,
  input: {
    projectId: string;
    definitionId?: ProjectSurfaceDefinitionId;
    paneId?: string;
    region?: ProjectPaneRegion;
    tabId: string;
    tabKind: ProjectTabKind;
  },
): Promise<string> {
  const tabKey = projectTabKey(input.tabKind, input.tabId, input.projectId);
  let groupId = input.paneId;
  let memberPosition = 0;
  let createdCenterPane = false;

  if (groupId) {
    const groups = await database
      .select({ id: schema.tabGroups.id, region: schema.tabGroups.region })
      .from(schema.tabGroups)
      .where(
        and(
          eq(schema.tabGroups.id, groupId),
          eq(schema.tabGroups.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!groups[0]) {
      throw new TabLayoutInvariantError(
        "The destination pane does not belong to this project.",
      );
    }
    assertTabSupportsRegion(
      input.tabKind,
      input.tabId,
      groups[0].region,
      input.definitionId,
    );
    const positions = await database
      .select({ position: schema.tabGroupMembers.position })
      .from(schema.tabGroupMembers)
      .where(eq(schema.tabGroupMembers.groupId, groupId))
      .orderBy(desc(schema.tabGroupMembers.position))
      .limit(1);
    memberPosition = (positions[0]?.position ?? -1) + 1;
  } else {
    const region =
      input.region ??
      (await suggestedPlacementForTab(
        database,
        input.projectId,
        input.tabKind,
        input.tabId,
        input.definitionId,
      ));
    assertTabSupportsRegion(
      input.tabKind,
      input.tabId,
      region,
      input.definitionId,
    );
    const regionPanes = await panesInRegion(database, input.projectId, region);
    assertSingleDockPane(regionPanes, region);
    if (isSinglePaneDockRegion(region) && regionPanes[0]) {
      groupId = regionPanes[0].id;
      const positions = await database
        .select({ position: schema.tabGroupMembers.position })
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, groupId))
        .orderBy(desc(schema.tabGroupMembers.position))
        .limit(1);
      memberPosition = (positions[0]?.position ?? -1) + 1;
    } else {
      groupId = randomUUID();
      await database.insert(schema.tabGroups).values({
        id: groupId,
        projectId: input.projectId,
        region,
        position: (regionPanes.at(-1)?.position ?? -1) + 1,
        anchorTabKey: tabKey,
      });
      createdCenterPane = region === "center";
    }
  }

  await database.insert(schema.tabGroupMembers).values({
    tabKey,
    groupId,
    projectId: input.projectId,
    tabKind: input.tabKind,
    tabId: input.tabId,
    position: memberPosition,
  });
  if (createdCenterPane) {
    await appendCenterPaneLeaf(database, input.projectId, groupId);
  }
  return groupId;
}

export async function attachProjectTab(
  database: TabLayoutExecutor,
  input: {
    projectId: string;
    definitionId?: ProjectSurfaceDefinitionId;
    paneId?: string;
    region?: ProjectPaneRegion;
    tabId: string;
    tabKind: ProjectTabKind;
  },
): Promise<string> {
  await bumpRevision(database, input.projectId);
  const groupId = await attachProjectTabPlacement(database, input);
  return groupId;
}

async function detachProjectTabPlacement(
  database: TabLayoutExecutor,
  projectId: string,
  tabKey: string,
): Promise<boolean> {
  const members = await database
    .select({ member: schema.tabGroupMembers, group: schema.tabGroups })
    .from(schema.tabGroupMembers)
    .innerJoin(
      schema.tabGroups,
      eq(schema.tabGroups.id, schema.tabGroupMembers.groupId),
    )
    .where(
      and(
        eq(schema.tabGroupMembers.projectId, projectId),
        eq(schema.tabGroupMembers.tabKey, tabKey),
      ),
    )
    .limit(1);
  const selected = members[0];
  if (!selected) return false;

  await database
    .delete(schema.tabGroupMembers)
    .where(eq(schema.tabGroupMembers.tabKey, tabKey));
  const remaining = await database
    .select({ tabKey: schema.tabGroupMembers.tabKey })
    .from(schema.tabGroupMembers)
    .where(eq(schema.tabGroupMembers.groupId, selected.group.id))
    .orderBy(
      asc(schema.tabGroupMembers.position),
      asc(schema.tabGroupMembers.tabKey),
    );
  if (remaining.length === 0) {
    await database
      .delete(schema.tabGroups)
      .where(eq(schema.tabGroups.id, selected.group.id));
    if (selected.group.region === "center") {
      await removeCenterPaneFromLayout(database, projectId, selected.group.id);
    }
    const remainingGroups = await database
      .select({ id: schema.tabGroups.id })
      .from(schema.tabGroups)
      .where(
        and(
          eq(schema.tabGroups.projectId, projectId),
          eq(schema.tabGroups.region, selected.group.region),
        ),
      )
      .orderBy(asc(schema.tabGroups.position), asc(schema.tabGroups.id));
    await updateGroupPositions(
      database,
      remainingGroups.map(({ id }) => id),
    );
  } else if (selected.group.anchorTabKey === tabKey || remaining.length === 1) {
    await database
      .update(schema.tabGroups)
      .set({
        ...(selected.group.anchorTabKey === tabKey
          ? { anchorTabKey: remaining[0]!.tabKey }
          : {}),
        ...(remaining.length === 1 ? { protectedLabel: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.tabGroups.id, selected.group.id));
  }
  if (remaining.length > 0) {
    await updateMemberPositions(
      database,
      selected.group.id,
      remaining.map(({ tabKey: remainingTabKey }) => remainingTabKey),
    );
  }
  return true;
}

export async function detachProjectTab(
  database: TabLayoutExecutor,
  projectId: string,
  tabKey: string,
): Promise<void> {
  await lockProjectLayout(database, projectId);
  if (await detachProjectTabPlacement(database, projectId, tabKey)) {
    await bumpRevision(database, projectId);
  }
}

async function resolveEntitySurface(
  database: TabLayoutExecutor,
  projectId: string,
  surface: ProjectSurfaceResourceRef,
): Promise<{ tabId: string; tabKind: ProjectTabKind } | null> {
  if (surface.kind !== "entity") return null;
  const tabKind = projectSurfaceTabKind(surface);
  if (!tabKind) return null;
  const tabId = surface.resourceId;
  let rows: Array<{ id: string }>;
  if (tabKind === "chat") {
    rows = await database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, tabId),
          eq(schema.chats.projectId, projectId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
  } else if (tabKind === "terminal") {
    rows = await database
      .select({ id: schema.terminals.id })
      .from(schema.terminals)
      .where(
        and(
          eq(schema.terminals.id, tabId),
          eq(schema.terminals.projectId, projectId),
          isNull(schema.terminals.linkedChatId),
        ),
      )
      .limit(1);
  } else if (tabKind === "explorer") {
    rows = await database
      .select({ id: schema.explorers.id })
      .from(schema.explorers)
      .where(
        and(
          eq(schema.explorers.id, tabId),
          eq(schema.explorers.projectId, projectId),
        ),
      )
      .limit(1);
  } else if (tabKind === "browser") {
    rows = await database
      .select({ id: schema.browsers.id })
      .from(schema.browsers)
      .where(
        and(
          eq(schema.browsers.id, tabId),
          eq(schema.browsers.projectId, projectId),
        ),
      )
      .limit(1);
  } else if (tabKind === "code") {
    rows = await database
      .select({ id: schema.codeTabs.id })
      .from(schema.codeTabs)
      .where(
        and(
          eq(schema.codeTabs.id, tabId),
          eq(schema.codeTabs.projectId, projectId),
        ),
      )
      .limit(1);
  } else {
    rows = await database
      .select({ id: schema.projectViews.id })
      .from(schema.projectViews)
      .where(
        and(
          eq(schema.projectViews.id, tabId),
          eq(schema.projectViews.projectId, projectId),
          eq(schema.projectViews.kind, tabKind),
        ),
      )
      .limit(1);
  }
  return rows[0] ? { tabId, tabKind } : null;
}

async function updateGroupPositions(
  database: TabLayoutExecutor,
  groupIds: string[],
): Promise<void> {
  for (const [position, id] of groupIds.entries()) {
    await database
      .update(schema.tabGroups)
      .set({ position, updatedAt: new Date() })
      .where(eq(schema.tabGroups.id, id));
  }
}

async function updateMemberPositions(
  database: TabLayoutExecutor,
  groupId: string,
  tabKeys: string[],
): Promise<void> {
  for (const [position, tabKey] of tabKeys.entries()) {
    await database
      .update(schema.tabGroupMembers)
      .set({ groupId, position, updatedAt: new Date() })
      .where(eq(schema.tabGroupMembers.tabKey, tabKey));
  }
}

function insertedAt<T>(items: T[], item: T, position: number): T[] {
  const result = [...items];
  result.splice(Math.min(position, result.length), 0, item);
  return result;
}

function movedTo<T>(items: T[], from: number, to: number): T[] {
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(Math.min(to, result.length), 0, item);
  return result;
}

const paneRegionOrder = sql<number>`CASE ${schema.tabGroups.region}
  WHEN 'center' THEN 0
  WHEN 'right' THEN 1
  WHEN 'bottom' THEN 2
  WHEN 'left' THEN 3
  ELSE 4
END`;

export class ProjectTabLayoutRepository {
  constructor(private readonly database: TabLayoutDatabase) {}

  async get(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    const projects = await this.database
      .select({
        id: schema.projects.id,
        revision: schema.projects.tabLayoutRevision,
        centerRoot: schema.projects.centerLayoutRoot,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projects[0];
    if (!project) return null;

    const [
      panes,
      members,
      chats,
      terminals,
      explorers,
      browsers,
      code,
      views,
      builtInStates,
      dockPresentations,
    ] = await Promise.all([
      this.database
        .select()
        .from(schema.tabGroups)
        .where(eq(schema.tabGroups.projectId, projectId))
        .orderBy(
          paneRegionOrder,
          asc(schema.tabGroups.position),
          asc(schema.tabGroups.id),
        ),
      this.database
        .select()
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.projectId, projectId))
        .orderBy(
          asc(schema.tabGroupMembers.position),
          asc(schema.tabGroupMembers.tabKey),
        ),
      this.database
        .select({
          id: schema.chats.id,
          titleProtection: schema.chats.protectedLabel,
        })
        .from(schema.chats)
        .where(eq(schema.chats.projectId, projectId)),
      this.database
        .select({
          id: schema.terminals.id,
          titleProtection: schema.terminals.protectedLabel,
        })
        .from(schema.terminals)
        .where(eq(schema.terminals.projectId, projectId)),
      this.database
        .select({
          id: schema.explorers.id,
          titleProtection: schema.explorers.protectedLabel,
        })
        .from(schema.explorers)
        .where(eq(schema.explorers.projectId, projectId)),
      this.database
        .select({
          id: schema.browsers.id,
          titleProtection: schema.browsers.protectedLabel,
        })
        .from(schema.browsers)
        .where(eq(schema.browsers.projectId, projectId)),
      this.database
        .select({
          id: schema.codeTabs.id,
          titleProtection: schema.codeTabs.protectedLabel,
        })
        .from(schema.codeTabs)
        .where(eq(schema.codeTabs.projectId, projectId)),
      this.database
        .select({
          id: schema.projectViews.id,
          titleProtection: schema.projectViews.protectedLabel,
        })
        .from(schema.projectViews)
        .where(eq(schema.projectViews.projectId, projectId)),
      this.database
        .select()
        .from(schema.projectBuiltInSurfaceStates)
        .where(eq(schema.projectBuiltInSurfaceStates.projectId, projectId)),
      this.database
        .select()
        .from(schema.projectDockPresentationPreferences)
        .where(
          eq(schema.projectDockPresentationPreferences.projectId, projectId),
        ),
    ]);
    for (const dockRegion of ["right", "bottom"] as const) {
      assertSingleDockPane(
        panes.filter(({ region }) => region === dockRegion),
        dockRegion,
      );
    }
    const centerRoot =
      project.centerRoot === null
        ? null
        : projectCenterLayoutNodeSchema.parse(project.centerRoot);
    const centerLeafIds = await assertCenterLayoutExact(
      this.database,
      projectId,
      centerRoot,
    );
    const centerPaneById = new Map(
      panes
        .filter(({ region }) => region === "center")
        .map((pane) => [pane.id, pane] as const),
    );
    if (
      centerLeafIds.some(
        (paneId, position) => centerPaneById.get(paneId)?.position !== position,
      )
    ) {
      throw new TabLayoutInvariantError(
        "Center pane positions must match center layout leaf order.",
      );
    }
    const titles = new Map<
      string,
      Pick<ProjectTabMemberWireSummary, "builtInState" | "titleProtection">
    >([
      ...chats.map(
        ({ id, titleProtection }) =>
          [`chat:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...terminals.map(
        ({ id, titleProtection }) =>
          [`terminal:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...explorers.map(
        ({ id, titleProtection }) =>
          [`explorer:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...browsers.map(
        ({ id, titleProtection }) =>
          [`browser:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...code.map(
        ({ id, titleProtection }) =>
          [`code:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...views.map(
        ({ id, titleProtection }) =>
          [`view:${id}`, { builtInState: null, titleProtection }] as const,
      ),
      ...builtInStates.map(
        ({ definitionId, worktreeId }) =>
          [
            projectSurfaceViewId({
              projectId,
              resource: { kind: "builtin", definitionId },
            }),
            {
              builtInState: { definitionId, worktreeId },
              titleProtection: null,
            },
          ] as const,
      ),
    ]);
    const memberSummaries = new Map<string, ProjectTabMemberWireSummary[]>();
    const dockPresentationByTabAndRegion = new Map(
      dockPresentations.map(
        ({ tabKey, region, preferredMode, splitFraction, restoreFraction }) =>
          [
            dockPresentationKey(tabKey, region),
            { preferredMode, splitFraction, restoreFraction },
          ] as const,
      ),
    );
    const paneRegionById = new Map(
      panes.map(({ id, region }) => [id, region] as const),
    );
    for (const member of members) {
      const protectedTitle = titles.get(member.tabKey);
      if (!protectedTitle) {
        throw new TabLayoutInvariantError(
          `Tab layout member ${member.tabKey} has no matching surface.`,
        );
      }
      const summary: ProjectTabMemberWireSummary = {
        tabKey: member.tabKey,
        paneId: member.groupId,
        projectId: member.projectId,
        tabKind: member.tabKind as ProjectTabKind,
        tabId: member.tabId,
        ...protectedTitle,
        dockPresentation:
          paneRegionById.get(member.groupId) === "right" ||
          paneRegionById.get(member.groupId) === "bottom"
            ? (dockPresentationByTabAndRegion.get(
                dockPresentationKey(
                  member.tabKey,
                  paneRegionById.get(member.groupId)!,
                ),
              ) ?? DEFAULT_DOCK_PRESENTATION)
            : null,
        position: member.position,
        createdAt: member.createdAt.toISOString(),
        updatedAt: member.updatedAt.toISOString(),
      };
      memberSummaries.set(member.groupId, [
        ...(memberSummaries.get(member.groupId) ?? []),
        summary,
      ]);
    }

    return {
      projectId,
      revision: project.revision,
      centerRoot,
      panes: panes.map((group) => {
        const groupedMembers = memberSummaries.get(group.id) ?? [];
        if (
          groupedMembers.length === 0 ||
          !groupedMembers.some(({ tabKey }) => tabKey === group.anchorTabKey)
        ) {
          throw new TabLayoutInvariantError(
            `Tab group ${group.id} has an invalid anchor or no members.`,
          );
        }
        return {
          id: group.id,
          projectId: group.projectId,
          region: group.region,
          titleProtection: group.protectedLabel,
          position: group.position,
          anchorTabKey: group.anchorTabKey,
          members: groupedMembers,
          createdAt: group.createdAt.toISOString(),
          updatedAt: group.updatedAt.toISOString(),
        };
      }),
    };
  }

  async updatePane(
    ownerId: string,
    projectId: string,
    paneId: string,
    input: EncryptedProjectPaneUpdate,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.id, paneId),
            eq(schema.tabGroups.projectId, projectId),
          ),
        )
        .limit(1);
      if (!groups[0]) {
        throw new TabLayoutInvariantError(
          "The pane does not belong to this project.",
        );
      }
      const members = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, paneId))
        .limit(2);
      if (members.length < 2) {
        throw new TabLayoutInvariantError(
          "A single-tab group shares its title with its tab.",
        );
      }
      await transaction
        .update(schema.tabGroups)
        .set({
          protectedLabel: input.titleProtection,
          updatedAt: new Date(),
        })
        .where(eq(schema.tabGroups.id, paneId));
    });
    return this.get(ownerId, projectId);
  }

  async updateDockPresentation(
    ownerId: string,
    projectId: string,
    input: ProjectDockPresentationUpdate,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const placements = await transaction
        .select({ region: schema.tabGroups.region })
        .from(schema.tabGroupMembers)
        .innerJoin(
          schema.tabGroups,
          eq(schema.tabGroups.id, schema.tabGroupMembers.groupId),
        )
        .where(
          and(
            eq(schema.tabGroupMembers.projectId, projectId),
            eq(schema.tabGroupMembers.tabKey, input.tabKey),
          ),
        )
        .limit(1);
      const region = placements[0]?.region;
      if (region !== "right" && region !== "bottom") {
        throw new TabLayoutInvariantError(
          "Dock presentation can only be updated for a right or bottom placement.",
        );
      }
      const now = new Date();
      await transaction
        .insert(schema.projectDockPresentationPreferences)
        .values({
          projectId,
          tabKey: input.tabKey,
          region,
          preferredMode: input.preferredMode,
          splitFraction: input.splitFraction,
          restoreFraction: input.restoreFraction,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.projectDockPresentationPreferences.projectId,
            schema.projectDockPresentationPreferences.tabKey,
            schema.projectDockPresentationPreferences.region,
          ],
          set: {
            preferredMode: input.preferredMode,
            splitFraction: input.splitFraction,
            restoreFraction: input.restoreFraction,
            updatedAt: now,
          },
        });
    });
    return this.get(ownerId, projectId);
  }

  async reorderPanes(
    ownerId: string,
    projectId: string,
    input: ProjectPaneOrder,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.projectId, projectId),
            eq(schema.tabGroups.region, input.region),
          ),
        );
      const expected = new Set(groups.map(({ id }) => id));
      if (
        expected.size !== input.paneIds.length ||
        input.paneIds.some((id) => !expected.has(id))
      ) {
        throw new TabLayoutInvariantError(
          "The pane order did not match this project's region.",
        );
      }
      if (input.region === "center") {
        const root = await readCenterLayoutRoot(transaction, projectId);
        if (root === null) {
          throw new TabLayoutInvariantError(
            "The center layout root is missing.",
          );
        }
        await assertCenterLayoutExact(transaction, projectId, root);
        await persistCenterLayoutRoot(
          transaction,
          projectId,
          replaceCenterLeafOrder(root, input.paneIds),
        );
      } else {
        await updateGroupPositions(transaction, input.paneIds);
      }
    });
    return this.get(ownerId, projectId);
  }

  async reorderLegacyPanes(
    ownerId: string,
    projectId: string,
    input: { revision: number; paneIds: string[] },
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const panes = await transaction
        .select({ id: schema.tabGroups.id, region: schema.tabGroups.region })
        .from(schema.tabGroups)
        .where(eq(schema.tabGroups.projectId, projectId));
      const expected = new Set(panes.map(({ id }) => id));
      if (
        expected.size !== input.paneIds.length ||
        input.paneIds.some((id) => !expected.has(id))
      ) {
        throw new TabLayoutInvariantError(
          "The pane order did not match this project.",
        );
      }
      const regionByPaneId = new Map(
        panes.map(({ id, region }) => [id, region] as const),
      );
      for (const region of ["center", "right", "bottom", "left"] as const) {
        const regionPaneIds = input.paneIds.filter(
          (id) => regionByPaneId.get(id) === region,
        );
        if (region === "center" && regionPaneIds.length > 0) {
          const root = await readCenterLayoutRoot(transaction, projectId);
          if (root === null) {
            throw new TabLayoutInvariantError(
              "The center layout root is missing.",
            );
          }
          await assertCenterLayoutExact(transaction, projectId, root);
          await persistCenterLayoutRoot(
            transaction,
            projectId,
            replaceCenterLeafOrder(root, regionPaneIds),
          );
        } else {
          await updateGroupPositions(transaction, regionPaneIds);
        }
      }
    });
    return this.get(ownerId, projectId);
  }

  async reorderMembers(
    ownerId: string,
    projectId: string,
    paneId: string,
    input: ProjectPaneMemberOrder,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.id, paneId),
            eq(schema.tabGroups.projectId, projectId),
          ),
        )
        .limit(1);
      if (!groups[0]) {
        throw new TabLayoutInvariantError(
          "The pane does not belong to this project.",
        );
      }
      const members = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, paneId));
      const expected = new Set(members.map(({ tabKey }) => tabKey));
      if (
        expected.size !== input.tabKeys.length ||
        input.tabKeys.some((tabKey) => !expected.has(tabKey))
      ) {
        throw new TabLayoutInvariantError(
          "The member order did not match this pane.",
        );
      }
      await updateMemberPositions(transaction, paneId, input.tabKeys);
    });
    return this.get(ownerId, projectId);
  }

  async moveMember(
    ownerId: string,
    projectId: string,
    input: ProjectPaneMemberMove,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const memberRows = await transaction
        .select({ member: schema.tabGroupMembers, group: schema.tabGroups })
        .from(schema.tabGroupMembers)
        .innerJoin(
          schema.tabGroups,
          eq(schema.tabGroups.id, schema.tabGroupMembers.groupId),
        )
        .where(
          and(
            eq(schema.tabGroupMembers.projectId, projectId),
            eq(schema.tabGroupMembers.tabKey, input.tabKey),
          ),
        )
        .limit(1);
      const selected = memberRows[0];
      if (!selected) {
        throw new TabLayoutInvariantError(
          "The moved tab does not belong to this project.",
        );
      }
      const sourceRegionPanes = await panesInRegion(
        transaction,
        projectId,
        selected.group.region,
      );
      const sourceMembers = await transaction
        .select()
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, selected.group.id))
        .orderBy(
          asc(schema.tabGroupMembers.position),
          asc(schema.tabGroupMembers.tabKey),
        );

      if (input.targetPaneId !== null && input.targetRegion !== undefined) {
        throw new TabLayoutInvariantError(
          "Specify either a target pane or a target region, not both.",
        );
      }

      let targetRegion = input.targetRegion ?? selected.group.region;
      let targetPane: (typeof sourceRegionPanes)[number] | null = null;
      let targetRegionPanes = sourceRegionPanes;
      if (input.targetPaneId !== null) {
        const targetPanes = await transaction
          .select()
          .from(schema.tabGroups)
          .where(
            and(
              eq(schema.tabGroups.id, input.targetPaneId),
              eq(schema.tabGroups.projectId, projectId),
            ),
          )
          .limit(1);
        targetPane = targetPanes[0] ?? null;
        if (!targetPane) {
          throw new TabLayoutInvariantError(
            "The destination pane does not belong to this project.",
          );
        }
        targetRegion = targetPane.region;
      } else if (targetRegion !== selected.group.region) {
        targetRegionPanes = await panesInRegion(
          transaction,
          projectId,
          targetRegion,
        );
      }
      if (input.targetPaneId === null) {
        assertSingleDockPane(targetRegionPanes, targetRegion);
        if (isSinglePaneDockRegion(targetRegion)) {
          targetPane = targetRegionPanes[0] ?? null;
        }
      }
      assertTabSupportsRegion(
        selected.member.tabKind as ProjectTabKind,
        selected.member.tabId,
        targetRegion,
      );

      if (targetPane?.id === selected.group.id) {
        const from = sourceMembers.findIndex(
          ({ tabKey }) => tabKey === input.tabKey,
        );
        await updateMemberPositions(
          transaction,
          selected.group.id,
          movedTo(
            sourceMembers.map(({ tabKey }) => tabKey),
            from,
            input.targetMemberPosition,
          ),
        );
        return;
      }

      if (
        targetPane === null &&
        isSinglePaneDockRegion(targetRegion) &&
        targetRegion !== selected.group.region &&
        targetRegionPanes.length === 0 &&
        sourceMembers.length === 1
      ) {
        await transaction
          .update(schema.tabGroups)
          .set({ region: targetRegion, position: 0, updatedAt: new Date() })
          .where(eq(schema.tabGroups.id, selected.group.id));
        if (selected.group.region === "center") {
          await removeCenterPaneFromLayout(
            transaction,
            projectId,
            selected.group.id,
          );
        }
        await updateGroupPositions(
          transaction,
          sourceRegionPanes
            .filter(({ id }) => id !== selected.group.id)
            .map(({ id }) => id),
        );
        return;
      }

      if (
        targetPane === null &&
        targetRegion === selected.group.region &&
        sourceMembers.length === 1
      ) {
        const from = sourceRegionPanes.findIndex(
          ({ id }) => id === selected.group.id,
        );
        const nextPaneIds = movedTo(
          sourceRegionPanes.map(({ id }) => id),
          from,
          input.targetPanePosition!,
        );
        if (targetRegion === "center") {
          const root = await readCenterLayoutRoot(transaction, projectId);
          if (root === null) {
            throw new TabLayoutInvariantError(
              "The center layout root is missing.",
            );
          }
          await persistCenterLayoutRoot(
            transaction,
            projectId,
            replaceCenterLeafOrder(root, nextPaneIds),
          );
        } else {
          await updateGroupPositions(transaction, nextPaneIds);
        }
        return;
      }

      const remainingSource = sourceMembers.filter(
        ({ tabKey }) => tabKey !== input.tabKey,
      );
      await transaction
        .delete(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.tabKey, input.tabKey));

      let nextSourcePaneIds = sourceRegionPanes.map(({ id }) => id);
      if (remainingSource.length === 0) {
        await transaction
          .delete(schema.tabGroups)
          .where(eq(schema.tabGroups.id, selected.group.id));
        if (selected.group.region === "center") {
          await removeCenterPaneFromLayout(
            transaction,
            projectId,
            selected.group.id,
          );
        }
        nextSourcePaneIds = nextSourcePaneIds.filter(
          (id) => id !== selected.group.id,
        );
      } else {
        await updateMemberPositions(
          transaction,
          selected.group.id,
          remainingSource.map(({ tabKey }) => tabKey),
        );
        if (selected.group.anchorTabKey === input.tabKey) {
          await transaction
            .update(schema.tabGroups)
            .set({
              anchorTabKey: remainingSource[0]!.tabKey,
              ...(remainingSource.length === 1 ? { protectedLabel: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(schema.tabGroups.id, selected.group.id));
        } else if (remainingSource.length === 1) {
          await transaction
            .update(schema.tabGroups)
            .set({ protectedLabel: null, updatedAt: new Date() })
            .where(eq(schema.tabGroups.id, selected.group.id));
        }
      }

      if (targetPane === null) {
        const targetPaneId = randomUUID();
        const targetPanePosition = input.targetPanePosition ?? 0;
        await transaction.insert(schema.tabGroups).values({
          id: targetPaneId,
          projectId,
          region: targetRegion,
          position: targetPanePosition,
          anchorTabKey: input.tabKey,
        });
        await transaction.insert(schema.tabGroupMembers).values({
          ...selected.member,
          groupId: targetPaneId,
          position: 0,
          updatedAt: new Date(),
        });
        if (targetRegion === "center") {
          await appendCenterPaneLeaf(transaction, projectId, targetPaneId);
        }
        if (targetRegion !== selected.group.region) {
          await updateGroupPositions(transaction, nextSourcePaneIds);
        }
        const targetPaneIds =
          targetRegion === selected.group.region
            ? nextSourcePaneIds
            : targetRegionPanes.map(({ id }) => id);
        const nextTargetPaneIds = insertedAt(
          targetPaneIds,
          targetPaneId,
          targetPanePosition,
        );
        if (targetRegion === "center") {
          const root = await readCenterLayoutRoot(transaction, projectId);
          if (root === null) {
            throw new TabLayoutInvariantError(
              "The center layout root is missing.",
            );
          }
          await persistCenterLayoutRoot(
            transaction,
            projectId,
            replaceCenterLeafOrder(root, nextTargetPaneIds),
          );
        } else {
          await updateGroupPositions(transaction, nextTargetPaneIds);
        }
      } else {
        const targetMembers = await transaction
          .select({ tabKey: schema.tabGroupMembers.tabKey })
          .from(schema.tabGroupMembers)
          .where(eq(schema.tabGroupMembers.groupId, targetPane.id))
          .orderBy(
            asc(schema.tabGroupMembers.position),
            asc(schema.tabGroupMembers.tabKey),
          );
        await transaction.insert(schema.tabGroupMembers).values({
          ...selected.member,
          groupId: targetPane.id,
          position: input.targetMemberPosition,
          updatedAt: new Date(),
        });
        await updateMemberPositions(
          transaction,
          targetPane.id,
          insertedAt(
            targetMembers.map(({ tabKey }) => tabKey),
            input.tabKey,
            input.targetMemberPosition,
          ),
        );
        if (remainingSource.length === 0) {
          await updateGroupPositions(transaction, nextSourcePaneIds);
        }
      }
    });
    return this.get(ownerId, projectId);
  }

  async splitMember(
    ownerId: string,
    projectId: string,
    input: ProjectPaneMemberSplit,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const selectedRows = await transaction
        .select({ member: schema.tabGroupMembers, group: schema.tabGroups })
        .from(schema.tabGroupMembers)
        .innerJoin(
          schema.tabGroups,
          eq(schema.tabGroups.id, schema.tabGroupMembers.groupId),
        )
        .where(
          and(
            eq(schema.tabGroupMembers.projectId, projectId),
            eq(schema.tabGroupMembers.tabKey, input.tabKey),
          ),
        )
        .limit(1);
      const selected = selectedRows[0];
      if (!selected) {
        throw new TabLayoutInvariantError(
          "The split tab does not belong to this project.",
        );
      }
      const targetRows = await transaction
        .select()
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.id, input.targetPaneId),
            eq(schema.tabGroups.projectId, projectId),
          ),
        )
        .limit(1);
      const target = targetRows[0];
      if (!target || target.region !== "center") {
        throw new TabLayoutInvariantError(
          "A center split must target a center pane in this project.",
        );
      }
      assertTabSupportsRegion(
        selected.member.tabKind as ProjectTabKind,
        selected.member.tabId,
        "center",
      );
      const currentRoot = await readCenterLayoutRoot(transaction, projectId);
      if (currentRoot === null) {
        throw new TabLayoutInvariantError("The center layout root is missing.");
      }
      await assertCenterLayoutExact(transaction, projectId, currentRoot);

      const sourceMembers = await transaction
        .select()
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, selected.group.id))
        .orderBy(
          asc(schema.tabGroupMembers.position),
          asc(schema.tabGroupMembers.tabKey),
        );
      if (selected.group.id === target.id && sourceMembers.length === 1) {
        throw new TabLayoutInvariantError(
          "A pane's final tab cannot split that same pane.",
        );
      }

      await transaction
        .delete(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.tabKey, input.tabKey));
      const remainingSource = sourceMembers.filter(
        ({ tabKey }) => tabKey !== input.tabKey,
      );
      if (remainingSource.length === 0) {
        await transaction
          .delete(schema.tabGroups)
          .where(eq(schema.tabGroups.id, selected.group.id));
        if (selected.group.region === "center") {
          await removeCenterPaneFromLayout(
            transaction,
            projectId,
            selected.group.id,
          );
        } else {
          const sourcePanes = await panesInRegion(
            transaction,
            projectId,
            selected.group.region,
          );
          await updateGroupPositions(
            transaction,
            sourcePanes.map(({ id }) => id),
          );
        }
      } else {
        await updateMemberPositions(
          transaction,
          selected.group.id,
          remainingSource.map(({ tabKey }) => tabKey),
        );
        await transaction
          .update(schema.tabGroups)
          .set({
            ...(selected.group.anchorTabKey === input.tabKey
              ? { anchorTabKey: remainingSource[0]!.tabKey }
              : {}),
            ...(remainingSource.length === 1 ? { protectedLabel: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.tabGroups.id, selected.group.id));
      }

      const paneId = randomUUID();
      const centerPanes = await panesInRegion(transaction, projectId, "center");
      await transaction.insert(schema.tabGroups).values({
        id: paneId,
        projectId,
        region: "center",
        position: (centerPanes.at(-1)?.position ?? -1) + 1,
        anchorTabKey: input.tabKey,
      });
      await transaction.insert(schema.tabGroupMembers).values({
        ...selected.member,
        groupId: paneId,
        position: 0,
        updatedAt: new Date(),
      });

      const root = await readCenterLayoutRoot(transaction, projectId);
      if (root === null) {
        throw new TabLayoutInvariantError(
          "The split target disappeared from the center layout.",
        );
      }
      const newLeaf: ProjectCenterLayoutNode = { kind: "pane", paneId };
      const targetLeaf: ProjectCenterLayoutNode = {
        kind: "pane",
        paneId: input.targetPaneId,
      };
      const placeNewFirst = input.edge === "left" || input.edge === "top";
      const split: Extract<ProjectCenterLayoutNode, { kind: "split" }> = {
        kind: "split",
        id: randomUUID(),
        direction:
          input.edge === "left" || input.edge === "right"
            ? "horizontal"
            : "vertical",
        fraction: input.fraction,
        first: placeNewFirst ? newLeaf : targetLeaf,
        second: placeNewFirst ? targetLeaf : newLeaf,
      };
      const replaced = replaceCenterPaneWithSplit(
        root,
        input.targetPaneId,
        split,
      );
      if (!replaced.replaced) {
        throw new TabLayoutInvariantError(
          "The split target is missing from the center layout.",
        );
      }
      await persistCenterLayoutRoot(transaction, projectId, replaced.node);
    });
    return this.get(ownerId, projectId);
  }

  async resizeCenterSplit(
    ownerId: string,
    projectId: string,
    splitId: string,
    input: ProjectCenterSplitResize,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const root = await readCenterLayoutRoot(transaction, projectId);
      if (root === null) {
        throw new TabLayoutInvariantError("The center layout root is missing.");
      }
      await assertCenterLayoutExact(transaction, projectId, root);
      const resized = resizeCenterSplit(root, splitId, input.fraction);
      if (!resized.resized) {
        throw new TabLayoutInvariantError(
          "The center split does not belong to this project.",
        );
      }
      await persistCenterLayoutRoot(transaction, projectId, resized.node);
    });
    return this.get(ownerId, projectId);
  }

  async openSurfaceView(
    ownerId: string,
    projectId: string,
    input: ProjectSurfaceViewOpen,
  ): Promise<ProjectSurfaceViewOpenResult | null> {
    const current = await this.get(ownerId, projectId);
    if (!current) return null;
    const viewId = projectSurfaceViewId({
      projectId,
      resource: input.surfaceRef,
    });
    const expectedTabKind =
      input.surfaceRef.kind === "builtin"
        ? ("builtin" as const)
        : projectSurfaceTabKind(input.surfaceRef);
    if (!expectedTabKind) {
      throw new TabLayoutInvariantError(
        "The surface definition is not currently entity-backed.",
      );
    }
    const existingPane = current.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === viewId),
    );
    const existingMember = existingPane?.members.find(
      ({ tabKey }) => tabKey === viewId,
    );
    if (existingPane && existingMember) {
      const expectedTabId =
        input.surfaceRef.kind === "builtin"
          ? input.surfaceRef.definitionId
          : input.surfaceRef.resourceId;
      if (
        existingMember.tabKind !== expectedTabKind ||
        existingMember.tabId !== expectedTabId ||
        (input.surfaceRef.kind === "entity" &&
          !(await resolveEntitySurface(
            this.database,
            projectId,
            input.surfaceRef,
          )))
      ) {
        throw new TabLayoutInvariantError(
          "The open view does not match the requested surface resource.",
        );
      }
      return {
        disposition: "focused",
        viewId,
        paneId: existingPane.id,
        layout: current,
      };
    }

    let paneId = "";
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      let tabId: string;
      let tabKind: ProjectTabKind;
      if (input.surfaceRef.kind === "builtin") {
        tabId = input.surfaceRef.definitionId;
        tabKind = "builtin";
        await transaction
          .insert(schema.projectBuiltInSurfaceStates)
          .values({
            projectId,
            definitionId: input.surfaceRef.definitionId,
          })
          .onConflictDoNothing();
      } else {
        const resolved = await resolveEntitySurface(
          transaction,
          projectId,
          input.surfaceRef,
        );
        if (!resolved) {
          throw new TabLayoutInvariantError(
            "The surface resource is unavailable in this project.",
          );
        }
        tabId = resolved.tabId;
        tabKind = resolved.tabKind;
      }
      paneId = await attachProjectTabPlacement(transaction, {
        projectId,
        definitionId: input.surfaceRef.definitionId,
        paneId: input.targetPaneId,
        region: input.targetRegion,
        tabId,
        tabKind,
      });
    });
    const layout = await this.get(ownerId, projectId);
    if (!layout) {
      throw new TabLayoutInvariantError(
        "The project disappeared while its surface view was opening.",
      );
    }
    return { disposition: "opened", viewId, paneId, layout };
  }

  async closeSurfaceView(
    ownerId: string,
    projectId: string,
    input: ProjectSurfaceViewClose,
  ): Promise<ProjectSurfaceViewCloseResult | null> {
    const current = await this.get(ownerId, projectId);
    if (!current) return null;
    const existing = current.panes.some(({ members }) =>
      members.some(({ tabKey }) => tabKey === input.viewId),
    );
    if (!existing) {
      return {
        disposition: "already-closed",
        viewId: input.viewId,
        layout: current,
      };
    }
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      if (
        !(await detachProjectTabPlacement(transaction, projectId, input.viewId))
      ) {
        throw new TabLayoutConflictError(
          "The project tab layout changed. Refresh it and try again.",
        );
      }
    });
    const layout = await this.get(ownerId, projectId);
    if (!layout) {
      throw new TabLayoutInvariantError(
        "The project disappeared while its surface view was closing.",
      );
    }
    return { disposition: "closed", viewId: input.viewId, layout };
  }

  async listSurfaceLaunchers(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectSurfaceLauncher[] | null> {
    const projects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!projects[0]) return null;
    const preferences = await this.database
      .select()
      .from(schema.projectSurfaceLauncherPreferences)
      .where(eq(schema.projectSurfaceLauncherPreferences.projectId, projectId));
    const preferenceByTarget = new Map(
      preferences.map((preference) => [
        `${preference.location}:${preference.definitionId}`,
        preference.pinned,
      ]),
    );
    return PROJECT_SURFACE_DEFINITIONS.flatMap((definition) => {
      const definitionId = definition.id;
      return definition.launcherLocations.map((location) => ({
        id: projectSurfaceLauncherId({ projectId, definitionId, location }),
        projectId,
        location,
        target: { kind: "definition" as const, definitionId },
        pinned:
          preferenceByTarget.get(`${location}:${definitionId}`) ??
          definition.launcherPinnedByDefault,
      }));
    });
  }

  async setSurfaceLauncherPin(
    ownerId: string,
    projectId: string,
    input: ProjectSurfaceLauncherPin,
  ): Promise<ProjectSurfaceLauncher | null> {
    const launchers = await this.listSurfaceLaunchers(ownerId, projectId);
    if (!launchers) return null;
    const launcher = launchers.find(
      ({ location, target }) =>
        location === input.location &&
        target.kind === "definition" &&
        target.definitionId === input.definitionId,
    );
    if (!launcher) {
      throw new TabLayoutInvariantError(
        "This surface does not support the requested launcher location.",
      );
    }
    await this.database
      .insert(schema.projectSurfaceLauncherPreferences)
      .values({
        projectId,
        location: input.location,
        definitionId: input.definitionId,
        pinned: input.pinned,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectSurfaceLauncherPreferences.projectId,
          schema.projectSurfaceLauncherPreferences.location,
          schema.projectSurfaceLauncherPreferences.definitionId,
        ],
        set: { pinned: input.pinned, updatedAt: new Date() },
      });
    return { ...launcher, pinned: input.pinned };
  }

  async updateBuiltInSurfaceWorktree(
    ownerId: string,
    projectId: string,
    definitionId: ProjectBuiltInSurfaceDefinitionId,
    worktreeId: string,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (
      definitionId === "project.overview" ||
      definitionId === "project.tasks"
    ) {
      throw new TabLayoutInvariantError(
        "This built-in surface does not use a worktree.",
      );
    }
    const worktrees = await this.database
      .select({ id: schema.projectWorktrees.id })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectWorktrees.id, worktreeId),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    if (!worktrees[0]) return null;
    await this.database
      .insert(schema.projectBuiltInSurfaceStates)
      .values({ projectId, definitionId, worktreeId })
      .onConflictDoUpdate({
        target: [
          schema.projectBuiltInSurfaceStates.projectId,
          schema.projectBuiltInSurfaceStates.definitionId,
        ],
        set: { worktreeId, updatedAt: new Date() },
      });
    return this.get(ownerId, projectId);
  }

  async nextProjectTabPosition(projectId: string): Promise<number> {
    const positions = await Promise.all([
      this.database
        .select({ position: schema.chats.position })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.projectId, projectId),
            isNull(schema.chats.archivedAt),
          ),
        )
        .orderBy(desc(schema.chats.position))
        .limit(1),
      this.database
        .select({ position: schema.terminals.position })
        .from(schema.terminals)
        .where(eq(schema.terminals.projectId, projectId))
        .orderBy(desc(schema.terminals.position))
        .limit(1),
      this.database
        .select({ position: schema.explorers.position })
        .from(schema.explorers)
        .where(eq(schema.explorers.projectId, projectId))
        .orderBy(desc(schema.explorers.position))
        .limit(1),
      this.database
        .select({ position: schema.codeTabs.position })
        .from(schema.codeTabs)
        .where(eq(schema.codeTabs.projectId, projectId))
        .orderBy(desc(schema.codeTabs.position))
        .limit(1),
      this.database
        .select({ position: schema.browsers.position })
        .from(schema.browsers)
        .where(eq(schema.browsers.projectId, projectId))
        .orderBy(desc(schema.browsers.position))
        .limit(1),
      this.database
        .select({ position: schema.projectViews.position })
        .from(schema.projectViews)
        .where(eq(schema.projectViews.projectId, projectId))
        .orderBy(desc(schema.projectViews.position))
        .limit(1),
    ]);
    return Math.max(...positions.map((rows) => rows[0]?.position ?? -1)) + 1;
  }

  async reorderProjects(ownerId: string, input: OrderedIds): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId));
    if (
      rows.length !== input.ids.length ||
      rows.some(({ id }) => !input.ids.includes(id))
    )
      return false;
    await this.database.transaction(async (transaction) => {
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.projects)
          .set({ position })
          .where(eq(schema.projects.id, id));
      }
    });
    return true;
  }
}
