import {
  BEDROCK_NBT,
  JAVA_NBT,
  NETWORK_NBT,
  type NbtCompression,
  type NbtFormat,
  NbtTag,
} from "@cantrip/nbt";
import {
  NBT_TYPE_NAMES,
  nbtScalarText,
  type NbtDisplayRow,
} from "@cantrip/nbt/document";
export { NBT_TYPE_NAMES, nbtScalarText };
export const NBT_PROFILES = [
  { id: "auto", label: "Automatic" },
  { id: "java", label: "Java · big-endian" },
  { id: "java-unnamed", label: "Java · unnamed root" },
  { id: "bedrock", label: "Bedrock · little-endian" },
  { id: "bedrock-level", label: "Bedrock level.dat" },
  { id: "network", label: "Network · little-varint" },
  { id: "network-named", label: "Network · named root" },
];
export function nbtFormat(
  profile: string,
  compressionChoice: string,
  header: Uint8Array,
  size: number,
): NbtFormat {
  const detected: NbtCompression =
    header[0] === 0x1f && header[1] === 0x8b
      ? "gzip"
      : header.length >= 2 &&
          (header[0]! & 15) === 8 &&
          ((header[0]! << 8) | header[1]!) % 31 === 0
        ? "zlib"
        : "none";
  const compression =
    compressionChoice === "auto"
      ? detected
      : (compressionChoice as NbtCompression);
  const level =
    header.length >= 8 &&
    compression === "none" &&
    new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      4,
      true,
    ) ===
      size - 8;
  const choice =
    profile === "auto" ? (level ? "bedrock-level" : "java") : profile;
  return {
    ...(choice.startsWith("bedrock")
      ? BEDROCK_NBT
      : choice.startsWith("network")
        ? NETWORK_NBT
        : JAVA_NBT),
    compression,
    namedRoot:
      choice === "java-unnamed"
        ? false
        : choice === "network-named"
          ? true
          : !choice.startsWith("network"),
    bedrockLevel: choice === "bedrock-level",
  };
}
export function nbtRowValue(row: NbtDisplayRow) {
  if (row.error) return row.error.message;
  if (row.value !== undefined)
    return nbtScalarText(row.value) + (row.valueTruncated ? "…" : "");
  const node = row.node;
  if (node.length !== undefined)
    return (
      node.length.toLocaleString() + (node.length === 1 ? " item" : " items")
    );
  return (
    node.childCount.toLocaleString() +
    (node.childCount === 1 ? " entry" : " entries") +
    (node.end === null ? " so far" : "")
  );
}
export function numericArray(node: { type: NbtTag }) {
  return [NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(
    node.type,
  );
}
export function container(node: { type: NbtTag }) {
  return node.type === NbtTag.List || node.type === NbtTag.Compound;
}
export function hexValue(value: number | bigint, type: NbtTag) {
  const bits =
    type === NbtTag.ByteArray ? 8 : type === NbtTag.IntArray ? 32 : 64;
  return (
    "0x" +
    BigInt.asUintN(bits, BigInt(value))
      .toString(16)
      .padStart(bits / 4, "0")
  );
}
export const nbtControl =
  "h-7 rounded border border-border/60 bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40";
