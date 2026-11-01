import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, Grid3X3, Table2 } from "lucide-react";
import { NbtTag } from "@cantrip/nbt";
import type {
  NbtDocumentClient,
  NbtDisplayRow,
  NbtTreeRow,
} from "@cantrip/nbt/document";
import { NbtVirtualList, type NbtVirtualHandle } from "./virtual-list";
import { container, numericArray, NBT_TYPE_NAMES, nbtRowValue } from "./format";
export interface NbtAnchor {
  id: string;
  center: boolean;
  nonce: number;
}
const TreeRow = memo(function TreeRow({
  item,
  selected,
  onSelect,
  onToggle,
  onOpen,
  idPrefix,
}: {
  idPrefix: string;
  item: NbtTreeRow;
  selected: boolean;
  onSelect(item: NbtTreeRow): void;
  onToggle(item: NbtTreeRow): void;
  onOpen(row: NbtDisplayRow, mode: "array" | "table"): void;
}) {
  const { row } = item,
    label =
      row.name ||
      (row.node.parent === null ? "Root" : "[" + row.node.ordinal + "]");
  return (
    <div
      role="row"
      aria-rowindex={item.index + 1}
      aria-level={item.depth + 1}
      aria-selected={selected}
      aria-expanded={container(row.node) ? item.expanded : undefined}
      id={idPrefix + row.node.id}
      className={
        "flex h-8 items-center gap-2 border-b border-border/15 px-2 text-xs " +
        (selected ? "bg-accent/70" : "hover:bg-accent/25")
      }
      data-nbt-node={row.node.id}
      onClick={() => onSelect(item)}
      onDoubleClick={() =>
        container(row.node)
          ? onToggle(item)
          : numericArray(row.node)
            ? onOpen(row, "array")
            : undefined
      }
    >
      <div
        role="gridcell"
        className="flex min-w-0 basis-2/5 items-center gap-1"
        style={{ paddingLeft: `min(${Math.min(item.depth, 24) * 14}px, 12%)` }}
      >
        {container(row.node) ? (
          <button
            type="button"
            tabIndex={-1}
            className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent"
            aria-label={(item.expanded ? "Collapse " : "Expand ") + label}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(item);
            }}
          >
            {item.expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <span className="truncate font-mono" title={label}>
          {label}
          {row.nameTruncated ? "…" : ""}
        </span>
      </div>
      <span
        role="gridcell"
        className="w-24 shrink-0 text-[10px] text-muted-foreground"
      >
        {NBT_TYPE_NAMES[row.node.type]}
      </span>
      <span
        role="gridcell"
        className={
          "min-w-0 flex-1 truncate font-mono " +
          (row.error ? "text-destructive" : "text-muted-foreground")
        }
      >
        {nbtRowValue(row)}
      </span>
      {numericArray(row.node) ? (
        <button
          tabIndex={-1}
          className="shrink-0 rounded p-1 hover:bg-accent"
          aria-label={"Open array " + label}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
            onOpen(row, "array");
          }}
        >
          <Grid3X3 className="size-3.5" />
        </button>
      ) : row.node.type === NbtTag.List &&
        row.node.elementType === NbtTag.Compound ? (
        <button
          tabIndex={-1}
          className="shrink-0 rounded p-1 hover:bg-accent"
          aria-label={"Open table " + label}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
            onOpen(row, "table");
          }}
        >
          <Table2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
});
export function NbtTree({
  client,
  root,
  nodes,
  revision = 0,
  expanded,
  onExpanded,
  selected,
  onSelected,
  onOpen,
  anchor,
}: {
  client: NbtDocumentClient;
  root: string | null;
  nodes: number;
  revision?: number;
  expanded: ReadonlySet<string>;
  onExpanded(value: ReadonlySet<string>): void;
  selected: string | null;
  onSelected(row: NbtDisplayRow): void;
  onOpen(row: NbtDisplayRow, mode: "array" | "table"): void;
  anchor: NbtAnchor | null;
}) {
  const [range, setRange] = useState({ offset: 0, limit: 32 }),
    [page, setPage] = useState<{
      rows: Map<number, NbtTreeRow>;
      total: number;
    }>({ rows: new Map(), total: 0 }),
    [error, setError] = useState<string | null>(null);
  const idPrefix = useId() + "-nbt-row-",
    grid = useRef<HTMLDivElement>(null);
  const list = useRef<NbtVirtualHandle>(null),
    rank = useRef(0),
    navigation = useRef<AbortController | null>(null),
    expandedIds = [...expanded],
    expandedKey = JSON.stringify(expandedIds);
  const onRange = useCallback(
    (offset: number, limit: number) =>
      setRange((current) =>
        current.offset === offset && current.limit === limit
          ? current
          : { offset, limit },
      ),
    [],
  );
  useEffect(() => {
    if (!root) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const rows = new Map<number, NbtTreeRow>();
      let total = 0;
      for (let at = range.offset; at < range.offset + range.limit; at += 128) {
        const part = await client.tree(
          JSON.parse(expandedKey),
          at,
          Math.min(128, range.offset + range.limit - at),
          undefined,
          controller.signal,
        );
        total = part.total;
        part.rows.forEach((row) => rows.set(row.index, row));
        if (at >= total) break;
      }
      if (!controller.signal.aborted) setPage({ rows, total });
    })().catch((reason) => {
      if (!controller.signal.aborted)
        setError(String(reason.message ?? reason));
    });
    return () => controller.abort();
  }, [client, root, nodes, revision, expandedKey, range.offset, range.limit]);
  useEffect(() => {
    if (!anchor) return;
    const controller = new AbortController();
    void client
      .tree(JSON.parse(expandedKey), 0, 0, anchor.id, controller.signal)
      .then((result) => {
        if (result.anchorIndex !== undefined && !controller.signal.aborted) {
          rank.current = result.anchorIndex;
          list.current?.scrollToIndex(
            result.anchorIndex,
            anchor.center ? "center" : "auto",
          );
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, expandedKey, anchor]);
  useEffect(() => () => navigation.current?.abort(), []);
  const select = useCallback(
    (item: NbtTreeRow) => {
      rank.current = item.index;
      onSelected(item.row);
      grid.current?.focus({ preventScroll: true });
    },
    [onSelected],
  );
  const toggle = useCallback(
    (item: NbtTreeRow) => {
      select(item);
      const next = new Set(expanded);
      if (next.has(item.row.node.id)) next.delete(item.row.node.id);
      else next.add(item.row.node.id);
      onExpanded(next);
    },
    [expanded, onExpanded, select],
  );
  const selectRank = async (index: number) => {
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    rank.current = Math.max(0, Math.min(index, page.total - 1));
    list.current?.scrollToIndex(rank.current);
    try {
      const result = await client.tree(
        JSON.parse(expandedKey),
        rank.current,
        1,
        undefined,
        controller.signal,
      );
      if (result.rows[0] && !controller.signal.aborted) select(result.rows[0]);
    } catch {}
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input,select")
    )
      return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      void selectRank(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? page.total - 1
            : rank.current + (event.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    const item = [...page.rows.values()].find(
      (row) => row.row.node.id === selected,
    );
    if (!item) return;
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      if (container(item.row.node)) {
        if (!item.expanded) toggle(item);
        else void selectRank(item.index + 1);
      } else if (numericArray(item.row.node)) onOpen(item.row, "array");
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (container(item.row.node) && item.expanded) toggle(item);
      else if (item.row.node.parent) {
        const parent = item.row.node.parent;
        void client
          .tree(JSON.parse(expandedKey), 0, 0, parent)
          .then((result) => {
            if (result.anchorIndex !== undefined)
              void selectRank(result.anchorIndex);
          });
      }
    }
  };
  return (
    <div
      ref={grid}
      role="treegrid"
      aria-label="NBT tree"
      aria-rowcount={page.total}
      tabIndex={0}
      aria-activedescendant={
        selected &&
        [...page.rows.values()].some((row) => row.row.node.id === selected)
          ? idPrefix + selected
          : undefined
      }
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={keyDown}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/45 px-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="basis-2/5">Name / index</span>
        <span className="w-24 shrink-0">Type</span>
        <span>Value</span>
      </div>
      {error ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <NbtVirtualList
        ref={list}
        count={page.total}
        onRange={onRange}
        label="NBT tree rows"
        render={(index) => {
          const item = page.rows.get(index);
          return item ? (
            <TreeRow
              idPrefix={idPrefix}
              item={item}
              selected={item.row.node.id === selected}
              onSelect={select}
              onToggle={toggle}
              onOpen={onOpen}
            />
          ) : (
            <div className="h-8 px-3 py-2 text-xs text-muted-foreground">
              Loading…
            </div>
          );
        }}
      />
    </div>
  );
}
