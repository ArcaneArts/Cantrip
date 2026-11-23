import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type {
  NbtDocumentClient,
  NbtDisplayRow,
  NbtTablePage,
} from "@cantrip/nbt/document";
import { NbtVirtualList, type NbtVirtualHandle } from "./virtual-list";
import type { NbtTableViewState, NbtViewHandle } from "@/lib/nbt/view-state";
import { nbtControl, nbtRowValue, NBT_TYPE_NAMES } from "./format";
export function NbtTable({
  client,
  active = true,
  row,
  nodes,
  revision = 0,
  onSelect,
  initialState,
  stateRef,
  complete = true,
}: {
  client: NbtDocumentClient;
  active?: boolean;
  row: NbtDisplayRow;
  nodes: number;
  revision?: number;
  onSelect(row: NbtDisplayRow): void;
  initialState?: NbtTableViewState;
  stateRef?: Ref<NbtViewHandle<NbtTableViewState>>;
  complete?: boolean;
}) {
  const [range, setRange] = useState({ offset: 0, limit: 32 }),
    [columnOffset, setColumnOffset] = useState(initialState?.columnOffset ?? 0),
    [reference, setReference] = useState(initialState?.reference ?? 0),
    [reverse, setReverse] = useState(initialState?.reverse ?? false),
    [loaded, setLoaded] = useState<{
      page: NbtTablePage;
      offset: number;
      key: string;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [referenceDraft, setReferenceDraft] = useState(
      String(initialState?.reference ?? 0),
    );
  const list = useRef<NbtVirtualHandle>(null),
    horizontal = useRef<HTMLDivElement>(null),
    restoredHorizontal = useRef(false);
  const pageKey = JSON.stringify([
    row.node.id,
    nodes,
    revision,
    columnOffset,
    reference,
    reverse,
    complete,
  ]);
  useImperativeHandle(
    stateRef,
    () => ({
      capture: () => ({
        position:
          list.current?.capturePosition() ?? initialState?.position ?? 0,
        scrollLeft: horizontal.current?.scrollLeft ?? 0,
        columnOffset,
        reference,
        reverse,
      }),
    }),
    [initialState, columnOffset, reference, reverse],
  );
  useLayoutEffect(() => {
    if (!loaded || restoredHorizontal.current || !horizontal.current) return;
    if (
      horizontal.current.scrollWidth - horizontal.current.clientWidth <
        (initialState?.scrollLeft ?? 0) &&
      !(complete && loaded.key === pageKey)
    )
      return;
    restoredHorizontal.current = true;
    horizontal.current.scrollLeft = initialState?.scrollLeft ?? 0;
  }, [loaded, initialState, complete, pageKey]);
  const page = loaded?.page,
    id = useId();
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
    if (!active) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      let result: NbtTablePage | null = null;
      for (let at = range.offset; at < range.offset + range.limit; at += 32) {
        const part = await client.table(
          {
            id: row.node.id,
            offset: at,
            limit: Math.min(32, range.offset + range.limit - at),
            columnOffset,
            columnLimit: 8,
            referenceOrdinal: reference,
            reverse,
          },
          controller.signal,
        );
        if (result) result.rows.push(...part.rows);
        else result = part;
        if (at >= part.totalRows) break;
      }
      if (!controller.signal.aborted)
        setLoaded(
          result ? { page: result, offset: range.offset, key: pageKey } : null,
        );
    })().catch((reason) => {
      if (!controller.signal.aborted)
        setError(String(reason.message ?? reason));
    });
    return () => controller.abort();
  }, [
    client,
    active,
    row.node.id,
    nodes,
    revision,
    range.offset,
    range.limit,
    columnOffset,
    reference,
    reverse,
    pageKey,
  ]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-nbt-table="">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 p-2 text-xs">
        <label>
          Order{" "}
          <select
            className={nbtControl}
            aria-label="NBT table order"
            value={reverse ? "reverse" : "source"}
            onChange={(event) => setReverse(event.target.value === "reverse")}
          >
            <option value="source">Source order</option>
            <option value="reverse">Reverse source order</option>
          </select>
        </label>
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const next = Number(referenceDraft);
            if (
              Number.isSafeInteger(next) &&
              next >= 0 &&
              next < (row.node.length ?? 0)
            ) {
              setReference(next);
              setColumnOffset(0);
            } else setError("Choose an item index in this list.");
          }}
        >
          <label htmlFor={id}>Columns from item</label>
          <input
            id={id}
            aria-label="Column sample item"
            className={nbtControl + " w-20"}
            inputMode="numeric"
            value={referenceDraft}
            onChange={(event) => setReferenceDraft(event.target.value)}
          />
          <button className={nbtControl} type="submit">
            Use
          </button>
        </form>
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          <button
            className={nbtControl}
            disabled={columnOffset === 0}
            onClick={() => setColumnOffset((value) => Math.max(0, value - 8))}
          >
            Previous fields
          </button>
          <span>
            {page?.totalColumns
              ? columnOffset +
                1 +
                "–" +
                Math.min(columnOffset + 8, page.totalColumns) +
                " of " +
                page.totalColumns.toLocaleString()
              : "No fields"}
          </span>
          <button
            className={nbtControl}
            disabled={!page || columnOffset + 8 >= page.totalColumns}
            onClick={() => setColumnOffset((value) => value + 8)}
          >
            Next fields
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div
        ref={horizontal}
        className="flex min-h-0 flex-1 flex-col overflow-x-auto"
      >
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{
            minWidth: Math.max(500, 80 + (page?.columns.length ?? 0) * 170),
          }}
          role="table"
          aria-label="NBT compound table"
        >
          <div
            role="row"
            className="flex h-8 shrink-0 border-b border-border/45 text-xs"
          >
            <span
              role="columnheader"
              className="w-20 shrink-0 px-2 py-2 text-muted-foreground"
            >
              Item
            </span>
            {page?.columns.map((column) => (
              <span
                key={column.id}
                role="columnheader"
                className="w-[170px] shrink-0 truncate border-l border-border/20 px-2 py-2 font-mono"
                title={column.name}
              >
                {column.name}
                {column.truncated ? "…" : ""}
              </span>
            ))}
          </div>
          <NbtVirtualList
            ref={list}
            initialPosition={initialState?.position}
            complete={complete && loaded?.key === pageKey}
            count={page?.totalRows ?? row.node.childCount}
            onRange={onRange}
            label="NBT table rows"
            render={(index) => {
              const item = loaded?.page.rows[index - loaded.offset];
              return (
                <div
                  role="row"
                  className="flex h-8 border-b border-border/20 text-xs"
                  data-nbt-table-row={item?.ordinal}
                >
                  <button
                    className="w-20 shrink-0 px-2 text-left text-muted-foreground hover:bg-accent"
                    aria-label={
                      item ? "Select item " + item.ordinal : "Loading item"
                    }
                    onClick={() => item && onSelect(item.item)}
                  >
                    {item ? "[" + item.ordinal + "]" : "…"}
                  </button>
                  {page?.columns.map((column, i) => {
                    const cell = item?.cells[i];
                    return (
                      <button
                        key={column.id}
                        role="cell"
                        className="flex w-[170px] shrink-0 items-center gap-1 overflow-hidden border-l border-border/20 px-2 text-left hover:bg-accent/40"
                        onClick={() => cell && onSelect(cell)}
                        title={
                          cell
                            ? NBT_TYPE_NAMES[cell.node.type] +
                              ": " +
                              nbtRowValue(cell)
                            : "Missing field"
                        }
                      >
                        <span className="truncate font-mono">
                          {cell ? nbtRowValue(cell) : "—"}
                        </span>
                        {cell ? (
                          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                            {NBT_TYPE_NAMES[cell.node.type]}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}
