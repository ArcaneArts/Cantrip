import { randomUUID } from "node:crypto";

import type {
  ProjectTabKind,
  ProjectTabLayoutWireSummary,
  ProjectTabMemberWireSummary,
  OrderedIds,
  EncryptedTabGroupUpdate,
  TabGroupMemberMove,
  TabGroupMemberOrder,
  TabGroupOrder,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type TabLayoutDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export type TabLayoutExecutor = Pick<
  TabLayoutDatabase,
  "delete" | "insert" | "select" | "update"
>;

export class TabLayoutConflictError extends Error {
  readonly statusCode = 409;
}

export class TabLayoutInvariantError extends Error {
  readonly statusCode = 400;
}

export function projectTabKey(kind: ProjectTabKind, tabId: string): string {
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

export async function attachProjectTab(
  database: TabLayoutExecutor,
  input: {
    projectId: string;
    tabGroupId?: string;
    tabId: string;
    tabKind: ProjectTabKind;
  },
): Promise<string> {
  const tabKey = projectTabKey(input.tabKind, input.tabId);
  let groupId = input.tabGroupId;
  let memberPosition = 0;

  if (groupId) {
    const groups = await database
      .select({ id: schema.tabGroups.id })
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
        "The destination tab group does not belong to this project.",
      );
    }
    const positions = await database
      .select({ position: schema.tabGroupMembers.position })
      .from(schema.tabGroupMembers)
      .where(eq(schema.tabGroupMembers.groupId, groupId))
      .orderBy(asc(schema.tabGroupMembers.position));
    memberPosition = positions.length;
  } else {
    groupId = randomUUID();
    const groups = await database
      .select({ position: schema.tabGroups.position })
      .from(schema.tabGroups)
      .where(eq(schema.tabGroups.projectId, input.projectId));
    await database.insert(schema.tabGroups).values({
      id: groupId,
      projectId: input.projectId,
      position: groups.length,
      anchorTabKey: tabKey,
    });
  }

  await database.insert(schema.tabGroupMembers).values({
    tabKey,
    groupId,
    projectId: input.projectId,
    tabKind: input.tabKind,
    tabId: input.tabId,
    position: memberPosition,
  });
  await bumpRevision(database, input.projectId);
  return groupId;
}

export async function detachProjectTab(
  database: TabLayoutExecutor,
  projectId: string,
  tabKey: string,
): Promise<void> {
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
  if (!selected) return;

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
    const remainingGroups = await database
      .select({ id: schema.tabGroups.id })
      .from(schema.tabGroups)
      .where(eq(schema.tabGroups.projectId, projectId))
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
  await bumpRevision(database, projectId);
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
      groups,
      members,
      chats,
      terminals,
      explorers,
      browsers,
      code,
      views,
    ] = await Promise.all([
      this.database
        .select()
        .from(schema.tabGroups)
        .where(eq(schema.tabGroups.projectId, projectId))
        .orderBy(asc(schema.tabGroups.position), asc(schema.tabGroups.id)),
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
    ]);
    const titles = new Map<
      string,
      Pick<ProjectTabMemberWireSummary, "titleProtection">
    >([
      ...chats.map(
        ({ id, titleProtection }) =>
          [`chat:${id}`, { titleProtection }] as const,
      ),
      ...terminals.map(
        ({ id, titleProtection }) =>
          [`terminal:${id}`, { titleProtection }] as const,
      ),
      ...explorers.map(
        ({ id, titleProtection }) =>
          [`explorer:${id}`, { titleProtection }] as const,
      ),
      ...browsers.map(
        ({ id, titleProtection }) =>
          [`browser:${id}`, { titleProtection }] as const,
      ),
      ...code.map(
        ({ id, titleProtection }) =>
          [`code:${id}`, { titleProtection }] as const,
      ),
      ...views.map(
        ({ id, titleProtection }) =>
          [`view:${id}`, { titleProtection }] as const,
      ),
    ]);
    const memberSummaries = new Map<string, ProjectTabMemberWireSummary[]>();
    for (const member of members) {
      const protectedTitle = titles.get(member.tabKey);
      if (!protectedTitle) {
        throw new TabLayoutInvariantError(
          `Tab layout member ${member.tabKey} has no matching surface.`,
        );
      }
      const summary: ProjectTabMemberWireSummary = {
        tabKey: member.tabKey,
        groupId: member.groupId,
        projectId: member.projectId,
        tabKind: member.tabKind as ProjectTabKind,
        tabId: member.tabId,
        ...protectedTitle,
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
      groups: groups.map((group) => {
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

  async updateGroup(
    ownerId: string,
    projectId: string,
    groupId: string,
    input: EncryptedTabGroupUpdate,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.id, groupId),
            eq(schema.tabGroups.projectId, projectId),
          ),
        )
        .limit(1);
      if (!groups[0]) {
        throw new TabLayoutInvariantError(
          "The tab group does not belong to this project.",
        );
      }
      const members = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, groupId))
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
        .where(eq(schema.tabGroups.id, groupId));
    });
    return this.get(ownerId, projectId);
  }

  async reorderGroups(
    ownerId: string,
    projectId: string,
    input: TabGroupOrder,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(eq(schema.tabGroups.projectId, projectId));
      const expected = new Set(groups.map(({ id }) => id));
      if (
        expected.size !== input.groupIds.length ||
        input.groupIds.some((id) => !expected.has(id))
      ) {
        throw new TabLayoutInvariantError(
          "The group order did not match this project's layout.",
        );
      }
      await updateGroupPositions(transaction, input.groupIds);
    });
    return this.get(ownerId, projectId);
  }

  async reorderMembers(
    ownerId: string,
    projectId: string,
    groupId: string,
    input: TabGroupMemberOrder,
  ): Promise<ProjectTabLayoutWireSummary | null> {
    if (!(await this.get(ownerId, projectId))) return null;
    await this.database.transaction(async (transaction) => {
      await claimRevision(transaction, ownerId, projectId, input.revision);
      const groups = await transaction
        .select({ id: schema.tabGroups.id })
        .from(schema.tabGroups)
        .where(
          and(
            eq(schema.tabGroups.id, groupId),
            eq(schema.tabGroups.projectId, projectId),
          ),
        )
        .limit(1);
      if (!groups[0]) {
        throw new TabLayoutInvariantError(
          "The tab group does not belong to this project.",
        );
      }
      const members = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, groupId));
      const expected = new Set(members.map(({ tabKey }) => tabKey));
      if (
        expected.size !== input.tabKeys.length ||
        input.tabKeys.some((tabKey) => !expected.has(tabKey))
      ) {
        throw new TabLayoutInvariantError(
          "The member order did not match this tab group.",
        );
      }
      await updateMemberPositions(transaction, groupId, input.tabKeys);
    });
    return this.get(ownerId, projectId);
  }

  async moveMember(
    ownerId: string,
    projectId: string,
    input: TabGroupMemberMove,
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
      const groups = await transaction
        .select()
        .from(schema.tabGroups)
        .where(eq(schema.tabGroups.projectId, projectId))
        .orderBy(asc(schema.tabGroups.position), asc(schema.tabGroups.id));
      const sourceMembers = await transaction
        .select()
        .from(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.groupId, selected.group.id))
        .orderBy(
          asc(schema.tabGroupMembers.position),
          asc(schema.tabGroupMembers.tabKey),
        );

      if (input.targetGroupId === selected.group.id) {
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

      if (input.targetGroupId === null && sourceMembers.length === 1) {
        const from = groups.findIndex(({ id }) => id === selected.group.id);
        await updateGroupPositions(
          transaction,
          movedTo(
            groups.map(({ id }) => id),
            from,
            input.targetGroupPosition!,
          ),
        );
        return;
      }

      const remainingSource = sourceMembers.filter(
        ({ tabKey }) => tabKey !== input.tabKey,
      );
      await transaction
        .delete(schema.tabGroupMembers)
        .where(eq(schema.tabGroupMembers.tabKey, input.tabKey));

      let nextGroupIds = groups.map(({ id }) => id);
      if (remainingSource.length === 0) {
        await transaction
          .delete(schema.tabGroups)
          .where(eq(schema.tabGroups.id, selected.group.id));
        nextGroupIds = nextGroupIds.filter((id) => id !== selected.group.id);
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

      let targetGroupId = input.targetGroupId;
      if (targetGroupId === null) {
        targetGroupId = randomUUID();
        await transaction.insert(schema.tabGroups).values({
          id: targetGroupId,
          projectId,
          position: input.targetGroupPosition!,
          anchorTabKey: input.tabKey,
        });
        nextGroupIds = insertedAt(
          nextGroupIds,
          targetGroupId,
          input.targetGroupPosition!,
        );
        await transaction.insert(schema.tabGroupMembers).values({
          ...selected.member,
          groupId: targetGroupId,
          position: 0,
          updatedAt: new Date(),
        });
      } else {
        const targetGroup = groups.find(({ id }) => id === targetGroupId);
        if (!targetGroup) {
          throw new TabLayoutInvariantError(
            "The destination tab group does not belong to this project.",
          );
        }
        const targetMembers = await transaction
          .select({ tabKey: schema.tabGroupMembers.tabKey })
          .from(schema.tabGroupMembers)
          .where(eq(schema.tabGroupMembers.groupId, targetGroupId))
          .orderBy(
            asc(schema.tabGroupMembers.position),
            asc(schema.tabGroupMembers.tabKey),
          );
        await transaction.insert(schema.tabGroupMembers).values({
          ...selected.member,
          groupId: targetGroupId,
          position: input.targetMemberPosition,
          updatedAt: new Date(),
        });
        await updateMemberPositions(
          transaction,
          targetGroupId,
          insertedAt(
            targetMembers.map(({ tabKey }) => tabKey),
            input.tabKey,
            input.targetMemberPosition,
          ),
        );
      }
      await updateGroupPositions(transaction, nextGroupIds);
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
