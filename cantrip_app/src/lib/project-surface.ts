import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectTabKind,
  ProjectTabLayoutSummary,
  ProjectTabMemberSummary,
  ProjectViewSummary,
  TerminalSummary,
} from "@cantrip/protocol";

export type ProjectSurface =
  | ProjectSurfaceBase<"chat", ChatSummary>
  | ProjectSurfaceBase<"terminal", TerminalSummary>
  | ProjectSurfaceBase<"explorer", ExplorerSummary>
  | ProjectSurfaceBase<"browser", BrowserSummary>
  | ProjectSurfaceBase<"code", CodeTabSummary>
  | ProjectSurfaceBase<"history", ProjectViewSummary>
  | ProjectSurfaceBase<"issues", ProjectViewSummary>
  | ProjectSurfaceBase<"remote-desktop", ProjectViewSummary>;

export interface ProjectSurfaceBase<Kind extends ProjectTabKind, Entity> {
  entity: Entity;
  groupId: string;
  kind: Kind;
  member: ProjectTabMemberSummary;
  projectId: string;
  tabId: string;
  tabKey: string;
  title: string;
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
  byGroupId: ReadonlyMap<string, ProjectSurface[]>;
  byTabKey: ReadonlyMap<string, ProjectSurface>;
  unresolvedTabKeys: readonly string[];
}

export function projectSurfaceTabKey(
  kind: ProjectTabKind | "view",
  tabId: string,
): string {
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
  const base = {
    groupId: member.groupId,
    member,
    projectId: member.projectId,
    tabId: member.tabId,
    tabKey: member.tabKey,
  };
  if (member.tabKind === "chat") {
    const entity = entities.chats.get(member.tabId);
    return entity
      ? { ...base, entity, kind: "chat", title: entity.title }
      : null;
  }
  if (member.tabKind === "terminal") {
    const entity = entities.terminals.get(member.tabId);
    return entity && entity.linkedChatId === null
      ? { ...base, entity, kind: "terminal", title: entity.title }
      : null;
  }
  if (member.tabKind === "explorer") {
    const entity = entities.explorers.get(member.tabId);
    return entity
      ? { ...base, entity, kind: "explorer", title: entity.title }
      : null;
  }
  if (member.tabKind === "browser") {
    const entity = entities.browsers.get(member.tabId);
    return entity
      ? { ...base, entity, kind: "browser", title: entity.title }
      : null;
  }
  if (member.tabKind === "code") {
    const entity = entities.codeTabs.get(member.tabId);
    return entity
      ? { ...base, entity, kind: "code", title: entity.title }
      : null;
  }
  const entity = entities.projectViews.get(member.tabId);
  return entity && entity.kind === member.tabKind
    ? { ...base, entity, kind: member.tabKind, title: entity.title }
    : null;
}

export function buildProjectSurfaceIndex(
  layout: ProjectTabLayoutSummary | null | undefined,
  collections: ProjectSurfaceCollections,
): ProjectSurfaceIndex {
  const byTabKey = new Map<string, ProjectSurface>();
  const byGroupId = new Map<string, ProjectSurface[]>();
  const unresolvedTabKeys: string[] = [];
  if (!layout) return { byGroupId, byTabKey, unresolvedTabKeys };

  const entities = {
    browsers: entityMap(collections.browsers),
    chats: entityMap(collections.chats),
    codeTabs: entityMap(collections.codeTabs),
    explorers: entityMap(collections.explorers),
    projectViews: entityMap(collections.projectViews),
    terminals: entityMap(collections.terminals),
  };
  for (const group of layout.groups) {
    const surfaces: ProjectSurface[] = [];
    for (const member of group.members) {
      const surface = surfaceForMember(member, entities);
      if (!surface) {
        unresolvedTabKeys.push(member.tabKey);
        continue;
      }
      byTabKey.set(surface.tabKey, surface);
      surfaces.push(surface);
    }
    byGroupId.set(group.id, surfaces);
  }
  return { byGroupId, byTabKey, unresolvedTabKeys };
}
