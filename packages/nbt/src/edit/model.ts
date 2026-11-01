import {
  NbtError,
  NbtTag,
  assertRange,
  type NbtNode,
  type NbtSpan,
  type NbtScalar,
} from "../types.js";
import type { NbtDisplayRow } from "../document/types.js";
import { nbtDocumentError } from "../document/engine.js";
import { nbtContainer, nbtArray, nbtArrayType } from "./validate.js";
import { NbtSequence } from "./persistent.js";
import { NbtEditData } from "./data.js";
import type {
  NbtSerializableModel,
  NbtEditState,
  NbtEditRecord,
  NbtChildPart,
  NbtArrayPart,
  NbtCopy,
} from "./types.js";
export const wrapCopy = (copy: NbtCopy, id: string) =>
  copy.prefix +
  (copy.sourcePrefix && !id.startsWith(copy.sourcePrefix)
    ? "a:" + id
    : "r:" + (copy.sourcePrefix ? id.slice(copy.sourcePrefix.length) : id));
export const unwrapCopy = (copy: NbtCopy, id: string) =>
  !id.startsWith(copy.prefix)
    ? undefined
    : id.slice(copy.prefix.length).startsWith("a:")
      ? id.slice(copy.prefix.length + 2)
      : copy.sourcePrefix + id.slice(copy.prefix.length + 2);
export interface NbtResolved {
  node: NbtNode;
  record: NbtEditRecord;
  origin?: { view: NbtSerializableModel; node: NbtNode; copy?: NbtCopy };
}
/** One immutable logical revision. Only edited records and piece-tree roots are retained. */
export class NbtEditView implements NbtSerializableModel {
  constructor(
    readonly baseline: NbtSerializableModel,
    readonly state: NbtEditState,
    readonly data: NbtEditData,
    readonly copies: ReadonlyMap<string, NbtCopy>,
  ) {}
  get encoding() {
    return this.baseline.encoding;
  }
  snapshot() {
    return { ...this.baseline.snapshot(), nodes: this.state.nodes };
  }
  changeRevision() {
    return this.baseline.changeRevision();
  }
  waitForChange(revision: number, signal: AbortSignal) {
    return this.baseline.waitForChange(revision, signal);
  }
  work(signal: AbortSignal, background = true) {
    return this.baseline.work(signal, background);
  }
  validated(signal: AbortSignal) {
    return this.baseline.validated(signal);
  }
  async resolve(id: string): Promise<NbtResolved | undefined> {
    const record = this.state.records.get(id) ?? {};
    let origin: NbtResolved["origin"], node: NbtNode | undefined;
    if (record.created) node = { ...record.created };
    else if (id.startsWith("node:")) {
      const source = await this.baseline.getNode(id);
      if (source) {
        node = { ...source };
        origin = { view: this.baseline, node: source };
      }
    } else {
      const slash = id.indexOf("/"),
        copy = this.copies.get(id.slice(0, slash + 1));
      if (copy) {
        const sourceId = unwrapCopy(copy, id)!,
          source = await copy.view.getNode(sourceId);
        if (source) {
          node = {
            ...source,
            id,
            parent:
              id === copy.prefix + copy.root
                ? copy.parent
                : source.parent === null
                  ? null
                  : wrapCopy(copy, source.parent),
          };
          origin = { view: copy.view, node: source, copy };
        }
      }
    }
    if (!node) return undefined;
    if (record.name !== undefined) node.name = record.name;
    if (record.type !== undefined) node.type = record.type;
    if (record.elementType !== undefined) node.elementType = record.elementType;
    if (record.text) node.data = record.text;
    if (nbtContainer(node.type)) {
      const children = record.children;
      node.childCount = children?.length ?? origin?.node.childCount ?? 0;
      if (node.type === NbtTag.List) node.length = node.childCount;
      else delete node.length;
      delete node.data;
    } else if (nbtArray(node.type)) {
      node.length = record.array?.length ?? origin?.node.length ?? 0;
      node.childCount = 0;
    } else {
      node.childCount = 0;
      delete node.length;
      delete node.elementType;
    }
    return { node, record, origin };
  }
  childrenSequence(resolved: NbtResolved): NbtSequence<NbtChildPart> {
    const { node, record, origin } = resolved;
    if (record.children) return record.children;
    if (!nbtContainer(node.type) || !origin) return new NbtSequence();
    return NbtSequence.from<NbtChildPart>(
      {
        kind: "source",
        view: origin.view,
        parent: origin.node.id,
        copy: origin.copy,
      },
      origin.node.childCount,
    );
  }
  arraySequence(resolved: NbtResolved): NbtSequence<NbtArrayPart> {
    if (resolved.record.array) return resolved.record.array;
    if (!resolved.origin) return new NbtSequence();
    return NbtSequence.from<NbtArrayPart>(
      {
        kind: "source",
        view: resolved.origin.view,
        id: resolved.origin.node.id,
      },
      resolved.origin.node.length ?? 0,
    );
  }
  async ordinal(parent: NbtResolved, id: string) {
    for (const piece of this.childrenSequence(parent).slices()) {
      if (piece.data.kind === "ids") {
        const at = piece.data.ids.indexOf(id, piece.offset);
        if (at >= piece.offset && at < piece.offset + piece.count)
          return piece.position + at - piece.offset;
      } else {
        const sourceId = piece.data.copy ? unwrapCopy(piece.data.copy, id) : id;
        if (sourceId === undefined) continue;
        const source = await piece.data.view.getNode(sourceId);
        if (
          source?.parent === piece.data.parent &&
          source.ordinal >= piece.offset &&
          source.ordinal < piece.offset + piece.count
        )
          return piece.position + source.ordinal - piece.offset;
      }
    }
    return undefined;
  }
  async getNode(id: string) {
    const result = await this.resolve(id);
    if (!result) return undefined;
    let child = result,
      depth = 0;
    while (child.node.parent !== null) {
      if (++depth > 4096) throw new NbtError(0, "NBT ancestor budget exceeded");
      const parent = await this.resolve(child.node.parent);
      if (!parent || !nbtContainer(parent.node.type)) return undefined;
      const ordinal = await this.ordinal(parent, child.node.id);
      if (ordinal === undefined) return undefined;
      if (child === result) result.node.ordinal = ordinal;
      child = parent;
    }
    return child.node.id === this.baseline.snapshot().root
      ? result.node
      : undefined;
  }
  async getChildren(parent: string, offset: number, limit: number) {
    assertRange(offset, limit);
    if (limit > 512)
      throw new NbtError(0, "Child pages are limited to 512 rows");
    const parentNode = await this.getNode(parent),
      resolved = parentNode && (await this.resolve(parent));
    if (!resolved || !nbtContainer(resolved.node.type)) return [];
    const result: NbtNode[] = [];
    for (const piece of this.childrenSequence(resolved).slices(offset, limit)) {
      const ids =
        piece.data.kind === "ids"
          ? piece.data.ids.slice(piece.offset, piece.offset + piece.count)
          : (
              await piece.data.view.getChildren(
                piece.data.parent,
                piece.offset,
                piece.count,
              )
            ).map((node) =>
              piece.data.kind === "source" && piece.data.copy
                ? wrapCopy(piece.data.copy, node.id)
                : node.id,
            );
      for (let i = 0; i < ids.length; i++) {
        const row = await this.resolve(ids[i]!);
        if (!row || row.node.parent !== parent)
          throw new NbtError(0, "Logical child identity is unavailable");
        row.node.ordinal = piece.position + i;
        result.push(row.node);
      }
    }
    return result;
  }
  text(span: NbtSpan, maxBytes: number, signal?: AbortSignal) {
    return this.data.text(span, this.encoding, maxBytes, signal);
  }
  bytes(span: NbtSpan, signal?: AbortSignal) {
    return this.data.read(span, signal);
  }
  async scalar(
    node: NbtNode,
    signal?: AbortSignal,
  ): Promise<{ value: NbtScalar; truncated: boolean }> {
    signal?.throwIfAborted();
    const resolved = await this.resolve(node.id);
    if (!resolved) throw new NbtError(0, "Logical scalar is unavailable");
    if (node.type === NbtTag.String) {
      const page = await this.text(node.data!, 65535, signal);
      return { value: page.text, truncated: page.truncated };
    }
    if (resolved.record.scalar !== undefined)
      return { value: resolved.record.scalar, truncated: false };
    if (!resolved.origin)
      throw new NbtError(0, "Logical scalar is unavailable");
    return resolved.origin.view.scalar(resolved.origin.node, signal);
  }
  async array(id: string, offset: number, limit: number, signal?: AbortSignal) {
    assertRange(offset, limit);
    if (limit > 4096)
      throw new NbtError(0, "Array pages are limited to 4096 elements");
    const node = await this.getNode(id),
      resolved = node && (await this.resolve(id));
    if (!resolved || !nbtArray(resolved.node.type))
      throw new NbtError(0, "Tag is not a numeric array");
    const values: Array<number | bigint> = [];
    for (const piece of this.arraySequence(resolved).slices(offset, limit)) {
      signal?.throwIfAborted();
      if (piece.data.kind === "source")
        values.push(
          ...(await piece.data.view.array(
            piece.data.id,
            piece.offset,
            piece.count,
            signal,
          )),
        );
      else {
        const type = nbtArrayType(piece.data.type),
          width = type === NbtTag.Byte ? 1 : type === NbtTag.Int ? 4 : 8,
          bytes = await this.bytes(
            {
              ...piece.data.span,
              offset: piece.data.span.offset + piece.offset * width,
              length: piece.count * width,
            },
            signal,
          );
        try {
          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          );
          for (let i = 0; i < piece.count; i++)
            values.push(
              width === 1
                ? view.getInt8(i)
                : width === 4
                  ? view.getInt32(i * 4, true)
                  : view.getBigInt64(i * 8, true),
            );
        } finally {
          bytes.fill(0);
        }
      }
    }
    return values;
  }
  async describe(node: NbtNode, signal?: AbortSignal) {
    const row: NbtDisplayRow = { node, name: "", nameTruncated: false };
    try {
      if (node.name) {
        const text = await this.text(node.name, 512, signal);
        row.name = text.text;
        row.nameTruncated = text.truncated;
      }
      if (node.type === NbtTag.String) {
        const text = await this.text(node.data!, 512, signal);
        row.value = text.text;
        row.valueTruncated = text.truncated;
      } else if (node.type >= NbtTag.Byte && node.type <= NbtTag.Double) {
        const scalar = await this.scalar(node, signal);
        row.value = scalar.value;
        row.valueTruncated = scalar.truncated;
      }
    } catch (error) {
      signal?.throwIfAborted();
      row.error = nbtDocumentError(error);
    }
    return row;
  }
  async raw(
    id: string,
    part: "node" | "header" | "payload",
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const resolved = await this.resolve(id);
    if (!resolved?.origin) return undefined;
    const { record, origin } = resolved;
    if (
      record.type !== undefined ||
      (part !== "payload" && record.name !== undefined) ||
      (part !== "header" && this.state.body.has(id))
    )
      return undefined;
    return origin.view.raw(origin.node.id, part, signal);
  }
  scanNodes(_offset: number, _limit: number): Promise<NbtNode[]> {
    throw new NbtError(
      0,
      "Logical search uses preorder pages, not baseline node offsets",
    );
  }
  async *walkNodes(scope: string | undefined, signal: AbortSignal) {
    const rootId = scope ?? this.snapshot().root,
      root = rootId && (await this.getNode(rootId));
    if (!root) throw new NbtError(0, "Search scope is unavailable");
    let page: NbtNode[] = [],
      next: NbtNode | undefined = root;
    const stack: Array<{
      id: string;
      offset: number;
      ids: string[];
      at: number;
    }> = [];
    while (next || stack.length) {
      signal.throwIfAborted();
      if (next) {
        page.push(next);
        if (nbtContainer(next.type))
          stack.push({ id: next.id, offset: 0, ids: [], at: 0 });
        next = undefined;
        if (page.length === 64) {
          yield page;
          page = [];
          await this.work(signal);
        }
      } else {
        const frame = stack.at(-1)!;
        if (frame.at >= frame.ids.length) {
          const children = await this.getChildren(frame.id, frame.offset, 32);
          frame.ids = children.map((child) => child.id);
          frame.at = 0;
          frame.offset += children.length;
          if (!children.length) {
            stack.pop();
            continue;
          }
        }
        next = await this.getNode(frame.ids[frame.at++]!);
      }
    }
    if (page.length) yield page;
  }
  async count(id: string): Promise<number> {
    const resolved = await this.resolve(id);
    if (!resolved) throw new NbtError(0, "Subtree is unavailable");
    if (resolved.record.count !== undefined) return resolved.record.count;
    if (resolved.origin)
      return resolved.origin.view.count(resolved.origin.node.id);
    return 1;
  }
}
