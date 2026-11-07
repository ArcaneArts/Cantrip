import {
  modelProfileOperation,
  providerOperationSupport,
} from "@cantrip/protocol";
import { OperationDefaultPicker } from "./operation-default-picker";
import { useProviderCatalog } from "./use-provider-catalog";
import { availableCatalogModelIds } from "./provider-catalog-cache";
import {
  modelOperationLabels,
  operationCapabilityText,
  scopedCapabilitiesByModel,
} from "./model-operation-metadata";
import { ProviderInferenceUsage } from "./provider-inference-usage";
import type {
  ModelOperation,
  ModelProfileSummary,
  ModelProviderSummary,
  UserSettings,
  UserSettingsUpdate,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Cpu,
  Pencil,
  Plus,
  Server,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  defaultModelConfiguration,
  defaultStandaloneChatModelConfiguration,
  ModelReasoningPicker,
  modelConfigurationSettingsUpdate,
  standaloneChatModelConfigurationSettingsUpdate,
} from "@/components/chat/model-reasoning-picker";
import {
  formatAgentTime,
  formatConcurrency,
  formatTokenCount,
} from "@/components/projects/token-usage-analytics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  providerRouteLabel,
  providerSupportsCatalog,
} from "./provider-catalog-display";
import {
  providerSetupOptions,
  providerSetupUnavailableReason,
  type ProviderSetupKind,
} from "./provider-setup";

function ModelList({
  models,
  providers,
  defaultModelId,
  removing,
  onEdit,
  onRemove,
  onDefault,
  preferencesPending,
  details,
}: {
  models: readonly ModelProfileSummary[];
  providers: readonly ModelProviderSummary[];
  defaultModelId: string | null;
  removing: boolean;
  onEdit(model: ModelProfileSummary): void;
  onRemove(model: ModelProfileSummary): void;
  onDefault?(model: ModelProfileSummary): void;
  preferencesPending?: boolean;
  details?: ReadonlyMap<string, string>;
}) {
  return (
    <div>
      <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_64px] gap-3 border-y px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
        <span>Model</span>
        <span>Routes</span>
        <span>Configuration</span>
        <span className="text-right">Actions</span>
      </div>
      <div className="divide-y border-t sm:border-t-0">
        {models.map((model) => (
          <div
            key={model.id}
            data-high-contrast-row
            role="button"
            tabIndex={0}
            aria-label={`Edit ${model.name}`}
            title={`Edit ${model.name}`}
            className="grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_64px]"
            onClick={() => onEdit(model)}
            onKeyDown={(event) => {
              if (
                event.target !== event.currentTarget ||
                (event.key !== "Enter" && event.key !== " ")
              )
                return;
              event.preventDefault();
              onEdit(model);
            }}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <Cpu className="size-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 truncate text-sm font-medium">
                {model.name}
              </p>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatTokenCount(model.tokenUsage.totalTokens)} tokens
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatAgentTime(model.agentTime.agentTimeMs)} AI ·{" "}
                {formatConcurrency(model.agentTime)}
              </span>
              {details?.get(model.id) ? (
                <span className="basis-full pl-6 text-[11px] text-muted-foreground">
                  {details.get(model.id)}
                </span>
              ) : null}
              {defaultModelId === model.id ? (
                <Badge className="sm:hidden" variant="secondary">
                  Default
                </Badge>
              ) : null}
            </div>
            <p className="col-span-2 truncate pl-6 text-xs text-muted-foreground sm:col-span-1 sm:pl-0">
              {model.routes
                .filter((route) => route.enabled)
                .map((route) => {
                  const provider = providers.find(
                    ({ id }) => id === route.providerId,
                  );
                  return provider
                    ? providerRouteLabel(provider)
                    : route.providerName;
                })
                .join(" → ") || "No enabled routes"}
              <span className="sm:hidden">{` · ${model.routes.filter((route) => route.enabled).length} enabled`}</span>
            </p>
            <div className="hidden items-center justify-end gap-2 text-xs text-muted-foreground sm:flex">
              <span>
                {model.routes.filter((route) => route.enabled).length} enabled
              </span>
              {defaultModelId === model.id ? (
                <Badge variant="secondary">Default</Badge>
              ) : null}
            </div>
            <div
              className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto"
              onClick={(event) => event.stopPropagation()}
            >
              {onDefault ? (
                <Button
                  type="button"
                  className="size-7"
                  size="icon"
                  variant="ghost"
                  title={`Use as default ${modelProfileOperation(model)} model`}
                  aria-label={`Use ${model.name} as default ${modelProfileOperation(model)} model`}
                  disabled={preferencesPending || defaultModelId === model.id}
                  onClick={() => onDefault(model)}
                >
                  <Check className="size-3.5" />
                </Button>
              ) : null}
              <Button
                className="size-7"
                size="icon"
                variant="ghost"
                disabled={removing}
                onClick={() => onRemove(model)}
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only">Delete {model.name}</span>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ModelsSettings({
  activeTab,
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
    workerId,
    Boolean(provider && providerSupportsCatalog(provider)),
    provider?.connectionRevision ?? provider?.updatedAt,
  );
  const capabilitiesById = useMemo(
    () => scopedCapabilitiesByModel(catalog.data, workerId),
    [catalog.data, workerId],
  );
  const languageModels = models.filter(
    (model) => modelProfileOperation(model) === "language",
  );
  const support = provider ? providerOperationSupport(provider) : null;
  const selectedTab = provider ? activeTab : "general";
  const visibleModels = provider
    ? modelsForProvider(models, provider.id)
    : unassignedModels(models, providers);
  const modelDetails = new Map<string, string>();
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
      const notes = [operationCapabilityText(operation, capability)];
      if (operation === "embedding" && route?.operationOptions?.dimensions)
        notes.push(
          `${route.operationOptions.dimensions.toLocaleString()} configured dimensions`,
        );
      if (entry && catalog.data && !available.has(entry.id))
        notes.push("Unavailable in selected scope");
      if (catalog.data?.servedStale) notes.push("Catalog stale");
      modelDetails.set(model.id, notes.join(" · "));
    }
  }
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
    <div className="min-w-0 space-y-4" data-slot="models-settings">
      <div className="sticky top-0 z-10 flex min-w-0 items-center gap-1 border-b bg-transparent">
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
                    <Server className="size-3.5 shrink-0" />
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
                  >
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
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${selectedTab}`}
        tabIndex={0}
        className="min-w-0 space-y-4 outline-none"
      >
        {provider ? (
          <section
            aria-label={`${provider.name} status`}
            className="min-w-0 border-y"
          >
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(8rem,0.75fr)_minmax(7rem,0.65fr)_96px] gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Provider</span>
              <span>Connection</span>
              <span>Catalog</span>
              <span>Scope</span>
              <span className="text-right">Actions</span>
            </div>
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
        {(["language", "embedding", "decision"] as const).map((operation) => {
          const operationModels = visibleModels.filter(
            (model) => modelProfileOperation(model) === operation,
          );
          if (!provider && !operationModels.length) return null;
          const unsupported = support?.[operation] === "unsupported";
          const defaultId =
            operation === "language"
              ? preferences.defaultModelId
              : operation === "embedding"
                ? preferences.defaultEmbeddingModelId
                : preferences.defaultDecisionModelId;
          return (
            <section
              key={operation}
              aria-label={`${provider?.name ?? "Unassigned"} ${operation} models`}
            >
              <div className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Cpu className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">
                    {provider ? "" : "Unassigned "}
                    {modelOperationLabels[operation]} models
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {operationModels.length}
                  </span>
                </div>
                <Button
                  className="size-8"
                  type="button"
                  size="icon"
                  variant="outline"
                  disabled={!providers.length || unsupported}
                  onClick={() => onAddModel(provider?.id, operation)}
                  aria-label={`Add ${operation} model`}
                  title={`Add ${operation} model`}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <ModelList
                models={operationModels}
                providers={providers}
                defaultModelId={defaultId ?? null}
                removing={removingModel}
                preferencesPending={preferencesPending}
                details={modelDetails}
                onEdit={onEditModel}
                onRemove={onRemoveModel}
                onDefault={
                  operation === "language"
                    ? undefined
                    : (model) =>
                        void onPreferencesChange(
                          operation === "embedding"
                            ? { defaultEmbeddingModelId: model.id }
                            : { defaultDecisionModelId: model.id },
                        ).catch(() => undefined)
                }
              />
              {!operationModels.length ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {unsupported
                    ? `This connection does not expose ${operation} inference.`
                    : `No ${operation} models configured. ${provider && providerSupportsCatalog(provider) ? "Refresh its catalog or add a model by ID." : "Add a model by ID."}`}
                </p>
              ) : null}
            </section>
          );
        })}
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
