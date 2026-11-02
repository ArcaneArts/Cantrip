import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NbtDocumentClient, NbtDisplayRow } from "@cantrip/nbt/document";
import { NbtVirtualList, type NbtVirtualHandle } from "./virtual-list";
import { hexValue, nbtControl, NBT_TYPE_NAMES } from "./format";
import type { NbtArrayViewState, NbtViewHandle } from "@/lib/nbt/view-state";
export function NbtArray({
  client,
  active = true,
  row,
  focus,
  availableBytes,
  revision = 0,
  onEdit,
  initialState,
  stateRef,
}: {
  client: NbtDocumentClient;
  active?: boolean;
  row: NbtDisplayRow;
  focus: { index: number; nonce: number } | null;
  availableBytes: number;
  revision?: number;
  onEdit?(index: number): void;
  initialState?: NbtArrayViewState;
  stateRef?: Ref<NbtViewHandle<NbtArrayViewState>>;
}) {
  const [columns, setColumns] = useState(4),
    [hex, setHex] = useState(initialState?.hex ?? false),
    [range, setRange] = useState({ offset: 0, limit: 32 }),
    [values, setValues] = useState(new Map<number, number | bigint>()),
    [error, setError] = useState<string | null>(null),
    [jump, setJump] = useState("");
  const list = useRef<NbtVirtualHandle>(null),
    host = useRef<HTMLDivElement>(null),
    columnsRef = useRef(columns),
    firstElement = useRef(initialState?.firstElement ?? 0);
  columnsRef.current = columns;
  useImperativeHandle(
    stateRef,
    () => ({
      capture: () => ({
        firstElement: Math.floor(
          (list.current?.capturePosition() ?? 0) * columns,
        ),
        hex,
      }),
    }),
    [columns, hex],
  );
  useLayoutEffect(() => {
    list.current?.restorePosition(Math.floor(firstElement.current / columns));
  }, [columns]);
  const total = row.node.length ?? 0;
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
    const node = host.current;
    if (!active || !node) return;
    const observer = new ResizeObserver(() => {
      const next = Math.max(1, Math.min(8, Math.floor(node.clientWidth / 150)));
      if (next === columnsRef.current) return;
      firstElement.current = Math.floor(
        (list.current?.capturePosition() ?? 0) * columnsRef.current,
      );
      columnsRef.current = next;
      setColumns(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const result = new Map<number, number | bigint>(),
        first = range.offset * columns,
        count = Math.min(range.limit * columns, Math.max(0, total - first));
      for (let at = first; at < first + count; at += 4096) {
        const page = await client.array(
          row.node.id,
          at,
          Math.min(4096, first + count - at),
          controller.signal,
        );
        page.forEach((value, i) => result.set(at + i, value));
      }
      if (!controller.signal.aborted) {
        setValues(result);
      }
    })().catch((reason) => {
      if (!controller.signal.aborted)
        setError(String(reason.message ?? reason));
    });
    return () => controller.abort();
  }, [
    client,
    active,
    row.node.id,
    total,
    columns,
    range.offset,
    range.limit,
    availableBytes,
    revision,
  ]);
  useEffect(() => {
    if (active && focus)
      list.current?.scrollToIndex(Math.floor(focus.index / columns), "center");
  }, [active, focus, columns]);
  return (
    <div
      ref={host}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-nbt-array=""
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 p-2 text-xs">
        <span>
          {NBT_TYPE_NAMES[row.node.type]} · {total.toLocaleString()} elements
        </span>
        <label className="ml-auto flex items-center gap-1 text-muted-foreground">
          Display
          <select
            className={nbtControl}
            aria-label="Array number format"
            value={hex ? "hex" : "decimal"}
            onChange={(event) => setHex(event.target.value === "hex")}
          >
            <option value="decimal">Decimal</option>
            <option value="hex">Hexadecimal</option>
          </select>
        </label>
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const index = Number(jump);
            if (Number.isSafeInteger(index) && index >= 0 && index < total) {
              setError(null);
              list.current?.scrollToIndex(
                Math.floor(index / columns),
                "center",
              );
            } else setError("Enter an element index within this array.");
          }}
        >
          <input
            className={nbtControl + " w-24"}
            aria-label="Array element index"
            value={jump}
            onChange={(event) => setJump(event.target.value)}
            inputMode="numeric"
            placeholder="Index"
          />
          <button className={nbtControl} type="submit">
            Go
          </button>
        </form>
      </div>
      {error ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <NbtVirtualList
        ref={list}
        count={Math.ceil(total / columns)}
        onRange={onRange}
        label="NBT array rows"
        render={(index) => (
          <div
            className="grid h-8 border-b border-border/15"
            style={{
              gridTemplateColumns: "repeat(" + columns + ", minmax(0,1fr))",
            }}
          >
            {Array.from(
              { length: Math.min(columns, total - index * columns) },
              (_, column) => {
                const at = index * columns + column,
                  value = values.get(at);
                return (
                  <button
                    type="button"
                    disabled={!onEdit || value === undefined}
                    aria-label={"Edit array element " + at}
                    onClick={() => onEdit?.(at)}
                    key={at}
                    data-nbt-element={at}
                    className={
                      "flex min-w-0 items-center gap-2 border-r border-border/20 px-2 font-mono text-xs " +
                      (focus?.index === at ? "bg-accent" : "")
                    }
                  >
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {at}
                    </span>
                    <span
                      className="truncate"
                      title={value === undefined ? "Loading" : String(value)}
                    >
                      {value === undefined
                        ? "…"
                        : hex
                          ? hexValue(value, row.node.type)
                          : String(value)}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        )}
      />
    </div>
  );
}
