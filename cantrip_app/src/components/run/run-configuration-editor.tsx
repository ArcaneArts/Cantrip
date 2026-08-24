import type {
  RunConfigurationDetectionCandidate,
  RunConfigurationFile,
  RunConfigurationJavaDocument,
  RunConfigurationNodeDocument,
  RunConfigurationProviderCapability,
  RunConfigurationProviderKind,
  RunConfigurationRepositoryEntry,
  RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Coffee,
  Loader2,
  Package,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  detectRunConfigurations,
  getRunConfigurationCapabilities,
  saveRunConfiguration,
} from "@/lib/run-configuration-api";
import {
  createRunConfigurationDocument,
  createShellRunConfigurationDocument,
  parseRunConfigurationEditorDocument,
  runConfigurationEffectiveCommand,
} from "@/lib/run-configuration-editor-model";
import { cn } from "@/lib/utils";

const fieldClassName = "grid gap-1.5 text-sm";
const labelClassName = "text-xs font-medium text-muted-foreground";
const textareaClassName =
  "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

type RunConfigurationEditorPatch = {
  [Field in keyof RunConfigurationFile]?: RunConfigurationFile[Field];
};

function StringListEditor({
  addLabel,
  values,
  onChange,
}: {
  addLabel: string;
  values: string[];
  onChange(values: string[]): void;
}) {
  return (
    <div className="grid gap-2">
      {values.map((value, index) => (
        <div className="flex gap-2" key={index}>
          <Input
            aria-label={`${addLabel} ${index + 1}`}
            value={value}
            onChange={(event) =>
              onChange(
                values.map((item, itemIndex) =>
                  itemIndex === index ? event.target.value : item,
                ),
              )
            }
          />
          <Button
            aria-label={`Remove ${addLabel.toLocaleLowerCase()} ${index + 1}`}
            onClick={() =>
              onChange(values.filter((_, itemIndex) => itemIndex !== index))
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        className="w-fit"
        onClick={() => onChange([...values, ""])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {addLabel}
      </Button>
    </div>
  );
}

function EnvironmentRows({
  kind,
  rows,
  onChange,
}: {
  kind: "variable" | "secret";
  rows: Array<{ name: string; value: string; enabled: boolean }>;
  onChange(
    rows: Array<{ name: string; value: string; enabled: boolean }>,
  ): void;
}) {
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div
          className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2"
          key={index}
        >
          <input
            aria-label={`Enable ${kind} ${index + 1}`}
            checked={row.enabled}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, enabled: event.target.checked }
                    : item,
                ),
              )
            }
            type="checkbox"
          />
          <Input
            aria-label={`${kind} name ${index + 1}`}
            placeholder="NAME"
            value={row.name}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, name: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Input
            aria-label={`${kind} value ${index + 1}`}
            placeholder={kind === "secret" ? "vault/reference" : "Value"}
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Button
            aria-label={`Remove ${kind} ${index + 1}`}
            onClick={() =>
              onChange(rows.filter((_, itemIndex) => itemIndex !== index))
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        className="w-fit"
        onClick={() =>
          onChange([...rows, { name: "", value: "", enabled: true }])
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> Add {kind}
      </Button>
    </div>
  );
}

function initialDocument(entry: RunConfigurationRepositoryEntry | null) {
  return entry?.status === "ready" && entry.document
    ? entry.document
    : createShellRunConfigurationDocument();
}

function ProviderGlyph({
  provider,
}: {
  provider: RunConfigurationProviderKind;
}) {
  if (provider === "node") return <Package className="size-5" />;
  if (provider === "java") return <Coffee className="size-5" />;
  return <Terminal className="size-5" />;
}

function RunConfigurationCreationChooser({
  candidates,
  capabilities,
  diagnostics,
  error,
  loading,
  onCancel,
  onChooseCandidate,
  onChooseProvider,
}: {
  candidates: RunConfigurationDetectionCandidate[];
  capabilities: RunConfigurationProviderCapability[];
  diagnostics: string[];
  error: Error | null;
  loading: boolean;
  onCancel(): void;
  onChooseCandidate(candidate: RunConfigurationDetectionCandidate): void;
  onChooseProvider(provider: "java" | "node" | "shell"): void;
}) {
  const highConfidence = candidates.filter(
    ({ confidence }) => confidence === "high",
  );
  const recommendedId =
    highConfidence.length === 1 ? highConfidence[0]!.document.id : null;
  const available = capabilities.filter(
    (
      capability,
    ): capability is RunConfigurationProviderCapability & {
      provider: "java" | "node" | "shell";
    } =>
      capability.available &&
      (capability.provider === "java" ||
        capability.provider === "node" ||
        capability.provider === "shell"),
  );
  return (
    <DialogContent className="max-w-3xl gap-4">
      <DialogHeader>
        <DialogTitle>New Run configuration</DialogTitle>
        <DialogDescription>
          Review a statically detected project target or start with a typed
          blank configuration. Nothing is written until you save.
        </DialogDescription>
      </DialogHeader>
      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Detecting project targets…
        </div>
      ) : (
        <div className="grid gap-5">
          <section className="grid gap-3">
            <div>
              <h3 className="font-medium">Detected targets</h3>
              <p className="text-xs text-muted-foreground">
                Detection reads bounded project metadata and never executes
                project code.
              </p>
            </div>
            {candidates.length ? (
              <Command className="rounded-lg border">
                <CommandInput placeholder="Search detected targets…" />
                <CommandList className="max-h-72">
                  <CommandEmpty>No matching detected targets.</CommandEmpty>
                  <CommandGroup>
                    {candidates.map((candidate) => (
                      <CommandItem
                        className="grid gap-2 border-b p-3 last:border-b-0"
                        key={candidate.document.id}
                        onSelect={() => onChooseCandidate(candidate)}
                        value={`${candidate.document.name} ${candidate.provider} ${candidate.effectiveCommand} ${candidate.reason}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderGlyph provider={candidate.provider} />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {candidate.document.name}
                          </span>
                          {candidate.document.id === recommendedId ? (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                              Recommended
                            </span>
                          ) : (
                            <span className="text-[10px] uppercase text-muted-foreground">
                              {candidate.confidence}
                            </span>
                          )}
                        </div>
                        <code className="truncate text-xs">
                          {candidate.effectiveCommand}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {candidate.reason}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No typed project targets were detected. You can still create a
                blank Java, Node, or Shell configuration.
              </div>
            )}
          </section>
          <section className="grid gap-3">
            <h3 className="font-medium">Configuration type</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((capability) => (
                <button
                  className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-ring hover:bg-muted/40"
                  key={capability.provider}
                  onClick={() => onChooseProvider(capability.provider)}
                  type="button"
                >
                  <ProviderGlyph provider={capability.provider} />
                  <span>
                    <span className="block font-medium">
                      {capability.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {capability.provider === "shell"
                        ? "Blank command or script"
                        : capability.provider === "node"
                          ? "Package script or Node entrypoint"
                          : "Gradle or Maven application"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          {diagnostics.length ? (
            <InlineAlert tone="warning" title="Detection notes">
              {diagnostics.join(" ")}
            </InlineAlert>
          ) : null}
          {error ? <InlineAlert error={error} tone="error" /> : null}
        </div>
      )}
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function JavaTargetEditor({
  document,
  onChange,
}: {
  document: RunConfigurationJavaDocument;
  onChange(document: RunConfigurationJavaDocument): void;
}) {
  const target = document.target;
  const gradle =
    target.kind === "gradleTask" || target.kind === "gradleMainClass";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldClassName}>
        <span className={labelClassName}>
          {gradle ? "Gradle project" : "Maven module (optional)"}
        </span>
        <Input
          className="font-mono"
          placeholder={gradle ? ":app" : ":api or services/api"}
          value={gradle ? target.projectPath : (target.module ?? "")}
          onChange={(event) =>
            onChange({
              ...document,
              target: gradle
                ? { ...target, projectPath: event.target.value }
                : { ...target, module: event.target.value || null },
            } as RunConfigurationJavaDocument)
          }
        />
      </label>
      <label className={fieldClassName}>
        <span className={labelClassName}>
          {target.kind === "gradleTask"
            ? "Gradle task"
            : target.kind === "mavenGoal"
              ? "Maven goal"
              : "Main class"}
        </span>
        <Input
          className="font-mono"
          placeholder={
            target.kind === "gradleTask"
              ? "run"
              : target.kind === "mavenGoal"
                ? "spring-boot:run"
                : "com.example.Application"
          }
          value={
            target.kind === "gradleTask"
              ? target.task
              : target.kind === "mavenGoal"
                ? target.goal
                : target.className
          }
          onChange={(event) =>
            onChange({
              ...document,
              target:
                target.kind === "gradleTask"
                  ? { ...target, task: event.target.value }
                  : target.kind === "mavenGoal"
                    ? { ...target, goal: event.target.value }
                    : { ...target, className: event.target.value },
            })
          }
        />
      </label>
    </div>
  );
}

export function RunConfigurationEditor({
  creating,
  entry,
  open,
  projectId,
  onOpenChange,
  onSaved,
}: {
  creating: boolean;
  entry: RunConfigurationRepositoryEntry | null;
  open: boolean;
  projectId: string;
  onOpenChange(open: boolean): void;
  onSaved(entry: RunConfigurationRepositoryEntry): void;
}) {
  const [document, setDocument] = useState<RunConfigurationFile>(() =>
    initialDocument(entry),
  );
  const [stage, setStage] = useState<"choose" | "edit">(
    creating ? "choose" : "edit",
  );
  const [expectedRevision, setExpectedRevision] = useState<string | null>(
    entry?.revision ?? null,
  );
  const [platformOverrides, setPlatformOverrides] = useState(() =>
    JSON.stringify(initialDocument(entry).platformOverrides, null, 2),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);
  const editingRevision = entry?.revision ?? null;
  const detection = useQuery({
    enabled: open && creating && stage === "choose",
    queryKey: ["run-configuration-detection", projectId],
    queryFn: () => detectRunConfigurations(projectId),
    staleTime: 5_000,
  });
  const capabilities = useQuery({
    enabled: open && creating && stage === "choose",
    queryKey: ["run-configuration-capabilities", projectId],
    queryFn: () => getRunConfigurationCapabilities(projectId),
    staleTime: 30_000,
  });

  const reload = () => {
    const next = initialDocument(entry);
    setDocument(next);
    setExpectedRevision(entry?.revision ?? null);
    setPlatformOverrides(JSON.stringify(next.platformOverrides, null, 2));
    setErrors([]);
    setConflictRevision(null);
    setStage(creating ? "choose" : "edit");
  };

  useEffect(() => {
    if (open) reload();
    // A newly opened dialog intentionally snapshots the latest prop revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const externallyDeleted = open && !creating && entry === null;
  const externallyChanged =
    !externallyDeleted &&
    open &&
    expectedRevision !== null &&
    editingRevision !== expectedRevision;
  const effective = useMemo(
    () => runConfigurationEffectiveCommand(document),
    [document],
  );
  const save = useMutation({
    mutationFn: async (overwriteRevision?: string) => {
      const parsed = parseRunConfigurationEditorDocument(
        document,
        platformOverrides,
      );
      if (!parsed.success) {
        setErrors(parsed.errors);
        return null;
      }
      setErrors([]);
      return saveRunConfiguration(projectId, {
        expectedRevision: overwriteRevision ?? expectedRevision,
        document: parsed.document,
      });
    },
    onSuccess: (result) => {
      if (!result) return;
      if ("entry" in result) {
        onSaved(result.entry);
        onOpenChange(false);
        return;
      }
      if (result.outcome === "revision-mismatch") {
        setConflictRevision(result.currentRevision);
        setErrors([
          "This configuration changed outside the editor. Reload it or explicitly overwrite the latest revision.",
        ]);
      } else if (result.outcome === "name-conflict") {
        setErrors(["Another Run configuration already uses this name."]);
      } else if (result.outcome === "already-exists") {
        setErrors([
          "A configuration with this ID already exists. Close and create it again.",
        ]);
      } else {
        setErrors([
          "This Run configuration no longer exists. Reload the inventory.",
        ]);
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined);
  };
  const patchDocument = (patch: RunConfigurationEditorPatch) =>
    setDocument(
      (current) => ({ ...current, ...patch }) as RunConfigurationFile,
    );
  const chooseDocument = (next: RunConfigurationFile) => {
    setDocument(next);
    setExpectedRevision(null);
    setPlatformOverrides(JSON.stringify(next.platformOverrides, null, 2));
    setErrors([]);
    setConflictRevision(null);
    setStage("edit");
  };

  if (creating && stage === "choose") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <RunConfigurationCreationChooser
          candidates={detection.data?.candidates ?? []}
          capabilities={capabilities.data ?? []}
          diagnostics={
            detection.data?.diagnostics.map(({ message }) => message) ?? []
          }
          error={detection.error ?? capabilities.error ?? null}
          loading={detection.isLoading || capabilities.isLoading}
          onCancel={() => onOpenChange(false)}
          onChooseCandidate={(candidate) =>
            chooseDocument({
              ...candidate.document,
              id: crypto.randomUUID(),
            } as RunConfigurationFile)
          }
          onChooseProvider={(provider) =>
            chooseDocument(createRunConfigurationDocument(provider))
          }
        />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-4">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {creating ? (
              <Button
                aria-label="Choose another Run configuration type"
                onClick={() => setStage("choose")}
                size="icon"
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : null}
            <DialogTitle>
              {entry ? "Edit Run configuration" : "New Run configuration"}
            </DialogTitle>
          </div>
          <DialogDescription>
            Shared as{" "}
            <code>.cantrip/run-configurations/{document.id}.json</code>.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          {externallyDeleted ? (
            <InlineAlert tone="error" title="The shared file was deleted">
              Close this editor and create a new Run configuration if you want
              to replace it. Saving this stale draft is disabled.
            </InlineAlert>
          ) : externallyChanged ? (
            <InlineAlert tone="warning" title="The shared file changed">
              Reload to use revision {editingRevision?.slice(0, 8)}, or keep
              editing and resolve the conflict when you save.
              <Button
                className="ml-3"
                onClick={reload}
                size="sm"
                type="button"
                variant="outline"
              >
                Reload
              </Button>
            </InlineAlert>
          ) : null}
          <section className="grid gap-3 rounded-lg border p-4">
            <h3 className="font-medium">Configuration</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldClassName}>
                <span className={labelClassName}>Name</span>
                <Input
                  autoFocus
                  value={document.name}
                  onChange={(event) =>
                    patchDocument({ name: event.target.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Provider</span>
                <NativeSelect disabled value={document.provider}>
                  <option value="shell">Shell</option>
                  <option value="node">Node / package</option>
                  <option value="java">Java</option>
                </NativeSelect>
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Start directory</span>
                <Input
                  placeholder="."
                  value={document.workingDirectory}
                  onChange={(event) =>
                    patchDocument({ workingDirectory: event.target.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Target type</span>
                <NativeSelect
                  value={document.target.kind}
                  onChange={(event) => {
                    const kind = event.target.value;
                    patchDocument({
                      target:
                        document.provider === "shell"
                          ? kind === "script"
                            ? { kind: "script", path: "", interpreter: null }
                            : { kind: "command", command: "" }
                          : document.provider === "node"
                            ? kind === "entry"
                              ? { kind: "entry", path: "" }
                              : { kind: "packageScript", script: "start" }
                            : kind === "gradleMainClass"
                              ? {
                                  kind: "gradleMainClass",
                                  projectPath: ":",
                                  className: "",
                                }
                              : kind === "mavenGoal"
                                ? {
                                    kind: "mavenGoal",
                                    module: null,
                                    goal: "spring-boot:run",
                                  }
                                : kind === "mavenMainClass"
                                  ? {
                                      kind: "mavenMainClass",
                                      module: null,
                                      className: "",
                                    }
                                  : {
                                      kind: "gradleTask",
                                      projectPath: ":",
                                      task: "run",
                                    },
                    });
                  }}
                >
                  {document.provider === "shell" ? (
                    <>
                      <option value="command">Command</option>
                      <option value="script">Script file</option>
                    </>
                  ) : document.provider === "node" ? (
                    <>
                      <option value="packageScript">Package script</option>
                      <option value="entry">Node entrypoint</option>
                    </>
                  ) : (
                    <>
                      <option value="gradleTask">Gradle task</option>
                      <option value="gradleMainClass">Gradle main class</option>
                      <option value="mavenGoal">Maven goal</option>
                      <option value="mavenMainClass">Maven main class</option>
                    </>
                  )}
                </NativeSelect>
              </label>
            </div>
            {document.provider === "shell" ? (
              document.target.kind === "command" ? (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Run command</span>
                  <Input
                    className="font-mono"
                    placeholder="pnpm dev"
                    value={document.target.command}
                    onChange={(event) =>
                      patchDocument({
                        target: {
                          kind: "command",
                          command: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Script path</span>
                    <Input
                      className="font-mono"
                      placeholder="tool/run.sh"
                      value={document.target.path}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell" &&
                          current.target.kind === "script"
                            ? {
                                ...current,
                                target: {
                                  ...current.target,
                                  path: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>
                      Interpreter (optional)
                    </span>
                    <Input
                      className="font-mono"
                      placeholder="bash"
                      value={document.target.interpreter ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell" &&
                          current.target.kind === "script"
                            ? {
                                ...current,
                                target: {
                                  ...current.target,
                                  interpreter: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                </div>
              )
            ) : document.provider === "node" ? (
              document.target.kind === "packageScript" ? (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Package script</span>
                  <Input
                    className="font-mono"
                    placeholder="start"
                    value={document.target.script}
                    onChange={(event) =>
                      setDocument((current) =>
                        current.provider === "node" &&
                        current.target.kind === "packageScript"
                          ? {
                              ...current,
                              target: {
                                kind: "packageScript",
                                script: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
              ) : (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Entrypoint path</span>
                  <Input
                    className="font-mono"
                    placeholder="src/index.js"
                    value={document.target.path}
                    onChange={(event) =>
                      setDocument((current) =>
                        current.provider === "node" &&
                        current.target.kind === "entry"
                          ? {
                              ...current,
                              target: {
                                kind: "entry",
                                path: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
              )
            ) : (
              <JavaTargetEditor document={document} onChange={setDocument} />
            )}
            <label className={fieldClassName}>
              <span className={labelClassName}>
                Command override (optional)
              </span>
              <Input
                className="font-mono"
                placeholder="Replace the provider command"
                value={document.commandOverride ?? ""}
                onChange={(event) =>
                  patchDocument({ commandOverride: event.target.value || null })
                }
              />
            </label>
            <div className="grid gap-1 rounded-md border bg-muted/30 p-3">
              <span className={labelClassName}>
                Effective command
                {effective.overridden ? " · override active" : ""}
              </span>
              <code className="break-all text-sm">
                {effective.command ||
                  "Complete the target to preview the command"}
              </code>
            </div>
          </section>

          <section className="grid gap-3 rounded-lg border p-4">
            <h3 className="font-medium">Arguments</h3>
            <StringListEditor
              addLabel="Add argument"
              values={document.arguments}
              onChange={(arguments_) =>
                patchDocument({ arguments: arguments_ })
              }
            />
          </section>

          <section className="grid gap-4 rounded-lg border p-4">
            <div>
              <h3 className="font-medium">Environment</h3>
              <p className="text-xs text-muted-foreground">
                Values are read fresh for every launch.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={document.environment.includeCodexEnvironment}
                onChange={(event) =>
                  patchDocument({
                    environment: {
                      ...document.environment,
                      includeCodexEnvironment: event.target.checked,
                    },
                  })
                }
                type="checkbox"
              />
              Inject the current Codex environment when this runs
            </label>
            <div className="grid gap-2">
              <span className={labelClassName}>Environment files</span>
              <StringListEditor
                addLabel="Add environment file"
                values={document.environment.files}
                onChange={(files) =>
                  patchDocument({
                    environment: { ...document.environment, files },
                  })
                }
              />
            </div>
            <div className="grid gap-2">
              <span className={labelClassName}>Variables</span>
              <EnvironmentRows
                kind="variable"
                rows={document.environment.variables}
                onChange={(rows) =>
                  patchDocument({
                    environment: { ...document.environment, variables: rows },
                  })
                }
              />
            </div>
            <div className="grid gap-2">
              <span className={labelClassName}>Secret references</span>
              <EnvironmentRows
                kind="secret"
                rows={document.environment.secrets.map(
                  ({ name, secret, enabled }) => ({
                    name,
                    value: secret,
                    enabled,
                  }),
                )}
                onChange={(rows) =>
                  patchDocument({
                    environment: {
                      ...document.environment,
                      secrets: rows.map(({ name, value, enabled }) => ({
                        name,
                        secret: value,
                        enabled,
                      })),
                    },
                  })
                }
              />
            </div>
          </section>

          <section className="grid gap-3 rounded-lg border p-4">
            <div>
              <h3 className="font-medium">Before launch</h3>
              <p className="text-xs text-muted-foreground">
                Steps run in order before the main process.
              </p>
            </div>
            {document.beforeLaunch.map((step, index) => (
              <div
                className="grid grid-cols-[8rem_1fr_1fr_auto] gap-2"
                key={index}
              >
                <NativeSelect
                  value={step.kind}
                  onChange={(event) =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.map(
                        (item, itemIndex) =>
                          itemIndex === index
                            ? event.target.value === "providerTask" &&
                              document.provider !== "shell"
                              ? { kind: "providerTask", task: "build" }
                              : {
                                  kind: "command",
                                  command: "",
                                  workingDirectory: ".",
                                }
                            : item,
                      ),
                    })
                  }
                >
                  <option value="command">Command</option>
                  {document.provider !== "shell" ||
                  step.kind === "providerTask" ? (
                    <option
                      disabled={document.provider === "shell"}
                      value="providerTask"
                    >
                      Provider task
                      {document.provider === "shell" ? " (unsupported)" : ""}
                    </option>
                  ) : null}
                </NativeSelect>
                <Input
                  value={step.kind === "command" ? step.command : step.task}
                  placeholder={
                    step.kind === "command" ? "Command" : "Task name"
                  }
                  onChange={(event) =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.map(
                        (item, itemIndex) =>
                          itemIndex === index
                            ? item.kind === "command"
                              ? { ...item, command: event.target.value }
                              : { ...item, task: event.target.value }
                            : item,
                      ),
                    })
                  }
                />
                {step.kind === "command" ? (
                  <Input
                    value={step.workingDirectory}
                    placeholder="Working directory"
                    onChange={(event) =>
                      patchDocument({
                        beforeLaunch: document.beforeLaunch.map(
                          (item, itemIndex) =>
                            itemIndex === index && item.kind === "command"
                              ? {
                                  ...item,
                                  workingDirectory: event.target.value,
                                }
                              : item,
                        ),
                      })
                    }
                  />
                ) : (
                  <span
                    className={cn(
                      "flex items-center text-xs",
                      document.provider !== "shell"
                        ? "text-muted-foreground"
                        : "text-destructive",
                    )}
                  >
                    {document.provider === "node"
                      ? "Runs a package script in the start directory."
                      : document.provider === "java"
                        ? "Runs a Gradle task or Maven goal in the selected module."
                        : "Change this step to Command or remove it."}
                  </span>
                )}
                <Button
                  aria-label={`Remove before-launch step ${index + 1}`}
                  onClick={() =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              className="w-fit"
              onClick={() =>
                patchDocument({
                  beforeLaunch: [
                    ...document.beforeLaunch,
                    { kind: "command", command: "", workingDirectory: "." },
                  ],
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" /> Add step
            </Button>
          </section>

          <section className="grid gap-3 rounded-lg border p-4">
            <h3 className="font-medium">Execution options</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {document.provider === "shell" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Shell</span>
                    <NativeSelect
                      value={document.options.shell}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  shell: event.target
                                    .value as RunConfigurationShellDocument["options"]["shell"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      {[
                        "automatic",
                        "powershell",
                        "cmd",
                        "sh",
                        "bash",
                        "zsh",
                      ].map((shell) => (
                        <option key={shell} value={shell}>
                          {shell}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.login}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  login: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Login shell
                  </label>
                </>
              ) : document.provider === "node" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Package manager</span>
                    <NativeSelect
                      value={document.options.packageManager}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "node"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  packageManager: event.target
                                    .value as RunConfigurationNodeDocument["options"]["packageManager"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      {[
                        ["npm", "npm"],
                        ["pnpm", "pnpm"],
                        ["yarn", "Yarn"],
                        ["bun", "Bun"],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Runtime</span>
                    <NativeSelect
                      value={document.options.runtime}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "node"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  runtime: event.target
                                    .value as RunConfigurationNodeDocument["options"]["runtime"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <option value="node">Node.js</option>
                      <option value="bun">Bun</option>
                    </NativeSelect>
                  </label>
                </>
              ) : (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>JDK home (optional)</span>
                    <Input
                      className="font-mono"
                      placeholder="Use worker JAVA_HOME"
                      value={document.options.jdkHome ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "java"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  jdkHome: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.useWrapper}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "java"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  useWrapper: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Use project wrapper
                  </label>
                </>
              )}
              <label className={fieldClassName}>
                <span className={labelClassName}>
                  Stop grace (milliseconds)
                </span>
                <Input
                  min={0}
                  max={60000}
                  type="number"
                  value={document.stop.gracePeriodMs}
                  onChange={(event) =>
                    patchDocument({
                      stop: { gracePeriodMs: Number(event.target.value) },
                    })
                  }
                />
              </label>
            </div>
            {document.provider === "node" ? (
              <div className="grid gap-2">
                <span className={labelClassName}>Runtime arguments</span>
                <StringListEditor
                  addLabel="Add runtime argument"
                  values={document.options.runtimeArguments}
                  onChange={(runtimeArguments) =>
                    setDocument((current) =>
                      current.provider === "node"
                        ? {
                            ...current,
                            options: { ...current.options, runtimeArguments },
                          }
                        : current,
                    )
                  }
                />
              </div>
            ) : null}
            {document.provider === "java" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <span className={labelClassName}>Build-tool arguments</span>
                  <StringListEditor
                    addLabel="Add build-tool argument"
                    values={document.options.buildToolArguments}
                    onChange={(buildToolArguments) =>
                      setDocument((current) =>
                        current.provider === "java"
                          ? {
                              ...current,
                              options: {
                                ...current.options,
                                buildToolArguments,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <span className={labelClassName}>Java VM arguments</span>
                  <StringListEditor
                    addLabel="Add VM argument"
                    values={document.options.vmArguments}
                    onChange={(vmArguments) =>
                      setDocument((current) =>
                        current.provider === "java"
                          ? {
                              ...current,
                              options: { ...current.options, vmArguments },
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>
            ) : null}
            <label className={fieldClassName}>
              <span className={labelClassName}>
                Platform overrides (advanced JSON)
              </span>
              <textarea
                className={textareaClassName}
                value={platformOverrides}
                onChange={(event) => setPlatformOverrides(event.target.value)}
              />
            </label>
          </section>

          {errors.length ? (
            <InlineAlert tone="error" title="Could not save">
              <ul className="list-disc pl-4">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : null}
          {save.error ? <InlineAlert error={save.error} tone="error" /> : null}
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            {conflictRevision ? (
              <Button
                disabled={externallyDeleted}
                onClick={() => save.mutate(conflictRevision)}
                pending={save.isPending}
                type="button"
                variant="destructive"
              >
                Overwrite latest revision
              </Button>
            ) : null}
            <Button
              disabled={externallyDeleted}
              pending={save.isPending}
              pendingLabel="Saving…"
              type="submit"
            >
              Save configuration
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
