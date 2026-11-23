/** Standard NBT tags. End is a compound terminator, never an editable value. */
export enum NbtTag {
  End,
  Byte,
  Short,
  Int,
  Long,
  Float,
  Double,
  ByteArray,
  String,
  List,
  Compound,
  IntArray,
  LongArray,
}
export type NbtEndian = "big" | "little" | "little-varint";
export interface NbtEncoding {
  endian: NbtEndian;
  namedRoot: boolean;
  strings: "mutf8" | "utf8";
  bedrockLevel: boolean;
}
export type NbtCompression = "none" | "gzip" | "zlib";
export interface NbtFormat extends NbtEncoding {
  compression: NbtCompression;
}
export const JAVA_NBT: Readonly<NbtFormat> = Object.freeze({
  endian: "big",
  namedRoot: true,
  strings: "mutf8",
  bedrockLevel: false,
  compression: "none",
});
export const BEDROCK_NBT: Readonly<NbtFormat> = Object.freeze({
  endian: "little",
  namedRoot: true,
  strings: "utf8",
  bedrockLevel: false,
  compression: "none",
});
export const NETWORK_NBT: Readonly<NbtFormat> = Object.freeze({
  endian: "little-varint",
  namedRoot: false,
  strings: "utf8",
  bedrockLevel: false,
  compression: "none",
});
export interface NbtSpan {
  /** Logical edit storage; absent for immutable file byte ranges. */
  source?: string;
  offset: number;
  length: number;
}
/** Immutable snapshot; short reads are allowed, an empty read means EOF. */
export interface NbtByteSource {
  readonly size: number | undefined;
  read(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
/** IDs are opaque, stable preorder sequences within one immutable document revision. */
export interface NbtNode {
  id: string;
  parent: string | null;
  ordinal: number;
  type: NbtTag;
  name: NbtSpan | null;
  start: number;
  payload: number;
  end: number | null;
  childCount: number;
  elementType?: NbtTag;
  length?: number;
  declaredLength?: number;
  data?: NbtSpan;
}
/** Implementations may page/encrypt records. No parsed values live in the index. */
export interface NbtIndexStore {
  put(node: NbtNode): Promise<void>;
  get(id: string): Promise<NbtNode | undefined>;
  children(parent: string, offset: number, limit: number): Promise<NbtNode[]>;
}
export interface NbtScanResult {
  root: string;
  bytes: number;
  nodes: number;
  levelVersion?: number;
}
export type NbtScalar = number | bigint | string;
export type NbtValue =
  | {
      type:
        NbtTag.Byte | NbtTag.Short | NbtTag.Int | NbtTag.Float | NbtTag.Double;
      value: number;
    }
  | { type: NbtTag.Long; value: bigint }
  | { type: NbtTag.String; value: string }
  | {
      type: NbtTag.ByteArray | NbtTag.IntArray;
      value: Iterable<number>;
      length: number;
    }
  | { type: NbtTag.LongArray; value: Iterable<bigint>; length: number }
  | {
      type: NbtTag.List;
      elementType: NbtTag;
      value: Iterable<NbtValue>;
      length: number;
    }
  | { type: NbtTag.Compound; value: Iterable<NbtEntry> };
export interface NbtEntry {
  name: string;
  tag: NbtValue;
}
export class NbtError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(`${message} (byte ${offset}).`);
    this.name = "NbtError";
  }
}
export const NBT_CHUNK_BYTES = 64 * 1024;
export function assertTag(
  type: number,
  offset: number,
): asserts type is NbtTag {
  if (!Number.isInteger(type) || type < NbtTag.End || type > NbtTag.LongArray)
    throw new NbtError(offset, "Unknown NBT tag type");
}
export function assertRange(offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  )
    throw new NbtError(offset, "Invalid byte range");
}
