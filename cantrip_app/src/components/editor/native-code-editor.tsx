import { useLayoutEffect, useRef, useState } from "react";
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

export function NativeCodeEditor({
  session,
  path,
  onChange,
  onSave,
  active = true,
}: {
  session: EditorDocumentSession;
  path: string;
  onChange?(value: string): void;
  onSave(): void;
  active?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
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
  const viewport = editorViewport(session.scrollTop, height, lines.length);
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
      if (
        event.inputType === "historyUndo" ||
        event.inputType === "historyRedo"
      ) {
        event.preventDefault();
        history(event.inputType === "historyRedo");
      } else beforeInput.current = selection(node);
    };
    node.addEventListener("beforeinput", onBeforeInput);
    const rememberSelection = () => {
      if (activeRef.current) session.selection = selection(node);
    };
    node.addEventListener("select", rememberSelection);
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
      node.removeEventListener("beforeinput", onBeforeInput);
      node.removeEventListener("select", rememberSelection);
    };
    // A document owns its input lifetime; ordinary typing must not replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useLayoutEffect(() => {
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

  return (
    <div
      className="cantrip-editor"
      data-selectable-text="true"
      data-native-code-editor="true"
      style={{ "--editor-gutter-width": gutterWidth } as React.CSSProperties}
    >
      <div className="cantrip-editor-gutter" aria-hidden="true">
        <div
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
            className="cantrip-editor-code"
            style={{
              transform: `translate(${-session.scrollLeft}px, ${EDITOR_VERTICAL_PADDING + viewport.first * EDITOR_LINE_HEIGHT - session.scrollTop}px)`,
            }}
          >
            {lines.slice(viewport.first, viewport.last).map((line, offset) => {
              const tokens =
                highlighted[offset]?.text === line
                  ? highlighted[offset]!.tokens
                  : [];
              return (
                <div
                  className="cantrip-editor-line"
                  data-editor-line={viewport.first + offset + 1}
                  key={viewport.first + offset}
                >
                  {tokens.length
                    ? tokens.map((token) => (
                        <span
                          className={`syntax-${token.kind}`}
                          key={token.from}
                        >
                          {line.slice(token.from, token.to)}
                        </span>
                      ))
                    : line}
                  {line.length === 0 ? "\u200b" : null}
                </div>
              );
            })}
          </div>
        </div>
        <textarea
          ref={input}
          aria-label={`Edit ${path.split("/").at(-1) ?? path}`}
          aria-description="Press Escape to leave the editor. Tab indents text."
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          wrap="off"
          className="cantrip-editor-input"
          defaultValue={session.text}
          onScroll={(event) => {
            if (!activeRef.current) return;
            session.scrollTop = event.currentTarget.scrollTop;
            session.scrollLeft = event.currentTarget.scrollLeft;
            redraw((value) => value + 1);
          }}
          onSelect={(event) => {
            if (activeRef.current)
              session.selection = selection(event.currentTarget);
          }}
          onCompositionStart={(event) => {
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
            if (modifier && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              onSave();
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
