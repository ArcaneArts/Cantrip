import {
  runConfigurationAuthoringDocumentSchema,
  type RunConfigurationAuthoringDocument,
  type RunConfigurationPlatform,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  FileCode2,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getRunConfigurationAuthoring,
  updateRunConfiguration,
} from "@/lib/api";

const inputClassName =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const textareaClassName =
  "min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

function emptyDocument(): RunConfigurationAuthoringDocument {
  return {
    version: 1,
    name: "Project environment",
    setup: { default: null, win32: null, darwin: null, linux: null },
    actions: [],
  };
}

function cloneDocument(
  document: RunConfigurationAuthoringDocument,
): RunConfigurationAuthoringDocument {
  return {
    ...document,
    setup: { ...document.setup },
    actions: document.actions.map((action) => ({ ...action })),
  };
}

const platformOptions: Array<{
  label: string;
  value: RunConfigurationPlatform | null;
}> = [
  { value: null, label: "All platforms" },
  { value: "win32", label: "Windows" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
];

const setupFields: Array<{
  key: keyof RunConfigurationAuthoringDocument["setup"];
  label: string;
  description: string;
}> = [
  {
    key: "default",
    label: "Default setup",
    description: "Used when the target worker has no platform override.",
  },
  {
    key: "win32",
    label: "Windows setup",
    description: "PowerShell script selected on win32 workers.",
  },
  {
    key: "darwin",
    label: "macOS setup",
    description: "Shell script selected on darwin workers.",
  },
  {
    key: "linux",
    label: "Linux setup",
    description: "Shell script selected on Linux workers.",
  },
];

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The environment could not be saved.";
}

export function RunEnvironmentSettings({
  projectId,
  workerOnline,
}: {
  projectId: string;
  workerOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["run-configuration-authoring", projectId] as const;
  const authoring = useQuery({
    queryKey,
    queryFn: () => getRunConfigurationAuthoring(projectId),
    retry: false,
  });
  const [draft, setDraft] =
    useState<RunConfigurationAuthoringDocument>(emptyDocument);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);

  useEffect(() => {
    if (!authoring.data) return;
    setBaseRevision(authoring.data.revision);
    setDraft(cloneDocument(authoring.data.document ?? emptyDocument()));
    setReplaceExisting(false);
  }, [authoring.data]);

  const validation = useMemo(
    () => runConfigurationAuthoringDocumentSchema.safeParse(draft),
    [draft],
  );
  const save = useMutation({
    mutationFn: async () => {
      const document = runConfigurationAuthoringDocumentSchema.parse(draft);
      return updateRunConfiguration(projectId, {
        expectedRevision: baseRevision,
        document,
      });
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(queryKey, snapshot);
      setBaseRevision(snapshot.revision);
      setDraft(cloneDocument(snapshot.document ?? emptyDocument()));
      setReplaceExisting(false);
      void queryClient.invalidateQueries({
        queryKey: ["run-environment", projectId],
      });
    },
  });
  const snapshot = authoring.data;
  const unsafe = Boolean(snapshot?.editingError && !snapshot.revision);
  const replacementRequired = Boolean(
    snapshot?.revision && !snapshot.document && !replaceExisting,
  );
  const canEdit =
    Boolean(snapshot) && workerOnline && !unsafe && !replacementRequired;
  const diagnostics = [
    ...(snapshot?.inspection.diagnostics ?? []),
    ...(snapshot?.inspection.configurations.flatMap(
      (configuration) => configuration.diagnostics,
    ) ?? []),
  ];
  const operationError = authoring.error ?? save.error;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <section aria-labelledby="environment-file-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="environment-file-title" className="font-semibold">
                Environment configuration
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Edits the Codex-compatible file on this project worker. Cantrip
                does not change .gitignore, stage, commit, or push it.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={authoring.isFetching || save.isPending}
              onClick={() =>
                void authoring.refetch().then(({ data }) => {
                  if (!data) return;
                  setBaseRevision(data.revision);
                  setDraft(cloneDocument(data.document ?? emptyDocument()));
                  setReplaceExisting(false);
                })
              }
            >
              <RefreshCw
                className={`size-4 ${authoring.isFetching ? "animate-spin" : ""}`}
              />
              Reload
            </Button>
          </div>

          <div className="mt-4 grid gap-3 border-y px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileCode2 className="size-4 shrink-0" />
                <code className="truncate text-xs">
                  {snapshot?.relativePath ??
                    ".codex/environments/environment.toml"}
                </code>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {snapshot?.revision
                  ? `Revision ${snapshot.revision.slice(0, 12)}`
                  : "No canonical file exists yet."}
              </p>
            </div>
            <Badge variant="outline" className="w-fit capitalize">
              {snapshot?.sourceControlState ?? "loading"}
            </Badge>
          </div>
        </section>

        {!workerOnline ? (
          <div className="flex gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            The project worker is offline. Environment files remain worker-local
            and cannot be edited until it reconnects.
          </div>
        ) : null}
        {operationError ? (
          <div className="flex gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {errorText(operationError)}
          </div>
        ) : null}
        {snapshot?.editingError ? (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <div className="flex gap-2 text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{snapshot.editingError}</span>
            </div>
            {snapshot.revision && !snapshot.document && !replaceExisting ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(emptyDocument());
                  setReplaceExisting(true);
                }}
              >
                Replace with editable v1 template
              </Button>
            ) : null}
          </div>
        ) : null}

        {authoring.isLoading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading environment…
          </div>
        ) : (
          <>
            <section aria-labelledby="environment-name-title">
              <h2 id="environment-name-title" className="font-semibold">
                Environment
              </h2>
              <label className="mt-3 block space-y-1.5 text-sm">
                <span className="font-medium">Display name</span>
                <input
                  className={inputClassName}
                  disabled={!canEdit || save.isPending}
                  maxLength={200}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
            </section>

            <section aria-labelledby="environment-setup-title">
              <h2 id="environment-setup-title" className="font-semibold">
                Worktree setup
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Setup runs only when Cantrip prepares a new secondary worktree
                or when setup is explicitly retried.
              </p>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                {setupFields.map((field) => (
                  <label key={field.key} className="block space-y-1.5 text-sm">
                    <span className="font-medium">{field.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {field.description}
                    </span>
                    <textarea
                      className={textareaClassName}
                      disabled={!canEdit || save.isPending}
                      maxLength={100_000}
                      value={draft.setup[field.key] ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          setup: {
                            ...current.setup,
                            [field.key]: event.target.value || null,
                          },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </section>

            <section aria-labelledby="environment-actions-title">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 id="environment-actions-title" className="font-semibold">
                    Run actions{" "}
                    <span className="text-muted-foreground">
                      ({draft.actions.length})
                    </span>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Platform variants may share a name. The target worker picks
                    the matching action.
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={
                    !canEdit || save.isPending || draft.actions.length >= 200
                  }
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      actions: [
                        ...current.actions,
                        {
                          name: "Run",
                          icon: "run",
                          command: "",
                          platform: null,
                        },
                      ],
                    }))
                  }
                >
                  <Plus className="size-4" /> Add action
                </Button>
              </div>
              <div className="mt-3 divide-y border-y">
                {draft.actions.map((action, index) => (
                  <div key={index} className="space-y-3 px-3 py-4">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_auto] sm:items-end">
                      <label className="space-y-1.5 text-sm">
                        <span className="font-medium">Name</span>
                        <input
                          className={inputClassName}
                          disabled={!canEdit || save.isPending}
                          maxLength={200}
                          value={action.name}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              actions: current.actions.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, name: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="space-y-1.5 text-sm">
                        <span className="font-medium">Icon</span>
                        <input
                          className={inputClassName}
                          disabled={!canEdit || save.isPending}
                          maxLength={100}
                          value={action.icon}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              actions: current.actions.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, icon: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="space-y-1.5 text-sm">
                        <span className="font-medium">Platform</span>
                        <select
                          className={inputClassName}
                          disabled={!canEdit || save.isPending}
                          value={action.platform ?? ""}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              actions: current.actions.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      platform:
                                        (event.target
                                          .value as RunConfigurationPlatform) ||
                                        null,
                                    }
                                  : item,
                              ),
                            }))
                          }
                        >
                          {platformOptions.map((option) => (
                            <option
                              key={option.value ?? "all"}
                              value={option.value ?? ""}
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={!canEdit || save.isPending}
                        title={`Remove action ${index + 1}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            actions: current.actions.filter(
                              (_item, itemIndex) => itemIndex !== index,
                            ),
                          }))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <label className="block space-y-1.5 text-sm">
                      <span className="font-medium">Command</span>
                      <textarea
                        className={textareaClassName}
                        disabled={!canEdit || save.isPending}
                        maxLength={100_000}
                        value={action.command}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            actions: current.actions.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, command: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      />
                    </label>
                  </div>
                ))}
                {!draft.actions.length ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No saved actions. Add one or keep this environment
                    setup-only.
                  </div>
                ) : null}
              </div>
            </section>

            {diagnostics.length ? (
              <section aria-labelledby="environment-validation-title">
                <h2 id="environment-validation-title" className="font-semibold">
                  Current file validation
                </h2>
                <div className="mt-3 divide-y border-y">
                  {diagnostics.map((diagnostic, index) => (
                    <div
                      key={`${diagnostic.code}-${index}`}
                      className="px-3 py-2 text-sm"
                    >
                      <span className="font-medium capitalize">
                        {diagnostic.severity}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {diagnostic.message}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-3 backdrop-blur">
              <p className="text-xs text-muted-foreground">
                {validation.success
                  ? "Draft is valid v1 TOML data."
                  : (validation.error.issues[0]?.message ??
                    "Draft is invalid.")}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={save.isPending || !snapshot}
                  onClick={() => {
                    setDraft(
                      cloneDocument(snapshot?.document ?? emptyDocument()),
                    );
                    setReplaceExisting(false);
                  }}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  disabled={!canEdit || !validation.success || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  {snapshot?.revision
                    ? "Save environment"
                    : "Create environment"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
