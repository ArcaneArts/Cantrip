import { Plus, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";

import type { TabularFileFormat } from "./explorer-file-language";
import {
  appendPropertyEntry,
  parseCsvFile,
  parsePropertyFile,
  updateCsvCell,
  updatePropertyEntry,
} from "./tabular-file";

function TextCellEditor({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit(value: string): void;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = () => {
    if (draft === value) return;
    try {
      onCommit(draft);
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Value is invalid.",
      );
    }
  };
  const shared = {
    "aria-invalid": Boolean(error),
    "aria-label": label,
    onBlur: commit,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setDraft(event.target.value);
      setError(null);
    },
    spellCheck: false,
    title: error ?? undefined,
    value: draft,
  };

  return (
    <div className="min-w-0">
      {value.includes("\n") ? (
        <textarea
          {...shared}
          className="min-h-20 w-full min-w-36 resize-y rounded-md border border-border/50 bg-transparent px-2 py-1.5 font-mono text-xs leading-5 outline-none transition-colors hover:bg-muted/20 focus:border-ring/60 focus:bg-background"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(value);
              setError(null);
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <input
          {...shared}
          className="h-8 w-full min-w-36 rounded-md border border-transparent bg-transparent px-2 font-mono text-xs outline-none transition-colors hover:border-border/60 hover:bg-muted/20 focus:border-ring/60 focus:bg-background"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(value);
              setError(null);
              event.currentTarget.blur();
            }
          }}
        />
      )}
      {error ? (
        <p className="px-2 pb-1 text-[10px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function VisualUnavailable({ error }: { error: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-lg border-y border-destructive/30 bg-destructive/5 p-5 text-sm">
        <p className="font-medium text-destructive">
          Visual mode is unavailable
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Switch to Edit to repair the document, or Preview to inspect its
          source.
        </p>
      </div>
    </div>
  );
}

function SearchBar({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className="relative min-w-56 flex-1 sm:max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
      <input
        aria-label={label}
        className="h-7 w-full rounded-md border border-border/70 bg-muted/15 pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring/60 focus:bg-background"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        value={value}
      />
      {value ? (
        <button
          aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onChange("")}
          type="button"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function CsvVisual({
  content,
  onChange,
  query,
  setEditError,
}: {
  content: string;
  onChange(content: string): void;
  query: string;
  setEditError(error: string | null): void;
}) {
  const parsed = useMemo(() => {
    try {
      return { error: null, value: parseCsvFile(content) };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "CSV could not be parsed.",
        value: undefined,
      };
    }
  }, [content]);
  if (parsed.error || !parsed.value) {
    return <VisualUnavailable error={parsed.error ?? "CSV has no rows."} />;
  }

  const normalized = query.trim().toLowerCase();
  const matchingRows = parsed.value.rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) =>
      normalized
        ? row.some((cell) => cell.toLowerCase().includes(normalized))
        : true,
    );
  const update = (rowIndex: number, columnIndex: number, value: string) => {
    try {
      onChange(updateCsvCell(content, rowIndex, columnIndex, value));
      setEditError(null);
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : "The CSV cell could not be updated.",
      );
      throw error;
    }
  };
  const minimumWidth = Math.max(640, parsed.value.headers.length * 180 + 48);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-full overflow-hidden rounded-lg border border-border/70 bg-card/20 shadow-sm">
        <table
          className="w-full border-collapse"
          style={{ minWidth: `${minimumWidth}px` }}
        >
          <thead className="sticky top-0 z-10 bg-muted/95 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
            <tr>
              <th
                className="w-12 border-b border-r border-border/70 px-2 py-2 text-center"
                scope="col"
              >
                #
              </th>
              {parsed.value.headers.map((header, index) => (
                <th
                  className="border-b border-r border-border/70 px-3 py-2 text-left last:border-r-0"
                  key={`${index}-${header}`}
                  scope="col"
                  title={header}
                >
                  {header || `Column ${index + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matchingRows.map(({ index: rowIndex, row }) => (
              <tr className="hover:bg-muted/10" key={rowIndex}>
                <th
                  className="border-b border-r border-border/45 px-2 text-center font-mono text-[10px] font-normal text-muted-foreground"
                  scope="row"
                >
                  {rowIndex + 2}
                </th>
                {row.map((cell, columnIndex) => (
                  <td
                    className="border-b border-r border-border/35 p-1 align-top last:border-r-0"
                    key={columnIndex}
                  >
                    <TextCellEditor
                      label={`Edit row ${rowIndex + 2}, ${parsed.value!.headers[columnIndex] || `column ${columnIndex + 1}`}`}
                      onCommit={(value) => update(rowIndex, columnIndex, value)}
                      value={cell}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {matchingRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {normalized
              ? `No CSV rows match “${query.trim()}”.`
              : "This CSV has headers but no data rows."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AddPropertyRow({
  format,
  onAdd,
  onCancel,
}: {
  format: Exclude<TabularFileFormat, "csv">;
  onAdd(key: string, value: string): void;
  onCancel(): void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noun = format === "env" ? "variable" : "property";
  const add = () => {
    try {
      onAdd(key, value);
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : `The ${noun} could not be added.`,
      );
    }
  };

  return (
    <div className="grid min-w-[36rem] grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)_auto] border-b border-border/45 bg-primary/[0.03] p-1">
      <input
        aria-label={`New ${noun} name`}
        autoFocus
        className="h-8 min-w-0 rounded-md border border-border/70 bg-background px-2 font-mono text-xs outline-none focus:border-ring/60"
        onChange={(event) => {
          setKey(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter") add();
        }}
        placeholder={format === "env" ? "VARIABLE_NAME" : "property.name"}
        spellCheck={false}
        value={key}
      />
      <input
        aria-label={`New ${noun} value`}
        className="ml-1 h-8 min-w-0 rounded-md border border-border/70 bg-background px-2 font-mono text-xs outline-none focus:border-ring/60"
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter") add();
        }}
        placeholder="Value"
        spellCheck={false}
        value={value}
      />
      <div className="ml-1 flex gap-1">
        <button
          className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={add}
          type="button"
        >
          Add
        </button>
        <button
          className="h-8 rounded-md border border-border/70 px-3 text-xs hover:bg-muted"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p className="col-span-3 px-2 py-1 text-[10px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PropertyVisual({
  adding,
  content,
  format,
  onChange,
  onFinishAdding,
  query,
  setEditError,
}: {
  adding: boolean;
  content: string;
  format: Exclude<TabularFileFormat, "csv">;
  onChange(content: string): void;
  onFinishAdding(): void;
  query: string;
  setEditError(error: string | null): void;
}) {
  const parsed = useMemo(
    () => parsePropertyFile(content, format),
    [content, format],
  );
  const normalized = query.trim().toLowerCase();
  const matchingEntries = parsed.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      normalized
        ? `${entry.key} ${entry.value}`.toLowerCase().includes(normalized)
        : true,
    );
  const noun = format === "env" ? "Variable" : "Property";
  const update = (index: number, field: "key" | "value", value: string) => {
    try {
      onChange(updatePropertyEntry(content, format, index, field, value));
      setEditError(null);
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : `The ${noun.toLowerCase()} could not be updated.`,
      );
      throw error;
    }
  };
  const add = (key: string, value: string) => {
    try {
      onChange(appendPropertyEntry(content, format, key, value));
      setEditError(null);
      onFinishAdding();
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : `The ${noun.toLowerCase()} could not be added.`,
      );
      throw error;
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div
        className="mx-auto min-w-[36rem] max-w-6xl overflow-hidden rounded-lg border border-border/70 bg-card/20 shadow-sm"
        role="table"
      >
        <div
          className="grid grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)] border-b border-border/70 bg-muted/25 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          role="row"
        >
          <span className="px-3 py-2" role="columnheader">
            {noun}
          </span>
          <span className="px-3 py-2" role="columnheader">
            Value
          </span>
        </div>
        {adding ? (
          <AddPropertyRow
            format={format}
            onAdd={add}
            onCancel={onFinishAdding}
          />
        ) : null}
        {matchingEntries.map(({ entry, index }) => (
          <div
            className="grid grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)] border-b border-border/35 hover:bg-muted/10"
            key={`${index}-${entry.key}`}
            role="row"
          >
            <div className="border-r border-border/35 p-1" role="cell">
              <TextCellEditor
                label={`Edit ${noun.toLowerCase()} name ${entry.key}`}
                onCommit={(value) => update(index, "key", value)}
                value={entry.key}
              />
            </div>
            <div className="p-1" role="cell">
              <TextCellEditor
                label={`Edit ${entry.key} value`}
                onCommit={(value) => update(index, "value", value)}
                value={entry.value}
              />
            </div>
          </div>
        ))}
        {matchingEntries.length === 0 && !adding ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {normalized
              ? `No ${noun.toLowerCase()}s match “${query.trim()}”.`
              : `This file has no ${noun.toLowerCase()}s yet.`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TabularFileVisual({
  content,
  format,
  onChange,
  onSave,
  path,
}: {
  content: string;
  format: TabularFileFormat;
  onChange(content: string): void;
  onSave(): void;
  path: string;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    setQuery("");
    setAdding(false);
    setEditError(null);
  }, [path]);

  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    },
    [onSave],
  );
  const propertyDocument = useMemo(
    () => (format === "csv" ? null : parsePropertyFile(content, format)),
    [content, format],
  );
  const csvDocument = useMemo(() => {
    if (format !== "csv") return null;
    try {
      return parseCsvFile(content);
    } catch {
      return null;
    }
  }, [content, format]);
  const total =
    csvDocument?.rows.length ?? propertyDocument?.entries.length ?? 0;
  const noun =
    format === "csv" ? "rows" : format === "env" ? "variables" : "properties";
  const matching = query.trim()
    ? format === "csv"
      ? (csvDocument?.rows.filter((row) =>
          row.some((cell) =>
            cell.toLowerCase().includes(query.trim().toLowerCase()),
          ),
        ).length ?? 0)
      : (propertyDocument?.entries.filter((entry) =>
          `${entry.key} ${entry.value}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        ).length ?? 0)
    : total;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={handleSaveShortcut}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
        <SearchBar
          label={`Search ${noun}`}
          onChange={setQuery}
          placeholder={`Search ${noun}`}
          value={query}
        />
        <p className="text-[10px] text-muted-foreground">
          {query
            ? `${matching} of ${total} ${noun}`
            : `${total} editable ${noun}`}
        </p>
        <p className="hidden text-[10px] text-muted-foreground lg:block">
          {format === "csv"
            ? "Cells only · headers, rows, and columns are locked"
            : "Keys and values are editable · comments are preserved"}
        </p>
        {format !== "csv" ? (
          <button
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            disabled={adding}
            onClick={() => setAdding(true)}
            type="button"
          >
            <Plus className="size-3.5" />
            Add {format === "env" ? "variable" : "property"}
          </button>
        ) : null}
      </div>
      {editError ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {editError}
        </div>
      ) : null}
      {format === "csv" ? (
        <CsvVisual
          content={content}
          onChange={onChange}
          query={query}
          setEditError={setEditError}
        />
      ) : (
        <PropertyVisual
          adding={adding}
          content={content}
          format={format}
          onChange={onChange}
          onFinishAdding={() => setAdding(false)}
          query={query}
          setEditError={setEditError}
        />
      )}
    </div>
  );
}
