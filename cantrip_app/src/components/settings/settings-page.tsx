import type {
  ModelProviderKind,
  ReasoningEffort,
  ThemePreference,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Plus,
  Server,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

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
  createModelProfile,
  createModelProvider,
  deleteModelProfile,
  deleteModelProvider,
  getSettings,
  updateSettings,
} from "@/lib/api";
import { cn } from "@/lib/utils";

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

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
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
  const [providerName, setProviderName] = useState("");
  const [providerKind, setProviderKind] = useState<ModelProviderKind>("ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelProviderId, setModelProviderId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    "",
  );

  useEffect(() => {
    if (!modelProviderId && settings.data?.providers[0]) {
      setModelProviderId(settings.data.providers[0].id);
    }
  }, [modelProviderId, settings.data?.providers]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  const preferences = useMutation({
    mutationFn: updateSettings,
    onSuccess: (value) => queryClient.setQueryData(["settings"], value),
  });
  const addProvider = useMutation({
    mutationFn: createModelProvider,
    onSuccess: async () => {
      setProviderName("");
      setApiKey("");
      await refresh();
    },
  });
  const removeProvider = useMutation({
    mutationFn: deleteModelProvider,
    onSuccess: refresh,
  });
  const addModel = useMutation({
    mutationFn: createModelProfile,
    onSuccess: async () => {
      setModelName("");
      setReasoningEffort("");
      await refresh();
    },
  });
  const removeModel = useMutation({
    mutationFn: deleteModelProfile,
    onSuccess: refresh,
  });

  const submitProvider = (event: FormEvent) => {
    event.preventDefault();
    addProvider.mutate({
      name: providerName,
      kind: providerKind,
      baseUrl,
      apiKey: apiKey.trim() || null,
    });
  };

  const submitModel = (event: FormEvent) => {
    event.preventDefault();
    if (!modelProviderId) return;
    addModel.mutate({
      name: modelName,
      providerId: modelProviderId,
      reasoningEffort: reasoningEffort || null,
    });
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
              <CardTitle>Providers</CardTitle>
              <CardDescription>
                Providers define the Responses-compatible endpoint Codex uses.
                API keys stay in the server database and are never returned to
                the app.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
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
                      disabled={removeProvider.isPending}
                      onClick={() => removeProvider.mutate(provider.id)}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete {provider.name}</span>
                    </Button>
                  </div>
                ))}
              </div>

              <form
                onSubmit={submitProvider}
                className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-2"
              >
                <Field label="Provider name">
                  <input
                    required
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
                      setBaseUrl(
                        kind === "ollama"
                          ? "http://127.0.0.1:11434/v1"
                          : "https://",
                      );
                    }}
                    className={inputClass}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="openai-compatible">OpenAI compatible</option>
                  </select>
                </Field>
                <Field label="Base URL">
                  <input
                    required
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    className={inputClass}
                    placeholder="http://127.0.0.1:11434/v1"
                  />
                </Field>
                <Field label="API key (optional)">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    className={inputClass}
                    autoComplete="off"
                    placeholder="Not required for local Ollama"
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={addProvider.isPending}>
                    {addProvider.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Add provider
                  </Button>
                </div>
              </form>
              {addProvider.isError || removeProvider.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(addProvider.error ?? removeProvider.error)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Models</CardTitle>
              <CardDescription>
                A model targets one provider. Reasoning effort is optional
                because not every model supports it.
              </CardDescription>
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

              <div className="grid gap-2">
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
                      disabled={removeModel.isPending}
                      onClick={() => removeModel.mutate(model.id)}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete {model.name}</span>
                    </Button>
                  </div>
                ))}
              </div>

              <form
                onSubmit={submitModel}
                className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-3"
              >
                <Field label="Model name">
                  <input
                    required
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
                <div className="sm:col-span-3">
                  <Button
                    type="submit"
                    disabled={!modelProviderId || addModel.isPending}
                  >
                    {addModel.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Add model
                  </Button>
                </div>
              </form>
              {addModel.isError || removeModel.isError ? (
                <p className="text-sm text-destructive">
                  {errorText(addModel.error ?? removeModel.error)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <p className={cn("text-xs text-muted-foreground", "pb-4")}>
            Changing the default affects only chats that have not sent their
            first message. A chat locks its selected model on that first turn.
          </p>
        </div>
      </div>
    </div>
  );
}
