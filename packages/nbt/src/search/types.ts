export type NbtSearchField = "name" | "value" | "type" | "path";
export interface NbtSearchQuery {
  text: string;
  fields: NbtSearchField[];
  caseSensitive: boolean;
  exactNumber: boolean;
  scope?: string;
}
export interface NbtSearchStatus {
  id: string;
  state: "searching" | "complete" | "cancelled" | "error";
  count: number;
  scannedNodes: number;
  error?: { message: string; offset?: number };
}
export interface NbtSearchResult {
  id: string;
  nodeId: string;
  elementIndex?: number;
  fields: NbtSearchField[];
}
