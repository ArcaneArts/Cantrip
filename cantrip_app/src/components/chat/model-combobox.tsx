import type { ModelProfileSummary } from "@cantrip/protocol";
import { Check, ChevronsUpDown } from "lucide-react";
import { useRef, useState, type Ref } from "react";

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
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  getOptionDisabled?(model: ModelProfileSummary): boolean;
  getOptionNote?(model: ModelProfileSummary): string | null | undefined;
  models: ModelProfileSummary[];
  placeholder?: string;
  searchPlaceholder?: string;
  value: string | null;
  onValueChange(value: string): void;
}

export function modelSearchText(model: ModelProfileSummary): string {
  return [
    model.id,
    model.name,
    model.canonicalModelId,
    ...model.routes.flatMap((route) => [route.providerName, route.modelName]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterConfiguredModels(
  models: ModelProfileSummary[],
  query: string,
): ModelProfileSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? models.filter((model) => modelSearchText(model).includes(normalizedQuery))
    : models;
}

export function ModelComboboxMenu({
  emptyMessage = "No models found.",
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
  return (
    <Command>
      <CommandInput
        ref={inputRef}
        aria-label="Search models"
        autoFocus
        placeholder={searchPlaceholder}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-72">
        <CommandEmpty>{emptyMessage}</CommandEmpty>
        <CommandGroup>
          {models.map((model) => {
            const optionDisabled = getOptionDisabled?.(model) ?? false;
            const note = getOptionNote?.(model);
            return (
              <CommandItem
                key={model.id}
                disabled={optionDisabled}
                value={modelSearchText(model)}
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
    </Command>
  );
}

export function ModelCombobox({
  ariaLabel,
  className,
  disabled = false,
  emptyMessage,
  getOptionDisabled,
  getOptionNote,
  models,
  onValueChange,
  placeholder = "Select a model",
  searchPlaceholder,
  value,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedModel = models.find((model) => model.id === value);

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
          getOptionDisabled={getOptionDisabled}
          getOptionNote={getOptionNote}
          inputRef={inputRef}
          models={models}
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
