import {
  modelProfileOperation,
  type ModelOperation,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import { Check, ChevronsUpDown } from "lucide-react";
import { defaultFilter } from "cmdk";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { modelSearchText, useConfiguredModelSearch } from "./model-search";
export { modelSearchText, filterConfiguredModels } from "./model-search";
import { ListPageControls } from "@/components/ui/list-page-controls";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ModelComboboxProps {
  operation?: ModelOperation;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  noneLabel?: string;
  getOptionDisabled?(model: ModelProfileSummary): boolean;
  getOptionNote?(model: ModelProfileSummary): string | null | undefined;
  models: ModelProfileSummary[];
  placeholder?: string;
  searchPlaceholder?: string;
  value: string | null;
  onValueChange(value: string): void;
}

export function ModelComboboxMenu({
  emptyMessage = "No models found.",
  noneLabel,
  getOptionDisabled,
  getOptionNote,
  inputRef,
  models,
  onSelect,
  query,
  searchPlaceholder = "Search models…",
  selectedValue,
  setQuery,
}: {
  emptyMessage?: string;
  noneLabel?: string;
  getOptionDisabled?(model: ModelProfileSummary): boolean;
  getOptionNote?(model: ModelProfileSummary): string | null | undefined;
  inputRef?: Ref<HTMLInputElement>;
  models: ModelProfileSummary[];
  onSelect(value: string): void;
  query: string;
  searchPlaceholder?: string;
  selectedValue: string | null;
  setQuery(query: string): void;
}) {
  const matches = useConfiguredModelSearch(models, query);
  const [position, setPosition] = useState({ query, page: 0 });
  const pageSize = 100;
  const page = Math.min(
    position.query === query ? position.page : 0,
    Math.max(0, Math.ceil(matches.length / pageSize) - 1),
  );
  const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
  const choices: {
    model: ModelProfileSummary | null;
    value: string;
    score: number;
  }[] = [];
  if (noneLabel) {
    const score = query ? defaultFilter(noneLabel, query) : 1;
    if (score > 0) choices.push({ model: null, value: noneLabel, score });
  }
  for (const model of visible) {
    const value = modelSearchText(model);
    choices.push({
      model,
      value,
      score: query ? defaultFilter(value, query) : 1,
    });
  }
  if (query) choices.sort((left, right) => right.score - left.score);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setPosition((previous) =>
      previous.query === query ? previous : { query, page: 0 },
    );
  }, [query, page]);
  return (
    <Command shouldFilter={false}>
      <CommandInput
        ref={inputRef}
        aria-label="Search models"
        autoFocus
        placeholder={searchPlaceholder}
        value={query}
        onValueChange={(value) => {
          setPosition({ query: value, page: 0 });
          setQuery(value);
        }}
      />
      <CommandList ref={list} className="max-h-72">
        <CommandEmpty>{emptyMessage}</CommandEmpty>
        <CommandGroup>
          {choices.map(({ model, value }) => {
            if (!model)
              return (
                <CommandItem
                  key="none"
                  value={value}
                  onSelect={() => onSelect("")}
                >
                  <span className="flex-1">{noneLabel}</span>
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-4",
                      selectedValue ? "opacity-0" : "opacity-100",
                    )}
                  />
                </CommandItem>
              );
            const optionDisabled = getOptionDisabled?.(model) ?? false;
            const note = getOptionNote?.(model);
            return (
              <CommandItem
                key={model.id}
                disabled={optionDisabled}
                value={value}
                onSelect={() => onSelect(model.id)}
              >
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
                {note ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {note}
                  </span>
                ) : null}
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    model.id === selectedValue ? "opacity-100" : "opacity-0",
                  )}
                />
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
      <ListPageControls
        count={matches.length}
        page={page}
        pageSize={pageSize}
        label="model results"
        onPageChange={(page) => setPosition({ query, page })}
      />
    </Command>
  );
}

export function ModelCombobox({
  ariaLabel,
  className,
  disabled = false,
  emptyMessage,
  noneLabel,
  getOptionDisabled,
  getOptionNote,
  models,
  operation = "language",
  onValueChange,
  placeholder = "Select a model",
  searchPlaceholder,
  value,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const operationModels = useMemo(
    () => models.filter((model) => modelProfileOperation(model) === operation),
    [models, operation],
  );
  const selectedModel = operationModels.find((model) => model.id === value);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
  };

  return (
    <Popover modal open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className={cn(
            "w-full min-w-0 justify-between bg-background px-3 font-normal",
            className,
          )}
          disabled={disabled}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !selectedModel && "text-muted-foreground",
            )}
          >
            {selectedModel?.name ?? placeholder}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[80] w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <ModelComboboxMenu
          emptyMessage={emptyMessage}
          noneLabel={noneLabel}
          getOptionDisabled={getOptionDisabled}
          getOptionNote={getOptionNote}
          inputRef={inputRef}
          models={operationModels}
          query={query}
          searchPlaceholder={searchPlaceholder}
          selectedValue={value}
          setQuery={setQuery}
          onSelect={(modelId) => {
            onValueChange(modelId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
