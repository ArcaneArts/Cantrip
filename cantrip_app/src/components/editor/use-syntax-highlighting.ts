import { useEffect, useRef, useState } from "react";
import { textChange, type HighlightedLine } from "./syntax/document";
import {
  isCurrentHighlight,
  type SyntaxRequest,
  type SyntaxResponse,
} from "./syntax/worker-protocol";

export function useSyntaxHighlighting(
  documentId: string,
  path: string,
  text: string,
  revision: number,
  first: number,
  last: number,
  active = true,
): HighlightedLine[] {
  const [result, setResult] = useState<SyntaxResponse | null>(null);
  const current = useRef({ documentId, revision, first });
  current.current = { documentId, revision, first };
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
      if (
        isCurrentHighlight(
          event.data,
          latest.documentId,
          latest.revision,
          latest.first,
        )
      )
        setResult(event.data);
    };
    worker.onerror = () => {
      setResult(null);
    };
    return () => {
      transport.current = null;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
  }, [active]);
  useEffect(() => {
    const target = transport.current;
    if (!target) return;
    let message: SyntaxRequest;
    if (target.documentId !== documentId)
      message = { type: "open", documentId, path, text, revision, first, last };
    else if (target.text !== text)
      message = {
        type: "edit",
        documentId,
        revision,
        baseRevision: target.revision,
        change: textChange(target.text, text),
        first,
        last,
      };
    else message = { type: "viewport", documentId, revision, first, last };
    target.worker.postMessage(message);
    target.documentId = documentId;
    target.text = text;
    target.revision = revision;
  }, [active, documentId, path, text, revision, first, last]);
  return result && isCurrentHighlight(result, documentId, revision, first)
    ? result.lines
    : [];
}
