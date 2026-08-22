import type {
  ChatReasoningState,
  ModelProfileSummary,
  ReasoningEffort,
} from "@cantrip/protocol";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Brain, Check, Search } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
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

const REASONING_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

function reasoningEffortRank(effort: ReasoningEffort): number {
  const normalized = effort.trim().toLocaleLowerCase().replaceAll(/[-_ ]/g, "");
  const index = REASONING_EFFORT_ORDER.indexOf(
    normalized as (typeof REASONING_EFFORT_ORDER)[number],
  );
  return index === -1 ? REASONING_EFFORT_ORDER.length : index;
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
  const orderedOptions = state.options
    .map((option, index) => ({ index, option }))
    .sort((left, right) => {
      const rankDifference =
        reasoningEffortRank(left.option.effort) -
        reasoningEffortRank(right.option.effort);
      return rankDifference || left.index - right.index;
    })
    .map(({ option }) => option);
  return [
    ...(state.reasoningMandatory
      ? []
      : [{ effort: null, label: "Default" } as const]),
    ...orderedOptions.map((option) => ({
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
  const [reasoningDraftIndex, setReasoningDraftIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const reasoningDraggingRef = useRef(false);
  const pendingReasoningEffortRef = useRef<ReasoningEffort | null>(
    reasoningEffort,
  );
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

  useEffect(() => {
    pendingReasoningEffortRef.current = reasoningEffort;
    if (reasoningPending || reasoningDraggingRef.current) return;
    setReasoningDraftIndex(selectedReasoningIndex);
  }, [reasoningEffort, reasoningPending, selectedReasoningIndex]);

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
    setReasoningDraftIndex(Number(event.target.value));
  };

  const commitReasoningIndex = (index: number) => {
    const choice = choices[index];
    if (choice && choice.effort !== pendingReasoningEffortRef.current) {
      pendingReasoningEffortRef.current = choice.effort;
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
                    {choices[reasoningDraftIndex]?.label ?? "Default"}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, choices.length - 1)}
                  step={1}
                  value={reasoningDraftIndex}
                  disabled={reasoningPending}
                  onChange={handleReasoningChange}
                  onPointerDown={() => {
                    reasoningDraggingRef.current = true;
                  }}
                  onPointerUp={(event) => {
                    reasoningDraggingRef.current = false;
                    commitReasoningIndex(Number(event.currentTarget.value));
                  }}
                  onPointerCancel={() => {
                    reasoningDraggingRef.current = false;
                    setReasoningDraftIndex(selectedReasoningIndex);
                  }}
                  onKeyUp={(event) => {
                    if (
                      [
                        "ArrowLeft",
                        "ArrowRight",
                        "ArrowDown",
                        "ArrowUp",
                        "Home",
                        "End",
                        "PageDown",
                        "PageUp",
                      ].includes(event.key)
                    ) {
                      commitReasoningIndex(Number(event.currentTarget.value));
                    }
                  }}
                  onBlur={(event) => {
                    reasoningDraggingRef.current = false;
                    commitReasoningIndex(Number(event.currentTarget.value));
                  }}
                  aria-label="Reasoning effort"
                  className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            )}
            {canSelectReasoning && panel === "reasoning" ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8 shrink-0"
                aria-label="Search models"
                title="Search models"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPanel("models");
                  window.setTimeout(() => searchRef.current?.focus(), 0);
                }}
              >
                <Search className="size-4" />
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
                      onPointerMove={(event) => {
                        if (event.pointerType === "mouse") {
                          event.preventDefault();
                        }
                      }}
                      onPointerLeave={(event) => {
                        if (event.pointerType === "mouse") {
                          event.preventDefault();
                        }
                      }}
                      className="justify-between gap-3 hover:bg-accent"
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
      {canSelectReasoning ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground"
          disabled={disabled || reasoningPending}
          aria-label="Configure reasoning effort"
          aria-haspopup="menu"
          aria-expanded={open && panel === "reasoning"}
          title="Configure reasoning effort"
          onClick={() => {
            setPanel("reasoning");
            setQuery("");
            setOpen(true);
          }}
        >
          <Brain className="size-4" />
        </Button>
      ) : null}
    </DropdownMenuPrimitive.Root>
  );
}
