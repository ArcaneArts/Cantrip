import type {
  NbtByteSource,
  NbtFormat,
  NbtNode,
  NbtScalar,
  NbtScanResult,
} from "../types.js";

export interface NbtDocumentStatus {
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
  format: NbtFormat;
  cacheBytes?: number;
  indexPages?: number;
  fallbackCompression?: boolean;
}
export interface NbtDocumentSource extends NbtByteSource {
  close?(): void;
}
export type NbtDocumentInput =
  { kind: "blob"; blob: Blob } | { kind: "remote"; size: number };
export type NbtDocumentCommand =
  | { type: "open"; input: NbtDocumentInput; options: NbtDocumentOpenOptions }
  | { type: "rows"; parent: string | null; offset: number; limit: number }
  | { type: "array"; id: string; offset: number; limit: number }
  | { type: "pause"; paused: boolean }
  | { type: "serialize.begin"; exportId: string; original: boolean }
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
