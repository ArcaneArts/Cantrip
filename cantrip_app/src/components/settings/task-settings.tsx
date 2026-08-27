import {
  TASK_WORKER_CONCURRENCY_MAX,
  taskWorkerCreateSchema,
  type TaskWorkerSummary,
} from "@cantrip/protocol/task-scheduling";
import type {
  ModelConfiguration,
  ModelProfileSummary,
  ReasoningEffort,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  ListTodo,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { ModelCombobox } from "@/components/chat/model-combobox";
import { modelsShareProvider } from "@/components/chat/model-reasoning-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { NativeSelect } from "@/components/ui/native-select";
import {
  createTaskWorker,
  deleteTaskWorker,
  getSettings,
  getTaskWorkers,
  reorderTaskWorkers,
  updateTaskWorker,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

const inputClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";
const commonReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

interface TaskWorkerDraft {
  allowsPlanGoal: boolean;
  continuityFamilyOverride: string;
  enabled: boolean;
  maxConcurrency: string;
  modelConfiguration: ModelConfiguration;
  name: string;
}

function emptyModelConfiguration(modelId: string | null): ModelConfiguration {
  return {
    modelId,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
}

function newTaskWorkerDraft(modelId: string | null): TaskWorkerDraft {
  return {
    name: "",
    enabled: true,
    modelConfiguration: emptyModelConfiguration(modelId),
    maxConcurrency: "1",
    allowsPlanGoal: false,
    continuityFamilyOverride: "",
  };
}

function taskWorkerDraft(worker: TaskWorkerSummary): TaskWorkerDraft {
  return {
    name: worker.name,
    enabled: worker.enabled,
    modelConfiguration: worker.modelConfiguration,
    maxConcurrency: String(worker.maxConcurrency),
    allowsPlanGoal: worker.allowsPlanGoal,
    continuityFamilyOverride: worker.continuityFamilyOverride ?? "",
  };
}

function reasoningOptions(selected: ReasoningEffort | null): string[] {
  return selected &&
    !commonReasoningEfforts.some((effort) => effort === selected)
    ? [...commonReasoningEfforts, selected]
    : [...commonReasoningEfforts];
}

function modelName(models: ModelProfileSummary[], modelId: string | null) {
  return models.find(({ id }) => id === modelId)?.name ?? "Model unavailable";
}

export function taskWorkerCapabilityLabel(worker: TaskWorkerSummary): string {
  return worker.allowsPlanGoal ? "Direct + Plan + Goal" : "Direct only";
}

export function TaskSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const taskWorkers = useQuery({
    queryFn: getTaskWorkers,
    queryKey: ["task-workers"],
  });
  const models = settings.data?.models ?? [];
  const [editing, setEditing] = useState<TaskWorkerSummary | "new" | null>(
    null,
  );
  const [draft, setDraft] = useState<TaskWorkerDraft>(() =>
    newTaskWorkerDraft(null),
  );
  const [draftError, setDraftError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TaskWorkerSummary | null>(null);

  const refreshTaskWorkers = () =>
    queryClient.invalidateQueries({ queryKey: ["task-workers"] });
  const createWorker = useMutation({
    mutationFn: createTaskWorker,
    onSuccess: async () => {
      setEditing(null);
      await refreshTaskWorkers();
    },
  });
  const updateWorker = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Parameters<typeof updateTaskWorker>[1];
    }) => updateTaskWorker(id, input),
    onSuccess: async () => {
      setEditing(null);
      await refreshTaskWorkers();
    },
  });
  const removeWorker = useMutation({
    mutationFn: (worker: TaskWorkerSummary) =>
      deleteTaskWorker(worker.id, worker.rowVersion),
    onSuccess: async () => {
      setRemoving(null);
      await refreshTaskWorkers();
    },
  });
  const reorderWorkers = useMutation({
    mutationFn: (ids: string[]) => reorderTaskWorkers({ ids }),
    onSuccess: (workers) => queryClient.setQueryData(["task-workers"], workers),
  });

  const openCreate = () => {
    const defaultModelId =
      settings.data?.preferences.defaultModelId ?? models[0]?.id ?? null;
    setDraft(newTaskWorkerDraft(defaultModelId));
    setDraftError(null);
    createWorker.reset();
    updateWorker.reset();
    setEditing("new");
  };

  const openEdit = (worker: TaskWorkerSummary) => {
    setDraft(taskWorkerDraft(worker));
    setDraftError(null);
    createWorker.reset();
    updateWorker.reset();
    setEditing(worker);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const maxConcurrency = Number(draft.maxConcurrency);
    const input = taskWorkerCreateSchema.safeParse({
      name: draft.name,
      enabled: draft.enabled,
      modelConfiguration: draft.modelConfiguration,
      maxConcurrency,
      allowsPlanGoal: draft.allowsPlanGoal,
      continuityFamilyOverride: draft.continuityFamilyOverride.trim() || null,
    });
    if (!input.success) {
      setDraftError(
        input.error.issues[0]?.message ?? "Check the Task Worker settings.",
      );
      return;
    }
    setDraftError(null);
    if (editing === "new") {
      createWorker.mutate(input.data);
    } else if (editing) {
      updateWorker.mutate({
        id: editing.id,
        input: { ...input.data, rowVersion: editing.rowVersion },
      });
    }
  };

  const moveWorker = (index: number, direction: -1 | 1) => {
    const workers = taskWorkers.data ?? [];
    const destination = index + direction;
    if (!workers[index] || !workers[destination]) return;
    const ids = workers.map(({ id }) => id);
    [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
    reorderWorkers.mutate(ids);
  };

  const saving = createWorker.isPending || updateWorker.isPending;
  const saveError = createWorker.error ?? updateWorker.error;
  const selectedRoot = models.find(
    ({ id }) => id === draft.modelConfiguration.modelId,
  );
  const selectedSubagent = models.find(
    ({ id }) => id === draft.modelConfiguration.subagentModelId,
  );
  const subagentCompatible =
    !draft.modelConfiguration.customSubagentModel ||
    Boolean(
      selectedRoot &&
      selectedSubagent &&
      modelsShareProvider(selectedRoot, selectedSubagent),
    );

  return (
    <div data-slot="task-settings" className="grid w-full gap-4">
      <section className="border-y" aria-labelledby="task-worker-title">
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <ListTodo className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h2 id="task-worker-title" className="text-sm font-semibold">
                  Task Workers
                </h2>
                <span className="text-xs text-muted-foreground">
                  {taskWorkers.data?.length ?? 0}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Global model profiles and concurrency limits for queued Tasks.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            disabled={!models.length || settings.isLoading}
            onClick={openCreate}
          >
            <Plus className="size-3.5" /> Add Task Worker
          </Button>
        </div>

        {!settings.isLoading && !models.length ? (
          <div className="border-t px-3 py-3">
            <InlineAlert>
              Configure at least one model in Settings &gt; Models before adding
              a Task Worker.
            </InlineAlert>
          </div>
        ) : null}

        {taskWorkers.isLoading ? (
          <div className="flex items-center justify-center gap-2 border-t px-4 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading Task Workers…
          </div>
        ) : taskWorkers.isError ? (
          <div className="border-t px-3 py-3">
            <InlineAlert tone="error">
              {errorMessage(taskWorkers.error, "Could not load Task Workers.")}
            </InlineAlert>
          </div>
        ) : taskWorkers.data?.length ? (
          <>
            <div className="hidden grid-cols-[minmax(10rem,1.1fr)_minmax(10rem,1fr)_minmax(8rem,.65fr)_minmax(7rem,.55fr)_7rem] gap-3 border-y px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Task Worker</span>
              <span>Model</span>
              <span>Capability</span>
              <span>Capacity</span>
              <span className="text-right">Order</span>
            </div>
            <div className="divide-y">
              {taskWorkers.data.map((worker, index) => (
                <div
                  key={worker.id}
                  data-high-contrast-row
                  role="button"
                  tabIndex={0}
                  aria-label={`Edit ${worker.name}`}
                  className="grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(10rem,1.1fr)_minmax(10rem,1fr)_minmax(8rem,.65fr)_minmax(7rem,.55fr)_7rem]"
                  onClick={() => openEdit(worker)}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      openEdit(worker);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ListTodo className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">
                      {worker.name}
                    </span>
                    <Badge variant={worker.enabled ? "secondary" : "outline"}>
                      {worker.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <div className="col-span-2 flex min-w-0 items-center gap-1.5 pl-6 text-xs text-muted-foreground sm:col-span-1 sm:pl-0">
                    <Cpu className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {modelName(models, worker.modelConfiguration.modelId)}
                      {worker.modelConfiguration.reasoningEffort
                        ? ` · ${worker.modelConfiguration.reasoningEffort}`
                        : ""}
                    </span>
                  </div>
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {taskWorkerCapabilityLabel(worker)}
                  </div>
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {worker.activeTaskCount}/{worker.maxConcurrency} active
                  </div>
                  <div
                    className="col-start-2 row-start-1 flex items-center justify-end sm:col-auto sm:row-auto"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button
                      aria-label={`Move ${worker.name} up`}
                      className="size-7"
                      size="icon"
                      variant="ghost"
                      disabled={index === 0 || reorderWorkers.isPending}
                      onClick={() => moveWorker(index, -1)}
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={`Move ${worker.name} down`}
                      className="size-7"
                      size="icon"
                      variant="ghost"
                      disabled={
                        index === taskWorkers.data!.length - 1 ||
                        reorderWorkers.isPending
                      }
                      onClick={() => moveWorker(index, 1)}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={`Delete ${worker.name}`}
                      className="size-7"
                      size="icon"
                      variant="ghost"
                      disabled={removeWorker.isPending}
                      onClick={() => {
                        removeWorker.reset();
                        setRemoving(worker);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="border-t px-4 py-12 text-center">
            <ListTodo className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No Task Workers configured</p>
            <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">
              Task queues remain idle until you explicitly add a Task Worker.
              Each profile controls its models, Task modes, and global capacity.
            </p>
            <Button
              className="mt-4"
              size="sm"
              disabled={!models.length}
              onClick={openCreate}
            >
              <Plus className="size-3.5" /> Add Task Worker
            </Button>
          </div>
        )}

        {reorderWorkers.isError ? (
          <div className="border-t px-3 py-3">
            <InlineAlert tone="error">
              {errorMessage(
                reorderWorkers.error,
                "Could not reorder Task Workers.",
              )}
            </InlineAlert>
          </div>
        ) : null}
      </section>

      <p className="px-1 text-xs text-muted-foreground">
        Capacity is shared across every Project. Auto-assigned Tasks try enabled
        Task Workers in this order.
      </p>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <form className="grid gap-5" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {editing === "new" ? "Add Task Worker" : "Edit Task Worker"}
              </DialogTitle>
              <DialogDescription>
                Configure the agent profile and account-wide Task concurrency.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Name</span>
                <input
                  autoFocus
                  required
                  maxLength={160}
                  className={inputClass}
                  value={draft.name}
                  placeholder="Primary Task Worker"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>

              <div className="grid gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Root agent</p>
                  <p className="text-xs text-muted-foreground">
                    The root model determines conversation continuity.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,.55fr)]">
                  <div className="grid gap-1.5 text-xs">
                    <span className="font-medium">Model</span>
                    <ModelCombobox
                      ariaLabel="Task Worker root model"
                      value={draft.modelConfiguration.modelId ?? ""}
                      models={models}
                      onValueChange={(modelId) => {
                        const root = models.find(({ id }) => id === modelId);
                        setDraft((current) => {
                          const subagent = models.find(
                            ({ id }) =>
                              id === current.modelConfiguration.subagentModelId,
                          );
                          const compatible = Boolean(
                            root &&
                            subagent &&
                            modelsShareProvider(root, subagent),
                          );
                          return {
                            ...current,
                            modelConfiguration: {
                              ...current.modelConfiguration,
                              modelId,
                              reasoningEffort: null,
                              subagentModelId: compatible
                                ? current.modelConfiguration.subagentModelId
                                : null,
                              subagentReasoningEffort: compatible
                                ? current.modelConfiguration
                                    .subagentReasoningEffort
                                : null,
                            },
                          };
                        });
                      }}
                    />
                  </div>
                  <label className="grid gap-1.5 text-xs">
                    <span className="font-medium">Reasoning</span>
                    <NativeSelect
                      size="default"
                      value={draft.modelConfiguration.reasoningEffort ?? ""}
                      aria-label="Task Worker root reasoning"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          modelConfiguration: {
                            ...current.modelConfiguration,
                            reasoningEffort: event.target.value || null,
                          },
                        }))
                      }
                    >
                      <option value="">Default</option>
                      {reasoningOptions(
                        draft.modelConfiguration.reasoningEffort,
                      ).map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                </div>

                <label className="flex cursor-pointer items-start gap-3 border-t pt-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={draft.modelConfiguration.customSubagentModel}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        modelConfiguration: {
                          ...current.modelConfiguration,
                          customSubagentModel: event.target.checked,
                        },
                      }))
                    }
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      Custom subagent model
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Off makes subagents inherit the root model and reasoning.
                    </span>
                  </span>
                </label>

                {draft.modelConfiguration.customSubagentModel ? (
                  <div className="grid gap-3 pl-0 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,.55fr)] sm:pl-7">
                    <div className="grid gap-1.5 text-xs">
                      <span className="font-medium">Subagent model</span>
                      <ModelCombobox
                        ariaLabel="Task Worker subagent model"
                        value={draft.modelConfiguration.subagentModelId ?? ""}
                        getOptionDisabled={(model) =>
                          !selectedRoot ||
                          !modelsShareProvider(selectedRoot, model)
                        }
                        getOptionNote={(model) =>
                          selectedRoot &&
                          modelsShareProvider(selectedRoot, model)
                            ? null
                            : "Different provider"
                        }
                        models={models}
                        placeholder="Select a subagent model"
                        onValueChange={(subagentModelId) =>
                          setDraft((current) => ({
                            ...current,
                            modelConfiguration: {
                              ...current.modelConfiguration,
                              subagentModelId,
                              subagentReasoningEffort: null,
                            },
                          }))
                        }
                      />
                    </div>
                    <label className="grid gap-1.5 text-xs">
                      <span className="font-medium">Reasoning</span>
                      <NativeSelect
                        size="default"
                        value={
                          draft.modelConfiguration.subagentReasoningEffort ?? ""
                        }
                        aria-label="Task Worker subagent reasoning"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            modelConfiguration: {
                              ...current.modelConfiguration,
                              subagentReasoningEffort:
                                event.target.value || null,
                            },
                          }))
                        }
                      >
                        <option value="">Default</option>
                        {reasoningOptions(
                          draft.modelConfiguration.subagentReasoningEffort,
                        ).map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    {!subagentCompatible ? (
                      <p className="text-xs text-destructive sm:col-span-2">
                        Root and subagent models must share an enabled provider.
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground sm:col-span-2">
                        The scheduler resolves both models through the same
                        provider and account.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>

              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Maximum concurrent Tasks</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={TASK_WORKER_CONCURRENCY_MAX}
                  step={1}
                  className={`${inputClass} max-w-40`}
                  value={draft.maxConcurrency}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      maxConcurrency: event.target.value,
                    }))
                  }
                />
                <span className="text-xs text-muted-foreground">
                  Shared across every Project. Lowering capacity never
                  interrupts active Tasks.
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={draft.allowsPlanGoal}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      allowsPlanGoal: event.target.checked,
                    }))
                  }
                />
                <span>
                  <span className="block text-sm font-medium">
                    Allow Plan + Goal Tasks
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Every Task Worker can run Direct Tasks. Enable this for
                    planning and Goal cycles too.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  <span className="block text-sm font-medium">Enabled</span>
                  <span className="block text-xs text-muted-foreground">
                    Disabled Task Workers retain history but cannot claim new
                    work.
                  </span>
                </span>
              </label>

              <details className="rounded-lg border px-3 py-2.5 text-sm">
                <summary className="cursor-pointer font-medium">
                  Advanced
                </summary>
                <div className="mt-3 grid gap-2 border-t pt-3">
                  <label className="grid gap-1.5">
                    <span className="font-medium">
                      Continuity family override
                    </span>
                    <input
                      maxLength={160}
                      className={inputClass}
                      value={draft.continuityFamilyOverride}
                      placeholder="Automatic"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          continuityFamilyOverride: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Leave blank to infer a safe family from trusted model
                    catalog metadata. Without one, continuity stays pinned to
                    the exact root model profile.
                  </p>
                  {editing && editing !== "new" ? (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Current: {editing.continuityFamily}
                    </p>
                  ) : null}
                </div>
              </details>

              {draftError ? (
                <InlineAlert tone="error">{draftError}</InlineAlert>
              ) : null}
              {saveError ? (
                <InlineAlert tone="error">
                  {errorMessage(saveError, "Could not save the Task Worker.")}
                </InlineAlert>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  saving ||
                  !draft.modelConfiguration.modelId ||
                  !subagentCompatible
                }
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {editing === "new" ? "Add Task Worker" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        pending={removeWorker.isPending}
        confirmLabel="Delete Task Worker"
        confirmPendingLabel="Deleting…"
        title={`Delete ${removing?.name ?? "Task Worker"}?`}
        description={
          removing?.activeTaskCount
            ? "This disables the profile and removes it from future assignment. Existing Task and execution history remains intact."
            : "This removes the profile from future assignment while retaining historical Task references."
        }
        error={
          removeWorker.isError
            ? errorMessage(removeWorker.error, "Could not delete Task Worker.")
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            removeWorker.reset();
          }
        }}
        onConfirm={() => {
          if (removing) removeWorker.mutate(removing);
        }}
      />
    </div>
  );
}
