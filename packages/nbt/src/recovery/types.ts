import type { NbtEditOperation, NbtSaveTarget } from "../edit/types.js";
import type { NbtFormat } from "../types.js";

/** The journal contains user operations, never an expanded document object. */
export type NbtRecoveryEvent =
  | {
      kind: "apply";
      allocationStart: number;
      allocationEnd: number;
      operations: NbtEditOperation[];
      label: string;
    }
  | { kind: "undo" | "redo" }
  | { kind: "save.begin"; id: string; target?: NbtSaveTarget }
  | {
      kind: "save.ready";
      id: string;
      metadata: { size: number; sha256: string };
    }
  | { kind: "save.ack"; id: string; version: string }
  | { kind: "save.fail"; id: string; uncertain: boolean; retain: boolean };

export interface NbtRecoveryWriter {
  prepare(signal: AbortSignal): Promise<void>;
  append(event: NbtRecoveryEvent): Promise<void>;
}

export interface NbtRecoveryDescriptor {
  format: NbtFormat;
  version: string;
  size: number;
  sha256: string;
  events: number;
}

/** Only authenticated ciphertext is persisted. Revision is a CAS fence shared
 * by renderers, not evidence that a previous renderer has stopped. */
export interface NbtRecoveryRecord {
  revision: number;
  bytes: Uint8Array | null;
}
export interface NbtRecoveryStore {
  head(): Promise<NbtRecoveryRecord>;
  commit(expectedRevision: number, bytes: Uint8Array | null): Promise<number>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class NbtRecoveryConflict extends Error {
  constructor() {
    super(
      "This NBT recovery journal changed in another view. Reopen the document before editing.",
    );
    this.name = "NbtRecoveryConflict";
  }
}
