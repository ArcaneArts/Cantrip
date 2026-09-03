import type { GitHistoryFilter, GitHistoryOptions } from "@cantrip/protocol";
import { Filter, GitMerge, ListTree, Search, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const filterLabels: Record<keyof GitHistoryFilter, string> = {
  message: "Message",
  author: "Author",
  hash: "SHA",
  dateFrom: "From",
  dateTo: "To",
  path: "Path",
  branch: "Branch",
  tag: "Tag",
};

export function GitHistoryFilters({
  disabled,
  onAdvancedSearch,
  onChange,
  options,
}: {
  disabled?: boolean;
  onAdvancedSearch(): void;
  onChange(options: GitHistoryOptions): void;
  options: GitHistoryOptions;
}) {
  const [draft, setDraft] = useState("");
  const activeFilters = Object.entries(options.filters).filter(
    (entry): entry is [keyof GitHistoryFilter, string] => Boolean(entry[1]),
  );
  const updateFilter = (key: keyof GitHistoryFilter, value: string | null) => {
    const filters = { ...options.filters, [key]: value };
    if (key === "branch" && value) filters.tag = null;
    if (key === "tag" && value) filters.branch = null;
    onChange({ ...options, filters });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
      <form
        className="flex min-w-48 flex-1 items-center gap-1 sm:max-w-80"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          if (!next) return;
          updateFilter("message", next);
          setDraft("");
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter history by commit message"
            className="h-7 pl-7 text-xs"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Filter commit messages…"
            value={draft}
          />
        </div>
        <Button
          className="h-7 px-2 text-[10px]"
          disabled={disabled || !draft.trim()}
          size="sm"
          type="submit"
          variant="outline"
        >
          Apply
        </Button>
      </form>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {activeFilters.map(([key, value]) => (
          <button
            key={key}
            type="button"
            className="inline-flex h-6 max-w-64 shrink-0 items-center gap-1 rounded-full border bg-muted/45 px-2 text-[10px] hover:bg-muted"
            onClick={() => updateFilter(key, null)}
            title={`Remove ${filterLabels[key]} filter`}
          >
            <span className="text-muted-foreground">{filterLabels[key]}:</span>
            <span className="truncate font-medium">{value}</span>
            <X className="size-3" />
          </button>
        ))}
        {activeFilters.length === 0 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            Click an author, branch, tag, or changed path to filter
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-pressed={options.firstParent}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground",
            options.firstParent && "bg-muted font-medium text-foreground",
          )}
          disabled={disabled}
          onClick={() =>
            onChange({ ...options, firstParent: !options.firstParent })
          }
          title="Follow only each commit's first parent"
        >
          <ListTree className="size-3.5" /> First parent
        </button>
        <button
          type="button"
          aria-pressed={options.hideMerges}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground",
            options.hideMerges && "bg-muted font-medium text-foreground",
          )}
          disabled={disabled}
          onClick={() =>
            onChange({ ...options, hideMerges: !options.hideMerges })
          }
          title="Hide merge commits"
        >
          <GitMerge className="size-3.5" /> Hide merges
        </button>
        <Button
          className="size-7"
          disabled={disabled}
          onClick={onAdvancedSearch}
          size="icon"
          title="Advanced history filters"
          variant="ghost"
        >
          <Filter className="size-3.5" />
          <span className="sr-only">Advanced history filters</span>
        </Button>
      </div>
    </div>
  );
}
