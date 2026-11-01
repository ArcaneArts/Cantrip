import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FileUp, Search } from "lucide-react";
import type {
  NbtDisplayRow,
  NbtDocumentSource,
  NbtSearchResult,
} from "@cantrip/nbt/document";
import { useNbtClient } from "./use-client";
import { NbtTree, type NbtAnchor } from "./tree";
import { NbtArray } from "./array";
import { NbtTable } from "./table";
import { NbtFind } from "./find";
import { container, nbtControl, NBT_PROFILES, NBT_TYPE_NAMES } from "./format";

export function NbtBrowser({
  openSource,
  scope,
  active = true,
  label = "NBT",
  onReady,
  onError,
  onLocalFile,
}: {
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>;
  scope: string;
  active?: boolean;
  label?: string;
  onReady?(): void;
  onError?(error: unknown): void;
  onLocalFile?(file: File): void;
}) {
  const [profile, setProfile] = useState("auto"),
    [compression, setCompression] = useState("auto"),
    [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set()),
    [selected, setSelected] = useState<NbtDisplayRow | null>(null),
    [target, setTarget] = useState<NbtDisplayRow | null>(null),
    [mode, setMode] = useState<"tree" | "array" | "table">("tree"),
    [anchor, setAnchor] = useState<NbtAnchor | null>(null),
    [arrayFocus, setArrayFocus] = useState<{
      index: number;
      nonce: number;
    } | null>(null),
    [find, setFind] = useState(false),
    [crumbs, setCrumbs] = useState<NbtDisplayRow[]>([]),
    [navigationError, setNavigationError] = useState<string | null>(null);
  const { client, status, error } = useNbtClient(
      openSource,
      scope,
      profile,
      compression,
      active,
    ),
    input = useRef<HTMLInputElement>(null),
    local = useRef<HTMLInputElement>(null),
    root = useRef<HTMLDivElement>(null),
    nonce = useRef(0),
    ready = useRef<unknown>(null),
    initialRoot = useRef<unknown>(null),
    navigation = useRef<AbortController | null>(null);
  useEffect(() => {
    setExpanded(new Set());
    setSelected(null);
    setTarget(null);
    setMode("tree");
    setAnchor(null);
    setArrayFocus(null);
    ready.current = null;
    initialRoot.current = null;
    navigation.current?.abort();
    return () => navigation.current?.abort();
  }, [client]);
  useEffect(() => {
    if (client && status?.root) {
      if (initialRoot.current !== client) {
        initialRoot.current = client;
        setExpanded(new Set([status.root!]));
      }
      if (ready.current !== client) {
        ready.current = client;
        onReady?.();
      }
    }
    if (status?.state === "error")
      onError?.(new Error(status.error?.message ?? "NBT could not be read."));
  }, [client, status?.root, status?.state, onReady, onError]);
  useEffect(() => {
    if (error) onError?.(new Error(error));
  }, [error, onError]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        !active ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.current?.contains(focus))
        return;
      event.preventDefault();
      event.stopPropagation();
      setFind(true);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
  const select = useCallback((row: NbtDisplayRow) => {
    navigation.current?.abort();
    setSelected(row);
  }, []);
  const reveal = useCallback(
    async (result: NbtSearchResult, signal?: AbortSignal) => {
      if (!client) return;
      navigation.current?.abort();
      const controller = new AbortController();
      navigation.current = controller;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      setNavigationError(null);
      try {
        const path = await client.ancestors(result.nodeId, controller.signal),
          row = await client.describe(result.nodeId, controller.signal);
        controller.signal.throwIfAborted();
        setExpanded((current) => {
          const next = new Set(current);
          for (const part of path.slice(0, -1)) next.add(part.id);
          return next;
        });
        setSelected(row);
        if (result.elementIndex !== undefined) {
          setTarget(row);
          setMode("array");
          setArrayFocus({ index: result.elementIndex, nonce: ++nonce.current });
        } else {
          setMode("tree");
          setAnchor({ id: row.node.id, center: true, nonce: ++nonce.current });
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setNavigationError(String((reason as Error).message ?? reason));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    [client],
  );
  useEffect(() => {
    if (!client || !selected) {
      setCrumbs([]);
      return;
    }
    const controller = new AbortController();
    void client
      .ancestors(selected.node.id, controller.signal)
      .then(async (path) => {
        const visible = path.length > 8 ? [path[0]!, ...path.slice(-7)] : path;
        const rows = [];
        for (const part of visible)
          rows.push(await client.describe(part.id, controller.signal));
        if (!controller.signal.aborted) setCrumbs(rows);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, selected?.node.id]);
  const open = useCallback((row: NbtDisplayRow, next: "array" | "table") => {
    setSelected(row);
    setTarget(row);
    setMode(next);
    setArrayFocus(null);
  }, []);
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="relative flex h-full min-h-0 min-w-0 flex-col outline-none"
      data-nbt-viewer=""
      data-nbt-binding={scope}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/45 px-3 py-2 text-xs">
        <span className="mr-1 max-w-40 truncate font-medium" title={label}>
          {label}
        </span>
        <label className="flex items-center gap-1 text-muted-foreground">
          Encoding
          <select
            className={nbtControl}
            aria-label="NBT encoding"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            {NBT_PROFILES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          Compression
          <select
            className={nbtControl}
            aria-label="NBT compression"
            value={compression}
            onChange={(event) => setCompression(event.target.value)}
          >
            <option value="auto">Automatic</option>
            <option value="none">Raw</option>
            <option value="gzip">Gzip</option>
            <option value="zlib">Zlib</option>
          </select>
        </label>
        <span
          className="ml-auto text-[10px] text-muted-foreground"
          role="status"
          data-nbt-document-state={status?.state ?? "opening"}
        >
          {status
            ? (status.state === "complete"
                ? status.nodes.toLocaleString() + " tags"
                : status.state === "indexing"
                  ? "Indexing… " + status.nodes.toLocaleString() + " tags"
                  : status.state === "paused"
                    ? "Indexing paused"
                    : status.state) +
              " · " +
              (status.availableBytes / 1024 ** 2).toFixed(1) +
              " MiB"
            : "Opening…"}
        </span>
        <button
          className={nbtControl + " inline-flex items-center gap-1"}
          disabled={!client}
          onClick={() => setFind((value) => !value)}
          aria-label="Find in NBT document"
        >
          <Search className="size-3.5" />
          <span>Find</span>
        </button>
        {onLocalFile ? (
          <>
            <input
              ref={local}
              type="file"
              accept=".nbt,.dat,.dat_old,.schematic,.litematic,.structure,*/*"
              className="hidden"
              aria-label="Choose local NBT file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onLocalFile(file);
                event.target.value = "";
              }}
            />
            <button
              className={nbtControl}
              onClick={() => local.current?.click()}
              aria-label="Open local NBT file"
            >
              <FileUp className="size-3.5" />
            </button>
          </>
        ) : null}
      </div>
      <div
        className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/25 px-2 text-[10px] text-muted-foreground"
        aria-label="NBT breadcrumbs"
      >
        {mode !== "tree" ? (
          <button
            className="mr-1 inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 hover:bg-accent"
            onClick={() => {
              setMode("tree");
              if (target)
                setAnchor({
                  id: target.node.id,
                  center: false,
                  nonce: ++nonce.current,
                });
            }}
          >
            <ArrowLeft className="size-3" />
            Tree
          </button>
        ) : null}
        {crumbs.length ? (
          crumbs.map((row, i) => (
            <span
              className="inline-flex shrink-0 items-center"
              key={row.node.id}
            >
              {i ? <span className="mx-1 opacity-40">›</span> : null}
              <button
                className="max-w-36 truncate rounded px-1 py-1 hover:bg-accent"
                onClick={() =>
                  void reveal({
                    id: "breadcrumb",
                    nodeId: row.node.id,
                    fields: [],
                  })
                }
              >
                {row.name ||
                  (row.node.parent === null
                    ? "Root"
                    : "[" + row.node.ordinal + "]")}
              </button>
            </span>
          ))
        ) : (
          <span>Names / types / values</span>
        )}
        {selected ? (
          <span className="ml-auto shrink-0 pl-2">
            {NBT_TYPE_NAMES[selected.node.type]}
          </span>
        ) : null}
      </div>
      {error || navigationError || status?.error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {error ?? navigationError ?? status?.error?.message}
          <p className="mt-1 text-muted-foreground">
            Check the encoding and compression options for this file.
          </p>
        </div>
      ) : null}
      {client ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {mode === "array" && target ? (
            <NbtArray
              key={target.node.id}
              client={client}
              row={target}
              focus={arrayFocus}
              availableBytes={status?.availableBytes ?? 0}
            />
          ) : mode === "table" && target ? (
            <NbtTable
              key={target.node.id}
              client={client}
              row={target}
              nodes={status?.nodes ?? 0}
              onSelect={select}
            />
          ) : (
            <NbtTree
              client={client}
              root={status?.root ?? null}
              nodes={status?.nodes ?? 0}
              expanded={expanded}
              onExpanded={setExpanded}
              selected={selected?.node.id ?? null}
              onSelected={select}
              onOpen={open}
              anchor={anchor}
            />
          )}
          <NbtFind
            client={client}
            open={find}
            onClose={() => {
              setFind(false);
              root.current
                ?.querySelector<HTMLElement>('[role="treegrid"]')
                ?.focus();
            }}
            inputRef={input}
            selection={
              selected
                ? { id: selected.node.id, name: selected.name || "Root" }
                : status?.root
                  ? { id: status.root, name: "Root" }
                  : null
            }
            onReveal={reveal}
          />
        </div>
      ) : !error ? (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">
          Opening NBT document…
        </div>
      ) : null}
    </div>
  );
}
