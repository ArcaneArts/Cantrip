import type {
  ChatReasoningState,
  ModelProfileSummary,
  ReasoningEffort,
} from "@cantrip/protocol";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Brain, Check, Search } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  useEffect,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

interface ReasoningChoice {
  effort: ReasoningEffort | null;
  label: string;
}

export interface ModelReasoningPickerProps {
  disabled?: boolean;
  models: ModelProfileSummary[];
  modelSelectionDisabled?: boolean;
  modelPending?: boolean;
  onSelectModel(modelId: string): void;
  onSelectReasoning(reasoningEffort: ReasoningEffort | null): void;
  reasoningEffort: ReasoningEffort | null;
  reasoningPending?: boolean;
  reasoningState?: ChatReasoningState;
  selectedModelId: string;
}

function searchableModelText(model: ModelProfileSummary): string {
  return [
    model.name,
    model.canonicalModelId,
    ...model.routes.flatMap((route) => [route.providerName, route.modelName]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function modelReasoningChoices(
  state?: ChatReasoningState,
): ReasoningChoice[] {
  if (!state) return [];
  return [
    ...(state.reasoningMandatory
      ? []
      : [{ effort: null, label: "Provider default" } as const]),
    ...state.options.map((option) => ({
      effort: option.effort,
      label: option.effort,
    })),
  ];
}

export function filterConfiguredModels(
  models: ModelProfileSummary[],
  query: string,
): ModelProfileSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? models.filter((model) =>
        searchableModelText(model).includes(normalizedQuery),
      )
    : models;
}

export function ModelReasoningPicker({
  disabled = false,
  models,
  modelSelectionDisabled = false,
  modelPending = false,
  onSelectModel,
  onSelectReasoning,
  reasoningEffort,
  reasoningPending = false,
  reasoningState,
  selectedModelId,
}: ModelReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"models" | "reasoning">("models");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedModel = models.find(({ id }) => id === selectedModelId);
  const choices = useMemo(
    () => modelReasoningChoices(reasoningState),
    [reasoningState],
  );
  const canSelectReasoning = choices.length > 1;
  const selectedReasoningIndex = Math.max(
    0,
    choices.findIndex(({ effort }) => effort === reasoningEffort),
  );
  const filteredModels = filterConfiguredModels(models, query);

  useEffect(() => {
    if (!open || panel !== "models") return;
    const frame = window.requestAnimationFrame(() =>
      searchRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, panel]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setPanel("models");
      setQuery("");
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") event.stopPropagation();
  };

  const handleReasoningChange = (event: ChangeEvent<HTMLInputElement>) => {
    const choice = choices[Number(event.target.value)];
    if (choice && choice.effort !== reasoningEffort) {
      onSelectReasoning(choice.effort);
    }
  };

  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-7 min-w-0 max-w-64 shrink px-1.5 text-xs font-medium"
          disabled={disabled}
          aria-label="Select agent model"
          title="Select agent model"
        >
          <span className="truncate">
            {selectedModel?.name ?? "Select model"}
          </span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-2rem))] p-1.5"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="mb-1 flex min-w-0 items-center gap-1">
            {panel === "models" ? (
              <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/50 px-2 text-muted-foreground">
                <Search className="size-3.5 shrink-0" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search configured models"
                  aria-label="Search configured models"
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>
            ) : (
              <div className="min-w-0 flex-1 rounded-md bg-muted/50 px-2 py-1.5">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium">Reasoning effort</span>
                  <span className="truncate text-muted-foreground">
                    {choices[selectedReasoningIndex]?.label ?? "Default"}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, choices.length - 1)}
                  step={1}
                  value={selectedReasoningIndex}
                  disabled={reasoningPending}
                  onChange={handleReasoningChange}
                  aria-label="Reasoning effort"
                  className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            )}
            {canSelectReasoning ? (
              <Button
                type="button"
                size="icon"
                variant={panel === "reasoning" ? "outline" : "ghost"}
                className="size-8 shrink-0"
                disabled={reasoningPending}
                aria-label={
                  panel === "reasoning"
                    ? "Search models"
                    : "Configure reasoning effort"
                }
                title={
                  panel === "reasoning"
                    ? "Search models"
                    : "Configure reasoning effort"
                }
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPanel((current) =>
                    current === "models" ? "reasoning" : "models",
                  );
                  if (panel === "reasoning") {
                    window.setTimeout(() => searchRef.current?.focus(), 0);
                  }
                }}
              >
                {panel === "reasoning" ? (
                  <Search className="size-4" />
                ) : (
                  <Brain className="size-4" />
                )}
              </Button>
            ) : null}
          </div>

          {panel === "models" ? (
            <div className="max-h-64 overflow-y-auto">
              {filteredModels.length > 0 ? (
                filteredModels.map((model) => {
                  const selected = model.id === selectedModelId;
                  const enabledRoutes = model.routes.filter(
                    ({ enabled }) => enabled,
                  );
                  return (
                    <StyledDropdownMenuItem
                      key={model.id}
                      disabled={modelSelectionDisabled || modelPending}
                      onSelect={() => onSelectModel(model.id)}
                      className="justify-between gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {model.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {enabledRoutes.length > 1
                            ? `${enabledRoutes.length} provider routes`
                            : (enabledRoutes[0]?.providerName ??
                              "No enabled route")}
                        </span>
                      </span>
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </StyledDropdownMenuItem>
                  );
                })
              ) : (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No configured models match “{query}”.
                </div>
              )}
            </div>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
