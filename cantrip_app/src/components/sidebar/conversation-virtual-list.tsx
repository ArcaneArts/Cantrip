import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A bounded catalog viewport. Only summaries are mounted; focus and scroll
 * are retained by resource ID when Live changes the recency order. */
export function ConversationVirtualList<T extends { id: string }>({
  rows,
  estimate,
  label,
  children,
}: {
  rows: readonly T[];
  estimate: number;
  label: string;
  children(row: T): ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [geometry, setGeometry] = useState({ top: 0, height: 384 });
  const [focused, setFocused] = useState<string | null>(null);
  const [measureVersion, measure] = useState(0);
  const offsets = [0];
  for (const row of rows)
    offsets.push(offsets.at(-1)! + (heights.current.get(row.id) ?? estimate));
  const total = offsets.at(-1)!;
  const indices = rows.flatMap((row, index) =>
    (offsets[index + 1]! >= geometry.top - estimate * 4 &&
      offsets[index]! <= geometry.top + geometry.height + estimate * 4) ||
    row.id === focused
      ? [index]
      : [],
  );
  const previous = useRef<{ ids: string[]; offsets: number[] } | null>(null);
  const order = rows.map((row) => row.id).join("\u0000");
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const before = previous.current;
    if (before) {
      const index = before.ids.findIndex(
        (_, index) => before.offsets[index + 1]! > element.scrollTop,
      );
      const anchor = before.ids[index];
      const next = rows.findIndex((row) => row.id === anchor);
      if (next >= 0)
        element.scrollTop += offsets[next]! - before.offsets[index]!;
    }
    previous.current = { ids: rows.map((row) => row.id), offsets };
    const update = () =>
      setGeometry({
        top: element.scrollTop,
        height: element.clientHeight || 384,
      });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [order, estimate, measureVersion]);
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualConversation;
        const height = entry.target.getBoundingClientRect().height;
        if (id && height > 0 && heights.current.get(id) !== height) {
          heights.current.set(id, height);
          changed = true;
        }
      }
      if (changed) measure((value) => value + 1);
    });
    root
      .querySelectorAll("[data-virtual-conversation]")
      .forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  });
  function focus(index: number) {
    const row = rows[index];
    const root = viewport.current;
    if (!row || !root) return;
    setFocused(row.id);
    if (offsets[index]! < root.scrollTop) root.scrollTop = offsets[index]!;
    else if (offsets[index + 1]! > root.scrollTop + root.clientHeight)
      root.scrollTop = Math.max(0, offsets[index + 1]! - root.clientHeight);
    setGeometry({ top: root.scrollTop, height: root.clientHeight || 384 });
    requestAnimationFrame(() => {
      [...root.querySelectorAll<HTMLElement>("[data-virtual-conversation]")]
        .find((element) => element.dataset.virtualConversation === row.id)
        ?.querySelector<HTMLElement>("button")
        ?.focus();
    });
  }
  return (
    <div
      ref={viewport}
      role="list"
      aria-label={label}
      data-conversation-viewport=""
      className="max-h-[42vh] min-h-0 overflow-y-auto"
      style={{ overflowAnchor: "none" }}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-virtual-conversation]",
        );
        if (row) setFocused(row.dataset.virtualConversation!);
      }}
      onKeyDown={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-virtual-conversation]",
        );
        if (
          !row ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const index = rows.findIndex(
          (item) => item.id === row.dataset.virtualConversation,
        );
        const target =
          event.key === "ArrowDown"
            ? Math.min(rows.length - 1, index + 1)
            : event.key === "ArrowUp"
              ? Math.max(0, index - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : null;
        if (target !== null) {
          event.preventDefault();
          focus(target);
        }
      }}
    >
      <div style={{ height: total, position: "relative" }}>
        {indices.map((index) => (
          <div
            key={rows[index]!.id}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={rows.length}
            data-virtual-conversation={rows[index]!.id}
            style={{
              position: "absolute",
              top: offsets[index],
              left: 0,
              right: 0,
            }}
          >
            {children(rows[index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
