import type {
  RunConfigurationRepositoryEntry,
  RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
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
import { saveRunConfiguration } from "@/lib/run-configuration-api";
import {
  createShellRunConfigurationDocument,
  parseShellRunConfigurationEditorDocument,
  shellRunConfigurationEffectiveCommand,
} from "@/lib/run-configuration-editor-model";

const fieldClassName = "grid gap-1.5 text-sm";
const labelClassName = "text-xs font-medium text-muted-foreground";
const textareaClassName =
  "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

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
  return entry?.status === "ready" && entry.document?.provider === "shell"
    ? entry.document
    : createShellRunConfigurationDocument();
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
  const [document, setDocument] = useState<RunConfigurationShellDocument>(() =>
    initialDocument(entry),
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

  const reload = () => {
    const next = initialDocument(entry);
    setDocument(next);
    setExpectedRevision(entry?.revision ?? null);
    setPlatformOverrides(JSON.stringify(next.platformOverrides, null, 2));
    setErrors([]);
    setConflictRevision(null);
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
    () => shellRunConfigurationEffectiveCommand(document),
    [document],
  );
  const save = useMutation({
    mutationFn: async (overwriteRevision?: string) => {
      const parsed = parseShellRunConfigurationEditorDocument(
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
  const patchDocument = (patch: Partial<RunConfigurationShellDocument>) =>
    setDocument((current) => ({ ...current, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-4">
        <DialogHeader>
          <DialogTitle>
            {entry ? "Edit Run configuration" : "New Run configuration"}
          </DialogTitle>
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
                <NativeSelect disabled value="shell">
                  <option value="shell">Shell</option>
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
                  onChange={(event) =>
                    patchDocument({
                      target:
                        event.target.value === "script"
                          ? { kind: "script", path: "", interpreter: null }
                          : { kind: "command", command: "" },
                    })
                  }
                >
                  <option value="command">Command</option>
                  <option value="script">Script file</option>
                </NativeSelect>
              </label>
            </div>
            {document.target.kind === "command" ? (
              <label className={fieldClassName}>
                <span className={labelClassName}>Run command</span>
                <Input
                  className="font-mono"
                  placeholder="pnpm dev"
                  value={document.target.command}
                  onChange={(event) =>
                    patchDocument({
                      target: { kind: "command", command: event.target.value },
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
                      patchDocument({
                        target: {
                          kind: "script",
                          path: event.target.value,
                          interpreter:
                            document.target.kind === "script"
                              ? document.target.interpreter
                              : null,
                        },
                      })
                    }
                  />
                </label>
                <label className={fieldClassName}>
                  <span className={labelClassName}>Interpreter (optional)</span>
                  <Input
                    className="font-mono"
                    placeholder="bash"
                    value={document.target.interpreter ?? ""}
                    onChange={(event) =>
                      patchDocument({
                        target: {
                          kind: "script",
                          path:
                            document.target.kind === "script"
                              ? document.target.path
                              : "",
                          interpreter: event.target.value || null,
                        },
                      })
                    }
                  />
                </label>
              </div>
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
                            ? {
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
                  {step.kind === "providerTask" ? (
                    <option disabled value="providerTask">
                      Provider task (unsupported)
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
                  <span className="flex items-center text-xs text-destructive">
                    Change this step to Command or remove it.
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
              <label className={fieldClassName}>
                <span className={labelClassName}>Shell</span>
                <NativeSelect
                  value={document.options.shell}
                  onChange={(event) =>
                    patchDocument({
                      options: {
                        ...document.options,
                        shell: event.target
                          .value as RunConfigurationShellDocument["options"]["shell"],
                      },
                    })
                  }
                >
                  {["automatic", "powershell", "cmd", "sh", "bash", "zsh"].map(
                    (shell) => (
                      <option key={shell} value={shell}>
                        {shell}
                      </option>
                    ),
                  )}
                </NativeSelect>
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  checked={document.options.login}
                  onChange={(event) =>
                    patchDocument({
                      options: {
                        ...document.options,
                        login: event.target.checked,
                      },
                    })
                  }
                  type="checkbox"
                />{" "}
                Login shell
              </label>
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
