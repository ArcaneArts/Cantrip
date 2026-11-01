import {
  assertRange,
  NbtError,
  NbtTag,
  type NbtNode,
  type NbtSpan,
} from "../types.js";
import type { NbtReadModel, NbtTablePage } from "./types.js";

/** Compare full names in bounded decoded pages; display truncation never aliases columns. */
async function sameName(
  model: NbtReadModel,
  a: NbtSpan | null,
  b: NbtSpan | null,
  signal: AbortSignal,
) {
  if (!a || !b) return a === b;
  if (a.source === b.source && a.offset === b.offset && a.length === b.length)
    return true;
  let left = a.offset,
    right = b.offset,
    leftText = "",
    rightText = "",
    pages = 0;
  while (
    left < a.offset + a.length ||
    right < b.offset + b.length ||
    leftText ||
    rightText
  ) {
    signal.throwIfAborted();
    if (!leftText && left < a.offset + a.length) {
      const page = await model.text(
        { ...a, offset: left, length: a.offset + a.length - left },
        4096,
        signal,
      );
      left = page.nextByte;
      leftText = page.text;
    }
    if (!rightText && right < b.offset + b.length) {
      const page = await model.text(
        { ...b, offset: right, length: b.offset + b.length - right },
        4096,
        signal,
      );
      right = page.nextByte;
      rightText = page.text;
    }
    const length = Math.min(leftText.length, rightText.length);
    if (!length) return false;
    if (leftText.slice(0, length) !== rightText.slice(0, length)) return false;
    leftText = leftText.slice(length);
    rightText = rightText.slice(length);
    if (++pages % 8 === 0) await model.work(signal, false);
  }
  return true;
}
/** Columns come from a chosen available item. Every field is reachable by paging columns. */
export async function nbtTablePage(
  model: NbtReadModel,
  listId: string,
  first: number,
  limit: number,
  columnOffset: number,
  columnLimit: number,
  referenceOrdinal: number,
  reverse: boolean,
  signal: AbortSignal,
): Promise<NbtTablePage> {
  [first, limit, columnOffset, columnLimit, referenceOrdinal].forEach((value) =>
    assertRange(value, 0),
  );
  if (limit > 32 || columnLimit > 16)
    throw new NbtError(0, "Table pages are limited to 32 items and 16 fields");
  const list = await model.getNode(listId);
  if (
    !list ||
    list.type !== NbtTag.List ||
    list.elementType !== NbtTag.Compound
  )
    throw new NbtError(0, "Table mode requires a list of compounds");
  const reference = (await model.getChildren(listId, referenceOrdinal, 1))[0];
  if (!reference)
    return {
      columns: [],
      rows: [],
      totalRows: list.childCount,
      totalColumns: 0,
      referenceOrdinal,
    };
  const fields = await model.getChildren(
      reference.id,
      columnOffset,
      columnLimit,
    ),
    groups: Array<{
      name: NbtSpan | null;
      selected: Array<{ column: number; occurrence: number }>;
      count: number;
    }> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    let group: (typeof groups)[number] | undefined;
    for (const candidate of groups)
      if (await sameName(model, candidate.name, field.name, signal)) {
        group = candidate;
        break;
      }
    if (!group) {
      group = { name: field.name, selected: [], count: 0 };
      groups.push(group);
    }
    group.selected.push({ column: i, occurrence: 0 });
  }
  for (
    let at = 0;
    at < Math.min(reference.childCount, columnOffset + fields.length);
    at += 128
  ) {
    for (const field of await model.getChildren(reference.id, at, 128)) {
      if (field.ordinal >= columnOffset + fields.length) break;
      for (const group of groups)
        if (await sameName(model, group.name, field.name, signal)) {
          const position = group.count++;
          const selected = group.selected.find(
            (item) => fields[item.column]!.id === field.id,
          );
          if (selected) selected.occurrence = position;
          break;
        }
    }
    await model.work(signal, false);
  }
  const columns = await Promise.all(
    fields.map(async (node) => {
      const row = await model.describe(node, signal);
      return {
        id: node.id,
        ordinal: node.ordinal,
        name: row.name,
        truncated: row.nameTruncated,
      };
    }),
  );
  const rows: NbtTablePage["rows"] = [];
  for (
    let rowOffset = first;
    rowOffset < Math.min(first + limit, list.childCount);
    rowOffset++
  ) {
    const ordinal = reverse ? list.childCount - 1 - rowOffset : rowOffset,
      item = (await model.getChildren(listId, ordinal, 1))[0];
    if (!item) break;
    const cells: Array<NbtNode | null> = fields.map(() => null),
      counts = groups.map(() => 0);
    let found = 0;
    for (let at = 0; at < item.childCount && found < fields.length; at += 128) {
      for (const field of await model.getChildren(item.id, at, 128)) {
        for (let g = 0; g < groups.length; g++) {
          const group = groups[g]!;
          if (await sameName(model, group.name, field.name, signal)) {
            const occurrence = counts[g]!;
            counts[g] = occurrence + 1;
            for (const selected of group.selected)
              if (selected.occurrence === occurrence) {
                cells[selected.column] = field;
                found++;
              }
            break;
          }
        }
      }
      await model.work(signal, false);
    }
    rows.push({
      item: await model.describe(item, signal),
      ordinal,
      cells: await Promise.all(
        cells.map((node) => (node ? model.describe(node, signal) : null)),
      ),
    });
  }
  return {
    columns,
    rows,
    totalRows: list.childCount,
    totalColumns: reference.childCount,
    referenceOrdinal,
  };
}
