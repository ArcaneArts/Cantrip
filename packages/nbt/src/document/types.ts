import type {
  NbtEditOperation,
  NbtEditStatus,
  NbtSaveTarget,
} from "../edit/types.js";
import type { NbtSearchQuery, NbtSearchStatus } from "../search/types.js";
import type {
  NbtByteSource,
  NbtFormat,
  NbtNode,
  NbtScalar,
  NbtScanResult,
} from "../types.js";

export interface NbtDocumentStatus {
  revision?: number;
  state: "indexing" | "paused" | "complete" | "error" | "closed";
  root: string | null;
  availableBytes: number;
  indexedBytes: number;
  sourceBytesRead: number;
  nodes: number;
  cacheBytes: number;
  indexPages: number;
  peakIndexPages: number;
  error?: { message: string; offset?: number };
}
export interface NbtDisplayRow {
  node: NbtNode;
  name: string;
  nameTruncated: boolean;
  value?: NbtScalar;
  valueTruncated?: boolean;
  error?: { message: string; offset?: number };
}
export interface NbtDocumentOpenOptions {
  binding: string;
  version?: string;
  format: NbtFormat;
  cacheBytes?: number;
  indexPages?: number;
  fallbackCompression?: boolean;
  /** Vault-wrapped key is unwrapped by the client; no account key enters the parser. */
  recovery?: { id: string; key: CryptoKey };
}
export interface NbtDocumentSource extends NbtByteSource {
  readonly version?: string;
  close?(): void;
}
export type NbtDocumentInput =
  | { kind: "blob"; blob: Blob }
  | { kind: "remote"; size: number }
  | { kind: "recovery" };
export type NbtDocumentCommand =
  | { type: "open"; input: NbtDocumentInput; options: NbtDocumentOpenOptions }
  | { type: "rows"; parent: string | null; offset: number; limit: number }
  | { type: "array"; id: string; offset: number; limit: number }
  | { type: "node"; id: string }
  | { type: "ancestors"; id: string }
  | {
      type: "tree";
      expanded: string[];
      offset: number;
      limit: number;
      anchor?: string;
    }
  | {
      type: "table";
      id: string;
      offset: number;
      limit: number;
      columnOffset: number;
      columnLimit: number;
      referenceOrdinal: number;
      reverse: boolean;
    }
  | { type: "search.start"; id: string; query: NbtSearchQuery }
  | { type: "search.page"; id: string; offset: number; limit: number }
  | { type: "search.cancel"; id: string }
  | {
      type: "edit.apply";
      operations: NbtEditOperation[];
      revision: number;
      label?: string;
    }
  | { type: "edit.undo" }
  | { type: "edit.redo" }
  | {
      type: "edit.text";
      id: string;
      field: "name" | "value";
      offset: number;
      limit: number;
    }
  | { type: "save.begin"; saveId: string; target?: NbtSaveTarget }
  | { type: "save.ready"; saveId: string; metadata: NbtSerializationReceipt }
  | { type: "save.ack"; saveId: string; version: string }
  | { type: "save.fail"; saveId: string; uncertain: boolean; retain?: boolean }
  | { type: "recovery.clear" }
  | { type: "recovery.attach"; id: string; key: CryptoKey }
  | { type: "pause"; paused: boolean }
  | {
      type: "serialize.begin";
      exportId: string;
      original: boolean;
      saveId?: string;
    }
  | { type: "serialize.next"; exportId: string }
  | { type: "serialize.cancel"; exportId: string }
  | { type: "close" };
export type NbtDocumentRequest =
  | { type: "request"; id: number; command: NbtDocumentCommand }
  | { type: "cancel"; id: number }
  | { type: "source.result"; id: number; bytes?: Uint8Array; error?: string };
export type NbtDocumentResponse =
  | {
      type: "result";
      id: number;
      value: unknown;
      error?: { message: string; offset?: number };
    }
  | { type: "status"; status: NbtDocumentStatus }
  | { type: "edit.status"; status: NbtEditStatus }
  | { type: "search.status"; status: NbtSearchStatus }
  | { type: "source.read"; id: number; offset: number; length: number }
  | { type: "source.cancel"; id: number };
export interface NbtMessageEndpoint<In, Out> {
  postMessage(message: Out, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<In>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<In>) => void,
  ): void;
}
export type NbtCompletedDocument = NbtScanResult;

export interface NbtSerializationReceipt {
  size: number;
  sha256: string;
}
