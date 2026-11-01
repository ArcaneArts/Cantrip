import type { NbtFormat } from "@cantrip/nbt";
import type { NbtDocumentStatus, NbtSearchField } from "@cantrip/nbt/document";

export interface NbtTreeViewState {
  position: number;
  rank: number;
}
export interface NbtArrayViewState {
  firstElement: number;
  hex: boolean;
}
export interface NbtTableViewState {
  position: number;
  scrollLeft: number;
  columnOffset: number;
  reference: number;
  reverse: boolean;
}
export interface NbtFindViewState {
  text: string;
  fields: NbtSearchField[];
  caseSensitive: boolean;
  exactNumber: boolean;
  scope?: string;
  rank: number;
}
/** Private encrypted transfer/recovery payload only. No document values, source
 * bytes, parsed tree snapshots, or display paths belong in this sparse state. */
export interface NbtViewState {
  viewer: "nbt";
  version: 1;
  baselineVersion: string;
  format: NbtFormat;
  profile: string;
  compression: string;
  expanded: string[];
  selected: string | null;
  target: string | null;
  mode: "tree" | "array" | "table";
  editing: boolean;
  findOpen: boolean;
  tree: NbtTreeViewState;
  array?: NbtArrayViewState;
  table?: NbtTableViewState;
  find?: NbtFindViewState;
}
export interface NbtViewHandle<T> {
  capture(): T;
}
const invalid = (): never => {
  throw new Error("Invalid NBT view transfer state.");
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const text = (value: unknown) =>
  typeof value === "string" ? value : invalid();
const id = (value: unknown) => text(value) || invalid();
const optionalId = (value: unknown) => (value === null ? null : id(value));
const bool = (value: unknown) =>
  typeof value === "boolean" ? value : invalid();
const position = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : invalid();
const integer = (value: unknown) =>
  Number.isSafeInteger(position(value)) ? (value as number) : invalid();
const choice = <T extends string>(value: unknown, options: readonly T[]): T =>
  options.includes(value as T) ? (value as T) : invalid();

/** Copy validated known fields; unknown input can never carry document data
 * through a generic custom-viewer field. Account/document scope is checked by
 * validateExplorerTransfer before this format-specific decoder is called. */
export function validateNbtViewState(value: unknown): NbtViewState {
  const state = object(value),
    format = object(state.format),
    tree = object(state.tree);
  if (
    state.viewer !== "nbt" ||
    state.version !== 1 ||
    !Array.isArray(state.expanded)
  )
    invalid();
  const result: NbtViewState = {
    viewer: "nbt",
    version: 1,
    baselineVersion: id(state.baselineVersion),
    format: {
      endian: choice(format.endian, ["big", "little", "little-varint"]),
      namedRoot: bool(format.namedRoot),
      strings: choice(format.strings, ["utf8", "mutf8"]),
      bedrockLevel: bool(format.bedrockLevel),
      compression: choice(format.compression, ["none", "gzip", "zlib"]),
    },
    profile: choice(state.profile, [
      "auto",
      "java",
      "java-unnamed",
      "bedrock",
      "bedrock-level",
      "network",
      "network-named",
    ]),
    compression: choice(state.compression, ["auto", "none", "gzip", "zlib"]),
    expanded: [...new Set((state.expanded as unknown[]).map(id))],
    selected: optionalId(state.selected),
    target: optionalId(state.target),
    mode: choice(state.mode, ["tree", "array", "table"]),
    editing: bool(state.editing),
    findOpen: bool(state.findOpen),
    tree: { position: position(tree.position), rank: integer(tree.rank) },
  };
  if (state.array !== undefined) {
    const array = object(state.array);
    result.array = {
      firstElement: integer(array.firstElement),
      hex: bool(array.hex),
    };
  }
  if (state.table !== undefined) {
    const table = object(state.table);
    result.table = {
      position: position(table.position),
      scrollLeft: position(table.scrollLeft),
      columnOffset: integer(table.columnOffset),
      reference: integer(table.reference),
      reverse: bool(table.reverse),
    };
  }
  if (state.find !== undefined) {
    const find = object(state.find);
    if (
      !Array.isArray(find.fields) ||
      !Number.isSafeInteger(find.rank) ||
      (find.rank as number) < -1
    )
      invalid();
    result.find = {
      text: text(find.text),
      fields: [
        ...new Set(
          (find.fields as unknown[]).map((field) =>
            choice(field, ["name", "value", "type", "path"] as const),
          ),
        ),
      ],
      caseSensitive: bool(find.caseSensitive),
      exactNumber: bool(find.exactNumber),
      rank: find.rank as number,
      ...(find.scope === undefined ? {} : { scope: id(find.scope) }),
    };
  }
  return result;
}
/** A journal replay preserves preorder IDs across owner generations. A fresh
 * physical parse after structural saves may reuse those IDs for different tags,
 * even when edit.version equals the latest save receipt. Bind to the original
 * parser baseline and encoding instead. */
export function nbtViewMatches(state: NbtViewState, status: NbtDocumentStatus) {
  const a = state.format,
    b = status.format;
  return (
    state.baselineVersion === status.baselineVersion &&
    b !== undefined &&
    a.endian === b.endian &&
    a.namedRoot === b.namedRoot &&
    a.strings === b.strings &&
    a.bedrockLevel === b.bedrockLevel &&
    a.compression === b.compression
  );
}
