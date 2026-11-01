import { NbtStorageError } from "../storage/types.js";
export const INDEX_FANOUT = 256;
export const NODE_FIELDS = 14;
export type IndexPage =
  | { kind: "nodes"; records: number[][] }
  | { kind: "children"; offsets: number[] };
const MAGIC = 0x3149424e;
function validRecord(record: number[]) {
  const nonnegative = (n: number | undefined) =>
    Number.isSafeInteger(n) && n! >= 0;
  return (
    record.length === NODE_FIELDS &&
    [0, 2, 3, 5, 6, 8, 13].every((i) => nonnegative(record[i])) &&
    [1, 4, 7, 9, 10, 12].every(
      (i) => record[i] === -1 || nonnegative(record[i]),
    ) &&
    record[3]! >= 1 &&
    record[3]! <= 12 &&
    (record[9] === -1 || record[9]! <= 12) &&
    record[6]! >= record[0]! &&
    (record[7] === -1 || record[7]! >= record[6]!) &&
    (Number.isNaN(record[11]) ||
      (Number.isInteger(record[11]) &&
        record[11]! >= -2147483648 &&
        record[11]! <= 2147483647))
  );
}
/** Numeric locations only. Names/values remain in the encrypted byte spool. */
export function encodeIndexPage(page: IndexPage): Uint8Array {
  const count =
    page.kind === "children" ? page.offsets.length : page.records.length;
  if (count > INDEX_FANOUT)
    throw new NbtStorageError("NBT index page overflow.");
  if (
    page.kind === "nodes" &&
    page.records.some((record) => !validRecord(record))
  )
    throw new NbtStorageError("Invalid NBT descriptor record.");
  const numbers = page.kind === "children" ? page.offsets : page.records.flat();
  const bytes = new Uint8Array(12 + numbers.length * 8),
    view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, page.kind === "nodes" ? 1 : 2, true);
  view.setUint32(8, count, true);
  numbers.forEach((value, i) => view.setFloat64(12 + i * 8, value, true));
  return bytes;
}
export function decodeIndexPage(bytes: Uint8Array): IndexPage {
  const bad = () => new NbtStorageError("Invalid NBT index page.");
  if (bytes.length < 12) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    kind = view.getUint32(4, true),
    count = view.getUint32(8, true);
  const fields = kind === 1 ? count * NODE_FIELDS : kind === 2 ? count : -1;
  if (
    view.getUint32(0, true) !== MAGIC ||
    count > INDEX_FANOUT ||
    fields < 0 ||
    bytes.length !== 12 + fields * 8
  )
    throw bad();
  const numbers = Array.from({ length: fields }, (_, i) =>
    view.getFloat64(12 + i * 8, true),
  );
  if (kind === 2) {
    if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) throw bad();
    return { kind: "children", offsets: numbers };
  }
  const records = Array.from({ length: count }, (_, i) =>
    numbers.slice(i * NODE_FIELDS, (i + 1) * NODE_FIELDS),
  );
  if (records.some((record) => !validRecord(record))) throw bad();
  return { kind: "nodes", records };
}
