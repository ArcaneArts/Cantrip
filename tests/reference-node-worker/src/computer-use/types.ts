// Shared browser-compatible cursor/target and wire-data contracts. Only this
// native worker return type adds raw process-owned PNG bytes.
export * from "@cantrip/protocol/computer-use";
import type { CuaSnapshot as CuaSnapshotMetadata } from "@cantrip/protocol/computer-use";
export type CuaSnapshot = CuaSnapshotMetadata & { payload: Buffer };
