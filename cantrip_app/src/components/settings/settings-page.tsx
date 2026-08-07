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
  Cpu,
  ExternalLink,
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
  X,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

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

export function SettingsPage({ onClose }: { onClose(): void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const workers = useQuery({ queryFn: getWorkers, queryKey: ["workers"] });
  const worker = workers.data?.find((item) => item.online) ?? null;
  const codexAuth = useQuery({
    enabled: Boolean(worker),
    queryFn: () => getCodexAuthStatus(worker!.workerId),
    queryKey: ["codex-auth", worker?.workerId],
    refetchInterval: 2_000,
  });
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceLogin | null>(null);
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
    onSuccess: async () => {
      setProviderDialogOpen(false);
      await refresh();
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
    mutationFn: () => startCodexDeviceLogin(worker!.workerId),
    onSuccess: (login) => {
      setDeviceLogin(login);
      window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
    },
  });
  const signOutCodex = useMutation({
    mutationFn: () => logoutCodex(worker!.workerId),
    onSuccess: async () => {
      setDeviceLogin(null);
      await codexAuth.refetch();
    },
  });

  const openProviderDialog = (provider: ModelProviderSummary | null) => {
    saveProvider.reset();
    setEditingProvider(provider);
    setProviderName(provider?.name ?? "");
    setProviderKind(provider?.kind ?? "ollama");
    setBaseUrl(provider?.baseUrl ?? "http://127.0.0.1:11434/v1");
    setApiKey("");
    setRemoveApiKey(false);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-8">
        <div>
          <h1 className="font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved for this Cantrip account on the server.
          </p>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose}>
          <X className="size-4" />
          <span className="sr-only">Close settings</span>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-5 sm:p-8">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Codex account</CardTitle>
              <CardDescription>
                Sign in on the worker to use Codex through your eligible ChatGPT
                plan. Credentials stay in the worker’s Codex home.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {!worker ? (
                <p className="text-sm text-muted-foreground">
                  Connect a worker to manage its Codex account.
                </p>
              ) : codexAuth.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Checking Codex
                  authentication…
                </div>
              ) : codexAuth.data?.authMode === "chatgpt" ? (
                <div className="flex items-center gap-3 rounded-lg border p-3">
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
                    variant="outline"
                    disabled={signOutCodex.isPending}
                    onClick={() => signOutCodex.mutate()}
                  >
                    <LogOut className="size-4" /> Sign out
                  </Button>
                </div>
              ) : (
                <div className="grid gap-3">
                  <Button
                    className="w-fit"
                    disabled={beginCodexLogin.isPending}
                    onClick={() => beginCodexLogin.mutate()}
                  >
                    {beginCodexLogin.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ExternalLink className="size-4" />
                    )}
                    Sign in with ChatGPT
                  </Button>
                  {deviceLogin ? (
                    <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                      <p>
                        Enter code{" "}
                        <button
                          type="button"
                          className="font-mono font-semibold underline"
                          onClick={() =>
                            navigator.clipboard.writeText(deviceLogin.userCode)
                          }
                        >
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
                        . This page will update after authorization.
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
              {codexAuth.isError ||
              beginCodexLogin.isError ||
              signOutCodex.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(
                    codexAuth.error ??
                      beginCodexLogin.error ??
                      signOutCodex.error,
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="grid gap-1.5">
                <CardTitle>Providers</CardTitle>
                <CardDescription>
                  Responses-compatible endpoints used by Codex. API keys are
                  never returned to the app.
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
                <div
                  key={provider.id}
                  className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                    <Server className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {provider.name}
                      </p>
                      <Badge variant="secondary">{provider.kind}</Badge>
                      {provider.hasApiKey ? (
                        <KeyRound className="size-3.5 text-muted-foreground" />
                      ) : null}
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {provider.baseUrl}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => openProviderDialog(provider)}
                  >
                    <Pencil className="size-4" />
                    <span className="sr-only">Edit {provider.name}</span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={removeProvider.isPending}
                    onClick={() => removeProvider.mutate(provider.id)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Delete {provider.name}</span>
                  </Button>
                </div>
              ))}
              {removeProvider.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(removeProvider.error)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
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
            Changing the default affects only chats that have not sent their
            first message. A chat locks its selected model on that first turn.
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
                Configure the Responses-compatible endpoint used by this
                account.
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
                  <option value="chatgpt">ChatGPT plan</option>
                  <option value="ollama">Ollama</option>
                  <option value="openai-compatible">OpenAI compatible</option>
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
                  Uses the ChatGPT account signed in on the selected worker.
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
            {editingProvider?.hasApiKey ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={removeApiKey}
                  onChange={(event) => setRemoveApiKey(event.target.checked)}
                />
                Remove the saved API key
              </label>
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
