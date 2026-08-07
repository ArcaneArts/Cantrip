import type {
  CodexDeviceLogin,
  ModelProfileSummary,
  ModelProviderKind,
  ModelProviderSummary,
  ReasoningEffort,
  ThemePreference,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Cpu,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Server,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
      className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
        <Server className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{provider.name}</p>
          <Badge variant="secondary">{provider.kind}</Badge>
          {provider.hasApiKey ? (
            <KeyRound className="size-3.5 text-muted-foreground" />
          ) : null}
        </div>
        {provider.kind === "chatgpt" ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
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
                <span className="inline-flex items-center gap-1 text-emerald-500">
                  <span className="size-1.5 rounded-full bg-current" /> Signed
                  in
                </span>
                <span>·</span>
                <span>{auth.data?.email ?? "ChatGPT account"}</span>
                <span>·</span>
                <span className="font-medium text-foreground">
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
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {provider.baseUrl}
          </p>
        )}
      </div>
      <Button size="icon" variant="ghost" onClick={onEdit}>
        <Pencil className="size-4" />
        <span className="sr-only">Edit {provider.name}</span>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={removing}
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
        <span className="sr-only">Delete {provider.name}</span>
      </Button>
    </div>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
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
  const [modelProviderId, setModelProviderId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    "",
  );
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
        providerId: modelProviderId,
        reasoningEffort: reasoningEffort || null,
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
    setModelProviderId(model?.providerId ?? firstProviderId);
    setReasoningEffort(model?.reasoningEffort ?? "");
    setModelDialogOpen(true);
  };

  const submitProvider = (event: FormEvent) => {
    event.preventDefault();
    saveProvider.mutate();
  };

  const submitModel = (event: FormEvent) => {
    event.preventDefault();
    if (modelProviderId) saveModel.mutate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
        <div className="mx-auto grid max-w-4xl gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>
                System follows the operating system and is the default.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2">
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
                    variant={
                      settings.data?.preferences.theme === theme
                        ? "default"
                        : "outline"
                    }
                    disabled={preferences.isPending}
                    onClick={() =>
                      preferences.mutate({
                        theme: theme as ThemePreference,
                      })
                    }
                  >
                    <Icon className="size-4" />
                    <span className="capitalize">{theme}</span>
                  </Button>
                ))}
              </div>
              <label className="mt-4 flex cursor-pointer items-center justify-between gap-4 rounded-lg bg-muted/35 px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium">
                    High Contrast
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Use pure black or white surfaces with restrained outlines.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={settings.data?.preferences.highContrast ?? false}
                  disabled={preferences.isPending}
                  onChange={(event) =>
                    preferences.mutate({ highContrast: event.target.checked })
                  }
                />
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
              <div className="grid gap-1.5">
                <CardTitle>Providers</CardTitle>
                <CardDescription>
                  Configure Ollama, compatible APIs, or isolated ChatGPT
                  accounts. Secrets stay on the server or worker.
                </CardDescription>
              </div>
              <Button
                size="icon"
                variant="outline"
                onClick={() => openProviderDialog(null)}
              >
                <Plus className="size-4" />
                <span className="sr-only">Add provider</span>
              </Button>
            </CardHeader>
            <CardContent className="grid gap-3">
              {(settings.data?.providers ?? []).map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  workerId={worker?.workerId ?? null}
                  removing={removeProvider.isPending}
                  onEdit={() => openProviderDialog(provider)}
                  onRemove={() => removeProvider.mutate(provider.id)}
                />
              ))}
              {removeProvider.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(removeProvider.error)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
              <div className="grid gap-1.5">
                <CardTitle>Models</CardTitle>
                <CardDescription>
                  Models target one provider and may set a reasoning effort.
                </CardDescription>
              </div>
              <Button
                size="icon"
                variant="outline"
                disabled={!settings.data?.providers.length}
                onClick={() => openModelDialog(null)}
              >
                <Plus className="size-4" />
                <span className="sr-only">Add model</span>
              </Button>
            </CardHeader>
            <CardContent className="grid gap-5">
              <Field label="Default model for the first message">
                <select
                  value={settings.data?.preferences.defaultModelId ?? ""}
                  onChange={(event) =>
                    preferences.mutate({ defaultModelId: event.target.value })
                  }
                  className={inputClass}
                  disabled={preferences.isPending}
                >
                  {(settings.data?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.providerName} / {model.name}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid gap-3">
                {(settings.data?.models ?? []).map((model) => (
                  <div
                    key={model.id}
                    data-high-contrast-row
                    className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                  >
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                      <Cpu className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {model.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {model.providerName}
                        {model.reasoningEffort
                          ? ` · ${model.reasoningEffort} reasoning`
                          : " · provider default reasoning"}
                      </p>
                    </div>
                    {settings.data?.preferences.defaultModelId === model.id ? (
                      <Badge variant="secondary">Default</Badge>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openModelDialog(model)}
                    >
                      <Pencil className="size-4" />
                      <span className="sr-only">Edit {model.name}</span>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={removeModel.isPending}
                      onClick={() => removeModel.mutate(model.id)}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete {model.name}</span>
                    </Button>
                  </div>
                ))}
              </div>
              {removeModel.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(removeModel.error)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <p className="pb-4 text-xs text-muted-foreground">
            The default initializes new chats. You can change a chat’s model at
            any time; the selected model applies to its next message.
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
        <DialogContent>
          <form onSubmit={submitModel} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>
                {editingModel ? "Edit model" : "Add model"}
              </DialogTitle>
              <DialogDescription>
                Choose the provider and optional reasoning effort for this
                model.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <Field label="Model name">
                <input
                  required
                  autoFocus
                  value={modelName}
                  onChange={(event) => setModelName(event.target.value)}
                  className={inputClass}
                  placeholder="gemma4:26b"
                />
              </Field>
              <Field label="Provider">
                <select
                  required
                  value={modelProviderId}
                  onChange={(event) => setModelProviderId(event.target.value)}
                  className={inputClass}
                >
                  {(settings.data?.providers ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reasoning effort">
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
                disabled={!modelProviderId || saveModel.isPending}
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
