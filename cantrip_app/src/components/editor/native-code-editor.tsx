import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SyntaxToken } from "./syntax/types";
import type {
  EditorDocumentSession,
  EditorSelection,
} from "./document-session";
import { applyTextChange } from "./document-session";
import { indentationChange } from "./input-history";
import {
  EDITOR_LINE_HEIGHT,
  EDITOR_VERTICAL_PADDING,
  EditorLineIndex,
  editorViewport,
} from "./viewport";
import { useSyntaxHighlighting } from "./use-syntax-highlighting";
import "./native-code-editor.css";

const selection = (input: HTMLTextAreaElement): EditorSelection => ({
  start: input.selectionStart,
  end: input.selectionEnd,
  direction: input.selectionDirection,
});

const NO_TOKENS: SyntaxToken[] = [];
const PaintedLine = memo(function PaintedLine({
  line,
  number,
  tokens,
}: {
  line: string;
  number: number;
  tokens: SyntaxToken[];
}) {
  return (
    <div className="cantrip-editor-line" data-editor-line={number}>
      {tokens.length
        ? tokens.map((token) => (
            <span className={`syntax-${token.kind}`} key={token.from}>
              {line.slice(token.from, token.to)}
            </span>
          ))
        : line}
      {line.length === 0 ? "\u200b" : null}
    </div>
  );
});

export function NativeCodeEditor({
  session,
  path,
  onChange,
  onSave,
  active = true,
  readOnly = false,
  onReady,
  onViewStateChange,
}: {
  session: EditorDocumentSession;
  path: string;
  onChange?(value: string): void;
  onSave?(): void;
  active?: boolean;
  readOnly?: boolean;
  /** Fires after this document's DOM text, selection and scroll are installed. */
  onReady?(session: EditorDocumentSession): void;
  onViewStateChange?(): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const codePaint = useRef<HTMLDivElement>(null);
  const gutterPaint = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollCheckpoint = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const rememberSelection = (node: HTMLTextAreaElement) => {
    if (!activeRef.current) return;
    const next = selection(node);
    if (
      session.selection.start === next.start &&
      session.selection.end === next.end &&
      session.selection.direction === next.direction
    )
      return;
    session.selection = next;
    onViewStateChangeRef.current?.();
  };
  const composing = useRef(false);
  const compositionStart = useRef<{
    text: string;
    selection: EditorSelection;
  } | null>(null);
  const beforeInput = useRef<EditorSelection>(session.selection);
  const [, redraw] = useState(0);
  const [height, setHeight] = useState(600);
  const lineIndex = useRef<EditorLineIndex | null>(null);
  lineIndex.current ??= new EditorLineIndex(session.text);
  lineIndex.current.update(session.text);
  const lines = lineIndex.current.lines;
  const viewport = editorViewport(session.scrollTop, height, lines.length, 16);
  const paintedViewport = useRef(viewport);
  const paintScroll = () => {
    const y =
      EDITOR_VERTICAL_PADDING +
      paintedViewport.current.first * EDITOR_LINE_HEIGHT -
      session.scrollTop;
    const codeTransform = `translate(${-session.scrollLeft}px, ${y}px)`;
    const gutterTransform = `translateY(${y}px)`;
    if (
      codePaint.current &&
      codePaint.current.style.transform !== codeTransform
    )
      codePaint.current.style.transform = codeTransform;
    if (
      gutterPaint.current &&
      gutterPaint.current.style.transform !== gutterTransform
    )
      gutterPaint.current.style.transform = gutterTransform;
  };
  const flushScrollCheckpoint = () => {
    if (scrollCheckpoint.current === null) return;
    clearTimeout(scrollCheckpoint.current);
    scrollCheckpoint.current = null;
    onViewStateChangeRef.current?.();
  };
  const highlighted = useSyntaxHighlighting(
    session.id,
    path,
    session.text,
    session.revision,
    viewport.first,
    viewport.last,
    active,
  );
  const gutterWidth = `${Math.max(3, String(lines.length).length) + 2}ch`;
  const notify = () => {
    redraw((value) => value + 1);
    onChangeRef.current?.(session.text);
  };
  const replace = (text: string, nextSelection: EditorSelection) => {
    const node = input.current;
    if (!node) return;
    node.value = text;
    node.setSelectionRange(
      nextSelection.start,
      nextSelection.end,
      nextSelection.direction,
    );
    session.selection = nextSelection;
    session.edit(text);
    notify();
  };
  const history = (redo: boolean) => {
    const result = redo
      ? session.history.redo(session.text)
      : session.history.undo(session.text);
    if (result) replace(result.text, result.selection);
  };
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.value = session.text;
    node.setSelectionRange(
      session.selection.start,
      session.selection.end,
      session.selection.direction,
    );
    node.scrollTop = session.scrollTop;
    node.scrollLeft = session.scrollLeft;
    const onBeforeInput = (event: InputEvent) => {
      if (readOnlyRef.current) {
        event.preventDefault();
        return;
      }
      if (
        event.inputType === "historyUndo" ||
        event.inputType === "historyRedo"
      ) {
        event.preventDefault();
        history(event.inputType === "historyRedo");
      } else beforeInput.current = selection(node);
    };
    node.addEventListener("beforeinput", onBeforeInput);
    const onNativeSelect = () => rememberSelection(node);
    node.addEventListener("select", onNativeSelect);
    const observer = new ResizeObserver(() => {
      setHeight(node.clientHeight);
    });
    observer.observe(node);
    setHeight(node.clientHeight);
    return () => {
      if (activeRef.current) {
        session.selection = selection(node);
        session.scrollTop = node.scrollTop;
        session.scrollLeft = node.scrollLeft;
      }
      observer.disconnect();
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
      flushScrollCheckpoint();
      node.removeEventListener("beforeinput", onBeforeInput);
      node.removeEventListener("select", onNativeSelect);
    };
    // A document owns its input lifetime; ordinary typing must not replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useLayoutEffect(() => {
    // Scroll events must use the window actually committed to the DOM, even
    // while React is preparing a replacement concurrently.
    paintedViewport.current = viewport;
    paintScroll();
    const node = input.current;
    if (node && !composing.current && node.value !== session.text) {
      node.value = session.text;
      node.setSelectionRange(
        session.selection.start,
        session.selection.end,
        session.selection.direction,
      );
    }
  });
  useLayoutEffect(() => {
    const node = input.current;
    if (!active || !node) return;
    node.setSelectionRange(
      session.selection.start,
      session.selection.end,
      session.selection.direction,
    );
    node.scrollTop = session.scrollTop;
    node.scrollLeft = session.scrollLeft;
    node.dispatchEvent(new Event("scroll"));
  }, [active]);
  useEffect(() => {
    if (input.current) onReady?.(session);
  }, [session, onReady]);
  useEffect(() => {
    if (!active) {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
      flushScrollCheckpoint();
    }
  }, [active]);

  return (
    <div
      className="cantrip-editor"
      data-selectable-text="true"
      data-native-code-editor="true"
      style={{ "--editor-gutter-width": gutterWidth } as React.CSSProperties}
    >
      <div className="cantrip-editor-gutter" aria-hidden="true">
        <div
          ref={gutterPaint}
          style={{
            transform: `translateY(${EDITOR_VERTICAL_PADDING + viewport.first * EDITOR_LINE_HEIGHT - session.scrollTop}px)`,
          }}
        >
          {lines.slice(viewport.first, viewport.last).map((_, offset) => (
            <div className="cantrip-editor-line" key={viewport.first + offset}>
              {viewport.first + offset + 1}
            </div>
          ))}
        </div>
      </div>
      <div className="cantrip-editor-body">
        <div className="cantrip-editor-paint" aria-hidden="true">
          <div
            ref={codePaint}
            className="cantrip-editor-code"
            style={{
              transform: `translate(${-session.scrollLeft}px, ${EDITOR_VERTICAL_PADDING + viewport.first * EDITOR_LINE_HEIGHT - session.scrollTop}px)`,
            }}
          >
            {lines.slice(viewport.first, viewport.last).map((line, offset) => {
              const cached = highlighted.get(viewport.first + offset + 1);
              const tokens = cached?.text === line ? cached.tokens : NO_TOKENS;
              return (
                <PaintedLine
                  line={line}
                  number={viewport.first + offset + 1}
                  tokens={tokens}
                  key={viewport.first + offset}
                />
              );
            })}
          </div>
        </div>
        <textarea
          ref={input}
          aria-label={`${readOnly ? "View" : "Edit"} ${path.split("/").at(-1) ?? path}`}
          aria-description={
            readOnly
              ? "Read only. Select and copy text. Press Escape to leave the viewer."
              : "Press Escape to leave the editor. Tab indents text."
          }
          readOnly={readOnly}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          wrap="off"
          className="cantrip-editor-input"
          onScroll={(event) => {
            if (!activeRef.current) return;
            if (
              session.scrollTop === event.currentTarget.scrollTop &&
              session.scrollLeft === event.currentTarget.scrollLeft
            )
              return;
            session.scrollTop = event.currentTarget.scrollTop;
            session.scrollLeft = event.currentTarget.scrollLeft;
            // Align paint immediately with native scrolling. React only needs
            // to replace the buffered line window when its boundaries change.
            paintScroll();
            if (scrollFrame.current === null)
              scrollFrame.current = requestAnimationFrame(() => {
                scrollFrame.current = null;
                if (!activeRef.current) return;
                const next = editorViewport(
                  session.scrollTop,
                  input.current?.clientHeight ?? height,
                  lineIndex.current!.lines.length,
                  16,
                );
                if (
                  next.first !== paintedViewport.current.first ||
                  next.last !== paintedViewport.current.last
                )
                  redraw((value) => value + 1);
              });
            // The session already holds the latest position for transfers and
            // tab switches. Persisting it need not rerender the whole explorer
            // on every scroll frame.
            if (scrollCheckpoint.current !== null)
              clearTimeout(scrollCheckpoint.current);
            scrollCheckpoint.current = setTimeout(flushScrollCheckpoint, 160);
          }}
          onSelect={(event) => rememberSelection(event.currentTarget)}
          onCompositionStart={(event) => {
            if (readOnly) return;
            composing.current = true;
            compositionStart.current = {
              text: session.text,
              selection: selection(event.currentTarget),
            };
          }}
          onCompositionEnd={(event) => {
            const start = compositionStart.current;
            composing.current = false;
            compositionStart.current = null;
            if (readOnly) {
              event.currentTarget.value = session.text;
              return;
            }
            if (start)
              session.history.record(
                start.text,
                event.currentTarget.value,
                start.selection,
                selection(event.currentTarget),
              );
            session.edit(event.currentTarget.value);
            session.selection = selection(event.currentTarget);
            notify();
          }}
          onChange={(event) => {
            const node = event.currentTarget;
            if (readOnly) {
              node.value = session.text;
              return;
            }
            if (!composing.current)
              session.history.record(
                session.text,
                node.value,
                beforeInput.current,
                selection(node),
              );
            session.edit(node.value);
            session.selection = selection(node);
            notify();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current) return;
            if (event.key === "Escape") {
              event.currentTarget.blur();
              return;
            }
            const modifier = event.metaKey || event.ctrlKey;
            if (readOnly) {
              if (
                event.key === "Backspace" ||
                event.key === "Delete" ||
                (modifier &&
                  !event.altKey &&
                  ["s", "z", "y"].includes(event.key.toLowerCase()))
              )
                event.preventDefault();
              return;
            }
            if (modifier && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              onSave?.();
            } else if (
              modifier &&
              !event.altKey &&
              (event.key.toLowerCase() === "z" ||
                event.key.toLowerCase() === "y")
            ) {
              event.preventDefault();
              history(event.key.toLowerCase() === "y" || event.shiftKey);
            } else if (event.key === "Tab" && !modifier && !event.altKey) {
              event.preventDefault();
              const node = event.currentTarget,
                before = selection(node);
              const result = indentationChange(
                session.text,
                before.start,
                before.end,
                event.shiftKey,
              );
              const text = applyTextChange(session.text, result.change);
              session.history.record(
                session.text,
                text,
                before,
                result.selection,
              );
              replace(text, result.selection);
            }
          }}
        />
      </div>
    </div>
  );
}
