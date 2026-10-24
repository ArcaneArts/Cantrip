import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectTabKind,
  ProjectTabLayoutSummary,
  ProjectTabMemberSummary,
  ProjectTabPlacement,
  ProjectSurfaceDefinition,
  ProjectBuiltInSurfaceDefinitionId,
  ProjectSurfaceResourceRef,
  ProjectSurfaceView,
  ProjectViewSummary,
  TerminalSummary,
  WorkspaceOwnership,
} from "@cantrip/protocol";
import {
  projectBuiltinSurfaceDefinitionIdSchema,
  projectSurfaceViewId,
} from "@cantrip/protocol";
import {
  projectBuiltInSurfaceIdentity,
  projectSurfaceIdentityForTab,
  projectSurfaceDefinition,
} from "./project-surface-registry";

export interface ProjectBuiltInSurfaceEntity {
  id: string;
  projectId: string;
  definitionId: ProjectBuiltInSurfaceDefinitionId;
  worktreeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSurface =
  | ProjectSurfaceBase<"chat", ChatSummary>
  | ProjectSurfaceBase<"terminal", TerminalSummary>
  | ProjectSurfaceBase<"explorer", ExplorerSummary>
  | ProjectSurfaceBase<"browser", BrowserSummary>
  | ProjectSurfaceBase<"code", CodeTabSummary>
  | ProjectSurfaceBase<"history", ProjectViewSummary>
  | ProjectSurfaceBase<"graph", ProjectViewSummary>
  | ProjectSurfaceBase<"issues", ProjectViewSummary>
  | ProjectSurfaceBase<"prs", ProjectViewSummary>
  | ProjectSurfaceBase<"actions", ProjectViewSummary>
  | ProjectSurfaceBase<"remote-desktop", ProjectViewSummary>
  | ProjectSurfaceBase<"builtin", ProjectBuiltInSurfaceEntity>
  | ProjectSurfaceBase<"unresolved", null>;

export type ProjectFileSurface = Extract<ProjectSurface, { kind: "explorer" }>;

export interface ProjectSurfaceBase<
  Kind extends ProjectTabKind | "unresolved",
  Entity,
> {
  definition: ProjectSurfaceDefinition;
  entity: Entity;
  paneId: string;
  kind: Kind;
  member: ProjectTabMemberSummary;
  placement: ProjectTabPlacement;
  projectId: string;
  resource: {
    entity: Entity;
    ref: ProjectSurfaceResourceRef;
  };
  tabId: string;
  tabKey: string;
  title: string;
  view: ProjectSurfaceView;
  preview?: boolean;
}

export interface ProjectSurfaceCollections {
  browsers: BrowserSummary[];
  chats: ChatSummary[];
  codeTabs: CodeTabSummary[];
  explorers: ExplorerSummary[];
  projectViews: ProjectViewSummary[];
  terminals: TerminalSummary[];
}

export interface ProjectSurfaceIndex {
  byPaneId: ReadonlyMap<string, ProjectSurface[]>;
  byTabKey: ReadonlyMap<string, ProjectSurface>;
  unresolvedTabKeys: readonly string[];
}

export function omitProjectSurfaceTabs(
  index: ProjectSurfaceIndex,
  omittedTabKeys: ReadonlySet<string>,
): ProjectSurfaceIndex {
  if (omittedTabKeys.size === 0) return index;
  return {
    byPaneId: new Map(
      [...index.byPaneId].map(([paneId, surfaces]) => [
        paneId,
        surfaces.filter(({ tabKey }) => !omittedTabKeys.has(tabKey)),
      ]),
    ),
    byTabKey: new Map(
      [...index.byTabKey].filter(([tabKey]) => !omittedTabKeys.has(tabKey)),
    ),
    unresolvedTabKeys: index.unresolvedTabKeys.filter(
      (tabKey) => !omittedTabKeys.has(tabKey),
    ),
  };
}

export function projectSurfaceIsFile(
  surface: ProjectSurface,
): surface is ProjectFileSurface {
  return surface.kind === "explorer" && surface.entity.selectedPath !== null;
}

export function projectSurfaceTabKey(
  kind: ProjectTabKind | "view",
  tabId: string,
  projectId?: string,
): string {
  if (kind === "builtin") {
    if (!projectId) throw new Error("Built-in tab keys require a project id.");
    return projectSurfaceViewId({
      projectId,
      resource: {
        kind: "builtin",
        definitionId: projectBuiltinSurfaceDefinitionIdSchema.parse(tabId),
      },
    });
  }
  const prefix =
    kind === "history" ||
    kind === "graph" ||
    kind === "issues" ||
    kind === "prs" ||
    kind === "actions" ||
    kind === "remote-desktop"
      ? "view"
      : kind;
  return `${prefix}:${tabId}`;
}

export function projectSurfaceTabId(
  tabKey: string | null | undefined,
  prefix: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
): string | null {
  const expectedPrefix = `${prefix}:`;
  return tabKey?.startsWith(expectedPrefix)
    ? tabKey.slice(expectedPrefix.length)
    : null;
}

function entityMap<T extends { id: string }>(entities: T[]): Map<string, T> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

function surfaceForMember(
  member: ProjectTabMemberSummary,
  entities: {
    browsers: Map<string, BrowserSummary>;
    chats: Map<string, ChatSummary>;
    codeTabs: Map<string, CodeTabSummary>;
    explorers: Map<string, ExplorerSummary>;
    projectViews: Map<string, ProjectViewSummary>;
    terminals: Map<string, TerminalSummary>;
  },
): ProjectSurface | null {
  if (member.tabKind === "builtin") {
    const definitionId = member.builtInState?.definitionId;
    if (!definitionId || definitionId !== member.tabId) return null;
    const identity = projectBuiltInSurfaceIdentity(
      member.projectId,
      definitionId,
    );
    const entity: ProjectBuiltInSurfaceEntity = {
      id: identity.viewId,
      projectId: member.projectId,
      definitionId,
      worktreeId: member.builtInState?.worktreeId ?? null,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    };
    return {
      definition: identity.definition,
      entity,
      paneId: member.paneId,
      kind: "builtin",
      member,
      placement: {
        paneId: member.paneId,
        position: member.position,
        viewId: member.tabKey,
      },
      projectId: member.projectId,
      resource: { entity, ref: identity.resource },
      tabId: member.tabId,
      tabKey: member.tabKey,
      title: identity.definition.label,
      view: {
        id: member.tabKey,
        projectId: member.projectId,
        resource: identity.resource,
      },
    };
  }
  const placedSurface = <Kind extends ProjectTabKind, Entity>(
    kind: Kind,
    entity: Entity,
    title: string,
    file = false,
  ): ProjectSurfaceBase<Kind, Entity> => {
    const identity = projectSurfaceIdentityForTab({
      kind,
      projectId: member.projectId,
      resourceId: member.tabId,
      file,
    });
    return {
      definition: identity.definition,
      entity,
      paneId: member.paneId,
      kind,
      member,
      placement: {
        paneId: member.paneId,
        position: member.position,
        viewId: member.tabKey,
      },
      projectId: member.projectId,
      resource: { entity, ref: identity.resource },
      tabId: member.tabId,
      tabKey: member.tabKey,
      title,
      view: {
        id: member.tabKey,
        projectId: member.projectId,
        resource: identity.resource,
      },
    };
  };
  if (member.tabKind === "chat") {
    const entity = entities.chats.get(member.tabId);
    return entity ? placedSurface("chat", entity, entity.title) : null;
  }
  if (member.tabKind === "terminal") {
    const entity = entities.terminals.get(member.tabId);
    return entity && entity.linkedChatId === null
      ? placedSurface("terminal", entity, entity.title)
      : null;
  }
  if (member.tabKind === "explorer") {
    const entity = entities.explorers.get(member.tabId);
    return entity
      ? placedSurface(
          "explorer",
          entity,
          entity.title,
          entity.selectedPath !== null,
        )
      : null;
  }
  if (member.tabKind === "browser") {
    const entity = entities.browsers.get(member.tabId);
    return entity ? placedSurface("browser", entity, entity.title) : null;
  }
  if (member.tabKind === "code") {
    const entity = entities.codeTabs.get(member.tabId);
    return entity ? placedSurface("code", entity, entity.title) : null;
  }
  const entity = entities.projectViews.get(member.tabId);
  return entity && entity.kind === member.tabKind
    ? placedSurface(member.tabKind, entity, entity.title)
    : null;
}

export function buildProjectSurfaceIndex(
  layout: ProjectTabLayoutSummary | null | undefined,
  collections: ProjectSurfaceCollections,
  ownership?: { layout: WorkspaceOwnership; windowId: string },
): ProjectSurfaceIndex {
  const byTabKey = new Map<string, ProjectSurface>();
  const byPaneId = new Map<string, ProjectSurface[]>();
  const unresolvedTabKeys: string[] = [];
  if (!layout) return { byPaneId, byTabKey, unresolvedTabKeys };
  const owner =
    ownership?.layout.projectId === layout.projectId
      ? ownership.layout.windows.find(({ id }) => id === ownership.windowId)
      : undefined;
  if (ownership && !owner) return { byPaneId, byTabKey, unresolvedTabKeys };
  const ownedTabs = new Map(
    owner?.panes.flatMap((pane) =>
      pane.tabs.map((tab) => [tab.id, { tab, paneId: pane.id }] as const),
    ),
  );

  const entities = {
    browsers: entityMap(collections.browsers),
    chats: entityMap(collections.chats),
    codeTabs: entityMap(collections.codeTabs),
    explorers: entityMap(collections.explorers),
    projectViews: entityMap(collections.projectViews),
    terminals: entityMap(collections.terminals),
  };
  for (const pane of layout.panes) {
    const surfaces: ProjectSurface[] = [];
    for (const member of pane.members) {
      const owned = ownedTabs.get(member.tabKey);
      if (
        ownership &&
        (!owned ||
          owned.paneId !== pane.id ||
          (owned.tab.resource.kind === "entity"
            ? owned.tab.resource.resourceId
            : owned.tab.resource.definitionId) !== member.tabId)
      )
        continue;
      if (
        member.tabKind === "chat" &&
        entities.chats.get(member.tabId)?.experience === "task"
      ) {
        continue;
      }
      let surface = surfaceForMember(member, entities);
      if (!surface) {
        unresolvedTabKeys.push(member.tabKey);
        // Invalid built-in metadata has no trustworthy resource definition.
        // Entity query absence, by contrast, must never erase owned placement.
        if (member.tabKind === "builtin") continue;
        if (
          member.tabKind === "terminal" &&
          entities.terminals.get(member.tabId)?.linkedChatId
        )
          continue;
        const identity = projectSurfaceIdentityForTab({
          kind: member.tabKind,
          projectId: member.projectId,
          resourceId: member.tabId,
        });
        surface = {
          kind: "unresolved",
          entity: null,
          member,
          definition: identity.definition,
          paneId: member.paneId,
          placement: {
            paneId: member.paneId,
            position: member.position,
            viewId: member.tabKey,
          },
          projectId: member.projectId,
          resource: { entity: null, ref: identity.resource },
          tabId: member.tabId,
          tabKey: member.tabKey,
          title: member.title,
          view: {
            id: member.tabKey,
            projectId: member.projectId,
            resource: identity.resource,
          },
        };
      }
      if (owned) {
        // Compatibility membership does not encode file definitions or preview
        // state. Use the owner, not query availability, as their authority.
        surface = {
          ...surface,
          definition: projectSurfaceDefinition(owned.tab.resource.definitionId),
          resource: { ...surface.resource, ref: owned.tab.resource },
          view: { ...surface.view, resource: owned.tab.resource },
          preview: owned.tab.preview,
        } as ProjectSurface;
      }
      byTabKey.set(surface.tabKey, surface);
      surfaces.push(surface);
    }
    byPaneId.set(pane.id, surfaces);
  }
  return { byPaneId, byTabKey, unresolvedTabKeys };
}
