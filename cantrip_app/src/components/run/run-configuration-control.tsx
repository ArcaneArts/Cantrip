import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ProjectWorktreeSummary, WorkerSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Coffee,
  Check,
  ChevronDown,
  CircleAlert,
  FileCode2,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Smartphone,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { RunConfigurationEditor } from "@/components/run/run-configuration-editor";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import {
  deleteRunConfiguration,
  operateRunConfigurationRuntime,
  type RunConfigurationListInventory,
} from "@/lib/run-configuration-api";
import {
  buildRunConfigurationControlModel,
  runConfigurationPrimaryOperation,
  type RunConfigurationControlItem,
  type RunConfigurationTargetControl,
} from "@/lib/run-configuration-control-model";
import {
  readRunConfigurationSelection,
  reconcileRunConfigurationSelection,
  writeRunConfigurationSelection,
} from "@/lib/run-configuration-selection";
import { scopedClientStorageKey } from "@/lib/client-session";
import { runConfigurationRuntimeIsActive } from "@/lib/run-terminal-model";
import { cn } from "@/lib/utils";

type LifecycleInput = {
  item: RunConfigurationControlItem;
  operation: "start" | "restart" | "stop";
  target: RunConfigurationTargetControl;
};

function ProviderIcon({ provider }: { provider?: string | null }) {
  if (provider === "dart") {
    return <FileCode2 className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (provider === "flutter") {
    return <Smartphone className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (provider === "java") {
    return <Coffee className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (provider === "rust") {
    return <Boxes className="size-4 shrink-0 text-muted-foreground" />;
  }
  return provider === "node" ? (
    <Package className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
  );
}

function LifecycleButtons({
  compact = false,
  disabled,
  disabledReason,
  pending,
  runtime,
  stopDisabled = disabled,
  stopDisabledReason = disabledReason,
  onOperate,
}: {
  compact?: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  pending: boolean;
  runtime: RunConfigurationRuntime | null | undefined;
  stopDisabled?: boolean;
  stopDisabledReason?: string | null;
  onOperate(operation: "start" | "restart" | "stop"): void;
}) {
  const active = runConfigurationRuntimeIsActive(runtime);
  const stopping = runtime?.state === "stopping";
  if (!active) {
    return (
      <button
        aria-label="Run"
        className={cn(
          "grid shrink-0 place-items-center rounded text-emerald-600 hover:bg-emerald-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-emerald-400",
          compact ? "size-7" : "size-8",
        )}
        disabled={disabled || pending}
        onClick={(event) => {
          event.stopPropagation();
          onOperate("start");
        }}
        title={disabledReason ?? "Run"}
        type="button"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4 fill-current" />
        )}
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center">
      <button
        aria-label="Restart"
        className={cn(
          "grid place-items-center rounded text-emerald-600 hover:bg-emerald-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-emerald-400",
          compact ? "size-7" : "size-8",
        )}
        disabled={disabled || pending || stopping}
        onClick={(event) => {
          event.stopPropagation();
          onOperate("restart");
        }}
        title={disabledReason ?? "Restart"}
        type="button"
      >
        {pending && !stopping ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RotateCw className="size-4" />
        )}
      </button>
      <button
        aria-label="Stop"
        className={cn(
          "grid place-items-center rounded text-red-600 hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-red-400",
          compact ? "size-7" : "size-8",
        )}
        disabled={stopDisabled || pending || stopping}
        onClick={(event) => {
          event.stopPropagation();
          onOperate("stop");
        }}
        title={stopDisabledReason ?? "Stop"}
        type="button"
      >
        {stopping ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Square className="size-3.5 fill-current" />
        )}
      </button>
    </span>
  );
}

export function RunConfigurationControl({
  compact = false,
  editorConfigurationId,
  error,
  inventory,
  loading,
  projectId,
  renderEditor = true,
  runtimes,
  workers,
  worktrees,
  onEditorConfigurationChange,
  onFocusTerminal,
}: {
  compact?: boolean;
  editorConfigurationId: string | "new" | null;
  error?: string | null;
  inventory: RunConfigurationListInventory | null | undefined;
  loading: boolean;
  projectId: string;
  renderEditor?: boolean;
  runtimes: readonly RunConfigurationRuntime[];
  workers: readonly WorkerSummary[];
  worktrees: readonly ProjectWorktreeSummary[];
  onEditorConfigurationChange(configurationId: string | "new" | null): void;
  onFocusTerminal(terminalId: string): void;
}) {
  const queryClient = useQueryClient();
  const model = useMemo(
    () =>
      buildRunConfigurationControlModel({
        inventory,
        runtimes,
        workers,
        worktrees,
      }),
    [inventory, runtimes, workers, worktrees],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileRunConfigurationSelection(
      readRunConfigurationSelection(projectId, scopedClientStorageKey),
      model.configurations.map(({ id }) => id),
    ),
  );
  const [worktreeConfigurationId, setWorktreeConfigurationId] = useState<
    string | null
  >(null);
  const [deleteConfigurationId, setDeleteConfigurationId] = useState<
    string | null
  >(null);

  const ids = model.configurations.map(({ id }) => id);
  const idsKey = ids.join("\0");
  const selectionProjectRef = useRef(projectId);
  useEffect(() => {
    const projectChanged = selectionProjectRef.current !== projectId;
    const preferred = projectChanged
      ? readRunConfigurationSelection(projectId, scopedClientStorageKey)
      : selectedId;
    selectionProjectRef.current = projectId;
    const reconciled = reconcileRunConfigurationSelection(preferred, ids);
    if (reconciled !== selectedId) setSelectedId(reconciled);
    writeRunConfigurationSelection(
      projectId,
      reconciled,
      scopedClientStorageKey,
    );
    // The joined identity list is the stable inventory dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, projectId, selectedId]);

  const selected =
    model.configurations.find(({ id }) => id === selectedId) ?? null;
  const editorEntry =
    editorConfigurationId && editorConfigurationId !== "new"
      ? (inventory?.entries.find(({ id }) => id === editorConfigurationId) ??
        null)
      : null;
  const worktreeItem =
    model.configurations.find(({ id }) => id === worktreeConfigurationId) ??
    null;
  const deleteItem =
    model.configurations.find(({ id }) => id === deleteConfigurationId) ?? null;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["run-configurations", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["run-configuration-runtimes", projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ["terminals", projectId] }),
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      }),
    ]);
  };
  const lifecycle = useMutation({
    mutationFn: ({ item, operation, target }: LifecycleInput) =>
      operateRunConfigurationRuntime({
        operation,
        projectId,
        configurationId: item.id,
        targetWorktreeId: target.worktree.isPrimary ? null : target.worktree.id,
      }),
    onSuccess: async (result) => {
      if (result.runtime) {
        queryClient.setQueryData<RunConfigurationRuntime[]>(
          ["run-configuration-runtimes", projectId],
          (current = []) => [
            ...current.filter(({ id }) => id !== result.runtime!.id),
            result.runtime!,
          ],
        );
      }
      await refresh();
      if (result.runtime?.terminalId)
        onFocusTerminal(result.runtime.terminalId);
    },
  });
  const remove = useMutation({
    mutationFn: async (item: RunConfigurationControlItem) => {
      const result = await deleteRunConfiguration(
        projectId,
        item.id,
        item.revision,
      );
      if (result.outcome === "revision-mismatch") {
        throw new Error(
          "The shared configuration changed. Reload and confirm deletion again.",
        );
      }
      if (result.outcome === "not-found") {
        throw new Error("The shared configuration was already deleted.");
      }
      return result;
    },
    onSuccess: async () => {
      setDeleteConfigurationId(null);
      await refresh();
    },
  });
  const operate = (
    item: RunConfigurationControlItem,
    target: RunConfigurationTargetControl | null,
    operation: LifecycleInput["operation"],
  ) => {
    if (!target) return;
    setSelectedId(item.id);
    lifecycle.mutate({ item, operation, target });
  };
  const selectAndRunPrimary = (item: RunConfigurationControlItem) => {
    setSelectedId(item.id);
    setMenuOpen(false);
    if (item.primary?.available) {
      operate(item, item.primary, runConfigurationPrimaryOperation(item));
    }
  };
  const pendingFor = (
    item: RunConfigurationControlItem,
    target: RunConfigurationTargetControl | null,
  ) =>
    lifecycle.isPending &&
    lifecycle.variables.item.id === item.id &&
    lifecycle.variables.target.worktree.id === target?.worktree.id;
  const filteredWorktrees =
    worktreeItem?.targets.filter(({ worktree }) => !worktree.isPrimary) ?? [];

  return (
    <div
      className="flex min-w-0 items-center gap-0.5"
      data-run-configuration-control="true"
    >
      {selected ? (
        <LifecycleButtons
          compact
          disabled={!selected.primary?.available}
          disabledReason={
            selected.primary?.reason ?? "Primary worktree unavailable."
          }
          pending={pendingFor(selected, selected.primary)}
          runtime={selected.primary?.runtime}
          stopDisabled={!selected.primary?.stopAvailable}
          stopDisabledReason={selected.primary?.stopReason}
          onOperate={(operation) =>
            operate(selected, selected.primary, operation)
          }
        />
      ) : null}
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            className={cn(
              "min-w-0 justify-between px-2",
              compact ? "max-w-36" : "max-w-64",
            )}
            size="sm"
            title={
              selected
                ? `${selected.name} · ${selected.targetLabel}`
                : "Add Run Configuration"
            }
            variant="ghost"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ProviderIcon provider={selected?.provider} />
            )}
            <span className="truncate">
              {selected?.name ?? "Add Run Configuration"}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(34rem,calc(100vw-1rem))] p-0"
        >
          <Command shouldFilter>
            <div className="flex items-center border-b pr-1">
              <div className="min-w-0 flex-1">
                <CommandInput
                  placeholder="Search Run configurations…"
                  value={search}
                  onValueChange={setSearch}
                />
              </div>
              <Button
                aria-label="New Run configuration"
                onClick={() => {
                  setMenuOpen(false);
                  onEditorConfigurationChange("new");
                }}
                size="icon"
                title="New Run configuration"
                variant="ghost"
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <CommandList className="max-h-[28rem]">
              <CommandEmpty>No matching Run configurations.</CommandEmpty>
              <CommandGroup heading="Run configurations">
                {model.configurations.map((item) => (
                  <div className="py-0.5" key={item.id}>
                    <CommandItem
                      className="min-h-12 px-1"
                      onSelect={() => selectAndRunPrimary(item)}
                      value={item.searchValue}
                    >
                      <LifecycleButtons
                        disabled={!item.primary?.available}
                        disabledReason={
                          item.primary?.reason ??
                          "Primary worktree unavailable."
                        }
                        pending={pendingFor(item, item.primary)}
                        runtime={item.primary?.runtime}
                        stopDisabled={!item.primary?.stopAvailable}
                        stopDisabledReason={item.primary?.stopReason}
                        onOperate={(operation) =>
                          operate(item, item.primary, operation)
                        }
                      />
                      <ProviderIcon provider={item.provider} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {item.name}
                          </span>
                          {item.id === selectedId ? (
                            <Check className="size-3.5 shrink-0" />
                          ) : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="capitalize">{item.provider}</span>
                          <span>·</span>
                          <span>
                            {item.primary?.reason ??
                              item.primary?.runtime?.state ??
                              (item.primary
                                ? "Primary idle"
                                : "Primary worktree unavailable")}
                          </span>
                          {item.activeAlternates.length ? (
                            <>
                              <span>·</span>
                              <span>
                                {item.activeAlternates.length} alternate active
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            aria-label={`More options for ${item.name}`}
                            className="grid size-8 shrink-0 place-items-center rounded hover:bg-muted"
                            onClick={(event) => event.stopPropagation()}
                            type="button"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <StyledDropdownMenuContent align="end" sideOffset={4}>
                            <StyledDropdownMenuItem
                              disabled={
                                !item.targets.some(
                                  ({ worktree }) => !worktree.isPrimary,
                                )
                              }
                              onSelect={() => {
                                setMenuOpen(false);
                                setWorktreeConfigurationId(item.id);
                              }}
                            >
                              <GitBranch className="size-4" /> Run in Worktree…
                            </StyledDropdownMenuItem>
                            <StyledDropdownMenuItem
                              onSelect={() => {
                                setMenuOpen(false);
                                onEditorConfigurationChange(item.id);
                              }}
                            >
                              <Pencil className="size-4" /> Edit
                            </StyledDropdownMenuItem>
                            <StyledDropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => {
                                setMenuOpen(false);
                                setDeleteConfigurationId(item.id);
                              }}
                            >
                              <Trash2 className="size-4" /> Delete
                            </StyledDropdownMenuItem>
                          </StyledDropdownMenuContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </CommandItem>
                    {item.activeAlternates.map((target) => (
                      <CommandItem
                        className="ml-10 min-h-10 border-l pl-3"
                        key={target.worktree.id}
                        value={`${item.searchValue} ${target.label.toLocaleLowerCase()}`}
                        onSelect={() =>
                          target.runtime?.terminalId &&
                          onFocusTerminal(target.runtime.terminalId)
                        }
                      >
                        <LifecycleButtons
                          compact
                          disabled={!target.available}
                          disabledReason={target.reason}
                          pending={pendingFor(item, target)}
                          runtime={target.runtime}
                          stopDisabled={!target.stopAvailable}
                          stopDisabledReason={target.stopReason}
                          onOperate={(operation) =>
                            operate(item, target, operation)
                          }
                        />
                        <GitBranch className="size-3.5 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {target.label}
                          </div>
                          <div className="text-[11px] capitalize text-muted-foreground">
                            {target.runtime?.state}
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </div>
                ))}
              </CommandGroup>
              {model.invalidConfigurations.length ? (
                <CommandGroup heading="Needs attention">
                  {model.invalidConfigurations.map((item) => (
                    <CommandItem
                      disabled
                      key={item.relativePath}
                      value={item.searchValue}
                    >
                      <SquareTerminal className="size-4" />
                      <div className="min-w-0">
                        <div className="truncate text-sm">{item.label}</div>
                        <div className="truncate text-xs text-destructive">
                          {item.diagnostic}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
            {error || lifecycle.error ? (
              <InlineAlert className="m-2" tone="error">
                {error ?? lifecycle.error?.message}
              </InlineAlert>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {error || lifecycle.error ? (
        <button
          aria-label="Run configuration problem"
          className="grid size-7 shrink-0 place-items-center rounded text-destructive hover:bg-destructive/10"
          onClick={() => setMenuOpen(true)}
          title={error ?? lifecycle.error?.message}
          type="button"
        >
          <CircleAlert className="size-4" />
        </button>
      ) : null}

      {renderEditor ? (
        <RunConfigurationEditor
          creating={editorConfigurationId === "new"}
          entry={editorEntry}
          open={editorConfigurationId !== null}
          projectId={projectId}
          onOpenChange={(open) => {
            if (!open) onEditorConfigurationChange(null);
          }}
          onSaved={(saved) => {
            queryClient.setQueryData<RunConfigurationListInventory>(
              ["run-configurations", projectId],
              (current) => ({
                directory: current?.directory ?? ".cantrip/run-configurations",
                diagnostics: current?.diagnostics ?? [],
                entries: [
                  ...(current?.entries ?? []).filter(
                    ({ id }) => id !== saved.id,
                  ),
                  saved,
                ],
                validations:
                  current?.validations.filter(
                    ({ configurationId }) => configurationId !== saved.id,
                  ) ?? [],
              }),
            );
            if (saved.id) {
              setSelectedId(saved.id);
              writeRunConfigurationSelection(
                projectId,
                saved.id,
                scopedClientStorageKey,
              );
            }
            void refresh();
          }}
        />
      ) : null}
      <Dialog
        open={worktreeItem !== null}
        onOpenChange={(open) => {
          if (!open) setWorktreeConfigurationId(null);
        }}
      >
        <DialogContent className="max-w-lg p-0">
          <DialogHeader className="p-5 pb-0">
            <DialogTitle>Run {worktreeItem?.name} in Worktree</DialogTitle>
            <DialogDescription>
              Choose an exact alternate worktree. Running instances restart in
              place.
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Search branches and worktrees…" />
            <CommandList className="max-h-80">
              <CommandEmpty>No alternate worktrees found.</CommandEmpty>
              <CommandGroup>
                {filteredWorktrees.map((target) => (
                  <CommandItem
                    disabled={!target.available}
                    key={target.worktree.id}
                    value={`${target.label} ${target.worktree.name}`}
                    onSelect={() => {
                      if (!worktreeItem) return;
                      operate(
                        worktreeItem,
                        target,
                        runConfigurationRuntimeIsActive(target.runtime)
                          ? "restart"
                          : "start",
                      );
                      setWorktreeConfigurationId(null);
                    }}
                  >
                    <GitBranch className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{target.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {target.reason ?? target.worktree.displayPath}
                      </div>
                    </div>
                    {runConfigurationRuntimeIsActive(target.runtime) ? (
                      <span className="text-xs capitalize text-emerald-600">
                        {target.runtime?.state}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        confirmLabel="Stop instances and delete"
        confirmPendingLabel="Deleting…"
        description={
          <>
            Delete <strong>{deleteItem?.name}</strong> from the shared project?
            Any active Primary or worktree instances will stop and their managed
            terminal tabs will close.
          </>
        }
        error={remove.error?.message}
        onConfirm={() => {
          if (deleteItem) remove.mutate(deleteItem);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfigurationId(null);
            remove.reset();
          }
        }}
        open={deleteItem !== null}
        pending={remove.isPending}
        title="Delete Run configuration?"
      />
    </div>
  );
}
