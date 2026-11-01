import { isFindShortcut, registerFindEditor } from "./find/shortcut";
import { EditorFindChip } from "./find/editor-find-chip";
import { useEditorFind } from "./find/use-editor-find";
import { findPaintedText } from "./find/find-painted-text";
import type { FindMatch } from "./find/index";
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
import { useCodeEditorLineNumbers } from "@/lib/code-editor-preferences";
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
  offset,
  match,
}: {
  line: string;
  number: number;
  tokens: SyntaxToken[];
  offset: number;
  match: FindMatch | null;
}) {
  return (
    <div className="cantrip-editor-line" data-editor-line={number}>
      {tokens.length
        ? tokens.map((token) => (
            <span className={`syntax-${token.kind}`} key={token.from}>
              {findPaintedText(
                line.slice(token.from, token.to),
                offset + token.from,
                match,
              )}
            </span>
          ))
        : findPaintedText(line, offset, match)}
      {line.length === 0 ? "\u200b" : null}
    </div>
  );
});

export function NativeCodeEditor({
  session,
  path,
  highlightPath,
  onChange,
  onSave,
  active = true,
  readOnly = false,
  onReady,
  onViewStateChange,
  onViewportChange,
  followEnd = false,
  onScrollPositionChange,
  onFindQueryChange,
  findReady = true,
  findError = false,
  findScope,
}: {
  session: EditorDocumentSession;
  path: string;
  highlightPath?: string;
  onChange?(value: string): void;
  onSave?(): void;
  active?: boolean;
  readOnly?: boolean;
  /** Fires after this document's DOM text, selection and scroll are installed. */
  onReady?(session: EditorDocumentSession): void;
  onViewStateChange?(): void;
  onViewportChange?(last: number, total: number): void;
  followEnd?: boolean;
  onScrollPositionChange?(atBottom: boolean): void;
  onFindQueryChange?(query: string | null): void;
  findReady?: boolean;
  findError?: boolean;
  findScope?: string;
}) {
  const showLineNumbers = useCodeEditorLineNumbers();
  const find = useEditorFind(session, active, findReady);
  useEffect(
    () => onFindQueryChange?.(active && find.open ? find.query : null),
    [active, find.open, find.query, onFindQueryChange],
  );
  useEffect(() => () => onFindQueryChange?.(null), [onFindQueryChange]);
  const pendingFindReveal = useRef(false);
  const editorRoot = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const codePaint = useRef<HTMLDivElement>(null);
  const gutterPaint = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollCheckpoint = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const scrollPositionChange = useRef(onScrollPositionChange);
  scrollPositionChange.current = onScrollPositionChange;
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
  useEffect(() => {
    if (active) onViewportChange?.(viewport.last, lines.length);
  }, [active, viewport.last, lines.length, onViewportChange]);
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
    highlightPath ?? path,
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
      node.scrollTop = session.scrollTop;
      node.scrollLeft = session.scrollLeft;
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
  useLayoutEffect(() => {
    const node = input.current;
    if (!active || !followEnd || !node) return;
    node.scrollTop = node.scrollHeight;
    session.scrollTop = node.scrollTop;
    paintScroll();
    const next = editorViewport(
      session.scrollTop,
      node.clientHeight,
      lines.length,
      16,
    );
    if (
      next.first !== paintedViewport.current.first ||
      next.last !== paintedViewport.current.last
    )
      redraw((value) => value + 1);
  }, [active, followEnd, height, session, session.revision]);
  useLayoutEffect(() => {
    const match = find.result?.match,
      node = input.current;
    if (!active || !find.result?.reveal || !match || !node) {
      pendingFindReveal.current = false;
      return;
    }
    session.selection = {
      start: match.from,
      end: match.to,
      direction: "forward",
    };
    node.setSelectionRange(match.from, match.to, "forward");
    const row = lineIndex.current!.lineAt(match.from);
    const top = EDITOR_VERTICAL_PADDING + row * EDITOR_LINE_HEIGHT;
    if (
      top < node.scrollTop + EDITOR_LINE_HEIGHT ||
      top + EDITOR_LINE_HEIGHT > node.scrollTop + node.clientHeight
    )
      node.scrollTop = Math.max(0, top - node.clientHeight / 2);
    session.scrollTop = node.scrollTop;
    scrollPositionChange.current?.(
      node.scrollHeight - node.clientHeight - node.scrollTop <= 2,
    );
    pendingFindReveal.current = true;
    paintScroll();
    redraw((value) => value + 1);
  }, [active, find.result]);
  useLayoutEffect(() => {
    if (!pendingFindReveal.current) return;
    const node = input.current,
      mark =
        codePaint.current?.querySelector<HTMLElement>("[data-find-active]");
    if (!node || !mark) return;
    pendingFindReveal.current = false;
    const bounds = node.getBoundingClientRect(),
      hit = mark.getBoundingClientRect();
    if (hit.left < bounds.left + 12 || hit.right > bounds.right - 12) {
      node.scrollLeft = Math.max(
        0,
        node.scrollLeft + hit.left - bounds.left - node.clientWidth / 2,
      );
      session.scrollLeft = node.scrollLeft;
      paintScroll();
    }
    onViewStateChangeRef.current?.();
  });
  const showFind = () => {
    const node = input.current;
    if (node) session.selection = selection(node);
    const selected =
      node?.value.slice(node.selectionStart, node.selectionEnd) ?? "";
    find.show(
      !find.open &&
        selected &&
        selected.length <= 1000 &&
        !/[\r\n]/u.test(selected)
        ? selected
        : undefined,
    );
  };
  const showFindRef = useRef(showFind);
  showFindRef.current = showFind;
  useEffect(() => {
    const root = editorRoot.current;
    if (active && root)
      return registerFindEditor(root, () => showFindRef.current());
  }, [active, session]);
  const closeFind = () => {
    find.close();
    pendingFindReveal.current = false;
    input.current?.focus({ preventScroll: true });
  };
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
      ref={editorRoot}
      className="cantrip-editor"
      data-selectable-text="true"
      data-native-code-editor="true"
      data-find-open={find.open || undefined}
      onKeyDownCapture={(event) => {
        if (!active || event.nativeEvent.isComposing) return;
        if (isFindShortcut(event)) {
          event.preventDefault();
          event.stopPropagation();
          showFind();
        } else if (event.key === "Escape" && find.open) {
          event.preventDefault();
          event.stopPropagation();
          closeFind();
        }
      }}
      style={{ "--editor-gutter-width": gutterWidth } as React.CSSProperties}
    >
      {find.open ? (
        <EditorFindChip
          find={find}
          onClose={closeFind}
          unavailable={findError}
          scope={findScope}
        />
      ) : null}
      {showLineNumbers ? (
        <div className="cantrip-editor-gutter" aria-hidden="true">
          <div
            ref={gutterPaint}
            style={{
              transform: `translateY(${EDITOR_VERTICAL_PADDING + viewport.first * EDITOR_LINE_HEIGHT - session.scrollTop}px)`,
            }}
          >
            {lines.slice(viewport.first, viewport.last).map((_, offset) => (
              <div
                className="cantrip-editor-line"
                key={viewport.first + offset}
              >
                {viewport.first + offset + 1}
              </div>
            ))}
          </div>
        </div>
      ) : null}
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
              const from = lineIndex.current!.offsets[viewport.first + offset]!;
              const selected = find.result?.match;
              const match =
                selected &&
                selected.from < from + line.length &&
                selected.to > from
                  ? selected
                  : null;
              return (
                <PaintedLine
                  line={line}
                  number={viewport.first + offset + 1}
                  tokens={tokens}
                  offset={match ? from : 0}
                  match={match}
                  key={viewport.first + offset}
                />
              );
            })}
          </div>
        </div>
        <textarea
          ref={input}
          aria-label={`${readOnly ? "View" : "Edit"} ${path.split("/").at(-1) ?? path}`}
          aria-keyshortcuts="Meta+F Control+F"
          aria-description={
            readOnly
              ? "Read only. Select and copy text. Press Command+F or Control+F to find. Press Escape to leave the viewer."
              : "Press Command+F or Control+F to find. Press Escape to leave the editor. Tab indents text."
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
            const verticalChanged =
              session.scrollTop !== event.currentTarget.scrollTop;
            session.scrollTop = event.currentTarget.scrollTop;
            session.scrollLeft = event.currentTarget.scrollLeft;
            if (verticalChanged)
              scrollPositionChange.current?.(
                event.currentTarget.scrollHeight -
                  event.currentTarget.clientHeight -
                  event.currentTarget.scrollTop <=
                  2,
              );
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
