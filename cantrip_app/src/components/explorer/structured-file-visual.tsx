import {
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  StructuredFileFormat,
  VisualFileFormat,
} from "./explorer-file-language";
import {
  coerceStructuredScalar,
  countStructuredScalarValues,
  countStructuredSearchMatches,
  formatStructuredScalar,
  isStructuredCollection,
  parseStructuredFile,
  structuredEntries,
  structuredEntryOwnMatches,
  structuredScalarType,
  structuredValueMatches,
  updateStructuredFileContent,
  type StructuredPath,
  type StructuredScalar,
  type StructuredValue,
} from "./structured-file";
import { TabularFileVisual } from "./tabular-file-visual";

function displayKey(key: string | number): string {
  return typeof key === "number" ? `[${key}]` : key;
}

function pathId(path: StructuredPath): string {
  return JSON.stringify(path);
}

function ScalarEditor({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit(value: StructuredScalar): void;
  value: StructuredScalar;
}) {
  const formatted = formatStructuredScalar(value);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(formatted);
    setError(null);
  }, [formatted]);

  const commit = () => {
    if (draft === formatted) {
      setError(null);
      return;
    }
    try {
      onCommit(coerceStructuredScalar(draft, value));
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Value is invalid.",
      );
    }
  };

  if (typeof value === "boolean") {
    return (
      <button
        aria-checked={value}
        aria-label={`Edit ${label}`}
        className="inline-flex h-7 min-w-16 items-center justify-center rounded-md border border-border/70 bg-muted/25 px-2 font-mono text-xs text-foreground transition-colors hover:bg-muted/60"
        onClick={() => {
          try {
            onCommit(!value);
            setError(null);
          } catch (nextError) {
            setError(
              nextError instanceof Error
                ? nextError.message
                : "Value is invalid.",
            );
          }
        }}
        role="switch"
        type="button"
      >
        {String(value)}
      </button>
    );
  }

  if (typeof value === "string" && value.includes("\n")) {
    return (
      <div className="min-w-0 py-1">
        <textarea
          aria-invalid={Boolean(error)}
          aria-label={`Edit ${label}`}
          className="min-h-20 w-full min-w-32 resize-y rounded-md border border-border/55 bg-transparent px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none transition-colors hover:bg-muted/20 focus:border-ring/60 focus:bg-background"
          onBlur={commit}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(formatted);
              setError(null);
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          title={error ?? undefined}
          value={draft}
        />
        {error ? (
          <p className="px-2 pt-1 text-[10px] text-destructive">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <input
        aria-invalid={Boolean(error)}
        aria-label={`Edit ${label}`}
        className="h-7 w-full min-w-32 rounded-md border border-transparent bg-transparent px-2 font-mono text-xs text-foreground outline-none transition-colors hover:border-border/60 hover:bg-muted/20 focus:border-ring/60 focus:bg-background"
        onBlur={commit}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(formatted);
            setError(null);
            event.currentTarget.blur();
          }
        }}
        spellCheck={false}
        title={error ?? undefined}
        value={draft}
      />
      {error ? (
        <p className="px-2 pt-1 text-[10px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function StructuredRows({
  depth,
  expanded,
  forceVisible,
  onChange,
  onToggle,
  path,
  query,
  value,
}: {
  depth: number;
  expanded: ReadonlySet<string>;
  forceVisible: boolean;
  onChange(path: StructuredPath, value: StructuredScalar): void;
  onToggle(id: string): void;
  path: StructuredPath;
  query: string;
  value: StructuredValue;
}) {
  const searching = Boolean(query.trim());

  return structuredEntries(value).map(([key, entry]) => {
    const entryPath = [...path, key];
    const id = pathId(entryPath);
    if (
      searching &&
      !forceVisible &&
      !structuredValueMatches(entry, key, entryPath, query)
    ) {
      return null;
    }
    const keyLabel = displayKey(key);
    const pathLabel = entryPath.map(displayKey).join(" › ");
    const paddingLeft = `${Math.min(depth, 8) * 16 + 12}px`;

    if (isStructuredCollection(entry)) {
      const ownMatches = structuredEntryOwnMatches(
        entry,
        key,
        entryPath,
        query,
      );
      const open = searching || expanded.has(id);
      const count = countStructuredScalarValues(entry);
      const CollectionIcon = Array.isArray(entry) ? Brackets : Braces;
      return (
        <div key={id} role="rowgroup">
          <button
            aria-expanded={open}
            className="grid w-full min-w-[36rem] grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)] border-b border-border/45 text-left transition-colors hover:bg-muted/20"
            onClick={() => onToggle(id)}
            role="row"
            type="button"
          >
            <span
              className="flex min-w-0 items-center gap-2 py-2 pr-3"
              role="cell"
              style={{ paddingLeft }}
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <CollectionIcon className="size-3.5 shrink-0 text-primary/80" />
              <span className="truncate font-mono text-xs font-medium">
                {keyLabel}
              </span>
            </span>
            <span
              className="flex min-w-0 items-center justify-between gap-3 py-2 pr-4 text-[10px] text-muted-foreground"
              role="cell"
            >
              <span className="truncate font-mono">{pathLabel}</span>
              <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5">
                {count} {count === 1 ? "value" : "values"}
              </span>
            </span>
          </button>
          {open ? (
            <StructuredRows
              depth={depth + 1}
              expanded={expanded}
              forceVisible={forceVisible || ownMatches}
              onChange={onChange}
              onToggle={onToggle}
              path={entryPath}
              query={query}
              value={entry}
            />
          ) : null}
        </div>
      );
    }

    return (
      <div
        className="grid min-w-[36rem] grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)] border-b border-border/35 hover:bg-muted/10"
        key={id}
        role="row"
      >
        <div
          className="flex min-w-0 items-center gap-2 py-1.5 pr-3"
          role="cell"
          style={{ paddingLeft: `${Math.min(depth, 8) * 16 + 34}px` }}
        >
          <span className="min-w-0 truncate font-mono text-xs">{keyLabel}</span>
          <span className="shrink-0 rounded border border-border/45 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
            {structuredScalarType(entry)}
          </span>
        </div>
        <div className="min-w-0 py-1 pr-3" role="cell">
          <ScalarEditor
            label={pathLabel || "Value"}
            onCommit={(next) => onChange(entryPath, next)}
            value={entry}
          />
        </div>
      </div>
    );
  });
}

function NestedStructuredFileVisual({
  content,
  format,
  onChange,
  onSave,
  path,
}: {
  content: string;
  format: StructuredFileFormat;
  onChange(content: string): void;
  onSave(): void;
  path: string;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editError, setEditError] = useState<string | null>(null);
  const parsed = useMemo(() => {
    try {
      return { error: null, value: parseStructuredFile(content, format) };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "The structured file could not be parsed.",
        value: undefined,
      };
    }
  }, [content, format]);

  useEffect(() => {
    setQuery("");
    setExpanded(new Set());
    setEditError(null);
  }, [path]);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateValue = useCallback(
    (valuePath: StructuredPath, value: StructuredScalar) => {
      try {
        onChange(
          updateStructuredFileContent(content, format, valuePath, value),
        );
        setEditError(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "The value could not be updated.";
        setEditError(message);
        throw error;
      }
    },
    [content, format, onChange],
  );

  const handleSaveShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
    }
  };

  if (parsed.error || parsed.value === undefined) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-lg border-y border-destructive/30 bg-destructive/5 p-5 text-sm">
          <p className="font-medium text-destructive">
            Visual mode is unavailable
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {parsed.error ?? "The document has no visual values."}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Switch to Edit to repair the document, or Preview to inspect its
            source.
          </p>
        </div>
      </div>
    );
  }

  const resultCount = countStructuredSearchMatches(parsed.value, query);
  const scalarCount = countStructuredScalarValues(parsed.value);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={handleSaveShortcut}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="relative min-w-56 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <input
            aria-label="Search structured values"
            className="h-7 w-full rounded-md border border-border/70 bg-muted/15 pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring/60 focus:bg-background"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search keys, paths, types, and values"
            spellCheck={false}
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear structured value search"
              className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setQuery("")}
              type="button"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {query
            ? `${resultCount.toLocaleString()} of ${scalarCount.toLocaleString()} values`
            : `${scalarCount.toLocaleString()} editable ${scalarCount === 1 ? "value" : "values"}`}
        </p>
        <p className="hidden text-[10px] text-muted-foreground lg:block">
          Values only · keys and structure are locked
        </p>
      </div>
      {editError ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {editError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div
          className="mx-auto min-w-[36rem] max-w-6xl overflow-hidden rounded-lg border border-border/70 bg-card/20 shadow-sm"
          role="table"
        >
          <div
            className="grid grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)] border-b border-border/70 bg-muted/25 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            role="row"
          >
            <span className="px-3 py-2" role="columnheader">
              Key
            </span>
            <span className="px-3 py-2" role="columnheader">
              Value
            </span>
          </div>
          {isStructuredCollection(parsed.value) ? (
            <StructuredRows
              depth={0}
              expanded={expanded}
              forceVisible={false}
              onChange={updateValue}
              onToggle={toggle}
              path={[]}
              query={query}
              value={parsed.value}
            />
          ) : !query ||
            structuredValueMatches(parsed.value, "Value", [], query) ? (
            <div
              className="grid grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)]"
              role="row"
            >
              <div className="px-3 py-2 font-mono text-xs" role="cell">
                Value
              </div>
              <div className="p-1" role="cell">
                <ScalarEditor
                  label="Value"
                  onCommit={(next) => updateValue([], next)}
                  value={parsed.value}
                />
              </div>
            </div>
          ) : null}
          {resultCount === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              {query.trim()
                ? `No keys or values match “${query.trim()}”.`
                : "This document has no scalar values."}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function StructuredFileVisual({
  content,
  format,
  onChange,
  onSave,
  path,
}: {
  content: string;
  format: VisualFileFormat;
  onChange(content: string): void;
  onSave(): void;
  path: string;
}) {
  if (format === "csv" || format === "env" || format === "properties") {
    return (
      <TabularFileVisual
        content={content}
        format={format}
        onChange={onChange}
        onSave={onSave}
        path={path}
      />
    );
  }

  return (
    <NestedStructuredFileVisual
      content={content}
      format={format}
      onChange={onChange}
      onSave={onSave}
      path={path}
    />
  );
}
