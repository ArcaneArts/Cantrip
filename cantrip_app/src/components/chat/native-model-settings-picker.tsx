import { useEffect, useId, useMemo, useState } from "react";
import {
  isLanguageModelProfile,
  resolveNativeModelSelection,
  type ChatReasoningState,
  type ModelConfiguration,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import { useModelReasoningState } from "./model-reasoning-picker";
import { modelDisplayName } from "../app/application-shell-model";
import { useNonLanguageRoutes } from "./use-language-model-routes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import type { NativeModelSettingsController } from "./use-native-model-settings";
import type {
  NativeModelDirty,
  NativeModelDraft,
} from "./native-model-settings";

const tabs = [
  { id: "model", label: "Model" },
  { id: "subagents", label: "Subagents" },
] as const;
type Tab = (typeof tabs)[number]["id"];

export function NativeModelSettingsPicker({
  controller,
  open,
  onOpenChange,
  disabled = false,
  configuredModels = [],
  configuration,
  loadReasoningState,
  saveConfiguration,
}: {
  controller: NativeModelSettingsController;
  open: boolean;
  onOpenChange(open: boolean): void;
  disabled?: boolean;
  configuredModels?: readonly ModelProfileSummary[];
  configuration?: ModelConfiguration;
  loadReasoningState?: (modelId: string) => Promise<ChatReasoningState>;
  saveConfiguration?: (configuration: ModelConfiguration) => Promise<unknown>;
}) {
  const { binding, selected, inventory, observed, update } = controller;
  const tabId = useId();
  const [activeTab, setActiveTab] = useState<Tab>("model");
  const nonLanguageRoutes = useNonLanguageRoutes(open);
  const modelChoices = useMemo(
    () =>
      inventory.data?.models.filter(
        (model) => !nonLanguageRoutes.has(model.routeId),
      ) ?? [],
    [inventory.data?.models, nonLanguageRoutes],
  );
  const [storedDraft, setDraft] = useState<NativeModelDraft | null>(null);
  const [dirty, setDirty] = useState<NativeModelDirty>({});
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [targetModelId, setTargetModelId] = useState<string | null>(null);
  const [targetEffort, setTargetEffort] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const sourceProviderId =
    inventory.data?.providerId ??
    configuredModels
      .flatMap(({ routes }) => routes)
      .find(({ id }) => id === binding?.modelRouteId)?.providerId;
  const otherModels = configuredModels.filter(
    (model) =>
      sourceProviderId &&
      isLanguageModelProfile(model) &&
      model.routes.some(
        (route) => route.enabled && route.providerId !== sourceProviderId,
      ) &&
      !modelChoices.some((choice) => choice.id === model.id),
  );
  const configuredTarget = otherModels.find(
    (model) => model.id === configuration?.modelId,
  );
  const target = otherModels.find((model) => model.id === targetModelId);
  const targetReasoning = useModelReasoningState({
    enabled: open,
    modelId: target?.id ?? null,
    loader: loadReasoningState,
  });
  const [editorIdentity, setEditorIdentity] = useState(observed.identity);
  const draft =
    observed.encryption.status === "ready" &&
    observed.confirmed &&
    editorIdentity === observed.identity
      ? storedDraft
      : null;
  useEffect(() => {
    setDraft(null);
    setDirty({});
    setEditingBindingId(null);
    setTargetModelId(null);
    setTargetEffort(null);
    setSaveError(null);
    setEditorIdentity(observed.identity);
  }, [observed.identity]);
  useEffect(() => {
    if (!open) {
      setActiveTab("model");
      if (selected) {
        setDraft({ ...selected, routeId: controller.selectedRouteId });
        setDirty({});
        setEditingBindingId(binding?.bindingId ?? null);
      }
    }
  }, [
    open,
    selected?.model,
    selected?.effort,
    selected?.serviceTier,
    selected?.multiAgentEnabled,
    selected?.subagentModel,
    selected?.subagentReasoningEffort,
    controller.selectedRouteId,
    binding?.bindingId,
  ]);
  // A slash command can open the picker before its first settings read finishes.
  useEffect(() => {
    if (open && !draft && selected) {
      setDraft({ ...selected, routeId: controller.selectedRouteId });
      setEditingBindingId(binding?.bindingId ?? null);
      setTargetModelId(configuredTarget?.id ?? null);
      setTargetEffort(configuration?.reasoningEffort ?? null);
    }
  }, [
    open,
    draft,
    selected,
    controller.selectedRouteId,
    binding?.bindingId,
    configuredTarget?.id,
    configuration?.reasoningEffort,
  ]);
  const changeOpen = (next: boolean) => {
    setTargetModelId(next ? (configuredTarget?.id ?? null) : null);
    setTargetEffort(next ? (configuration?.reasoningEffort ?? null) : null);
    setSaveError(null);
    if (next && selected) {
      setDraft({ ...selected, routeId: controller.selectedRouteId });
      setEditingBindingId(binding?.bindingId ?? null);
      setDirty({});
    }
    onOpenChange(next);
  };
  useEffect(() => {
    if (!observed.confirmed && observed.encryption.status !== "ready") {
      setDraft(null);
      setDirty({});
      setEditingBindingId(null);
    }
  }, [observed.encryption, observed.confirmed]);
  const model = inventory.data?.models.find(
    (candidate) => candidate.routeId === draft?.routeId,
  );
  const displayModel = (name: string, routeId?: string | null) => {
    if (!inventory.data) return name;
    const resolved = resolveNativeModelSelection(inventory.data, name, routeId);
    return resolved.status === "resolved"
      ? (resolved.model.catalog?.displayName ?? name)
      : name;
  };
  const subagentConflict =
    Boolean(draft?.subagentModel) &&
    inventory.data?.models.some(
      (entry) => entry.name === draft?.subagentModel,
    ) &&
    !modelChoices.some((entry) => entry.name === draft?.subagentModel);
  const efforts = [
    ...new Set([
      null,
      ...(target
        ? (targetReasoning.state?.options ?? []).map((option) => option.effort)
        : (model?.catalog?.supportedReasoningEfforts ?? []).map(
            (option) => option.effort,
          )),
      target ? targetEffort : (draft?.effort ?? null),
    ]),
  ];
  const pending =
    controller.pending > 0 ||
    controller.localStatus === "requesting" ||
    controller.localStatus === "queued";
  const status = observed.state.data?.desiredStatus;
  const rejected =
    status === "rejected" || controller.localStatus === "rejected";
  const uncertain =
    status === "uncertain" || controller.localStatus === "uncertain";
  const showConfirmed = pending || rejected || uncertain || configuredTarget;
  const canSelectModel = Boolean(
    draft &&
    binding &&
    inventory.data &&
    binding.bindingId === inventory.data.bindingId &&
    editingBindingId === binding.bindingId &&
    observed.confirmed,
  );
  const editable = canSelectModel && !target;
  const targetDirty =
    target &&
    (target.id !== configuredTarget?.id ||
      targetEffort !== configuration?.reasoningEffort);
  const localSelection = configuredTarget && !target && model;
  const canSaveSelection = Boolean(
    configuration &&
    saveConfiguration &&
    !saving &&
    (targetDirty || localSelection),
  );
  const settingsDirty = Object.values(dirty).some(Boolean);
  const save = async () => {
    const requestedModel =
      target ?? (localSelection ? { id: localSelection.id } : undefined);
    if (requestedModel && saveConfiguration && configuration) {
      setSaving(true);
      setSaveError(null);
      try {
        await saveConfiguration({
          ...configuration,
          modelId: requestedModel.id,
          reasoningEffort: target ? targetEffort : (draft?.effort ?? null),
        });
        onOpenChange(false);
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Could not change the chat model.",
        );
      } finally {
        setSaving(false);
      }
    } else if (draft && editingBindingId) {
      await update.mutateAsync({ draft, dirty, bindingId: editingBindingId });
      onOpenChange(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-8 max-w-72 justify-start px-1.5 text-left"
          disabled={disabled}
          aria-label="Configure agent models"
        >
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">
              {configuredTarget
                ? modelDisplayName(configuredTarget)
                : selected
                  ? displayModel(selected.model, controller.selectedRouteId)
                  : "Session model"}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {configuredTarget
                ? (configuration?.reasoningEffort ?? "Default reasoning")
                : pending
                  ? "Change pending"
                  : (selected?.effort ?? "Default reasoning")}
            </span>
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>Session model settings</DialogTitle>
          <DialogDescription>Changes apply on the next turn.</DialogDescription>
        </DialogHeader>
        <NavigationTabBar<Tab>
          activeTab={activeTab}
          ariaLabel="Session model settings sections"
          className="border-b"
          onTabChange={setActiveTab}
          panelIdPrefix={tabId}
          tabs={tabs}
        />
        {observed.confirmed ? (
          showConfirmed ? (
            <p
              className="text-xs text-muted-foreground"
              aria-label="Effective model settings"
            >
              Confirmed:{" "}
              {displayModel(
                observed.confirmed.model,
                controller.confirmedRouteId,
              )}
              {" · "}
              {observed.confirmed.effort ?? "Default reasoning"}
            </p>
          ) : null
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {observed.encryption.status !== "ready"
              ? "Unlock encryption to view session settings."
              : observed.state.error
                ? "Session settings could not be read."
                : "Reading confirmed session settings…"}
          </p>
        )}
        {pending ? (
          <p role="status" className="text-xs">
            Requested changes are awaiting confirmation.
          </p>
        ) : null}
        {rejected ? (
          <p role="status" className="text-xs text-destructive">
            The latest change was rejected.
          </p>
        ) : null}
        {uncertain ? (
          <p role="status" className="text-xs">
            The latest change has an unconfirmed outcome. Check session settings
            before submitting it again.
          </p>
        ) : null}
        <div
          role="tabpanel"
          id={`${tabId}-model-panel`}
          aria-labelledby={`${tabId}-model-tab`}
          hidden={activeTab !== "model"}
        >
          <div className="grid min-h-44 content-start gap-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Model
              <NativeSelect
                aria-label="Session model"
                className="w-full min-w-0 font-normal"
                value={target ? `profile:${target.id}` : (draft?.routeId ?? "")}
                disabled={
                  (!canSelectModel &&
                    !(binding && saveConfiguration && otherModels.length)) ||
                  update.isPending ||
                  saving
                }
                onChange={(event) => {
                  const choice = modelChoices.find(
                    (candidate) => candidate.routeId === event.target.value,
                  );
                  if (choice) {
                    setTargetModelId(null);
                    if (choice.routeId === draft?.routeId) return;
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            routeId: choice.routeId,
                            model: choice.name,
                          }
                        : current,
                    );
                    setDirty((current) => ({ ...current, model: true }));
                  } else {
                    const next = otherModels.find(
                      (model) => `profile:${model.id}` === event.target.value,
                    );
                    if (next) {
                      setTargetModelId(next.id);
                      setTargetEffort(
                        next.id === configuredTarget?.id
                          ? (configuration?.reasoningEffort ?? null)
                          : null,
                      );
                    }
                  }
                }}
              >
                <option value="" disabled>
                  {draft
                    ? displayModel(draft.model, draft.routeId)
                    : "Choose model"}
                </option>
                {draft?.routeId && nonLanguageRoutes.has(draft.routeId) ? (
                  <option value={draft.routeId} disabled>
                    {displayModel(draft.model, draft.routeId)} · Review language
                    configuration
                  </option>
                ) : null}
                {modelChoices.map((candidate) => (
                  <option key={candidate.routeId} value={candidate.routeId}>
                    {candidate.catalog?.displayName ?? candidate.name}
                    {modelChoices.filter(
                      (entry) => entry.name === candidate.name,
                    ).length > 1
                      ? ` (${candidate.routeId})`
                      : ""}
                  </option>
                ))}
                {otherModels.map((choice) => (
                  <option key={choice.id} value={`profile:${choice.id}`}>
                    {modelDisplayName(choice)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Reasoning effort
              <NativeSelect
                aria-label="Session reasoning effort"
                className="w-full min-w-0 font-normal"
                value={(target ? targetEffort : draft?.effort) ?? ""}
                disabled={
                  target
                    ? saving || targetReasoning.loading
                    : !editable || update.isPending
                }
                onChange={(event) => {
                  if (target) {
                    setTargetEffort(event.target.value || null);
                    return;
                  }
                  setDraft((current) =>
                    current
                      ? { ...current, effort: event.target.value || null }
                      : current,
                  );
                  setDirty((current) => ({ ...current, effort: true }));
                }}
              >
                {efforts.map((effort) => (
                  <option key={effort ?? "default"} value={effort ?? ""}>
                    {effort ?? "Default"}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
        </div>
        <div
          role="tabpanel"
          id={`${tabId}-subagents-panel`}
          aria-labelledby={`${tabId}-subagents-tab`}
          hidden={activeTab !== "subagents"}
        >
          <div className="grid min-h-44 content-start gap-4">
            {draft?.multiAgentEnabled !== undefined ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Enable subagents"
                  className="size-4 accent-primary"
                  checked={draft.multiAgentEnabled}
                  disabled={!editable || update.isPending}
                  onChange={(event) => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            multiAgentEnabled: event.target.checked,
                          }
                        : current,
                    );
                    setDirty((current) => ({
                      ...current,
                      multiAgentEnabled: true,
                    }));
                  }}
                />{" "}
                Enable subagents
              </label>
            ) : null}
            {draft?.subagentModel !== undefined ? (
              <label className="grid gap-1.5 text-sm font-medium">
                Subagent model
                <NativeSelect
                  aria-label="Subagent model"
                  className="w-full min-w-0 font-normal"
                  value={draft.subagentModel ?? ""}
                  disabled={!editable || update.isPending}
                  onChange={(event) => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            subagentModel: event.target.value || null,
                          }
                        : current,
                    );
                    setDirty((current) => ({
                      ...current,
                      subagentModel: true,
                    }));
                  }}
                >
                  <option value="">Inherit parent model</option>
                  {[
                    ...new Set([
                      ...modelChoices.map((entry) => entry.name),
                      ...(draft.subagentModel ? [draft.subagentModel] : []),
                    ]),
                  ].map((name) => (
                    <option
                      key={name}
                      value={name}
                      disabled={
                        name === draft.subagentModel && subagentConflict
                      }
                    >
                      {displayModel(name)}
                      {name === draft.subagentModel && subagentConflict
                        ? " · Review language configuration"
                        : ""}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {draft?.subagentReasoningEffort !== undefined ? (
              <label className="grid gap-1.5 text-sm font-medium">
                Subagent reasoning effort
                <NativeSelect
                  aria-label="Subagent reasoning effort"
                  className="w-full min-w-0 font-normal"
                  value={draft.subagentReasoningEffort ?? ""}
                  disabled={!editable || update.isPending}
                  onChange={(event) => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            subagentReasoningEffort: event.target.value || null,
                          }
                        : current,
                    );
                    setDirty((current) => ({
                      ...current,
                      subagentReasoningEffort: true,
                    }));
                  }}
                >
                  <option value="">Inherit parent reasoning</option>
                  {[
                    ...new Set([
                      ...(modelChoices
                        .find(
                          (entry) =>
                            entry.name === (draft.subagentModel ?? draft.model),
                        )
                        ?.catalog?.supportedReasoningEfforts?.map(
                          (entry) => entry.effort,
                        ) ?? []),
                      ...(draft.subagentReasoningEffort
                        ? [draft.subagentReasoningEffort]
                        : []),
                    ]),
                  ].map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {draft &&
            draft.subagentModel === undefined &&
            draft.subagentReasoningEffort === undefined ? (
              <p className="text-sm text-muted-foreground">
                Subagent model settings are unavailable for this session.
              </p>
            ) : null}
          </div>
        </div>
        {saveError ? (
          <p role="alert" className="text-xs text-destructive">
            {saveError}
          </p>
        ) : null}
        {controller.error ? (
          <p role="alert" className="text-xs text-destructive">
            {controller.error.message}
          </p>
        ) : null}
        {editingBindingId && binding?.bindingId !== editingBindingId ? (
          <p role="alert">
            The session changed. Reopen model settings before saving.
          </p>
        ) : null}
        {!observed.confirmed || controller.error ? (
          <Button
            variant="outline"
            disabled={observed.state.isFetching}
            onClick={() => {
              void observed.state.refetch();
            }}
          >
            Retry settings read
          </Button>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              target || localSelection
                ? !canSaveSelection
                : !editable || update.isPending || !settingsDirty
            }
            onClick={() => void save().catch(() => {})}
          >
            {update.isPending || saving ? "Submitting…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
