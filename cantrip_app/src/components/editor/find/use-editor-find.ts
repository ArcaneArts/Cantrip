import { useEffect, useRef, useState } from "react";
import type { EditorDocumentSession } from "../document-session";
import type { FindRequest, FindResult, FindResponse } from "./index";

export function useEditorFind(
  session: EditorDocumentSession,
  active: boolean,
  ready = true,
) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  const [result, setResult] = useState<
    (FindResult & { reveal: boolean }) | null
  >(null);
  const [failed, setFailed] = useState(false);
  const worker = useRef<Worker | null>(null),
    pendingMoves = useRef(0),
    revealNext = useRef(false);
  const anchor = useRef(session.selection.start);
  anchor.current = session.selection.start;
  const fence = useRef({
    session,
    revision: session.revision,
    query,
    open,
    active,
    ready,
    requestId: 0,
  });
  const previous = fence.current;
  if (
    previous.session !== session ||
    previous.revision !== session.revision ||
    previous.query !== query ||
    previous.open !== open ||
    previous.active !== active ||
    previous.ready !== ready
  ) {
    if (previous.query !== query || (!previous.open && open))
      revealNext.current = true;
    else if (
      previous.session !== session ||
      previous.active !== active ||
      !open ||
      (previous.revision !== session.revision && previous.ready)
    )
      revealNext.current = false;
    if (
      previous.query !== query ||
      previous.session !== session ||
      previous.open !== open ||
      previous.active !== active
    )
      pendingMoves.current = 0;
    fence.current = {
      session,
      revision: session.revision,
      query,
      open,
      active,
      ready,
      requestId: previous.requestId + 1,
    };
  }
  useEffect(() => {
    if (!open || !active) return;
    let next: Worker;
    try {
      next = new Worker(new URL("./find.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      setFailed(true);
      return;
    }
    worker.current = next;
    setFailed(false);
    next.onmessage = (
      event: MessageEvent<FindResponse | { requestId: number; error: true }>,
    ) => {
      if (
        worker.current !== next ||
        event.data.requestId !== fence.current.requestId
      )
        return;
      if ("error" in event.data) {
        setFailed(true);
        return;
      }
      const direction = pendingMoves.current;
      pendingMoves.current = 0;
      if (direction && event.data.count) {
        next.postMessage({
          type: "move",
          requestId: event.data.requestId,
          direction,
        } satisfies FindRequest);
        return;
      }
      setResult({
        ...event.data,
        reveal: event.data.action === "move" || revealNext.current,
      });
      revealNext.current = false;
      setFailed(false);
    };
    next.onerror = () => {
      if (worker.current === next) setFailed(true);
    };
    return () => {
      if (worker.current === next) worker.current = null;
      next.terminate();
    };
  }, [open, active]);
  useEffect(() => {
    const current = worker.current;
    if (!current || !open || !active || !ready) return;
    const requestId = fence.current.requestId;
    const timer = setTimeout(
      () =>
        current.postMessage({
          type: "search",
          requestId,
          text: query ? session.text : "",
          query,
          anchor: anchor.current,
        } satisfies FindRequest),
      75,
    );
    return () => clearTimeout(timer);
  }, [open, active, ready, session, session.revision, query]);
  const current =
    open && active && ready && result?.requestId === fence.current.requestId
      ? result
      : null;
  return {
    open,
    query,
    focusToken,
    result: current,
    failed,
    show(seed?: string) {
      if (seed !== undefined) setQuery(seed);
      setOpen(true);
      setFocusToken((value) => value + 1);
    },
    close() {
      setOpen(false);
    },
    setQuery,
    move(direction: 1 | -1) {
      if (!current && query) {
        pendingMoves.current += direction;
        return;
      }
      if (current?.count)
        worker.current?.postMessage({
          type: "move",
          requestId: fence.current.requestId,
          direction,
        } satisfies FindRequest);
    },
  };
}
export type EditorFindState = ReturnType<typeof useEditorFind>;
