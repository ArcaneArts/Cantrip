import { useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { EditorFindState } from "./use-editor-find";

export function EditorFindChip({
  find,
  onClose,
  unavailable = false,
  scope,
}: {
  find: EditorFindState;
  onClose(): void;
  unavailable?: boolean;
  scope?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [find.focusToken]);
  const count = find.result?.count ?? 0;
  return (
    <div className="cantrip-editor-find" role="group" aria-label="Find in file">
      <input
        ref={input}
        aria-label="Find in file"
        aria-description={scope}
        placeholder="Find"
        value={find.query}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => find.setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            find.move(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span
        className="cantrip-editor-find-count"
        title={scope ?? "All matches in this file"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {find.failed || unavailable
          ? "Unavailable"
          : find.query && !find.result
            ? "Searching…"
            : `${count ? (find.result!.index + 1).toLocaleString() : "0"} of ${count.toLocaleString()}`}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!count}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => find.move(-1)}
      >
        <ChevronUp />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!count}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => find.move(1)}
      >
        <ChevronDown />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close find (Escape)"
        onClick={onClose}
      >
        <X />
      </button>
    </div>
  );
}
