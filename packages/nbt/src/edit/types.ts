import type { NbtTag, NbtSpan, NbtNode, NbtScalar } from "../types.js";
import type { NbtReadModel } from "../view/types.js";
import type { NbtSequence, NbtPersistentMap } from "./persistent.js";
export type NbtEditValue = {
  type: NbtTag;
  value?: string;
  values?: string[];
  elementType?: NbtTag;
  children?: Array<{ name: string; tag: NbtEditValue }>;
  items?: NbtEditValue[];
};
export type NbtEditOperation =
  | { type: "value"; id: string; value: string }
  | { type: "rename"; id: string; name: string }
  | {
      type: "insert";
      parent: string;
      index: number;
      name?: string;
      value: NbtEditValue;
    }
  | { type: "delete"; id: string }
  | {
      type: "duplicate";
      id: string;
      parent: string;
      index: number;
      name?: string;
    }
  | { type: "replace"; id: string; value: NbtEditValue }
  | {
      type: "array.splice";
      id: string;
      index: number;
      remove: number;
      values: string[];
    }
  | {
      type: "string.splice";
      id: string;
      offset: number;
      remove: number;
      text: string;
    };
export interface NbtEditStatus {
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  version: string;
  saving: boolean;
  /** Client-side mutation acknowledgement is still in flight. */
  editing?: boolean;
  pendingSaveId?: string;
  pendingSave?: NbtPendingSave;
  uncertain: boolean;
}
export interface NbtSaveTarget {
  path: string;
  copy: boolean;
}
export interface NbtPendingSave {
  id: string;
  version: string;
  revision: number;
  target?: NbtSaveTarget;
  /** Persisted after the worker acknowledged the complete uploaded stream and
   * before requesting publication. Recovery can verify its durable receipt. */
  metadata?: { size: number; sha256: string };
}
export interface NbtSerializableModel extends NbtReadModel {
  /** Encoded fixed-width array elements in this model's original byte order.
   * Chunks are borrowed until the next iterator step and must be consumed then. */
  arrayBytes?(
    id: string,
    offset: number,
    count: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  raw(
    id: string,
    part: "node" | "header" | "payload",
    signal?: AbortSignal,
  ): Promise<
    | {
        model: NbtSerializableModel;
        span: NbtSpan;
        header: "named" | "unnamed" | "none";
      }
    | undefined
  >;
  count(id: string): Promise<number>;
  bytes(span: NbtSpan, signal?: AbortSignal): Promise<Uint8Array>;
  walkNodes?(
    scope: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<NbtNode[]>;
}
export interface NbtCopy {
  prefix: string;
  sourcePrefix: string;
  root: string;
  parent: string;
  view: NbtSerializableModel;
}
export type NbtChildPart =
  | {
      kind: "source";
      view: NbtSerializableModel;
      parent: string;
      copy?: NbtCopy;
    }
  | { kind: "ids"; ids: readonly string[] };
export type NbtArrayPart =
  | { kind: "source"; view: NbtSerializableModel; id: string }
  | { kind: "bytes"; span: NbtSpan; type: NbtTag };
export interface NbtEditRecord {
  count?: number;
  created?: NbtNode;
  name?: NbtSpan | null;
  type?: NbtTag;
  elementType?: NbtTag;
  scalar?: NbtScalar;
  text?: NbtSpan;
  children?: NbtSequence<NbtChildPart>;
  array?: NbtSequence<NbtArrayPart>;
}
export interface NbtEditState {
  nodes: number;
  records: NbtPersistentMap<NbtEditRecord>;
  body: NbtPersistentMap<true>;
}
