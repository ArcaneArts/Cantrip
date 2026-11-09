import { randomUUID } from "node:crypto";

import type { ProjectCenterLayoutNode } from "@cantrip/protocol";
import { projectCenterLayoutNodeSchema } from "@cantrip/protocol";
import { and, eq } from "drizzle-orm";

import { TabLayoutInvariantError } from "./tab-layout-errors.js";
import type { TabLayoutExecutor } from "./tab-layouts.js";
import * as schema from "./schema.js";

const MAX_CENTER_LAYOUT_DEPTH = 32;
const MAX_CENTER_LAYOUT_NODES = 255;

export function centerPaneIdsInLeafOrder(
  root: ProjectCenterLayoutNode | null,
): string[] {
  if (root === null) return [];
  const paneIds: string[] = [];
  const splitIds = new Set<string>();
  let nodeCount = 0;
  const visit = (node: ProjectCenterLayoutNode, depth: number): void => {
    nodeCount += 1;
    if (
      depth > MAX_CENTER_LAYOUT_DEPTH ||
      nodeCount > MAX_CENTER_LAYOUT_NODES
    ) {
      throw new TabLayoutInvariantError(
        "The center layout exceeds its supported topology bounds.",
      );
    }
    if (node.kind === "pane") {
      if (paneIds.includes(node.paneId)) {
        throw new TabLayoutInvariantError(
          `Center pane ${node.paneId} appears more than once in the layout tree.`,
        );
      }
      paneIds.push(node.paneId);
      return;
    }
    if (splitIds.has(node.id)) {
      throw new TabLayoutInvariantError(
        `Center split ${node.id} appears more than once in the layout tree.`,
      );
    }
    splitIds.add(node.id);
    visit(node.first, depth + 1);
    visit(node.second, depth + 1);
  };
  visit(root, 1);
  return paneIds;
}

export async function readCenterLayoutRoot(
  database: TabLayoutExecutor,
  projectId: string,
): Promise<ProjectCenterLayoutNode | null> {
  const rows = await database
    .select({ centerRoot: schema.projects.centerLayoutRoot })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!rows[0]) {
    throw new TabLayoutInvariantError("The project no longer exists.");
  }
  return rows[0].centerRoot === null
    ? null
    : projectCenterLayoutNodeSchema.parse(rows[0].centerRoot);
}

export async function assertCenterLayoutExact(
  database: TabLayoutExecutor,
  projectId: string,
  root: ProjectCenterLayoutNode | null,
): Promise<string[]> {
  const leafIds = centerPaneIdsInLeafOrder(root);
  const centerPanes = await database
    .select({ id: schema.tabGroups.id })
    .from(schema.tabGroups)
    .where(
      and(
        eq(schema.tabGroups.projectId, projectId),
        eq(schema.tabGroups.region, "center"),
      ),
    );
  const paneIds = new Set(centerPanes.map(({ id }) => id));
  if (
    leafIds.length !== paneIds.size ||
    leafIds.some((paneId) => !paneIds.has(paneId))
  ) {
    throw new TabLayoutInvariantError(
      "The center layout tree does not exactly match its center panes.",
    );
  }
  return leafIds;
}

export async function persistCenterLayoutRoot(
  database: TabLayoutExecutor,
  projectId: string,
  root: ProjectCenterLayoutNode | null,
): Promise<void> {
  const leafIds = await assertCenterLayoutExact(database, projectId, root);
  await database
    .update(schema.projects)
    .set({ centerLayoutRoot: root, updatedAt: new Date() })
    .where(eq(schema.projects.id, projectId));
  for (const [position, id] of leafIds.entries()) {
    await database
      .update(schema.tabGroups)
      .set({ position, updatedAt: new Date() })
      .where(eq(schema.tabGroups.id, id));
  }
}

function removeCenterPaneLeaf(
  node: ProjectCenterLayoutNode,
  paneId: string,
): { node: ProjectCenterLayoutNode | null; removed: boolean } {
  if (node.kind === "pane") {
    return node.paneId === paneId
      ? { node: null, removed: true }
      : { node, removed: false };
  }
  const first = removeCenterPaneLeaf(node.first, paneId);
  if (first.removed) {
    return first.node === null
      ? { node: node.second, removed: true }
      : { node: { ...node, first: first.node }, removed: true };
  }
  const second = removeCenterPaneLeaf(node.second, paneId);
  if (second.removed) {
    return second.node === null
      ? { node: node.first, removed: true }
      : { node: { ...node, second: second.node }, removed: true };
  }
  return { node, removed: false };
}

export async function appendCenterPaneLeaf(
  database: TabLayoutExecutor,
  projectId: string,
  paneId: string,
): Promise<void> {
  const current = await readCenterLayoutRoot(database, projectId);
  const next: ProjectCenterLayoutNode = current
    ? {
        kind: "split",
        id: randomUUID(),
        direction: "horizontal",
        fraction: 0.5,
        first: current,
        second: { kind: "pane", paneId },
      }
    : { kind: "pane", paneId };
  await persistCenterLayoutRoot(database, projectId, next);
}

export async function removeCenterPaneFromLayout(
  database: TabLayoutExecutor,
  projectId: string,
  paneId: string,
): Promise<void> {
  const current = await readCenterLayoutRoot(database, projectId);
  if (current === null) {
    throw new TabLayoutInvariantError("The center layout root is missing.");
  }
  const result = removeCenterPaneLeaf(current, paneId);
  if (!result.removed) {
    throw new TabLayoutInvariantError(
      `Center pane ${paneId} is missing from the layout tree.`,
    );
  }
  await persistCenterLayoutRoot(database, projectId, result.node);
}

export function replaceCenterPaneWithSplit(
  node: ProjectCenterLayoutNode,
  targetPaneId: string,
  split: Extract<ProjectCenterLayoutNode, { kind: "split" }>,
): { node: ProjectCenterLayoutNode; replaced: boolean } {
  if (node.kind === "pane") {
    return node.paneId === targetPaneId
      ? { node: split, replaced: true }
      : { node, replaced: false };
  }
  const first = replaceCenterPaneWithSplit(node.first, targetPaneId, split);
  if (first.replaced) {
    return { node: { ...node, first: first.node }, replaced: true };
  }
  const second = replaceCenterPaneWithSplit(node.second, targetPaneId, split);
  return second.replaced
    ? { node: { ...node, second: second.node }, replaced: true }
    : { node, replaced: false };
}

export function resizeCenterSplit(
  node: ProjectCenterLayoutNode,
  splitId: string,
  fraction: number,
): { node: ProjectCenterLayoutNode; resized: boolean } {
  if (node.kind === "pane") return { node, resized: false };
  if (node.id === splitId) {
    return { node: { ...node, fraction }, resized: true };
  }
  const first = resizeCenterSplit(node.first, splitId, fraction);
  if (first.resized) {
    return { node: { ...node, first: first.node }, resized: true };
  }
  const second = resizeCenterSplit(node.second, splitId, fraction);
  return second.resized
    ? { node: { ...node, second: second.node }, resized: true }
    : { node, resized: false };
}

export function replaceCenterLeafOrder(
  node: ProjectCenterLayoutNode,
  paneIds: readonly string[],
  nextIndex = { value: 0 },
): ProjectCenterLayoutNode {
  if (node.kind === "pane") {
    const paneId = paneIds[nextIndex.value++];
    if (!paneId) {
      throw new TabLayoutInvariantError("The center pane order is incomplete.");
    }
    return { kind: "pane", paneId };
  }
  return {
    ...node,
    first: replaceCenterLeafOrder(node.first, paneIds, nextIndex),
    second: replaceCenterLeafOrder(node.second, paneIds, nextIndex),
  };
}
