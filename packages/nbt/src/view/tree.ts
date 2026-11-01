import { assertRange, NbtError, NbtTag, type NbtNode } from "../types.js";
import type { NbtReadModel, NbtPathEntry, NbtTreePage } from "./types.js";

export const nbtContainer = (node: NbtNode) =>
  node.type === NbtTag.List || node.type === NbtTag.Compound;
export async function nbtAncestors(
  model: NbtReadModel,
  id: string,
  signal?: AbortSignal,
): Promise<NbtPathEntry[]> {
  const path: NbtPathEntry[] = [];
  let current: string | null = id;
  while (current !== null) {
    signal?.throwIfAborted();
    if (path.length > 4096)
      throw new NbtError(0, "NBT ancestor budget exceeded");
    const node = await model.getNode(current);
    if (!node) throw new NbtError(0, "Indexed node is unavailable");
    path.push({
      id: node.id,
      parent: node.parent,
      ordinal: node.ordinal,
      type: node.type,
    });
    current = node.parent;
  }
  return path.reverse();
}
/** Rank/select over only expanded containers. A million collapsed children need no row array. */
export async function nbtTreePage(
  model: NbtReadModel,
  expandedIds: readonly string[],
  first: number,
  limit: number,
  anchor: string | undefined,
  signal: AbortSignal,
): Promise<NbtTreePage> {
  assertRange(first, limit);
  if (limit > 128) throw new NbtError(0, "Tree pages are limited to 128 rows");
  const rootId = model.snapshot().root;
  if (!rootId) return { rows: [], total: 0 };
  const root = await model.getNode(rootId);
  if (!root) return { rows: [], total: 0 };
  const expanded = new Map<
    string,
    {
      node: NbtNode;
      extra: number;
      children: Array<{ node: NbtNode; extra: number }>;
    }
  >();
  for (let i = 0; i < expandedIds.length; i++) {
    signal.throwIfAborted();
    const id = expandedIds[i]!;
    if (expanded.has(id)) continue;
    const node = await model.getNode(id);
    if (node && nbtContainer(node))
      expanded.set(id, { node, extra: node.childCount, children: [] });
    if (i % 128 === 127) await model.work(signal, false);
  }
  // Baseline IDs are stable preorder sequences, so a child's size is known before its parent.
  for (const item of [...expanded.values()].sort(
    (a, b) => Number(b.node.id.slice(5)) - Number(a.node.id.slice(5)),
  )) {
    if (item.node.parent === null) continue;
    const parent = expanded.get(item.node.parent);
    if (parent) {
      parent.extra += item.extra;
      parent.children.push(item);
    }
  }
  for (const item of expanded.values())
    item.children.sort((a, b) => a.node.ordinal - b.node.ordinal);
  const total = 1 + (expanded.get(root.id)?.extra ?? 0);
  async function locate(
    node: NbtNode,
    rank: number,
    depth: number,
  ): Promise<{ node: NbtNode; depth: number }> {
    for (;;) {
      signal.throwIfAborted();
      if (rank === 0) return { node, depth };
      const open = expanded.get(node.id);
      if (!open) throw new NbtError(node.start, "Tree rank is unavailable");
      let childRank = rank - 1,
        ordinal = childRank,
        descend: (typeof open.children)[number] | undefined;
      for (const child of open.children) {
        if (childRank < child.node.ordinal) {
          ordinal = childRank;
          break;
        }
        if (childRank <= child.node.ordinal + child.extra) {
          descend = child;
          rank = childRank - child.node.ordinal;
          break;
        }
        childRank -= child.extra;
        ordinal = childRank;
      }
      if (descend) {
        node = descend.node;
        depth++;
        if (depth % 128 === 0) await model.work(signal, false);
        continue;
      }
      const child = (await model.getChildren(node.id, ordinal, 1))[0];
      if (!child) throw new NbtError(node.start, "Tree child is unavailable");
      return { node: child, depth: depth + 1 };
    }
  }

  let anchorIndex: number | undefined;
  if (anchor) {
    const path = await nbtAncestors(model, anchor, signal);
    let rank = 0,
      visible = path[0]?.id === root.id;
    for (let i = 1; i < path.length && visible; i++) {
      const parent = expanded.get(path[i - 1]!.id);
      if (!parent) {
        visible = false;
        break;
      }
      const child = path[i]!;
      rank +=
        1 +
        child.ordinal +
        parent.children
          .filter((item) => item.node.ordinal < child.ordinal)
          .reduce((sum, item) => sum + item.extra, 0);
    }
    if (visible) anchorIndex = rank;
  }
  const rows: NbtTreePage["rows"] = [];
  for (let index = first; index < Math.min(total, first + limit); index++) {
    const found = await locate(root, index, 0);
    rows.push({
      row: await model.describe(found.node, signal),
      depth: found.depth,
      index,
      expanded: expanded.has(found.node.id),
    });
  }
  return { rows, total, ...(anchorIndex === undefined ? {} : { anchorIndex }) };
}
