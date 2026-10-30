import { useEffect, useRef, useState } from "react";
import { textChange, type HighlightedLine } from "./syntax/document";
import {
  isCurrentHighlight,
  type SyntaxRequest,
  type SyntaxResponse,
} from "./syntax/worker-protocol";

const HIGHLIGHT_BLOCK = 128;
const MAX_CACHED_LINES = 2048;

export function useSyntaxHighlighting(
  documentId: string,
  path: string,
  text: string,
  revision: number,
  first: number,
  last: number,
  active = true,
): ReadonlyMap<number, HighlightedLine> {
  const [, redraw] = useState(0);
  const current = useRef({ documentId, revision, first, last });
  current.current = { documentId, revision, first, last };
  const cache = useRef({
    documentId,
    revision,
    lines: new Map<number, HighlightedLine>(),
  });
  if (
    cache.current.documentId !== documentId ||
    cache.current.revision !== revision
  )
    cache.current = { documentId, revision, lines: new Map() };
  // Prefetch on both sides in stable blocks. Scrolling within a block reuses
  // existing tokens without sending work or waiting for a viewport-exact reply.
  const requestFirst = Math.max(
    0,
    Math.floor(first / HIGHLIGHT_BLOCK) * HIGHLIGHT_BLOCK - HIGHLIGHT_BLOCK,
  );
  const requestLast =
    Math.ceil(last / HIGHLIGHT_BLOCK) * HIGHLIGHT_BLOCK + HIGHLIGHT_BLOCK;
  const transport = useRef<{
    worker: Worker;
    documentId: string;
    text: string;
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (!active) return;
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./syntax/syntax.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      return;
    }
    transport.current = { worker, documentId: "", text: "", revision: -1 };
    worker.onmessage = (event: MessageEvent<SyntaxResponse>) => {
      const latest = current.current;
      if (!isCurrentHighlight(event.data, latest.documentId, latest.revision))
        return;
      const lines = cache.current.lines;
      let visibleChanged = false;
      for (const line of event.data.lines) {
        if (lines.has(line.number)) continue;
        lines.set(line.number, line);
        if (line.number > latest.first && line.number <= latest.last)
          visibleChanged = true;
      }
      // Keep memory bounded without evicting the currently painted lines.
      for (const number of lines.keys()) {
        if (lines.size <= MAX_CACHED_LINES) break;
        if (number <= latest.first || number > latest.last)
          lines.delete(number);
      }
      if (visibleChanged) redraw((value) => value + 1);
    };
    return () => {
      transport.current = null;
      worker.onmessage = null;
      worker.terminate();
    };
  }, [active]);
  useEffect(() => {
    const target = transport.current;
    if (!target) return;
    let message: SyntaxRequest;
    if (target.documentId !== documentId)
      message = {
        type: "open",
        documentId,
        path,
        text,
        revision,
        first: requestFirst,
        last: requestLast,
      };
    else if (target.text !== text)
      message = {
        type: "edit",
        documentId,
        revision,
        baseRevision: target.revision,
        change: textChange(target.text, text),
        first: requestFirst,
        last: requestLast,
      };
    else
      message = {
        type: "viewport",
        documentId,
        revision,
        first: requestFirst,
        last: requestLast,
      };
    target.worker.postMessage(message);
    target.documentId = documentId;
    target.text = text;
    target.revision = revision;
  }, [active, documentId, path, text, revision, requestFirst, requestLast]);
  return cache.current.lines;
}
