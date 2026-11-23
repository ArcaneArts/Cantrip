import type { NbtNode, NbtSpan, NbtEncoding, NbtScalar } from "../types.js";
import type { NbtDisplayRow, NbtDocumentStatus } from "../document/types.js";

/** All browsing/search reads use one logical model; edit overlays extend this boundary. */
export interface NbtReadModel {
  walkNodes?(
    scope: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<NbtNode[]>;
  snapshot(): NbtDocumentStatus;
  getNode(id: string): Promise<NbtNode | undefined>;
  getChildren(
    parent: string,
    offset: number,
    limit: number,
  ): Promise<NbtNode[]>;
  describe(node: NbtNode, signal?: AbortSignal): Promise<NbtDisplayRow>;
  text(
    span: NbtSpan,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean; nextByte: number }>;
  scalar(
    node: NbtNode,
    signal?: AbortSignal,
  ): Promise<{ value: NbtScalar; truncated: boolean }>;
  array(
    id: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<number | bigint>>;
  scanNodes(offset: number, limit: number): Promise<NbtNode[]>;
  changeRevision(): number;
  waitForChange(revision: number, signal: AbortSignal): Promise<void>;
  work(signal: AbortSignal, background?: boolean): Promise<void>;
  validated(signal: AbortSignal): Promise<void>;
  readonly encoding: NbtEncoding;
}
export interface NbtTreeRow {
  row: NbtDisplayRow;
  depth: number;
  index: number;
  expanded: boolean;
}
export interface NbtTreePage {
  rows: NbtTreeRow[];
  total: number;
  anchorIndex?: number;
}
export interface NbtPathEntry {
  id: string;
  parent: string | null;
  ordinal: number;
  type: number;
}
export interface NbtTableColumn {
  id: string;
  ordinal: number;
  name: string;
  truncated: boolean;
}
export interface NbtTableRow {
  item: NbtDisplayRow;
  ordinal: number;
  cells: Array<NbtDisplayRow | null>;
}
export interface NbtTablePage {
  columns: NbtTableColumn[];
  rows: NbtTableRow[];
  totalRows: number;
  totalColumns: number;
  referenceOrdinal: number;
}
