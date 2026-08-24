import type {
  RunConfigurationPathPurpose,
  RunConfigurationPathSuggestion,
} from "@cantrip/protocol/run-configuration-definitions";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  File,
  Folder,
  FolderSearch2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { discoverRunConfigurationPaths } from "@/lib/run-configuration-api";

const purposeLabels: Record<RunConfigurationPathPurpose, string> = {
  directory: "project directory",
  "environment-file": "environment file",
  file: "project file",
  "shell-script": "shell script",
};

export function RunConfigurationPathPickerList({
  currentPath,
  error,
  fetching,
  onChoose,
  onQueryChange,
  query,
  suggestions,
  truncated,
}: {
  currentPath: string;
  error: Error | null;
  fetching: boolean;
  onChoose(suggestion: RunConfigurationPathSuggestion): void;
  onQueryChange(query: string): void;
  query: string;
  suggestions: RunConfigurationPathSuggestion[];
  truncated: boolean;
}) {
  return (
    <div className="grid gap-2">
      {error ? (
        <InlineAlert className="m-2 mb-0" error={error} tone="error" />
      ) : null}
      <Command shouldFilter={false}>
        <CommandInput
          autoFocus
          maxLength={256}
          onValueChange={onQueryChange}
          placeholder="Search project paths…"
          value={query}
        />
        <CommandList className="max-h-80">
          {fetching && suggestions.length === 0 ? (
            <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Searching project
              paths…
            </div>
          ) : suggestions.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No {query ? "matching" : "available"} project paths.
            </div>
          ) : (
            <CommandGroup>
              {suggestions.map((suggestion) => {
                const selected = suggestion.path === currentPath;
                return (
                  <CommandItem
                    className="font-mono"
                    key={`${suggestion.kind}:${suggestion.path}`}
                    onSelect={() => onChoose(suggestion)}
                    value={suggestion.path}
                  >
                    <Check
                      className={
                        selected
                          ? "size-4 shrink-0 text-emerald-600"
                          : "size-4 shrink-0 opacity-0"
                      }
                    />
                    {suggestion.kind === "directory" ? (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <File className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{suggestion.path}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      {truncated ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          Showing the first 100 matches. Refine the search to find deeper paths.
        </p>
      ) : null}
    </div>
  );
}

export function RunConfigurationPathPicker({
  ariaLabel,
  currentPath,
  onChoose,
  projectId,
  purpose,
}: {
  ariaLabel: string;
  currentPath: string;
  onChoose(path: string): void;
  projectId: string;
  purpose: RunConfigurationPathPurpose;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const discovery = useQuery({
    enabled: open,
    queryKey: ["run-configuration-paths", projectId, purpose, debouncedQuery],
    queryFn: () =>
      discoverRunConfigurationPaths(projectId, purpose, debouncedQuery),
    staleTime: 5_000,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className="size-9 shrink-0"
          size="icon"
          title={ariaLabel}
          type="button"
          variant="outline"
        >
          <FolderSearch2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-start justify-between gap-3 border-b p-3">
          <div>
            <h4 className="text-sm font-medium">
              Choose a {purposeLabels[purpose]}
            </h4>
            <p className="text-xs text-muted-foreground">
              Paths come from a bounded static scan of Primary. Project code is
              never executed.
            </p>
          </div>
          <Button
            aria-label={`Refresh ${purposeLabels[purpose]} paths`}
            className="size-8 shrink-0"
            disabled={discovery.isFetching}
            onClick={() => void discovery.refetch()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw
              className={discovery.isFetching ? "animate-spin" : undefined}
            />
          </Button>
        </div>
        <RunConfigurationPathPickerList
          currentPath={currentPath}
          error={discovery.error ?? null}
          fetching={discovery.isFetching}
          onChoose={(suggestion) => {
            onChoose(suggestion.path);
            setOpen(false);
          }}
          onQueryChange={setQuery}
          query={query}
          suggestions={discovery.data?.suggestions ?? []}
          truncated={discovery.data?.truncated ?? false}
        />
      </PopoverContent>
    </Popover>
  );
}
