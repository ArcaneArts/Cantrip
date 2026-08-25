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

export interface ReasoningChoice {
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
  loadReasoningState?: (modelId: string) => Promise<ChatReasoningState>;
  subagentCapability?: NativeSubagentRuntimeCapability;
  subagents?: boolean;
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

export function defaultStandaloneChatModelConfiguration(
  settings: Pick<
    UserSettings,
    | "defaultChatModelId"
    | "defaultChatReasoningEffort"
    | "defaultModelId"
    | "defaultReasoningEffort"
  >,
): ModelConfiguration {
  return modelConfigurationSchema.parse({
    modelId: settings.defaultChatModelId ?? settings.defaultModelId,
    reasoningEffort:
      settings.defaultChatReasoningEffort ?? settings.defaultReasoningEffort,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  });
}

export function standaloneChatModelConfigurationSettingsUpdate(
  configuration: ModelConfiguration,
): UserSettingsUpdate {
  return {
    defaultChatModelId: configuration.modelId,
    defaultChatReasoningEffort: configuration.reasoningEffort,
  };
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

export function modelConfigurationReasoningChoices(
  modelId: string | null,
  selected: ReasoningEffort | null,
  state?: ChatReasoningState,
  authoritative = false,
): ReasoningChoice[] {
  if (state?.modelId === modelId) {
    const advertised = modelReasoningChoices(state);
    return advertised.some(({ effort }) => effort === null)
      ? advertised
      : [{ effort: null, label: "Default" }, ...advertised];
  }
  return authoritative
    ? [{ effort: null, label: "Default" }]
    : fallbackReasoningChoices(selected);
}

export function normalizeReasoningSelection(
  selected: ReasoningEffort | null,
  choices: ReasoningChoice[],
  preferred: ReasoningEffort | null = null,
): ReasoningEffort | null {
  if (choices.some(({ effort }) => effort === selected)) return selected;
  if (choices.some(({ effort }) => effort === preferred)) return preferred;
  return choices[0]?.effort ?? null;
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

function useModelReasoningState({
  enabled,
  fallbackState,
  loader,
  modelId,
}: {
  enabled: boolean;
  fallbackState?: ChatReasoningState;
  loader?: (modelId: string) => Promise<ChatReasoningState>;
  modelId: string | null;
}): {
  failed: boolean;
  loading: boolean;
  state?: ChatReasoningState;
} {
  const [loaded, setLoaded] = useState<{
    modelId: string | null;
    state?: ChatReasoningState;
    status: "error" | "idle" | "loading" | "ready";
  }>({ modelId: null, status: "idle" });

  useEffect(() => {
    if (!enabled || !modelId || !loader) {
      setLoaded({ modelId: null, status: "idle" });
      return;
    }
    let cancelled = false;
    setLoaded({ modelId, status: "loading" });
    void loader(modelId)
      .then((state) => {
        if (!cancelled) {
          const matches = state.modelId === modelId;
          setLoaded({
            modelId,
            state: matches ? state : undefined,
            status: matches ? "ready" : "error",
          });
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded({ modelId, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, loader, modelId]);

  if (!loader) {
    return {
      failed: false,
      loading: false,
      state: fallbackState?.modelId === modelId ? fallbackState : undefined,
    };
  }
  const matches = loaded.modelId === modelId;
  return {
    failed: matches && loaded.status === "error",
    loading:
      enabled && Boolean(modelId) && (!matches || loaded.status === "loading"),
    state: matches ? loaded.state : undefined,
  };
}

function ReasoningSlider({
  choices,
  disabled,
  label,
  loading = false,
  onChange,
  unavailable = false,
  value,
}: {
  choices: ReasoningChoice[];
  disabled: boolean;
  label: string;
  loading?: boolean;
  onChange(value: ReasoningEffort | null): void;
  unavailable?: boolean;
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
        <span className="flex items-center gap-1.5 capitalize text-muted-foreground">
          {loading ? <Loader2 className="size-3 animate-spin" /> : null}
          {loading
            ? "Checking available efforts"
            : unavailable
              ? "Options unavailable"
              : (choices[selectedIndex]?.label ?? "Default")}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, choices.length - 1)}
        step={1}
        value={selectedIndex}
        disabled={disabled || loading || unavailable || choices.length < 2}
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
  loadReasoningState,
  models,
  mode = "chat",
  onSave,
  pending = false,
  readOnly = false,
  reasoningState,
  subagentCapability,
  subagents = true,
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
  const rootReasoning = useModelReasoningState({
    enabled: open,
    fallbackState: reasoningState,
    loader: loadReasoningState,
    modelId: draft.modelId,
  });
  const subagentReasoning = useModelReasoningState({
    enabled: open && draft.customSubagentModel,
    loader: loadReasoningState,
    modelId: draft.subagentModelId,
  });
  const rootChoices = useMemo(
    () =>
      modelConfigurationReasoningChoices(
        draft.modelId,
        draft.reasoningEffort,
        rootReasoning.state,
        Boolean(loadReasoningState),
      ),
    [
      draft.modelId,
      draft.reasoningEffort,
      loadReasoningState,
      rootReasoning.state,
    ],
  );
  const subagentChoices = useMemo(
    () =>
      modelConfigurationReasoningChoices(
        draft.subagentModelId,
        draft.subagentReasoningEffort,
        subagentReasoning.state,
        Boolean(loadReasoningState),
      ),
    [
      draft.subagentModelId,
      draft.subagentReasoningEffort,
      loadReasoningState,
      subagentReasoning.state,
    ],
  );
  const effectivePending = pending || saving;
  const reasoningPending =
    rootReasoning.loading ||
    (draft.customSubagentModel && subagentReasoning.loading);
  const reasoningUnavailable =
    rootReasoning.failed ||
    (draft.customSubagentModel && subagentReasoning.failed);
  const subagentsAvailable = subagentCapability?.available ?? true;

  useEffect(() => {
    if (!open) setDraft(configuration);
  }, [configuration, open]);

  useEffect(() => {
    if (!rootReasoning.state || rootReasoning.loading) return;
    setDraft((current) => {
      if (current.modelId !== rootReasoning.state?.modelId) return current;
      const reasoningEffort = normalizeReasoningSelection(
        current.reasoningEffort,
        rootChoices,
        rootReasoning.state.reasoningEffort,
      );
      return reasoningEffort === current.reasoningEffort
        ? current
        : { ...current, reasoningEffort };
    });
  }, [rootChoices, rootReasoning.loading, rootReasoning.state]);

  useEffect(() => {
    if (!subagentReasoning.state || subagentReasoning.loading) return;
    setDraft((current) => {
      if (
        !current.customSubagentModel ||
        current.subagentModelId !== subagentReasoning.state?.modelId
      ) {
        return current;
      }
      const subagentReasoningEffort = normalizeReasoningSelection(
        current.subagentReasoningEffort,
        subagentChoices,
        subagentReasoning.state.reasoningEffort,
      );
      return subagentReasoningEffort === current.subagentReasoningEffort
        ? current
        : { ...current, subagentReasoningEffort };
    });
  }, [subagentChoices, subagentReasoning.loading, subagentReasoning.state]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (effectivePending) return;
    setOpen(nextOpen);
    setSaveError(null);
    if (nextOpen) setDraft(configuration);
  };

  const save = async () => {
    const normalizedDraft = {
      ...draft,
      reasoningEffort: normalizeReasoningSelection(
        draft.reasoningEffort,
        rootChoices,
        rootReasoning.state?.reasoningEffort ?? null,
      ),
      subagentReasoningEffort: draft.customSubagentModel
        ? normalizeReasoningSelection(
            draft.subagentReasoningEffort,
            subagentChoices,
            subagentReasoning.state?.reasoningEffort ?? null,
          )
        : draft.subagentReasoningEffort,
    };
    const parsed = modelConfigurationSchema.safeParse(normalizedDraft);
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

  const subagentSummary = !subagents
    ? "Conversation model"
    : subagentCapability && !subagentsAvailable
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
              : subagents
                ? "Configure the root agent and how native subagents inherit or override it."
                : "Configure the model and reasoning used for this conversation."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {readOnly ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              This configuration is read-only while the agent turn is active or
              awaiting input.
            </p>
          ) : null}
          {subagents && subagentCapability && !subagentsAvailable ? (
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
              loading={rootReasoning.loading}
              unavailable={rootReasoning.failed}
              disabled={readOnly || effectivePending}
              onChange={(reasoningEffort) =>
                setDraft((current) => ({ ...current, reasoningEffort }))
              }
            />
          </section>

          {subagents ? (
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
                    Off uses the root model and reasoning. Saved custom values
                    are retained while inactive.
                  </span>
                </span>
              </label>

              {draft.customSubagentModel ? (
                <div className="space-y-2 pl-0 sm:pl-4">
                  <NativeSelect
                    size="default"
                    className="w-full"
                    value={draft.subagentModelId ?? ""}
                    disabled={
                      readOnly || effectivePending || !subagentsAvailable
                    }
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
                    loading={subagentReasoning.loading}
                    unavailable={subagentReasoning.failed}
                    disabled={
                      readOnly || effectivePending || !subagentsAvailable
                    }
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
          ) : null}

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
              reasoningPending ||
              reasoningUnavailable ||
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
