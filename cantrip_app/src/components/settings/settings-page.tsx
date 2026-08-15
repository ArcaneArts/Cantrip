import type {
  CodexDeviceLogin,
  ModelProfileSummary,
  ModelProviderKind,
  ModelProviderSummary,
  ModelRouteInput,
  ProviderModelCatalogEntry,
  ThemePreference,
  UserSettings,
  TunnelSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cable,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Gauge,
  KeyRound,
  Layers3,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Network,
  Palette,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/components/projects/token-usage-analytics";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createModelProfile,
  createModelProvider,
  createModelProviderAccount,
  deleteModelProviderAccount,
  deleteModelProfile,
  deleteModelProvider,
  getSettings,
  getCodexAuthStatus,
  getProviderModelCatalog,
  getWorkers,
  logoutCodex,
  startCodexDeviceLogin,
  refreshProviderModelCatalog,
  updateModelProviderAccount,
  updateModelProfile,
  updateModelProvider,
  updateSettings,
} from "@/lib/api";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import {
  SettingsSearchField,
  SettingsTabBar,
  type SettingsTab,
} from "./settings-controls";
import { McpServerSettings } from "./mcp-server-settings";
import { WorkspaceSettings } from "./workspace-settings";
import { SkillsSettings } from "./skills-settings";
import { WorkerSettings } from "./worker-settings";
import { TunnelSettings } from "./tunnel-settings";
import {
  availableCatalogModelIds,
  catalogDisplayStatus,
  catalogModelAvailable,
  catalogScopeLabel,
  formatCatalogAge,
  formatContextWindow,
  latestCatalogSuccess,
  providerSupportsCatalog,
} from "./provider-catalog-display";

export type SettingsSection =
  | "general"
  | "models"
  | "workers"
  | "tunnels"
  | "skills"
  | "mcp"
  | "workspaces";

const settingsTabs: readonly SettingsTab<SettingsSection>[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "models", label: "Models", icon: Cpu },
  { id: "workers", label: "Workers", icon: Network },
  { id: "tunnels", label: "Tunnels", icon: Route },
  { id: "workspaces", label: "Workspaces", icon: Layers3 },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP", icon: Cable },
];

type ProviderSetupKind = ModelProviderKind | "openai" | "openrouter" | "xai";

const providerSetups: Record<
  Exclude<ProviderSetupKind, "chatgpt" | "grok" | "openai-compatible">,
  { baseUrl: string; kind: ModelProviderKind; label: string }
> = {
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    kind: "ollama",
    label: "Ollama",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    label: "OpenRouter",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    kind: "openai-compatible",
    label: "xAI API",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    kind: "openai-compatible",
    label: "OpenAI API",
  },
};

function providerSetupFor(provider: ModelProviderSummary): ProviderSetupKind {
  if (
    provider.kind === "chatgpt" ||
    provider.kind === "grok" ||
    provider.kind === "ollama"
  ) {
    return provider.kind;
  }
  const match = Object.entries(providerSetups).find(
    ([key, setup]) => key !== "ollama" && setup.baseUrl === provider.baseUrl,
  );
  return (match?.[0] as ProviderSetupKind | undefined) ?? "openai-compatible";
}

type AccountProviderKind = Extract<ModelProviderKind, "chatgpt" | "grok">;

function isAccountProviderKind(
  kind: ModelProviderKind,
): kind is AccountProviderKind {
  return kind === "chatgpt" || kind === "grok";
}

function accountProviderName(kind: AccountProviderKind) {
  return kind === "grok" ? "Grok" : "ChatGPT";
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";

type EditableRoute = ModelRouteInput & { key: string };

function newEditableRoute(providerId: string, modelName = ""): EditableRoute {
  return {
    key: crypto.randomUUID(),
    providerId,
    modelName,
    enabled: true,
  };
}

function matchesSearch(query: string, ...values: Array<string | null>) {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function editSettingsRowFromKeyboard(
  event: KeyboardEvent<HTMLDivElement>,
  onEdit: () => void,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onEdit();
}

function ProviderRow({
  provider,
  workerId,
  removing,
  onEdit,
  onRemove,
}: {
  provider: ModelProviderSummary;
  workerId: string | null;
  removing: boolean;
  onEdit(): void;
  onRemove(): void;
}) {
  const queryClient = useQueryClient();
  const supportsCatalog = providerSupportsCatalog(provider);
  const catalogQueryKey = ["provider-catalog", provider.id, workerId];
  const catalog = useQuery({
    enabled: supportsCatalog,
    queryFn: () => getProviderModelCatalog(provider.id, workerId),
    queryKey: catalogQueryKey,
    retry: false,
    staleTime: 60_000,
  });
  const refreshCatalog = useMutation({
    mutationFn: () => refreshProviderModelCatalog(provider.id, workerId),
    onSuccess: (result) => {
      queryClient.setQueryData(catalogQueryKey, result);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const availableModelIds = catalog.data
    ? availableCatalogModelIds(catalog.data, workerId)
    : new Set<string>();
  const availableModelCount =
    catalog.data?.models.filter(
      (model) => !model.hidden && availableModelIds.has(model.id),
    ).length ?? 0;
  const displayStatus = catalogDisplayStatus(provider, catalog.data, workerId);
  const catalogError =
    refreshCatalog.error ??
    catalog.error ??
    catalog.data?.syncStates.find(({ error }) => error)?.error ??
    null;
  const enabledAccounts = provider.accounts.filter(({ enabled }) => enabled);
  const signedInBindings = enabledAccounts.flatMap((account) =>
    account.workerBindings.filter(
      (binding) =>
        binding.authState === "signed-in" &&
        (!workerId || binding.workerId === workerId),
    ),
  );
  const remainingUsage = signedInBindings.flatMap((binding) =>
    binding.weeklyUsageUsedPercent === null
      ? []
      : [Math.max(0, 100 - binding.weeklyUsageUsedPercent)],
  );
  const lowestRemaining = remainingUsage.length
    ? Math.min(...remainingUsage)
    : null;
  const statusTone =
    displayStatus === "current"
      ? "text-emerald-500"
      : displayStatus === "failed"
        ? "text-destructive"
        : displayStatus === "stale"
          ? "text-amber-500"
          : "text-muted-foreground";
  const statusLabel =
    displayStatus === "manual"
      ? "Manual"
      : displayStatus === "unknown" && catalog.isLoading
        ? "Loading"
        : displayStatus[0]!.toUpperCase() + displayStatus.slice(1);

  return (
    <div
      data-high-contrast-row
      role="button"
      tabIndex={0}
      aria-label={`Edit ${provider.name}`}
      title={`Edit ${provider.name}`}
      className="grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(8rem,0.75fr)_minmax(7rem,0.65fr)_72px]"
      onClick={onEdit}
      onKeyDown={(event) => editSettingsRowFromKeyboard(event, onEdit)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <p className="truncate text-sm font-medium">{provider.name}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatTokenCount(provider.tokenUsage.totalTokens)} tokens
        </span>
        <Badge className="sm:hidden" variant="secondary">
          {provider.kind}
        </Badge>
      </div>
      <div className="col-span-2 min-w-0 pl-6 sm:col-span-1 sm:pl-0">
        {isAccountProviderKind(provider.kind) ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span
              className={
                signedInBindings.length ? "text-emerald-500" : undefined
              }
            >
              {signedInBindings.length}/{enabledAccounts.length} signed in
            </span>
            {lowestRemaining === null ? null : (
              <span>{Math.round(lowestRemaining)}% lowest 7-day remaining</span>
            )}
          </p>
        ) : (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.baseUrl}
          </p>
        )}
      </div>
      <div className="hidden min-w-0 sm:block">
        <p className={`truncate text-xs font-medium ${statusTone}`}>
          {refreshCatalog.isPending ? "Refreshing" : statusLabel}
          {supportsCatalog ? ` · ${availableModelCount} available` : ""}
        </p>
        <p
          className="truncate text-[10px] text-muted-foreground"
          title={catalogError ? errorText(catalogError) : undefined}
        >
          {catalogError
            ? errorText(catalogError)
            : formatCatalogAge(latestCatalogSuccess(catalog.data, workerId))}
        </p>
      </div>
      <div className="hidden min-w-0 sm:block">
        <p className="truncate text-xs text-muted-foreground">
          {catalogScopeLabel(provider, catalog.data, workerId)}
        </p>
        <div className="mt-0.5 flex items-center gap-1">
          <Badge variant="secondary">{provider.kind}</Badge>
          {provider.hasApiKey ? (
            <KeyRound className="size-3 text-muted-foreground" />
          ) : null}
        </div>
      </div>
      <div
        className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto"
        onClick={(event) => event.stopPropagation()}
      >
        {supportsCatalog ? (
          <Button
            className="size-7"
            size="icon"
            variant="ghost"
            disabled={refreshCatalog.isPending}
            title="Refresh model catalog"
            onClick={() => refreshCatalog.mutate()}
          >
            <RefreshCw
              className={`size-3.5 ${refreshCatalog.isPending ? "animate-spin" : ""}`}
            />
            <span className="sr-only">Refresh {provider.name} catalog</span>
          </Button>
        ) : null}
        <Button
          className="size-7"
          size="icon"
          variant="ghost"
          disabled={removing}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Delete {provider.name}</span>
        </Button>
      </div>
    </div>
  );
}

function CatalogModelField({
  provider,
  routeKey,
  value,
  workerId,
  onChange,
}: {
  provider: ModelProviderSummary | undefined;
  routeKey: string;
  value: string;
  workerId: string | null;
  onChange(value: string): void;
}) {
  const supportsCatalog = provider ? providerSupportsCatalog(provider) : false;
  const catalog = useQuery({
    enabled: Boolean(provider && supportsCatalog),
    queryFn: () => getProviderModelCatalog(provider!.id, workerId),
    queryKey: ["provider-catalog", provider?.id, workerId],
    retry: false,
    staleTime: 60_000,
  });
  const visibleModels =
    catalog.data?.models.filter(({ hidden }) => !hidden) ?? [];
  const availableModelIds = catalog.data
    ? availableCatalogModelIds(catalog.data, workerId)
    : new Set<string>();
  const selected = visibleModels.find(
    ({ nativeModelId }) => nativeModelId === value,
  );
  const listId = `provider-models-${routeKey}`;

  return (
    <div className="grid min-w-0 gap-1">
      <input
        required
        value={value}
        list={supportsCatalog ? listId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2"
        placeholder={
          supportsCatalog ? "Search catalog or enter a custom ID" : "Model ID"
        }
      />
      {supportsCatalog ? (
        <datalist id={listId}>
          {visibleModels.map((model) => (
            <option key={model.id} value={model.nativeModelId}>
              {model.displayName}
              {availableModelIds.has(model.id)
                ? ""
                : " — unavailable on this worker"}
            </option>
          ))}
        </datalist>
      ) : null}
      <CatalogModelMetadata
        catalog={catalog.data}
        loading={catalog.isLoading}
        model={selected}
        supportsCatalog={supportsCatalog}
        value={value}
        workerId={workerId}
      />
    </div>
  );
}

function CatalogModelMetadata({
  catalog,
  loading,
  model,
  supportsCatalog,
  value,
  workerId,
}: {
  catalog: Awaited<ReturnType<typeof getProviderModelCatalog>> | undefined;
  loading: boolean;
  model: ProviderModelCatalogEntry | undefined;
  supportsCatalog: boolean;
  value: string;
  workerId: string | null;
}) {
  if (!supportsCatalog || !value) return null;
  if (loading) {
    return (
      <span className="text-[10px] text-muted-foreground">
        Loading catalog…
      </span>
    );
  }
  if (!model || !catalog) {
    return (
      <span className="text-[10px] text-muted-foreground">Custom model ID</span>
    );
  }
  const metadata = [
    formatContextWindow(model.contextWindow),
    model.inputModalities.length ? model.inputModalities.join(" + ") : null,
    model.supportsTools ? "tools" : null,
    model.supportsStructuredOutput ? "structured output" : null,
    model.supportsVision ? "vision" : null,
    model.supportsReasoning ? "reasoning" : null,
  ].filter((item): item is string => Boolean(item));
  const available = catalogModelAvailable(model, catalog, workerId);
  return (
    <span
      className={`truncate text-[10px] ${available ? "text-muted-foreground" : "text-amber-500"}`}
      title={model.description ?? undefined}
    >
      {available
        ? metadata.join(" · ") || "Catalog metadata incomplete"
        : "Unavailable on this worker"}
    </span>
  );
}

export function SettingsPage({
  initialSection = "general",
  onOpenTunnelOwner,
}: {
  initialSection?: SettingsSection;
  onOpenTunnelOwner?(tunnel: TunnelSummary): void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const macosDesktopRuntime = isMacosDesktopRuntime();
  const [generalSearchQuery, setGeneralSearchQuery] = useState("");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [proModeOpacityDialogOpen, setProModeOpacityDialogOpen] =
    useState(false);
  const [proModeOpacityDraft, setProModeOpacityDraft] = useState(80);
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceLogin | null>(null);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [deviceLinkCopied, setDeviceLinkCopied] = useState(false);
  const workers = useQuery({ queryFn: getWorkers, queryKey: ["workers"] });
  const worker = workers.data?.find((item) => item.online) ?? null;
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<ModelProviderSummary | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerKind, setProviderKind] = useState<ModelProviderKind>("ollama");
  const [providerSetup, setProviderSetup] =
    useState<ProviderSetupKind>("ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );
  const [accountLabelDraft, setAccountLabelDraft] = useState("");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelProfileSummary | null>(
    null,
  );
  const [modelName, setModelName] = useState("");
  const [modelRoutes, setModelRoutes] = useState<EditableRoute[]>([]);
  const accountProvider =
    editingProvider && isAccountProviderKind(editingProvider.kind)
      ? editingProvider
      : null;
  const selectedAccount =
    accountProvider?.accounts.find(({ id }) => id === selectedAccountId) ??
    accountProvider?.accounts[0] ??
    null;
  const authProviderName = accountProvider
    ? accountProviderName(accountProvider.kind as AccountProviderKind)
    : "account";
  const codexAuth = useQuery({
    enabled: Boolean(
      worker && providerDialogOpen && accountProvider && selectedAccount,
    ),
    queryFn: () =>
      getCodexAuthStatus(
        worker!.workerId,
        accountProvider!.id,
        selectedAccount!.id,
      ),
    queryKey: [
      "codex-auth",
      worker?.workerId,
      accountProvider?.id,
      selectedAccount?.id,
    ],
    refetchInterval: (query) =>
      query.state.data?.loginPending ? 1_500 : 10_000,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  const preferences = useMutation({
    mutationFn: updateSettings,
    onSuccess: (value) => queryClient.setQueryData(["settings"], value),
  });
  const savedProModeOpacity = settings.data?.preferences.proModeOpacity ?? 80;
  useEffect(() => {
    if (!proModeOpacityDialogOpen) return;
    document.documentElement.style.setProperty(
      "--pro-mode-opacity",
      `${proModeOpacityDraft}%`,
    );
    return () => {
      document.documentElement.style.setProperty(
        "--pro-mode-opacity",
        `${savedProModeOpacity}%`,
      );
    };
  }, [proModeOpacityDialogOpen, proModeOpacityDraft, savedProModeOpacity]);
  const saveProvider = useMutation({
    mutationFn: async () => {
      const input = {
        name: providerName,
        kind: providerKind,
        baseUrl: isAccountProviderKind(providerKind)
          ? providerKind === "grok"
            ? "https://cli-chat-proxy.grok.com/v1"
            : "https://api.openai.com/v1"
          : baseUrl,
        ...(isAccountProviderKind(providerKind)
          ? { apiKey: null }
          : editingProvider
            ? removeApiKey
              ? { apiKey: null }
              : apiKey.trim()
                ? { apiKey: apiKey.trim() }
                : {}
            : { apiKey: apiKey.trim() || null }),
      };
      return editingProvider
        ? updateModelProvider(editingProvider.id, input)
        : createModelProvider(input);
    },
    onSuccess: async (provider) => {
      await refresh();
      if (
        isAccountProviderKind(provider.kind) &&
        editingProvider?.kind !== provider.kind
      ) {
        setEditingProvider(provider);
        setProviderName(provider.name);
        setProviderKind(provider.kind);
        setProviderSetup(provider.kind);
        setBaseUrl(provider.baseUrl);
        setSelectedAccountId(provider.accounts[0]?.id ?? null);
        setAccountLabelDraft(provider.accounts[0]?.label ?? "");
        return;
      }
      setProviderDialogOpen(false);
    },
  });
  const removeProvider = useMutation({
    mutationFn: deleteModelProvider,
    onSuccess: refresh,
  });
  const saveModel = useMutation({
    mutationFn: async () => {
      const input = {
        name: modelName,
        routes: modelRoutes.map(({ key: _key, ...route }) => route),
      };
      return editingModel
        ? updateModelProfile(editingModel.id, input)
        : createModelProfile(input);
    },
    onSuccess: async () => {
      setModelDialogOpen(false);
      await refresh();
    },
  });
  const removeModel = useMutation({
    mutationFn: deleteModelProfile,
    onSuccess: refresh,
  });
  const beginCodexLogin = useMutation({
    mutationFn: () =>
      startCodexDeviceLogin(
        worker!.workerId,
        accountProvider!.id,
        selectedAccount!.id,
      ),
    onSuccess: (login) => {
      setDeviceLogin(login);
      setDeviceLinkCopied(false);
      void codexAuth.refetch();
    },
  });
  const signOutCodex = useMutation({
    mutationFn: () =>
      logoutCodex(worker!.workerId, accountProvider!.id, selectedAccount!.id),
    onSuccess: async () => {
      setDeviceLogin(null);
      await codexAuth.refetch();
    },
  });

  useEffect(() => {
    if (codexAuth.data?.authMode !== accountProvider?.kind) return;
    setDeviceLogin(null);
  }, [accountProvider?.kind, codexAuth.data?.authMode]);

  useEffect(() => {
    setAccountLabelDraft(selectedAccount?.label ?? "");
    setDeviceLogin(null);
    setDeviceCodeCopied(false);
    setDeviceLinkCopied(false);
  }, [selectedAccount?.id, selectedAccount?.label]);

  const reloadAccountProvider = async (providerId: string) => {
    const bundle = await getSettings();
    queryClient.setQueryData(["settings"], bundle);
    const provider =
      bundle.providers.find(({ id }) => id === providerId) ?? null;
    setEditingProvider(provider);
    return provider;
  };
  const addProviderAccount = useMutation({
    mutationFn: () =>
      createModelProviderAccount(accountProvider!.id, {
        label: `${authProviderName} account ${accountProvider!.accounts.length + 1}`,
      }),
    onSuccess: async (account) => {
      await reloadAccountProvider(account.providerId);
      setSelectedAccountId(account.id);
      setAccountLabelDraft(account.label);
    },
  });
  const renameProviderAccount = useMutation({
    mutationFn: () =>
      updateModelProviderAccount(accountProvider!.id, selectedAccount!.id, {
        label: accountLabelDraft.trim(),
      }),
    onSuccess: async (account) => {
      await reloadAccountProvider(account.providerId);
      setSelectedAccountId(account.id);
    },
  });
  const removeProviderAccount = useMutation({
    mutationFn: () =>
      deleteModelProviderAccount(accountProvider!.id, selectedAccount!.id),
    onSuccess: async () => {
      const providerId = accountProvider!.id;
      const nextAccount = accountProvider!.accounts.find(
        ({ id }) => id !== selectedAccount!.id,
      );
      await reloadAccountProvider(providerId);
      setSelectedAccountId(nextAccount?.id ?? null);
    },
  });

  const openProviderDialog = (provider: ModelProviderSummary | null) => {
    saveProvider.reset();
    beginCodexLogin.reset();
    signOutCodex.reset();
    setEditingProvider(provider);
    setProviderName(provider?.name ?? "");
    setProviderKind(provider?.kind ?? "ollama");
    setProviderSetup(provider ? providerSetupFor(provider) : "ollama");
    setBaseUrl(provider?.baseUrl ?? "http://127.0.0.1:11434/v1");
    setApiKey("");
    setRemoveApiKey(false);
    setSelectedAccountId(provider?.accounts[0]?.id ?? null);
    setAccountLabelDraft(provider?.accounts[0]?.label ?? "");
    setDeviceLogin(null);
    setDeviceCodeCopied(false);
    setDeviceLinkCopied(false);
    setProviderDialogOpen(true);
  };

  const openModelDialog = (model: ModelProfileSummary | null) => {
    const firstProviderId = settings.data?.providers[0]?.id ?? "";
    saveModel.reset();
    setEditingModel(model);
    setModelName(model?.name ?? "");
    setModelRoutes(
      model
        ? model.routes.map((route) => ({ ...route, key: route.id }))
        : firstProviderId
          ? [newEditableRoute(firstProviderId)]
          : [],
    );
    setModelDialogOpen(true);
  };

  const submitProvider = (event: FormEvent) => {
    event.preventDefault();
    saveProvider.mutate();
  };

  const submitModel = (event: FormEvent) => {
    event.preventDefault();
    if (modelRoutes.length && modelRoutes.every((route) => route.modelName)) {
      saveModel.mutate();
    }
  };

  const generalSearch = generalSearchQuery.trim().toLowerCase();
  const modelSearch = modelSearchQuery.trim().toLowerCase();
  const providers = settings.data?.providers ?? [];
  const models = settings.data?.models ?? [];
  const appearanceMatches =
    !generalSearch ||
    matchesSearch(
      generalSearch,
      "appearance theme system light dark high contrast pro mode opacity transparency vibrancy blur macos operating system",
    );
  const desktopStreamingMatches =
    !generalSearch ||
    matchesSearch(
      generalSearch,
      "remote desktop streaming frame rate fps quality adaptive latency bandwidth data saver sharp",
    );
  const providerSectionMatches =
    !modelSearch ||
    matchesSearch(
      modelSearch,
      "providers provider ollama api chatgpt grok supergrok oauth xai account endpoint key",
    );
  const visibleProviders = providerSectionMatches
    ? providers
    : providers.filter((provider) =>
        matchesSearch(
          modelSearch,
          provider.name,
          provider.kind,
          provider.baseUrl,
          provider.hasApiKey ? "api key" : null,
        ),
      );
  const modelSectionMatches =
    !modelSearch ||
    matchesSearch(
      modelSearch,
      "models model default provider routes priority failover new agents",
    );
  const visibleModels = modelSectionMatches
    ? models
    : models.filter((model) =>
        matchesSearch(
          modelSearch,
          model.name,
          ...model.routes.flatMap((route) => [
            route.providerName,
            route.modelName,
          ]),
          settings.data?.preferences.defaultModelId === model.id
            ? "default"
            : null,
        ),
      );
  const providersMatch = providerSectionMatches || visibleProviders.length > 0;
  const modelsMatch = modelSectionMatches || visibleModels.length > 0;
  const hasSearchResults =
    section === "models"
      ? providersMatch || modelsMatch
      : appearanceMatches || desktopStreamingMatches;

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <SettingsTabBar<SettingsSection>
        activeTab={section}
        ariaLabel="Account settings sections"
        tabs={settingsTabs}
        onTabChange={setSection}
      />
      <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <div
          className={`${section === "general" || section === "models" ? "grid" : "hidden"} mx-auto w-full min-w-0 max-w-6xl gap-4`}
        >
          <SettingsSearchField
            ariaLabel="Search settings"
            placeholder={
              section === "models"
                ? "Search providers and models"
                : "Search general settings"
            }
            value={section === "models" ? modelSearchQuery : generalSearchQuery}
            onValueChange={
              section === "models" ? setModelSearchQuery : setGeneralSearchQuery
            }
          />

          {settings.isError ? (
            <p className="text-sm text-destructive">
              {errorText(settings.error)}
            </p>
          ) : null}

          {hasSearchResults ? (
            <div className="min-w-0 divide-y overflow-hidden border-y">
              {section === "general" && appearanceMatches ? (
                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Palette className="size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <h2 className="text-sm font-semibold">Appearance</h2>
                        <p className="text-xs text-muted-foreground">
                          System follows the operating system.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="flex rounded-md bg-muted/50 p-0.5">
                        {(
                          [
                            ["system", Monitor],
                            ["light", Sun],
                            ["dark", Moon],
                          ] as const
                        ).map(([theme, Icon]) => (
                          <Button
                            key={theme}
                            type="button"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            variant={
                              settings.data?.preferences.theme === theme
                                ? "default"
                                : "ghost"
                            }
                            disabled={preferences.isPending}
                            onClick={() =>
                              preferences.mutate({
                                theme: theme as ThemePreference,
                              })
                            }
                          >
                            <Icon className="size-3.5" />
                            <span className="capitalize">{theme}</span>
                          </Button>
                        ))}
                      </div>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-primary"
                          checked={
                            settings.data?.preferences.highContrast ?? false
                          }
                          disabled={preferences.isPending}
                          onChange={(event) =>
                            preferences.mutate({
                              highContrast: event.target.checked,
                            })
                          }
                        />
                        High contrast
                      </label>
                      {macosDesktopRuntime ? (
                        <label
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 has-disabled:cursor-not-allowed has-disabled:opacity-50"
                          title="Use a translucent native macOS material. Right-click to adjust opacity."
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setProModeOpacityDraft(savedProModeOpacity);
                            setProModeOpacityDialogOpen(true);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={
                              settings.data?.preferences.proMode ?? false
                            }
                            disabled={preferences.isPending}
                            onChange={(event) =>
                              preferences.mutate({
                                proMode: event.target.checked,
                              })
                            }
                          />
                          &quot;Pro&quot; Mode
                        </label>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {section === "general" && desktopStreamingMatches ? (
                <section>
                  <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Gauge className="size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <h2 className="text-sm font-semibold">
                          Remote Desktop
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          Higher rates are best effort; adaptive quality keeps
                          the newest frame responsive.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <label className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">
                          Frame rate
                        </span>
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2"
                          aria-label="Remote Desktop frame rate"
                          value={
                            settings.data?.preferences.desktopFrameRate ?? 30
                          }
                          disabled={preferences.isPending}
                          onChange={(event) =>
                            preferences.mutate({
                              desktopFrameRate: Number(event.target.value) as
                                15 | 30 | 60,
                            })
                          }
                        >
                          <option value={15}>15 FPS</option>
                          <option value={30}>30 FPS</option>
                          <option value={60}>60 FPS max</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Quality</span>
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2"
                          aria-label="Remote Desktop stream quality"
                          value={
                            settings.data?.preferences.desktopStreamQuality ??
                            "adaptive"
                          }
                          disabled={preferences.isPending}
                          onChange={(event) =>
                            preferences.mutate({
                              desktopStreamQuality: event.target
                                .value as UserSettings["desktopStreamQuality"],
                            })
                          }
                        >
                          <option value="adaptive">Adaptive</option>
                          <option value="data-saver">Data saver</option>
                          <option value="balanced">Balanced</option>
                          <option value="sharp">Sharp</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </section>
              ) : null}

              {section === "models" && providersMatch ? (
                <section>
                  <div className="flex items-center justify-between gap-3 px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Server className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <h2 className="text-sm font-semibold">Providers</h2>
                          <span className="text-xs text-muted-foreground">
                            {visibleProviders.length}
                            {modelSearch &&
                            visibleProviders.length !== providers.length
                              ? ` of ${providers.length}`
                              : ""}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          Ollama, compatible APIs, and isolated ChatGPT or Grok
                          accounts.
                        </p>
                      </div>
                    </div>
                    <Button
                      className="size-8"
                      size="icon"
                      variant="outline"
                      onClick={() => openProviderDialog(null)}
                    >
                      <Plus className="size-3.5" />
                      <span className="sr-only">Add provider</span>
                    </Button>
                  </div>
                  <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(8rem,0.75fr)_minmax(7rem,0.65fr)_72px] gap-3 border-y px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                    <span>Provider</span>
                    <span>Connection</span>
                    <span>Catalog</span>
                    <span>Scope</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <div className="divide-y border-t sm:border-t-0">
                    {visibleProviders.map((provider) => (
                      <ProviderRow
                        key={provider.id}
                        provider={provider}
                        workerId={worker?.workerId ?? null}
                        removing={removeProvider.isPending}
                        onEdit={() => openProviderDialog(provider)}
                        onRemove={() => removeProvider.mutate(provider.id)}
                      />
                    ))}
                    {!visibleProviders.length ? (
                      <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                        No providers match “{modelSearchQuery.trim()}”.
                      </p>
                    ) : null}
                  </div>
                  {removeProvider.isError ? (
                    <p className="border-t px-3 py-3 text-sm text-destructive">
                      {errorText(removeProvider.error)}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {section === "models" && modelsMatch ? (
                <section>
                  <div className="flex items-center justify-between gap-3 px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Cpu className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <h2 className="text-sm font-semibold">Models</h2>
                          <span className="text-xs text-muted-foreground">
                            {visibleModels.length}
                            {modelSearch &&
                            visibleModels.length !== models.length
                              ? ` of ${models.length}`
                              : ""}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          Logical models with ordered provider failover routes.
                        </p>
                      </div>
                    </div>
                    <Button
                      className="size-8"
                      size="icon"
                      variant="outline"
                      disabled={!providers.length}
                      onClick={() => openModelDialog(null)}
                    >
                      <Plus className="size-3.5" />
                      <span className="sr-only">Add model</span>
                    </Button>
                  </div>

                  <label className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2.5 text-xs">
                    <span className="font-medium">Default for new agents</span>
                    <select
                      value={settings.data?.preferences.defaultModelId ?? ""}
                      onChange={(event) =>
                        preferences.mutate({
                          defaultModelId: event.target.value,
                        })
                      }
                      className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2 sm:w-72"
                      disabled={preferences.isPending}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_40px] gap-3 border-y px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                    <span>Model</span>
                    <span>Routes</span>
                    <span>Configuration</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <div className="divide-y border-t sm:border-t-0">
                    {visibleModels.map((model) => (
                      <div
                        key={model.id}
                        data-high-contrast-row
                        role="button"
                        tabIndex={0}
                        aria-label={`Edit ${model.name}`}
                        title={`Edit ${model.name}`}
                        className="grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_40px]"
                        onClick={() => openModelDialog(model)}
                        onKeyDown={(event) =>
                          editSettingsRowFromKeyboard(event, () =>
                            openModelDialog(model),
                          )
                        }
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Cpu className="size-4 shrink-0 text-muted-foreground" />
                          <p className="truncate text-sm font-medium">
                            {model.name}
                          </p>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {formatTokenCount(model.tokenUsage.totalTokens)}{" "}
                            tokens
                          </span>
                          {settings.data?.preferences.defaultModelId ===
                          model.id ? (
                            <Badge className="sm:hidden" variant="secondary">
                              Default
                            </Badge>
                          ) : null}
                        </div>
                        <p className="col-span-2 truncate pl-6 text-xs text-muted-foreground sm:col-span-1 sm:pl-0">
                          {model.routes
                            .filter((route) => route.enabled)
                            .map((route) => route.providerName)
                            .join(" → ")}
                          <span className="sm:hidden">
                            {` · ${model.routes.filter((route) => route.enabled).length} enabled`}
                          </span>
                        </p>
                        <div className="hidden items-center justify-end gap-2 text-xs text-muted-foreground sm:flex">
                          <span>
                            {
                              model.routes.filter((route) => route.enabled)
                                .length
                            }{" "}
                            enabled
                          </span>
                          {settings.data?.preferences.defaultModelId ===
                          model.id ? (
                            <Badge variant="secondary">Default</Badge>
                          ) : null}
                        </div>
                        <div
                          className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button
                            className="size-7"
                            size="icon"
                            variant="ghost"
                            disabled={removeModel.isPending}
                            onClick={() => removeModel.mutate(model.id)}
                          >
                            <Trash2 className="size-3.5" />
                            <span className="sr-only">Delete {model.name}</span>
                          </Button>
                        </div>
                      </div>
                    ))}
                    {!visibleModels.length ? (
                      <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                        No models match “{modelSearchQuery.trim()}”.
                      </p>
                    ) : null}
                  </div>
                  {removeModel.isError ? (
                    <p className="border-t px-3 py-3 text-sm text-destructive">
                      {errorText(removeModel.error)}
                    </p>
                  ) : null}
                </section>
              ) : null}
            </div>
          ) : null}

          {!hasSearchResults ? (
            <div className="py-12 text-center">
              <Search className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">
                {section === "models" ? "No models found" : "No settings found"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {section === "models"
                  ? "Try a provider name, model name, or route."
                  : "Try a theme, display option, or setting."}
              </p>
            </div>
          ) : null}

          {section === "models" ? (
            <p className="pb-2 text-xs text-muted-foreground">
              The default initializes new agents. An agent’s selected model
              applies to its next message.
            </p>
          ) : null}
        </div>
        {section === "workspaces" ? (
          <div className="mx-auto w-full min-w-0 max-w-6xl">
            <WorkspaceSettings />
          </div>
        ) : null}
        {section === "workers" ? <WorkerSettings /> : null}
        {section === "tunnels" ? (
          <TunnelSettings onOpenOwner={onOpenTunnelOwner} />
        ) : null}
        {section === "skills" ? <SkillsSettings /> : null}
        {section === "mcp" ? (
          <div className="mx-auto w-full min-w-0 max-w-6xl">
            <McpServerSettings scope={{ kind: "global" }} />
          </div>
        ) : null}
      </div>

      {macosDesktopRuntime ? (
        <Dialog
          open={proModeOpacityDialogOpen}
          onOpenChange={(open) => {
            if (open) setProModeOpacityDraft(savedProModeOpacity);
            setProModeOpacityDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-md">
            <form
              className="grid gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                preferences.mutate(
                  { proModeOpacity: proModeOpacityDraft },
                  { onSuccess: () => setProModeOpacityDialogOpen(false) },
                );
              }}
            >
              <DialogHeader>
                <DialogTitle>Pro Mode opacity</DialogTitle>
                <DialogDescription>
                  Adjust the window tint over the native macOS blur. Changes
                  preview immediately and are saved to this Cantrip account.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <div className="flex items-center justify-between text-sm">
                  <label htmlFor="pro-mode-opacity" className="font-medium">
                    Window opacity
                  </label>
                  <output
                    htmlFor="pro-mode-opacity"
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs"
                  >
                    {proModeOpacityDraft}%
                  </output>
                </div>
                <input
                  id="pro-mode-opacity"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={proModeOpacityDraft}
                  className="w-full accent-primary"
                  onChange={(event) =>
                    setProModeOpacityDraft(Number(event.target.value))
                  }
                />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Transparent</span>
                  <span>Opaque</span>
                </div>
              </div>
              {preferences.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(preferences.error)}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  className="sm:mr-auto"
                  onClick={() => setProModeOpacityDraft(80)}
                >
                  Reset to 80%
                </Button>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={preferences.isPending}>
                  {preferences.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog open={providerDialogOpen} onOpenChange={setProviderDialogOpen}>
        <DialogContent>
          <form onSubmit={submitProvider} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>
                {editingProvider ? "Edit provider" : "Add provider"}
              </DialogTitle>
              <DialogDescription>
                Configure an API endpoint or a subscription account used through
                Codex.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider name">
                <input
                  required
                  autoFocus
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  className={inputClass}
                  placeholder="My Ollama"
                />
              </Field>
              <Field label="Provider type">
                <select
                  value={providerSetup}
                  onChange={(event) => {
                    const setup = event.target.value as ProviderSetupKind;
                    setProviderSetup(setup);
                    if (setup === "chatgpt" || setup === "grok") {
                      setProviderKind(setup);
                      setBaseUrl(
                        setup === "grok"
                          ? "https://cli-chat-proxy.grok.com/v1"
                          : "https://api.openai.com/v1",
                      );
                      if (!providerName.trim()) {
                        setProviderName(accountProviderName(setup));
                      }
                    } else if (setup === "openai-compatible") {
                      setProviderKind("openai-compatible");
                      if (!editingProvider) setBaseUrl("https://");
                    } else {
                      const preset = providerSetups[setup];
                      setProviderKind(preset.kind);
                      setBaseUrl(preset.baseUrl);
                      if (!providerName.trim()) setProviderName(preset.label);
                    }
                  }}
                  className={inputClass}
                >
                  <option value="ollama">Ollama</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="xai">xAI API key</option>
                  <option value="openai">OpenAI API</option>
                  <option value="openai-compatible">
                    Custom OpenAI compatible
                  </option>
                  <option value="chatgpt">ChatGPT Account</option>
                  <option value="grok">Grok / SuperGrok Account</option>
                </select>
              </Field>
              {!isAccountProviderKind(providerKind) ? (
                <Field label="Base URL">
                  <div className="space-y-1.5">
                    <input
                      required
                      type="url"
                      value={baseUrl}
                      onChange={(event) => {
                        setBaseUrl(event.target.value);
                        if (
                          providerSetup !== "ollama" &&
                          providerSetup !== "openai-compatible"
                        ) {
                          setProviderSetup("openai-compatible");
                          setProviderKind("openai-compatible");
                        }
                      }}
                      className={inputClass}
                      placeholder="https://openrouter.ai/api/v1"
                    />
                    <p className="text-xs text-muted-foreground">
                      Choose a preset above or edit its API root. Cantrip adds
                      the Responses endpoint.
                    </p>
                  </div>
                </Field>
              ) : (
                <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                  This provider keeps each {accountProviderName(providerKind)}
                  sign-in isolated on the selected worker.
                </div>
              )}
              {!isAccountProviderKind(providerKind) ? (
                <Field label="API key (optional)">
                  <input
                    type="password"
                    value={apiKey}
                    disabled={removeApiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    className={inputClass}
                    autoComplete="off"
                    placeholder={
                      editingProvider?.hasApiKey
                        ? "Leave blank to keep saved key"
                        : "Not required for local Ollama"
                    }
                  />
                </Field>
              ) : null}
            </div>
            {!isAccountProviderKind(providerKind) &&
            editingProvider?.hasApiKey ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={removeApiKey}
                  onChange={(event) => setRemoveApiKey(event.target.checked)}
                />
                Remove the saved API key
              </label>
            ) : null}
            {accountProvider ? (
              <div className="grid gap-3 border-y py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Accounts</p>
                    <p className="text-xs text-muted-foreground">
                      Each sign-in has separate credentials and can be tried as
                      a fallback route.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={addProviderAccount.isPending}
                    onClick={() => addProviderAccount.mutate()}
                  >
                    {addProviderAccount.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    Account
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {accountProvider.accounts.map((account) => {
                    const signedIn = account.workerBindings.some(
                      (binding) =>
                        binding.authState === "signed-in" &&
                        (!worker || binding.workerId === worker.workerId),
                    );
                    return (
                      <Button
                        key={account.id}
                        type="button"
                        size="sm"
                        variant={
                          account.id === selectedAccount?.id
                            ? "outline"
                            : "ghost"
                        }
                        onClick={() => setSelectedAccountId(account.id)}
                      >
                        <span
                          className={`size-1.5 rounded-full ${signedIn ? "bg-emerald-400" : "bg-muted-foreground/45"}`}
                        />
                        {account.label}
                      </Button>
                    );
                  })}
                </div>
                {selectedAccount ? (
                  <div className="flex items-center gap-2">
                    <input
                      aria-label="Account label"
                      value={accountLabelDraft}
                      onChange={(event) =>
                        setAccountLabelDraft(event.target.value)
                      }
                      className={`${inputClass} h-8 flex-1`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !accountLabelDraft.trim() ||
                        accountLabelDraft.trim() === selectedAccount.label ||
                        renameProviderAccount.isPending
                      }
                      onClick={() => renameProviderAccount.mutate()}
                    >
                      Save label
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title="Delete account"
                      disabled={
                        accountProvider.accounts.length <= 1 ||
                        removeProviderAccount.isPending
                      }
                      onClick={() => removeProviderAccount.mutate()}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {isAccountProviderKind(providerKind) ? (
              !accountProvider || !selectedAccount ? (
                <p className="border-y py-3 text-sm text-muted-foreground">
                  Add this provider to continue to{" "}
                  {accountProviderName(providerKind)} device sign-in.
                </p>
              ) : !worker ? (
                <p className="border-y py-3 text-sm text-muted-foreground">
                  Connect a worker to manage this {authProviderName} account.
                </p>
              ) : codexAuth.isLoading ? (
                <div className="flex items-center gap-2 border-y py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Checking{" "}
                  {authProviderName} authentication…
                </div>
              ) : codexAuth.data?.authMode === accountProvider.kind ? (
                <div className="grid gap-3 border-y py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        Signed in with {authProviderName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {codexAuth.data.email ?? selectedAccount.label}
                        {codexAuth.data.planType
                          ? ` · ${codexAuth.data.planType} plan`
                          : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={signOutCodex.isPending}
                      onClick={() => signOutCodex.mutate()}
                    >
                      <LogOut className="size-4" /> Sign out
                    </Button>
                  </div>
                  {codexAuth.data.weeklyUsage ? (
                    <div className="grid gap-1.5 border-t pt-3">
                      <div className="flex justify-between text-xs">
                        <span>7-day usage</span>
                        <span className="font-medium">
                          {Math.round(codexAuth.data.weeklyUsage.usedPercent)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{
                            width: `${codexAuth.data.weeklyUsage.usedPercent}%`,
                          }}
                        />
                      </div>
                      {codexAuth.data.weeklyUsage.resetsAt ? (
                        <p className="text-[11px] text-muted-foreground">
                          Resets{" "}
                          {new Date(
                            codexAuth.data.weeklyUsage.resetsAt * 1_000,
                          ).toLocaleString()}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-3 border-y py-3">
                  <Button
                    type="button"
                    className="w-fit"
                    disabled={
                      beginCodexLogin.isPending ||
                      Boolean(codexAuth.data?.loginPending)
                    }
                    onClick={() => beginCodexLogin.mutate()}
                  >
                    {beginCodexLogin.isPending ||
                    codexAuth.data?.loginPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <KeyRound className="size-4" />
                    )}
                    {codexAuth.data?.loginPending
                      ? "Waiting for authorization"
                      : "Get sign-in code"}
                  </Button>
                  {deviceLogin ? (
                    <div className="grid gap-3 bg-muted/40 p-3 text-sm">
                      <p>
                        Enter code{" "}
                        <button
                          type="button"
                          title="Copy device code"
                          className="inline-flex items-center gap-1 rounded bg-background px-1.5 py-0.5 font-mono font-semibold underline"
                          onClick={async () => {
                            await navigator.clipboard.writeText(
                              deviceLogin.userCode,
                            );
                            setDeviceCodeCopied(true);
                            window.setTimeout(
                              () => setDeviceCodeCopied(false),
                              1_500,
                            );
                          }}
                        >
                          {deviceCodeCopied ? (
                            <Check className="size-3" />
                          ) : null}
                          {deviceLogin.userCode}
                        </button>{" "}
                        at{" "}
                        <a
                          className="underline"
                          href={deviceLogin.verificationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          the {authProviderName} device page
                        </a>
                        . This page updates after authorization.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={async () => {
                          await navigator.clipboard.writeText(
                            deviceLogin.verificationUrl,
                          );
                          setDeviceLinkCopied(true);
                          window.setTimeout(
                            () => setDeviceLinkCopied(false),
                            1_500,
                          );
                        }}
                      >
                        {deviceLinkCopied ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        {deviceLinkCopied
                          ? "Sign-in link copied"
                          : "Copy sign-in link"}
                      </Button>
                    </div>
                  ) : null}
                  {codexAuth.data?.loginError ? (
                    <p className="text-sm text-destructive">
                      {codexAuth.data.loginError}
                    </p>
                  ) : null}
                </div>
              )
            ) : null}
            {isAccountProviderKind(providerKind) &&
            (codexAuth.isError ||
              beginCodexLogin.isError ||
              signOutCodex.isError ||
              addProviderAccount.isError ||
              renameProviderAccount.isError ||
              removeProviderAccount.isError) ? (
              <p className="text-sm text-destructive">
                {errorText(
                  codexAuth.error ??
                    beginCodexLogin.error ??
                    signOutCodex.error ??
                    addProviderAccount.error ??
                    renameProviderAccount.error ??
                    removeProviderAccount.error,
                )}
              </p>
            ) : null}
            {saveProvider.isError ? (
              <p className="text-sm text-destructive">
                {errorText(saveProvider.error)}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saveProvider.isPending}>
                {saveProvider.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {editingProvider ? "Save changes" : "Add provider"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="max-w-3xl">
          <form onSubmit={submitModel} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>
                {editingModel ? "Edit model" : "Add model"}
              </DialogTitle>
              <DialogDescription>
                Select this logical model in an agent; Cantrip tries its enabled
                provider routes from top to bottom.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <Field label="Display name">
                <input
                  required
                  autoFocus
                  value={modelName}
                  onChange={(event) => setModelName(event.target.value)}
                  className={inputClass}
                  placeholder="GPT-5.6 Sol"
                />
              </Field>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Provider routes</p>
                    <p className="text-xs text-muted-foreground">
                      The first available route handles each new turn.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const providerId = settings.data?.providers[0]?.id;
                      if (!providerId) return;
                      setModelRoutes((routes) => [
                        ...routes,
                        newEditableRoute(
                          providerId,
                          routes.at(-1)?.modelName || modelName,
                        ),
                      ]);
                    }}
                  >
                    <Plus className="size-3.5" /> Add route
                  </Button>
                </div>
                <div className="divide-y overflow-hidden border-y">
                  <div className="hidden grid-cols-[5rem_minmax(0,0.9fr)_minmax(0,1.4fr)_auto] items-center gap-2 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                    <span>Priority</span>
                    <span>Provider</span>
                    <span>Provider model</span>
                    <span className="pr-1 text-right">Status &amp; order</span>
                  </div>
                  {modelRoutes.map((route, index) => (
                    <div
                      key={route.key}
                      data-high-contrast-row
                      className="grid min-w-0 gap-2 px-2 py-2 even:bg-muted/20 sm:grid-cols-[5rem_minmax(0,0.9fr)_minmax(0,1.4fr)_auto] sm:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Route className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-xs font-medium">
                          Priority {index + 1}
                        </span>
                      </div>
                      <label className="grid min-w-0 gap-1 text-xs">
                        <span className="font-medium text-muted-foreground sm:sr-only">
                          Provider
                        </span>
                        <select
                          required
                          value={route.providerId}
                          onChange={(event) =>
                            setModelRoutes((routes) =>
                              routes.map((candidate) =>
                                candidate.key === route.key
                                  ? {
                                      ...candidate,
                                      providerId: event.target.value,
                                      modelName: "",
                                    }
                                  : candidate,
                              ),
                            )
                          }
                          className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2"
                        >
                          {(settings.data?.providers ?? []).map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid min-w-0 gap-1 text-xs">
                        <span className="font-medium text-muted-foreground sm:sr-only">
                          Provider model name
                        </span>
                        <CatalogModelField
                          provider={settings.data?.providers.find(
                            ({ id }) => id === route.providerId,
                          )}
                          routeKey={route.key}
                          value={route.modelName}
                          workerId={worker?.workerId ?? null}
                          onChange={(modelName) =>
                            setModelRoutes((routes) =>
                              routes.map((candidate) =>
                                candidate.key === route.key
                                  ? {
                                      ...candidate,
                                      modelName,
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        />
                      </label>
                      <div className="flex items-center justify-end gap-0.5">
                        <label className="mr-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={route.enabled}
                            onChange={(event) =>
                              setModelRoutes((routes) =>
                                routes.map((candidate) =>
                                  candidate.key === route.key
                                    ? {
                                        ...candidate,
                                        enabled: event.target.checked,
                                      }
                                    : candidate,
                                ),
                              )
                            }
                          />
                          Enabled
                        </label>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          disabled={index === 0}
                          onClick={() =>
                            setModelRoutes((routes) => {
                              const next = [...routes];
                              [next[index - 1], next[index]] = [
                                next[index]!,
                                next[index - 1]!,
                              ];
                              return next;
                            })
                          }
                        >
                          <ChevronUp className="size-3.5" />
                          <span className="sr-only">Increase priority</span>
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          disabled={index === modelRoutes.length - 1}
                          onClick={() =>
                            setModelRoutes((routes) => {
                              const next = [...routes];
                              [next[index], next[index + 1]] = [
                                next[index + 1]!,
                                next[index]!,
                              ];
                              return next;
                            })
                          }
                        >
                          <ChevronDown className="size-3.5" />
                          <span className="sr-only">Decrease priority</span>
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          disabled={modelRoutes.length === 1}
                          onClick={() =>
                            setModelRoutes((routes) =>
                              routes.filter(
                                (candidate) => candidate.key !== route.key,
                              ),
                            )
                          }
                        >
                          <Trash2 className="size-3.5" />
                          <span className="sr-only">Remove route</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {saveModel.isError ? (
              <p className="text-sm text-destructive">
                {errorText(saveModel.error)}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={
                  !modelRoutes.length ||
                  !modelRoutes.some((route) => route.enabled) ||
                  modelRoutes.some((route) => !route.modelName.trim()) ||
                  saveModel.isPending
                }
              >
                {saveModel.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {editingModel ? "Save changes" : "Add model"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
