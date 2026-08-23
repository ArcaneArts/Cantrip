import {
  modelConfigurationSchema,
  type ChatReasoningState,
  type ModelConfiguration,
  type ModelProfileSummary,
  type NativeSubagentRuntimeCapability,
  type ReasoningEffort,
  type UserSettings,
  type UserSettingsUpdate,
} from "@cantrip/protocol";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { errorMessage } from "@/lib/error-message";
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
  configuration: ModelConfiguration;
  disabled?: boolean;
  models: ModelProfileSummary[];
  mode?: "chat" | "settings";
  pending?: boolean;
  readOnly?: boolean;
  reasoningState?: ChatReasoningState;
  subagentCapability?: NativeSubagentRuntimeCapability;
  onSave(configuration: ModelConfiguration): Promise<unknown> | unknown;
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

export function chatModelConfiguration(
  chat: {
    customSubagentModel?: boolean;
    modelId: string | null;
    reasoningEffort: ReasoningEffort | null;
    subagentModelId?: string | null;
    subagentReasoningEffort?: ReasoningEffort | null;
  },
  fallbackModelId: string | null = null,
): ModelConfiguration {
  return modelConfigurationSchema.parse({
    modelId: chat.modelId ?? fallbackModelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: chat.customSubagentModel ?? false,
    subagentModelId: chat.subagentModelId ?? null,
    subagentReasoningEffort: chat.subagentReasoningEffort ?? null,
  });
}

export function defaultModelConfiguration(
  settings: Pick<
    UserSettings,
    | "defaultModelId"
    | "defaultReasoningEffort"
    | "defaultCustomSubagentModel"
    | "defaultSubagentModelId"
    | "defaultSubagentReasoningEffort"
  >,
): ModelConfiguration {
  return modelConfigurationSchema.parse({
    modelId: settings.defaultModelId,
    reasoningEffort: settings.defaultReasoningEffort,
    customSubagentModel: settings.defaultCustomSubagentModel,
    subagentModelId: settings.defaultSubagentModelId,
    subagentReasoningEffort: settings.defaultSubagentReasoningEffort,
  });
}

export function modelConfigurationSettingsUpdate(
  configuration: ModelConfiguration,
): UserSettingsUpdate {
  return {
    defaultModelId: configuration.modelId,
    defaultReasoningEffort: configuration.reasoningEffort,
    defaultCustomSubagentModel: configuration.customSubagentModel,
    defaultSubagentModelId: configuration.subagentModelId,
    defaultSubagentReasoningEffort: configuration.subagentReasoningEffort,
  };
}

function fallbackReasoningChoices(
  selected: ReasoningEffort | null,
): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [
    { effort: null, label: "Default" },
    ...REASONING_EFFORT_ORDER.map((effort) => ({ effort, label: effort })),
  ];
  return selected && !choices.some(({ effort }) => effort === selected)
    ? [...choices, { effort: selected, label: selected }]
    : choices;
}

function choicesFor(
  modelId: string | null,
  selected: ReasoningEffort | null,
  state?: ChatReasoningState,
): ReasoningChoice[] {
  const advertised =
    state?.modelId === modelId ? modelReasoningChoices(state) : [];
  const choices = advertised.length
    ? advertised
    : fallbackReasoningChoices(selected);
  return choices.some(({ effort }) => effort === selected)
    ? choices
    : [...choices, { effort: selected, label: selected ?? "Default" }];
}

function providerIds(model: ModelProfileSummary | undefined): Set<string> {
  return new Set(
    model?.routes
      .filter(({ enabled }) => enabled)
      .map(({ providerId }) => providerId) ?? [],
  );
}

export function modelsShareProvider(
  root: ModelProfileSummary | undefined,
  child: ModelProfileSummary,
): boolean {
  const rootProviders = providerIds(root);
  return child.routes.some(
    ({ enabled, providerId }) => enabled && rootProviders.has(providerId),
  );
}

function ReasoningSlider({
  choices,
  disabled,
  label,
  onChange,
  value,
}: {
  choices: ReasoningChoice[];
  disabled: boolean;
  label: string;
  onChange(value: ReasoningEffort | null): void;
  value: ReasoningEffort | null;
}) {
  const selectedIndex = Math.max(
    0,
    choices.findIndex(({ effort }) => effort === value),
  );
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <span className="capitalize text-muted-foreground">
          {choices[selectedIndex]?.label ?? "Default"}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, choices.length - 1)}
        step={1}
        value={selectedIndex}
        disabled={disabled || choices.length < 2}
        onChange={(event) =>
          onChange(choices[Number(event.currentTarget.value)]?.effort ?? null)
        }
        aria-label={label}
        className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{choices[0]?.label ?? "Default"}</span>
        <span>{choices.at(-1)?.label ?? "Default"}</span>
      </div>
    </div>
  );
}

export function ModelReasoningPicker({
  configuration,
  disabled = false,
  models,
  mode = "chat",
  onSave,
  pending = false,
  readOnly = false,
  reasoningState,
  subagentCapability,
}: ModelReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(configuration);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedModel = models.find(({ id }) => id === configuration.modelId);
  const selectedSubagentModel = models.find(
    ({ id }) => id === configuration.subagentModelId,
  );
  const draftRootModel = models.find(({ id }) => id === draft.modelId);
  const rootChoices = useMemo(
    () => choicesFor(draft.modelId, draft.reasoningEffort, reasoningState),
    [draft.modelId, draft.reasoningEffort, reasoningState],
  );
  const subagentChoices = useMemo(
    () => choicesFor(draft.subagentModelId, draft.subagentReasoningEffort),
    [draft.subagentModelId, draft.subagentReasoningEffort],
  );
  const effectivePending = pending || saving;
  const subagentsAvailable = subagentCapability?.available ?? true;

  useEffect(() => {
    if (!open) setDraft(configuration);
  }, [configuration, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (effectivePending) return;
    setOpen(nextOpen);
    setSaveError(null);
    if (nextOpen) setDraft(configuration);
  };

  const save = async () => {
    const parsed = modelConfigurationSchema.safeParse(draft);
    if (!parsed.success || !parsed.data.modelId) {
      setSaveError(
        parsed.success
          ? "Choose a root model."
          : (parsed.error.issues[0]?.message ?? "Check the configuration."),
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(parsed.data);
      setOpen(false);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const subagentSummary =
    subagentCapability && !subagentsAvailable
      ? "Subagents unavailable"
      : configuration.customSubagentModel
        ? (selectedSubagentModel?.name ?? "Custom subagent model")
        : "Subagents inherit root";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        type="button"
        variant={mode === "settings" ? "outline" : "ghost"}
        className={cn(
          "min-w-0 text-left",
          mode === "settings"
            ? "h-auto max-w-full justify-between gap-3 px-3 py-2 sm:w-80"
            : "h-8 max-w-72 justify-start gap-2 px-1.5",
        )}
        disabled={disabled}
        aria-label={
          mode === "settings"
            ? "Configure default models"
            : "Configure agent models"
        }
        title="Configure model and reasoning"
        onClick={() => handleOpenChange(true)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {selectedModel?.name ?? "Select model"}
          </span>
          <span className="block truncate text-[10px] font-normal text-muted-foreground">
            {subagentSummary}
          </span>
        </span>
        {mode === "settings" ? (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        ) : configuration.customSubagentModel ? (
          <Check className="size-3.5 shrink-0 text-primary" />
        ) : null}
      </Button>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "settings"
              ? "Default model configuration"
              : "Model configuration"}
          </DialogTitle>
          <DialogDescription>
            {mode === "settings"
              ? "Applied to newly created agent chats. Existing chats are unchanged."
              : "Configure the root agent and how native subagents inherit or override it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {readOnly ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              This configuration is read-only while the agent turn is active or
              awaiting input.
            </p>
          ) : null}
          {subagentCapability && !subagentsAvailable ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              {subagentCapability.reason ??
                "The selected worker does not support native subagents."}
            </p>
          ) : null}

          <section className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">Root agent</h3>
              <p className="text-xs text-muted-foreground">
                The model used for the main conversation.
              </p>
            </div>
            <NativeSelect
              size="default"
              className="w-full"
              value={draft.modelId ?? ""}
              disabled={readOnly || effectivePending}
              aria-label="Root model"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  modelId: event.target.value || null,
                  reasoningEffort: null,
                }))
              }
            >
              <option value="" disabled>
                Select a model
              </option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </NativeSelect>
            <ReasoningSlider
              label="Root reasoning effort"
              choices={rootChoices}
              value={draft.reasoningEffort}
              disabled={readOnly || effectivePending}
              onChange={(reasoningEffort) =>
                setDraft((current) => ({ ...current, reasoningEffort }))
              }
            />
          </section>

          <section className="space-y-3 border-t pt-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={draft.customSubagentModel}
                disabled={
                  readOnly ||
                  effectivePending ||
                  (!subagentsAvailable && !draft.customSubagentModel)
                }
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    customSubagentModel: event.target.checked,
                  }))
                }
              />
              <span>
                <span className="block text-sm font-medium">
                  Custom Subagent Model
                </span>
                <span className="block text-xs text-muted-foreground">
                  Off uses the root model and reasoning. Saved custom values are
                  retained while inactive.
                </span>
              </span>
            </label>

            {draft.customSubagentModel ? (
              <div className="space-y-2 pl-0 sm:pl-4">
                <NativeSelect
                  size="default"
                  className="w-full"
                  value={draft.subagentModelId ?? ""}
                  disabled={readOnly || effectivePending || !subagentsAvailable}
                  aria-label="Subagent model"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      subagentModelId: event.target.value || null,
                      subagentReasoningEffort: null,
                    }))
                  }
                >
                  <option value="" disabled>
                    Select a subagent model
                  </option>
                  {models.map((model) => {
                    const compatible = modelsShareProvider(
                      draftRootModel,
                      model,
                    );
                    return (
                      <option
                        key={model.id}
                        value={model.id}
                        disabled={!compatible}
                      >
                        {model.name}
                        {compatible ? "" : " — different provider"}
                      </option>
                    );
                  })}
                </NativeSelect>
                <ReasoningSlider
                  label="Subagent reasoning effort"
                  choices={subagentChoices}
                  value={draft.subagentReasoningEffort}
                  disabled={readOnly || effectivePending || !subagentsAvailable}
                  onChange={(subagentReasoningEffort) =>
                    setDraft((current) => ({
                      ...current,
                      subagentReasoningEffort,
                    }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  Custom subagents must resolve through the same provider and
                  account as the root agent.
                </p>
              </div>
            ) : null}
          </section>

          {saveError ? (
            <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={effectivePending}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              readOnly ||
              effectivePending ||
              !draft.modelId ||
              (draft.customSubagentModel && !subagentsAvailable)
            }
            onClick={() => void save()}
          >
            {effectivePending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Save configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
