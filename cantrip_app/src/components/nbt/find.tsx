import {
  useEffect,
  useRef,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type RefObject,
  type Ref,
} from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import type {
  NbtDocumentClient,
  NbtSearchField,
  NbtSearchResult,
} from "@cantrip/nbt/document";
import type { NbtFindViewState, NbtViewHandle } from "@/lib/nbt/view-state";
export function NbtFind({
  client,
  open,
  active = true,
  revision = 0,
  onClose,
  inputRef,
  selection,
  onReveal,
  initialState,
  stateRef,
}: {
  client: NbtDocumentClient;
  open: boolean;
  active?: boolean;
  revision?: number;
  onClose(): void;
  inputRef: RefObject<HTMLInputElement | null>;
  selection: { id: string; name: string } | null;
  onReveal(result: NbtSearchResult, signal?: AbortSignal): Promise<void>;
  initialState?: NbtFindViewState;
  stateRef?: Ref<NbtViewHandle<NbtFindViewState>>;
}) {
  const [text, setText] = useState(initialState?.text ?? ""),
    [caseSensitive, setCase] = useState(initialState?.caseSensitive ?? false),
    [exactNumber, setExact] = useState(initialState?.exactNumber ?? false),
    [fields, setFields] = useState<NbtSearchField[]>(
      initialState?.fields ?? ["name", "value"],
    ),
    [scope, setScope] = useState<{ id: string; name: string } | undefined>(
      initialState?.scope
        ? { id: initialState.scope, name: "Selected subtree" }
        : undefined,
    ),
    [job, setJob] = useState<{ id: string; key: string } | null>(null),
    [error, setError] = useState<string | null>(null),
    [position, setPosition] = useState({ id: "", rank: -1 });
  const snapshot = useSyncExternalStore(
      client.subscribeSearch,
      client.getSearchSnapshot,
      () => null,
    ),
    key = JSON.stringify({
      revision,
      text,
      caseSensitive,
      exactNumber,
      fields,
      scope: scope?.id,
    }),
    rank = useRef(-1),
    navigation = useRef<AbortController | null>(null),
    auto = useRef(""),
    restoreRank = useRef(initialState?.rank ?? -1),
    firstKey = useRef(key);
  useImperativeHandle(
    stateRef,
    () => ({
      capture: () => ({
        text,
        fields: [...fields],
        caseSensitive,
        exactNumber,
        ...(scope ? { scope: scope.id } : {}),
        rank: rank.current < 0 ? restoreRank.current : rank.current,
      }),
    }),
    [text, fields, caseSensitive, exactNumber, scope],
  );
  const status = job?.key === key && snapshot?.id === job.id ? snapshot : null;
  useEffect(() => {
    if (key !== firstKey.current) restoreRank.current = -1;
    setError(null);
    rank.current = -1;
    auto.current = "";
    navigation.current?.abort();
    if (!active || !open || !text || !fields.length) {
      setJob(null);
      return;
    }
    let disposed = false;
    const id = crypto.randomUUID(),
      timer = setTimeout(() => {
        setJob({ id, key });
        void client
          .startSearch(id, {
            text,
            caseSensitive,
            exactNumber,
            fields,
            scope: scope?.id,
          })
          .catch((reason) => {
            if (!disposed) setError(String(reason.message ?? reason));
          });
      }, 120);
    return () => {
      disposed = true;
      clearTimeout(timer);
      navigation.current?.abort();
      void client.cancelSearch(id).catch(() => {});
    };
  }, [client, active, open, key]);
  useEffect(() => {
    if (active && open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active, open, inputRef]);
  useEffect(() => () => navigation.current?.abort(), []);
  const move = async (next: number) => {
    if (!job || !status?.count) return;
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    rank.current = (next + status.count) % status.count;
    setPosition({ id: job.id, rank: rank.current });
    try {
      const [result] = await client.searchResults(
        job.id,
        rank.current,
        1,
        controller.signal,
      );
      if (result && !controller.signal.aborted)
        await onReveal(result, controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(String((reason as Error).message ?? reason));
    }
  };
  useEffect(() => {
    if (status?.count && job && auto.current !== job.id) {
      if (restoreRank.current >= status.count && status.state === "searching")
        return;
      auto.current = job.id;
      const next = Math.max(0, Math.min(restoreRank.current, status.count - 1));
      restoreRank.current = -1;
      void move(next);
    }
  }, [status?.count, job?.id]);
  if (!open) return null;
  const current = job && position.id === job.id ? position.rank : -1;
  return (
    <div
      className="absolute right-2 top-2 z-20 w-[min(30rem,calc(100%-1rem))] rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur"
      data-nbt-find=""
    >
      <div className="flex items-center gap-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Find in NBT"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void move(rank.current + (event.shiftKey ? -1 : 1));
            }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
          placeholder="Find names or values…"
        />
        <span
          className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
          role="status"
          data-nbt-search-status={status?.state ?? (text ? "pending" : "idle")}
        >
          {status
            ? (current >= 0 ? current + 1 + " of " : "") +
              status.count.toLocaleString() +
              (status.state === "searching"
                ? " · searching…"
                : status.state === "error"
                  ? " · incomplete"
                  : " found")
            : text
              ? fields.length
                ? "Searching…"
                : "Choose a field"
              : ""}
        </span>
        <button
          className="rounded p-1 hover:bg-accent disabled:opacity-30"
          aria-label="Previous NBT result"
          disabled={!status?.count}
          onClick={() => void move(rank.current - 1)}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent disabled:opacity-30"
          aria-label="Next NBT result"
          disabled={!status?.count}
          onClick={() => void move(rank.current + 1)}
        >
          <ArrowDown className="size-3.5" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent"
          aria-label="Close NBT find"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <details className="mt-1 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer select-none">Find options</summary>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
          {(
            [
              ["name", "Names"],
              ["value", "Values"],
              ["type", "Types"],
              ["path", "Paths"],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(event) =>
                  setFields((current) =>
                    event.target.checked
                      ? [...current, field]
                      : current.filter((value) => value !== field),
                  )
                }
              />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCase(event.target.checked)}
            />
            Match case
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={exactNumber}
              onChange={(event) => setExact(event.target.checked)}
            />
            Exact number
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(scope)}
              disabled={!selection}
              onChange={(event) =>
                setScope(
                  event.target.checked ? (selection ?? undefined) : undefined,
                )
              }
            />
            Within selected subtree
          </label>
          {scope ? (
            <span className="max-w-36 truncate" title={scope.name}>
              {scope.name || "Root"}
            </span>
          ) : null}
        </div>
      </details>
      {error || status?.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error ?? status?.error?.message}
        </p>
      ) : null}
    </div>
  );
}
