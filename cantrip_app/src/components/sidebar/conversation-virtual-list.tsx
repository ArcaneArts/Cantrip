import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// The positioned scroll region is also the offset parent of both lists.
const scrollRegion = '[data-slot="conversation-list-scroll"]';

/** Window each catalog against the shared sidebar scroll region. */
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
  const list = useRef<HTMLDivElement>(null);
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
    const element = list.current;
    const scroll = element?.closest<HTMLElement>(scrollRegion);
    if (!element || !scroll) return;
    const before = previous.current;
    const top = scroll.scrollTop - element.offsetTop;
    // Only the list under the viewport's leading edge can anchor its scroll.
    if (before && top >= 0 && top < before.offsets.at(-1)!) {
      const index = before.ids.findIndex(
        (_, index) => before.offsets[index + 1]! > top,
      );
      const anchor = before.ids[index];
      const next = rows.findIndex((row) => row.id === anchor);
      if (next >= 0)
        scroll.scrollTop += offsets[next]! - before.offsets[index]!;
    }
    previous.current = { ids: rows.map((row) => row.id), offsets };
    const update = () =>
      setGeometry({
        top: scroll.scrollTop - element.offsetTop,
        height: scroll.clientHeight || 384,
      });
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroll);
    // Content ahead of Archived can resize without changing the viewport.
    if (scroll.firstElementChild) observer?.observe(scroll.firstElementChild);
    return () => {
      scroll.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [order, estimate, measureVersion]);
  useLayoutEffect(() => {
    const root = list.current;
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
    const root = list.current;
    const scroll = root?.closest<HTMLElement>(scrollRegion);
    if (!row || !root || !scroll) return;
    setFocused(row.id);
    const top = root.offsetTop + offsets[index]!;
    const bottom = root.offsetTop + offsets[index + 1]!;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight)
      scroll.scrollTop = Math.max(0, bottom - scroll.clientHeight);
    setGeometry({
      top: scroll.scrollTop - root.offsetTop,
      height: scroll.clientHeight || 384,
    });
    requestAnimationFrame(() => {
      [...root.querySelectorAll<HTMLElement>("[data-virtual-conversation]")]
        .find((element) => element.dataset.virtualConversation === row.id)
        ?.querySelector<HTMLElement>("button")
        ?.focus();
    });
  }
  return (
    <div
      ref={list}
      role="list"
      aria-label={label}
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
