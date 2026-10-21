import type { HighlightedLine, TextChange } from "./document";

export type SyntaxRequest =
  | {
      type: "open";
      documentId: string;
      revision: number;
      path: string;
      text: string;
      first: number;
      last: number;
    }
  | {
      type: "edit";
      documentId: string;
      revision: number;
      baseRevision: number;
      change: TextChange;
      first: number;
      last: number;
    }
  | {
      type: "viewport";
      documentId: string;
      revision: number;
      first: number;
      last: number;
    };

export interface SyntaxResponse {
  documentId: string;
  revision: number;
  first: number;
  lines: HighlightedLine[];
}

export function isCurrentHighlight(
  response: SyntaxResponse,
  documentId: string,
  revision: number,
  first: number,
): boolean {
  return (
    response.documentId === documentId &&
    response.revision === revision &&
    response.first === first
  );
}
