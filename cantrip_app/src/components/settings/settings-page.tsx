import type {
  CodexDeviceLogin,
  ModelProfileSummary,
  ModelProviderKind,
  ModelProviderSummary,
  ModelRouteInput,
  ReasoningEffort,
  ThemePreference,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Route,
  Search,
  Server,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  deleteModelProfile,
  deleteModelProvider,
  getSettings,
  getCodexAuthStatus,
  getWorkers,
  logoutCodex,
  startCodexDeviceLogin,
  updateModelProfile,
  updateModelProvider,
  updateSettings,
} from "@/lib/api";

const reasoningOptions: Array<ReasoningEffort | ""> = [
  "",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
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
    reasoningEffort: null,
    enabled: true,
  };
}

function matchesSearch(query: string, ...values: Array<string | null>) {
  return values.some((value) => value?.toLowerCase().includes(query));
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
  const auth = useQuery({
    enabled: provider.kind === "chatgpt" && Boolean(workerId),
    queryFn: () => getCodexAuthStatus(workerId!, provider.id),
    queryKey: ["codex-auth", workerId, provider.id],
    refetchInterval: 10_000,
  });
  const signedIn = auth.data?.authenticated && auth.data.authMode === "chatgpt";
  const weeklyRemaining = auth.data?.weeklyUsage
    ? Math.max(0, 100 - auth.data.weeklyUsage.usedPercent)
    : null;

  return (
    <div
      data-high-contrast-row
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_auto_auto]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <p className="truncate text-sm font-medium">{provider.name}</p>
        <Badge className="sm:hidden" variant="secondary">
          {provider.kind}
        </Badge>
      </div>
      <div className="col-span-2 min-w-0 pl-6 sm:col-span-1 sm:pl-0">
        {provider.kind === "chatgpt" ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {!workerId ? (
              <span>Worker offline · sign-in status unavailable</span>
            ) : auth.isLoading ? (
              <span>Checking sign-in…</span>
            ) : auth.isError ? (
              <span className="text-destructive">
                Could not check sign-in status
              </span>
            ) : signedIn ? (
              <>
                <span className="inline-flex shrink-0 items-center gap-1 text-emerald-500">
                  <span className="size-1.5 rounded-full bg-current" /> Signed
                  in
                </span>
                <span className="truncate">
                  {auth.data?.email ?? "ChatGPT account"}
                </span>
                <span className="shrink-0 font-medium text-foreground">
                  {weeklyRemaining === null
                    ? "7-day usage unavailable"
                    : `${Math.round(weeklyRemaining)}% 7-day usage left`}
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-muted-foreground" />
                Not signed in
              </span>
            )}
          </p>
        ) : (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.baseUrl}
          </p>
        )}
      </div>
      <div className="hidden items-center justify-end gap-1 sm:flex">
        <Badge variant="secondary">{provider.kind}</Badge>
        {provider.hasApiKey ? (
          <KeyRound className="size-3.5 text-muted-foreground" />
        ) : null}
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto">
        <Button className="size-8" size="icon" variant="ghost" onClick={onEdit}>
          <Pencil className="size-3.5" />
          <span className="sr-only">Edit {provider.name}</span>
        </Button>
        <Button
          className="size-8"
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

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const [searchQuery, setSearchQuery] = useState("");
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
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelProfileSummary | null>(
    null,
  );
  const [modelName, setModelName] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    "",
  );
  const [modelRoutes, setModelRoutes] = useState<EditableRoute[]>([]);
  const chatGptProvider =
    editingProvider?.kind === "chatgpt" ? editingProvider : null;
  const codexAuth = useQuery({
    enabled: Boolean(worker && providerDialogOpen && chatGptProvider),
    queryFn: () => getCodexAuthStatus(worker!.workerId, chatGptProvider!.id),
    queryKey: ["codex-auth", worker?.workerId, chatGptProvider?.id],
    refetchInterval: 10_000,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  const preferences = useMutation({
    mutationFn: updateSettings,
    onSuccess: (value) => queryClient.setQueryData(["settings"], value),
  });
  const saveProvider = useMutation({
    mutationFn: async () => {
      const input = {
        name: providerName,
        kind: providerKind,
        baseUrl:
          providerKind === "chatgpt" ? "https://api.openai.com/v1" : baseUrl,
        ...(providerKind === "chatgpt"
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
      if (provider.kind === "chatgpt" && editingProvider?.kind !== "chatgpt") {
        setEditingProvider(provider);
        setProviderName(provider.name);
        setProviderKind(provider.kind);
        setBaseUrl(provider.baseUrl);
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
        reasoningEffort: reasoningEffort || null,
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
      startCodexDeviceLogin(worker!.workerId, chatGptProvider!.id),
    onSuccess: (login) => {
      setDeviceLogin(login);
      setDeviceLinkCopied(false);
    },
  });
  const signOutCodex = useMutation({
    mutationFn: () => logoutCodex(worker!.workerId, chatGptProvider!.id),
    onSuccess: async () => {
      setDeviceLogin(null);
      await codexAuth.refetch();
    },
  });

  useEffect(() => {
    if (codexAuth.data?.authMode !== "chatgpt") return;
    setDeviceLogin(null);
  }, [codexAuth.data?.authMode]);

  const openProviderDialog = (provider: ModelProviderSummary | null) => {
    saveProvider.reset();
    beginCodexLogin.reset();
    signOutCodex.reset();
    setEditingProvider(provider);
    setProviderName(provider?.name ?? "");
    setProviderKind(provider?.kind ?? "ollama");
    setBaseUrl(provider?.baseUrl ?? "http://127.0.0.1:11434/v1");
    setApiKey("");
    setRemoveApiKey(false);
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
    setReasoningEffort(model?.reasoningEffort ?? "");
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

  const search = searchQuery.trim().toLowerCase();
  const providers = settings.data?.providers ?? [];
  const models = settings.data?.models ?? [];
  const appearanceMatches =
    !search ||
    matchesSearch(
      search,
      "appearance theme system light dark high contrast operating system",
    );
  const providerSectionMatches =
    !search ||
    matchesSearch(
      search,
      "providers provider ollama api chatgpt account endpoint key",
    );
  const visibleProviders = providerSectionMatches
    ? providers
    : providers.filter((provider) =>
        matchesSearch(
          search,
          provider.name,
          provider.kind,
          provider.baseUrl,
          provider.hasApiKey ? "api key" : null,
        ),
      );
  const modelSectionMatches =
    !search ||
    matchesSearch(
      search,
      "models model default reasoning effort provider routes priority failover new chats",
    );
  const visibleModels = modelSectionMatches
    ? models
    : models.filter((model) =>
        matchesSearch(
          search,
          model.name,
          model.reasoningEffort,
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
  const hasSearchResults = appearanceMatches || providersMatch || modelsMatch;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto grid max-w-6xl gap-5">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              role="searchbox"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-9 w-full rounded-md border bg-background pl-9 pr-9 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              placeholder="Search settings, providers, and models"
              aria-label="Search settings"
            />
            {searchQuery ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0.5 top-0.5 size-8"
                onClick={() => setSearchQuery("")}
              >
                <X className="size-3.5" />
                <span className="sr-only">Clear search</span>
              </Button>
            ) : null}
          </div>

          {settings.isError ? (
            <p className="text-sm text-destructive">
              {errorText(settings.error)}
            </p>
          ) : null}

          {appearanceMatches ? (
            <section className="overflow-hidden rounded-lg border bg-card/30">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div>
                  <h2 className="text-sm font-semibold">Appearance</h2>
                  <p className="text-xs text-muted-foreground">
                    System follows the operating system.
                  </p>
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
                      checked={settings.data?.preferences.highContrast ?? false}
                      disabled={preferences.isPending}
                      onChange={(event) =>
                        preferences.mutate({
                          highContrast: event.target.checked,
                        })
                      }
                    />
                    High contrast
                  </label>
                </div>
              </div>
            </section>
          ) : null}

          {providersMatch ? (
            <section className="overflow-hidden rounded-lg border bg-card/30">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-semibold">Providers</h2>
                    <span className="text-xs text-muted-foreground">
                      {visibleProviders.length}
                      {search && visibleProviders.length !== providers.length
                        ? ` of ${providers.length}`
                        : ""}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Ollama, compatible APIs, and isolated ChatGPT accounts.
                  </p>
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
              <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_auto_72px] gap-3 bg-muted/35 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                <span>Provider</span>
                <span>Connection</span>
                <span>Type</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="[&>[data-high-contrast-row]:nth-child(even)]:bg-muted/20">
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
                    No providers match “{searchQuery.trim()}”.
                  </p>
                ) : null}
              </div>
              {removeProvider.isError ? (
                <p className="px-3 pb-3 text-sm text-destructive">
                  {errorText(removeProvider.error)}
                </p>
              ) : null}
            </section>
          ) : null}

          {modelsMatch ? (
            <section className="overflow-hidden rounded-lg border bg-card/30">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-semibold">Models</h2>
                    <span className="text-xs text-muted-foreground">
                      {visibleModels.length}
                      {search && visibleModels.length !== models.length
                        ? ` of ${models.length}`
                        : ""}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Logical models with ordered provider failover routes.
                  </p>
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

              <label className="flex flex-wrap items-center justify-between gap-2 bg-muted/15 px-3 py-2 text-xs">
                <span className="font-medium">Default for new chats</span>
                <select
                  value={settings.data?.preferences.defaultModelId ?? ""}
                  onChange={(event) =>
                    preferences.mutate({ defaultModelId: event.target.value })
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

              <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_72px] gap-3 bg-muted/35 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                <span>Model</span>
                <span>Routes</span>
                <span>Configuration</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="[&>[data-high-contrast-row]:nth-child(even)]:bg-muted/20">
                {visibleModels.map((model) => (
                  <div
                    key={model.id}
                    data-high-contrast-row
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_72px]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Cpu className="size-4 shrink-0 text-muted-foreground" />
                      <p className="truncate text-sm font-medium">
                        {model.name}
                      </p>
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
                        {model.routes.filter((route) => route.enabled).length}{" "}
                        enabled
                      </span>
                      {settings.data?.preferences.defaultModelId ===
                      model.id ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : null}
                    </div>
                    <div className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto">
                      <Button
                        className="size-8"
                        size="icon"
                        variant="ghost"
                        onClick={() => openModelDialog(model)}
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">Edit {model.name}</span>
                      </Button>
                      <Button
                        className="size-8"
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
                    No models match “{searchQuery.trim()}”.
                  </p>
                ) : null}
              </div>
              {removeModel.isError ? (
                <p className="px-3 pb-3 text-sm text-destructive">
                  {errorText(removeModel.error)}
                </p>
              ) : null}
            </section>
          ) : null}

          {!hasSearchResults ? (
            <div className="py-12 text-center">
              <Search className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No settings found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try a provider name, model name, theme, or setting.
              </p>
            </div>
          ) : null}

          <p className="pb-2 text-xs text-muted-foreground">
            The default initializes new chats. A chat’s selected model applies
            to its next message.
          </p>
        </div>
      </div>

      <Dialog open={providerDialogOpen} onOpenChange={setProviderDialogOpen}>
        <DialogContent>
          <form onSubmit={submitProvider} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>
                {editingProvider ? "Edit provider" : "Add provider"}
              </DialogTitle>
              <DialogDescription>
                Configure an API endpoint or a ChatGPT account used through
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
                  value={providerKind}
                  onChange={(event) => {
                    const kind = event.target.value as ModelProviderKind;
                    setProviderKind(kind);
                    if (!editingProvider) {
                      setBaseUrl(
                        kind === "chatgpt"
                          ? "https://api.openai.com/v1"
                          : kind === "ollama"
                            ? "http://127.0.0.1:11434/v1"
                            : "https://",
                      );
                    }
                  }}
                  className={inputClass}
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai-compatible">OpenAI compatible</option>
                  <option value="chatgpt">ChatGPT Account</option>
                </select>
              </Field>
              {providerKind !== "chatgpt" ? (
                <Field label="Base URL">
                  <div className="space-y-1.5">
                    <input
                      required
                      type="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      className={inputClass}
                      placeholder="https://openrouter.ai/api/v1"
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter the API root; Cantrip adds /responses. OpenRouter
                      uses https://openrouter.ai/api/v1.
                    </p>
                  </div>
                </Field>
              ) : (
                <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                  This provider keeps its own ChatGPT sign-in on the selected
                  worker.
                </div>
              )}
              {providerKind !== "chatgpt" ? (
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
            {providerKind !== "chatgpt" && editingProvider?.hasApiKey ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={removeApiKey}
                  onChange={(event) => setRemoveApiKey(event.target.checked)}
                />
                Remove the saved API key
              </label>
            ) : null}
            {providerKind === "chatgpt" ? (
              !chatGptProvider ? (
                <p className="rounded-lg border bg-muted/35 p-3 text-sm text-muted-foreground">
                  Add this provider to continue to ChatGPT device sign-in.
                </p>
              ) : !worker ? (
                <p className="rounded-lg border bg-muted/35 p-3 text-sm text-muted-foreground">
                  Connect a worker to manage this ChatGPT account.
                </p>
              ) : codexAuth.isLoading ? (
                <div className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Checking ChatGPT
                  authentication…
                </div>
              ) : codexAuth.data?.authMode === "chatgpt" ? (
                <div className="grid gap-3 rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        Signed in with ChatGPT
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {codexAuth.data.email ?? "ChatGPT account"}
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
                <div className="grid gap-3 rounded-lg border p-3">
                  <Button
                    type="button"
                    className="w-fit"
                    disabled={beginCodexLogin.isPending}
                    onClick={() => beginCodexLogin.mutate()}
                  >
                    {beginCodexLogin.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <KeyRound className="size-4" />
                    )}
                    Get sign-in code
                  </Button>
                  {deviceLogin ? (
                    <div className="grid gap-3 rounded-lg bg-muted/40 p-3 text-sm">
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
                          the OpenAI device page
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
                </div>
              )
            ) : null}
            {providerKind === "chatgpt" &&
            (codexAuth.isError ||
              beginCodexLogin.isError ||
              signOutCodex.isError) ? (
              <p className="text-sm text-destructive">
                {errorText(
                  codexAuth.error ??
                    beginCodexLogin.error ??
                    signOutCodex.error,
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
                Select this logical model in chat; Cantrip tries its enabled
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
              <Field label="Default reasoning effort">
                <select
                  value={reasoningEffort}
                  onChange={(event) =>
                    setReasoningEffort(
                      event.target.value as ReasoningEffort | "",
                    )
                  }
                  className={inputClass}
                >
                  {reasoningOptions.map((effort) => (
                    <option key={effort || "default"} value={effort}>
                      {effort || "Provider default"}
                    </option>
                  ))}
                </select>
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
                <div className="grid gap-2">
                  {modelRoutes.map((route, index) => (
                    <div
                      key={route.key}
                      className="grid gap-3 rounded-lg border bg-muted/15 p-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Route className="size-4 shrink-0 text-muted-foreground" />
                        <span className="text-xs font-semibold">
                          Priority {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {settings.data?.providers.find(
                            (provider) => provider.id === route.providerId,
                          )?.name ?? "Provider"}
                          {route.modelName ? ` · ${route.modelName}` : ""}
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label="Provider">
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
                                      }
                                    : candidate,
                                ),
                              )
                            }
                            className={inputClass}
                          >
                            {(settings.data?.providers ?? []).map(
                              (provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.name}
                                </option>
                              ),
                            )}
                          </select>
                        </Field>
                        <Field label="Provider model name">
                          <input
                            required
                            value={route.modelName}
                            onChange={(event) =>
                              setModelRoutes((routes) =>
                                routes.map((candidate) =>
                                  candidate.key === route.key
                                    ? {
                                        ...candidate,
                                        modelName: event.target.value,
                                      }
                                    : candidate,
                                ),
                              )
                            }
                            className={inputClass}
                            placeholder="openai/gpt-5.6-sol"
                          />
                        </Field>
                        <Field label="Reasoning override">
                          <select
                            value={route.reasoningEffort ?? ""}
                            onChange={(event) =>
                              setModelRoutes((routes) =>
                                routes.map((candidate) =>
                                  candidate.key === route.key
                                    ? {
                                        ...candidate,
                                        reasoningEffort:
                                          (event.target
                                            .value as ReasoningEffort) || null,
                                      }
                                    : candidate,
                                ),
                              )
                            }
                            className={inputClass}
                          >
                            {reasoningOptions.map((effort) => (
                              <option key={effort || "inherit"} value={effort}>
                                {effort || "Use model default"}
                              </option>
                            ))}
                          </select>
                        </Field>
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
