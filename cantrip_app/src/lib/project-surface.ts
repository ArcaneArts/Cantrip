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
} from "@cantrip/protocol";
import {
  projectBuiltinSurfaceDefinitionIdSchema,
  projectSurfaceViewId,
} from "@cantrip/protocol";
import {
  projectBuiltInSurfaceIdentity,
  projectSurfaceIdentityForTab,
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
  | ProjectSurfaceBase<"issues", ProjectViewSummary>
  | ProjectSurfaceBase<"remote-desktop", ProjectViewSummary>
  | ProjectSurfaceBase<"builtin", ProjectBuiltInSurfaceEntity>;

export type ProjectFileSurface = Extract<ProjectSurface, { kind: "explorer" }>;

export interface ProjectSurfaceBase<Kind extends ProjectTabKind, Entity> {
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
    kind === "history" || kind === "issues" || kind === "remote-desktop"
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
        viewId: identity.viewId,
      },
      projectId: member.projectId,
      resource: { entity, ref: identity.resource },
      tabId: member.tabId,
      tabKey: member.tabKey,
      title: identity.definition.label,
      view: {
        id: identity.viewId,
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
        viewId: identity.viewId,
      },
      projectId: member.projectId,
      resource: { entity, ref: identity.resource },
      tabId: member.tabId,
      tabKey: member.tabKey,
      title,
      view: {
        id: identity.viewId,
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
): ProjectSurfaceIndex {
  const byTabKey = new Map<string, ProjectSurface>();
  const byPaneId = new Map<string, ProjectSurface[]>();
  const unresolvedTabKeys: string[] = [];
  if (!layout) return { byPaneId, byTabKey, unresolvedTabKeys };

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
      if (
        member.tabKind === "chat" &&
        entities.chats.get(member.tabId)?.experience === "task"
      ) {
        continue;
      }
      const surface = surfaceForMember(member, entities);
      if (!surface) {
        unresolvedTabKeys.push(member.tabKey);
        continue;
      }
      byTabKey.set(surface.tabKey, surface);
      surfaces.push(surface);
    }
    byPaneId.set(pane.id, surfaces);
  }
  return { byPaneId, byTabKey, unresolvedTabKeys };
}
