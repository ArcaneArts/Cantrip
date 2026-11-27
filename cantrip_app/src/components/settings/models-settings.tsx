import {
  isLanguageModelProfile,
  modelProfileOperation,
  providerOperationSupport,
} from "@cantrip/protocol";
import { ProviderSetupIcon } from "./provider-setup-icon";
import { OperationDefaultPicker } from "./operation-default-picker";
import { useProviderCatalog } from "./use-provider-catalog";
import {
  operationCapabilityText,
  scopedCapabilitiesByModel,
} from "./model-operation-metadata";
import { ProviderInferenceUsage } from "./provider-inference-usage";
import { SettingsModelGrid } from "./settings-model-grid";
import type {
  ModelOperation,
  ModelProfileSummary,
  ModelProviderSummary,
  UserSettings,
  UserSettingsUpdate,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Pencil, Plus, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  councilModelConfigurationSettingsUpdate,
  defaultCouncilModelConfiguration,
  defaultModelConfiguration,
  defaultStandaloneChatModelConfiguration,
  inheritsCouncilModelConfiguration,
  ModelReasoningPicker,
  modelConfigurationSettingsUpdate,
  standaloneChatModelConfigurationSettingsUpdate,
} from "@/components/chat/model-reasoning-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { ModelCombobox } from "@/components/chat/model-combobox";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { getModelReasoningOptions } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  modelsForProvider,
  providerModelsTab,
  unassignedModels,
  type ModelsSettingsTab,
} from "./models-settings-state";
import {
  availableCatalogModelIds,
  providerSupportsCatalog,
} from "./provider-catalog-display";
import {
  providerSetupFor,
  providerSetupOptions,
  providerSetupUnavailableReason,
  type ProviderSetupKind,
} from "./provider-setup";

export function ModelsSettings({
  activeTab,
  inSearchResults = false,
  workerId = null,
  models,
  providers,
  providersLoaded = true,
  preferences,
  preferencesPending,
  preferencesError,
  removingModel,
  modelError,
  providerError,
  onTabChange,
  onAddProvider,
  onEditProvider,
  onAddModel,
  onEditModel,
  onRemoveModel,
  onPreferencesChange,
  renderProviderOverview,
}: {
  activeTab: ModelsSettingsTab;
  inSearchResults?: boolean;
  workerId?: string | null;
  models: ModelProfileSummary[];
  providers: ModelProviderSummary[];
  providersLoaded?: boolean;
  preferences: UserSettings;
  preferencesPending: boolean;
  preferencesError?: string | null;
  removingModel: boolean;
  modelError?: string | null;
  providerError?: string | null;
  onTabChange(tab: ModelsSettingsTab): void;
  onAddProvider(setup: ProviderSetupKind): void;
  onEditProvider(provider: ModelProviderSummary): void;
  onAddModel(providerId?: string, operation?: ModelOperation): void;
  onEditModel(model: ModelProfileSummary): void;
  onRemoveModel(model: ModelProfileSummary): void;
  onPreferencesChange(input: UserSettingsUpdate): Promise<unknown>;
  renderProviderOverview(provider: ModelProviderSummary): ReactNode;
}) {
  const id = useId();
  const tabList = useRef<HTMLDivElement>(null);
  const provider = providers.find(
    ({ id }) => providerModelsTab(id) === activeTab,
  );
  const catalog = useProviderCatalog(
    provider?.id,
    provider?.kind === "claude-code" ? null : workerId,
    Boolean(provider && providerSupportsCatalog(provider)),
    provider?.connectionRevision ?? provider?.updatedAt,
  );
  const capabilitiesById = useMemo(
    () => scopedCapabilitiesByModel(catalog.data, workerId),
    [catalog.data, workerId],
  );
  const languageModels = useMemo(
    () => models.filter(isLanguageModelProfile),
    [models],
  );
  const support = provider ? providerOperationSupport(provider) : null;
  const selectedTab = provider ? activeTab : "general";
  const visibleModels = useMemo(
    () =>
      provider
        ? modelsForProvider(models, provider.id)
        : unassignedModels(models, providers),
    [models, provider, providers],
  );
  const modelDetails = useMemo(() => {
    const details = new Map<string, string>();
    for (const model of visibleModels) {
      if (
        modelProfileOperation(model) === "language" &&
        !isLanguageModelProfile(model)
      )
        details.set(
          model.id,
          "Configured for language, but routes advertise only embeddings or decisions. Edit the routes or add a profile for the matching operation. Saved selections are retained.",
        );
    }
    if (provider) {
      const entries = new Map(
        catalog.data?.models.map((entry) => [entry.nativeModelId, entry]),
      );
      const available = catalog.data
        ? availableCatalogModelIds(catalog.data, workerId)
        : new Set<string>();
      for (const model of visibleModels) {
        const route = model.routes.find(
          (route) => route.providerId === provider.id,
        );
        const entry = route ? entries.get(route.modelName) : undefined;
        const capability = entry ? (capabilitiesById.get(entry.id) ?? {}) : {};
        const operation = modelProfileOperation(model);
        const notes = details.has(model.id) ? [details.get(model.id)!] : [];
        if (capability[operation])
          notes.push(operationCapabilityText(operation, capability));
        if (operation === "embedding" && route?.operationOptions?.dimensions)
          notes.push(
            `${route.operationOptions.dimensions.toLocaleString()} configured dimensions`,
          );
        if (entry && catalog.data && !available.has(entry.id))
          notes.push("Unavailable in selected scope");
        if (catalog.data?.servedStale) notes.push("Catalog stale");
        details.set(model.id, notes.join(" · "));
      }
    }
    return details;
  }, [provider, catalog.data, capabilitiesById, visibleModels, workerId]);
  useEffect(() => {
    if (providersLoaded && activeTab !== selectedTab) onTabChange(selectedTab);
  }, [activeTab, selectedTab, onTabChange, providersLoaded]);
  useEffect(() => {
    tabList.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedTab, providers.length]);
  const tabClass = (tab: ModelsSettingsTab) =>
    cn(
      "h-10 max-w-48 shrink-0 rounded-none border-b-2 px-3 text-sm",
      selectedTab === tab
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground",
    );
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const index = tabs.findIndex((tab) => tab === event.target);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next]!.focus();
    tabs[next]!.click();
  };
  const tabProps = (tab: ModelsSettingsTab) => ({
    role: "tab",
    id: `${id}-tab-${tab}`,
    "aria-controls": `${id}-panel`,
    "aria-selected": selectedTab === tab,
    tabIndex: selectedTab === tab ? 0 : -1,
    className: tabClass(tab),
    onClick: () => onTabChange(tab),
  });
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="models-settings"
    >
      <div
        data-content-gutter={inSearchResults ? undefined : "standard"}
        className={cn(
          "shrink-0",
          !inSearchResults && "px-4 pt-4 sm:px-6 sm:pt-6",
        )}
      >
        <div className="flex min-w-0 items-center gap-1 border-b">
          <div
            ref={tabList}
            role="tablist"
            aria-label="Model providers"
            aria-orientation="horizontal"
            className="flex min-w-0 items-center overflow-x-auto overflow-y-hidden overscroll-x-contain"
            onKeyDown={navigateTabs}
          >
            <Button type="button" variant="ghost" {...tabProps("general")}>
              <SlidersHorizontal className="size-3.5" />
              General
            </Button>
            {providers.map((provider) => {
              const tab = providerModelsTab(provider.id);
              return (
                <ContextMenu.Root key={provider.id}>
                  <ContextMenu.Trigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      {...tabProps(tab)}
                      title={provider.name}
                    >
                      <ProviderSetupIcon setup={providerSetupFor(provider)} />
                      <span className="truncate">{provider.name}</span>
                    </Button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <StyledContextMenuContent>
                      <StyledContextMenuItem
                        onSelect={() => onEditProvider(provider)}
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </StyledContextMenuItem>
                    </StyledContextMenuContent>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
              );
            })}
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                className="size-8 shrink-0"
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Add provider"
                title="Add provider"
              >
                <Plus className="size-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <StyledDropdownMenuContent align="end" sideOffset={4}>
                {providerSetupOptions.map((setup) => {
                  const unavailableReason = providerSetupUnavailableReason(
                    setup.kind,
                    providers,
                  );
                  return (
                    <StyledDropdownMenuItem
                      key={setup.id}
                      disabled={Boolean(unavailableReason)}
                      onSelect={() => {
                        if (!unavailableReason) onAddProvider(setup.id);
                      }}
                      title={unavailableReason ?? undefined}
                      textValue={setup.label}
                    >
                      <ProviderSetupIcon setup={setup.id} />
                      {unavailableReason ? (
                        <span className="grid gap-0.5">
                          <span>{setup.label}</span>
                          <span className="text-xs">
                            Already added · manage sign-ins in its tab
                          </span>
                        </span>
                      ) : (
                        setup.label
                      )}
                    </StyledDropdownMenuItem>
                  );
                })}
              </StyledDropdownMenuContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${selectedTab}`}
        tabIndex={0}
        data-content-gutter={inSearchResults ? undefined : "standard"}
        className={cn(
          "min-w-0 space-y-4 pt-4 outline-none",
          !inSearchResults &&
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6",
        )}
      >
        {provider ? (
          <section
            aria-label={`${provider.name} status`}
            className="min-w-0 space-y-4 border-b pb-4"
          >
            {renderProviderOverview(provider)}
            <ProviderInferenceUsage providerId={provider.id} />
          </section>
        ) : (
          <section
            aria-label="General model settings"
            className="divide-y border-y"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
              <div>
                <p className="text-sm font-medium">
                  Default model configuration
                </p>
                <p className="text-xs text-muted-foreground">
                  Root and subagent defaults for newly created IDE Agent chats.
                </p>
              </div>
              <ModelReasoningPicker
                configuration={defaultModelConfiguration(preferences)}
                disabled={preferencesPending}
                loadReasoningState={getModelReasoningOptions}
                mode="settings"
                models={languageModels}
                ollamaCatalog={{ providers, workerId }}
                pending={preferencesPending}
                onSave={(configuration) =>
                  onPreferencesChange(
                    modelConfigurationSettingsUpdate(configuration),
                  )
                }
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">
                    Standalone Chat defaults
                  </p>
                  {preferences.defaultChatModelId === null &&
                  preferences.defaultChatReasoningEffort === null ? (
                    <Badge variant="outline">Inherits IDE</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Model and reasoning for newly created standalone Chats.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {preferences.defaultChatModelId !== null ||
                preferences.defaultChatReasoningEffort !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={preferencesPending}
                    onClick={() =>
                      void onPreferencesChange({
                        defaultChatModelId: null,
                        defaultChatReasoningEffort: null,
                      }).catch(() => undefined)
                    }
                  >
                    Use IDE defaults
                  </Button>
                ) : null}
                <ModelReasoningPicker
                  configuration={defaultStandaloneChatModelConfiguration(
                    preferences,
                  )}
                  disabled={preferencesPending}
                  loadReasoningState={getModelReasoningOptions}
                  mode="settings"
                  models={languageModels}
                  ollamaCatalog={{ providers, workerId }}
                  pending={preferencesPending}
                  onSave={(configuration) =>
                    onPreferencesChange(
                      standaloneChatModelConfigurationSettingsUpdate(
                        configuration,
                      ),
                    )
                  }
                />
              </div>
            </div>
            {preferences.defaultCouncilReasoningEffort !== undefined ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">Council defaults</p>
                    {inheritsCouncilModelConfiguration(preferences) ? (
                      <Badge variant="outline">Inherits IDE</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Root and subagent defaults for newly created Council agents.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!inheritsCouncilModelConfiguration(preferences) ? (
                    <TooltipButton
                      tooltip="Use IDE defaults"
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={preferencesPending}
                      onClick={() =>
                        void onPreferencesChange(
                          councilModelConfigurationSettingsUpdate(null),
                        ).catch(() => undefined)
                      }
                    >
                      Use IDE defaults
                    </TooltipButton>
                  ) : null}
                  <ModelReasoningPicker
                    buttonTooltips
                    configuration={defaultCouncilModelConfiguration(
                      preferences,
                    )}
                    disabled={preferencesPending}
                    label="Council default model configuration"
                    loadReasoningState={getModelReasoningOptions}
                    mode="settings"
                    models={languageModels}
                    ollamaCatalog={{ providers, workerId }}
                    pending={preferencesPending}
                    onSave={(configuration) =>
                      onPreferencesChange(
                        councilModelConfigurationSettingsUpdate(configuration),
                      )
                    }
                  />
                </div>
              </div>
            ) : preferences.defaultCouncilModelId !== undefined ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <p className="text-sm font-medium">Council default model</p>
                <div className="grid w-full gap-1 sm:w-72">
                  <ModelCombobox
                    ariaLabel="Council default model"
                    tooltip="Choose the Council default model"
                    models={languageModels}
                    value={preferences.defaultCouncilModelId}
                    disabled={preferencesPending}
                    noneLabel="Use IDE default model"
                    placeholder="Use IDE default model"
                    onValueChange={(id) =>
                      void onPreferencesChange({
                        defaultCouncilModelId: id || null,
                      }).catch(() => undefined)
                    }
                  />
                </div>
              </div>
            ) : null}
            {(["embedding", "decision"] as const).map((operation) => {
              const preference =
                operation === "embedding"
                  ? "defaultEmbeddingModelId"
                  : "defaultDecisionModelId";
              return (
                <div
                  key={operation}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      Default {operation} model
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Used by features that request{" "}
                      {operation === "embedding"
                        ? "embeddings"
                        : "native decisions"}
                      . No model is selected automatically.
                    </p>
                  </div>
                  <OperationDefaultPicker
                    models={models}
                    providers={providers}
                    workerId={workerId}
                    operation={operation}
                    value={preferences[preference] ?? null}
                    pending={preferencesPending}
                    onChange={(value) =>
                      void onPreferencesChange(
                        operation === "embedding"
                          ? { defaultEmbeddingModelId: value }
                          : { defaultDecisionModelId: value },
                      ).catch(() => undefined)
                    }
                  />
                </div>
              );
            })}
            <p className="px-3 py-3 text-xs text-muted-foreground">
              The default initializes new agents. An agent’s selected model
              applies to its next message. Select a provider tab to manage its
              models, or use + to add a provider.
            </p>
            {preferencesError ? (
              <p role="alert" className="px-3 py-3 text-sm text-destructive">
                {preferencesError}
              </p>
            ) : null}
          </section>
        )}
        {providerError ? (
          <p role="alert" className="text-sm text-destructive">
            {providerError}
          </p>
        ) : null}
        {provider || visibleModels.length ? (
          <SettingsModelGrid
            key={selectedTab}
            title={provider ? "Models" : "Unassigned models"}
            models={visibleModels}
            providers={providers}
            preferences={preferences}
            unavailableOperations={(
              ["language", "embedding", "decision"] as const
            ).filter((operation) => support?.[operation] === "unsupported")}
            emptyMessage={
              provider && providerSupportsCatalog(provider)
                ? "No models configured. Refresh the catalog or add a model by ID."
                : "No models configured. Add a model by ID."
            }
            details={modelDetails}
            removing={removingModel}
            preferencesPending={preferencesPending}
            onAdd={(operation) => onAddModel(provider?.id, operation)}
            onEdit={onEditModel}
            onRemove={onRemoveModel}
            onDefault={(model, operation) =>
              void onPreferencesChange(
                operation === "embedding"
                  ? { defaultEmbeddingModelId: model.id }
                  : { defaultDecisionModelId: model.id },
              ).catch(() => undefined)
            }
          />
        ) : null}
        {modelError || (preferencesError && provider) ? (
          <p role="alert" className="px-3 py-3 text-sm text-destructive">
            {modelError ?? preferencesError}
          </p>
        ) : null}
        {!provider && !providers.length ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Add a provider with + to discover and configure models.
          </p>
        ) : null}
      </div>
    </div>
  );
}
