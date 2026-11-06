import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CantripOsInstanceSummary,
  CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { errorMessage } from "@/lib/error-message";
import {
  cantripOsBackupAccountKey,
  clearCantripOsBackupDraft,
  readCantripOsBackupDraft,
  saveCantripOsBackupDraft,
  type CantripOsBackupDraft,
} from "@/lib/cantrip-os-backup-draft";
import {
  getCantripOsBackupOperations,
  prepareCantripOsBackup,
  recoverCantripOsBackup,
  submitCantripOsBackup,
  type CantripOsBackupSummary,
  type CantripOsBackupIntent,
} from "@/lib/api/cantrip-os-backups";
import {
  createCantripOsWorkspace,
  refreshCantripOs,
} from "@/lib/api/cantrip-os";
import { CantripOsBackupEntry } from "./cantrip-os-backup-entry";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import { observeLegacyCantripOsRestoreWorkspace } from "@/lib/api/cantrip-os-workspace-operations";
import {
  CantripOsResetForm,
  type CantripOsResetSelection,
} from "./cantrip-os-reset-form";

export function CantripOsBackupControls({
  instance,
  instances = [instance],
  workerNames = {},
  workspace,
  workspaces,
  onChanged,
}: {
  instance: CantripOsInstanceSummary;
  instances?: CantripOsInstanceSummary[];
  workerNames?: Record<string, string>;
  workspace?: CantripOsWorkspaceSummary;
  workspaces: CantripOsWorkspaceSummary[];
  onChanged(): void;
}) {
  const queryClient = useQueryClient();
  const activeMutation = useRef<object | null>(null),
    epoch = useRef(0),
    mounted = useRef(true);
  const currentAccount = () => {
    try {
      return cantripOsBackupAccountKey();
    } catch {
      return null;
    }
  };
  const [accountKey, setAccountKey] = useState(currentAccount);
  const renderEpoch = epoch.current;
  const isCurrent = () =>
    mounted.current &&
    accountKey !== null &&
    renderEpoch === epoch.current &&
    accountKey === currentAccount();
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error(
        "The account or Server changed. This recovery request was not redirected.",
      );
  };
  const [label, setLabel] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [backup, setBackup] = useState<CantripOsBackupSummary | null>(null);
  const [rollback, setRollback] = useState<CantripOsBackupSummary | null>(null);
  const [target, setTarget] = useState("");
  const [newWorkspace, setNewWorkspace] = useState(
    () => `restore-${crypto.randomUUID().slice(0, 12)}`,
  );
  const [replace, setReplace] = useState(false);
  const [draftState, setDraftState] = useState<{
    draft: CantripOsBackupDraft | null;
    error?: string;
  }>(() => {
    try {
      return { draft: readCantripOsBackupDraft(instance.id) };
    } catch (error) {
      return {
        draft: null,
        error: `Saved request could not be read: ${errorMessage(error)}`,
      };
    }
  });
  const operations = useInfiniteQuery({
    queryKey: ["cantrip-os-backup-operations", accountKey],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      assertCurrent();
      const result = await getCantripOsBackupOperations(pageParam);
      assertCurrent();
      return result;
    },
    enabled: Boolean(accountKey),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  function retain(draft: CantripOsBackupDraft) {
    assertCurrent();
    saveCantripOsBackupDraft(draft, undefined, accountKey!);
    setDraftState({ draft });
    return draft;
  }
  const changed = () => {
    if (!isCurrent()) return;
    void queryClient.invalidateQueries({
      queryKey: ["cantrip-os-backup-operations"],
    });
    onChanged();
  };
  async function exclusive<T>(action: () => Promise<T>, creating = false) {
    if (activeMutation.current)
      throw new Error("A backup action is already in progress.");
    assertCurrent();
    const token = {};
    activeMutation.current = token;
    try {
      if (
        creating &&
        readCantripOsBackupDraft(instance.id, undefined, accountKey!)
      )
        throw new Error(
          "Resume or discard the saved request before creating another operation.",
        );
      return await action();
    } finally {
      if (activeMutation.current === token) activeMutation.current = null;
    }
  }
  async function prepare(
    intent: CantripOsBackupIntent,
  ): Promise<CantripOsBackupDraft> {
    assertCurrent();
    const current = (await refreshCantripOs(instance.id)).instance;
    assertCurrent();
    if (current.attachmentGeneration !== instance.attachmentGeneration)
      throw new Error(
        "The instance attachment changed. Select and verify the intended instance again.",
      );
    if (
      intent.action === "reset" &&
      current.runtimeGeneration !== instance.runtimeGeneration
    )
      throw new Error(
        "The selected OS runtime changed. Review the reset against its intended runtime again.",
      );
    return retain({
      stage: "admission",
      instanceId: instance.id,
      admission: await prepareCantripOsBackup(current, intent),
    });
  }
  function finishSaved(result: CantripOsBackupSummary) {
    assertCurrent();
    const saved = readCantripOsBackupDraft(instance.id, undefined, accountKey!);
    if (
      saved?.stage === "admission" &&
      saved.admission.operationId === result.operationId &&
      result.result &&
      ["ready", "failed"].includes(result.result.state)
    ) {
      clearCantripOsBackupDraft(instance.id, undefined, accountKey!);
      setDraftState({ draft: null });
    }
  }
  async function execute(draft: CantripOsBackupDraft) {
    assertCurrent();
    if (draft.stage === "workspace") {
      const plan = draft;
      // New plans preserve their exact guarded POST. Legacy plans may only
      // observe an existing original admission; they cannot initiate creation.
      const creation = plan.createRequest
        ? await createCantripOsWorkspace(plan.instanceId, plan.createRequest)
        : (await observeLegacyCantripOsRestoreWorkspace(plan)).result;
      assertCurrent();
      if (!creation || creation.state !== "ready")
        throw new Error(
          creation?.error ??
            `Workspace creation is ${creation?.state ?? "unknown"}. Resume this saved request to observe its original operation.`,
        );
      if (
        creation.receipt.kind !== "workspace" ||
        creation.receipt.workspace.guestWorkspaceId !== plan.guestWorkspaceId
      )
        throw new Error(
          "The new workspace receipt differs from the saved restore plan.",
        );
      const observed = await refreshCantripOs(plan.instanceId);
      assertCurrent();
      if (observed.instance.attachmentGeneration !== plan.attachmentGeneration)
        throw new Error(
          "The restore destination attachment changed during workspace creation.",
        );
      const destination = observed.workspaces.find(
        (item) => item.guestWorkspaceId === plan.guestWorkspaceId,
      );
      if (
        !destination ||
        destination.uid !== creation.receipt.workspace.uid ||
        destination.gid !== creation.receipt.workspace.gid ||
        destination.homeGuestPath !== creation.receipt.workspace.homeGuestPath
      )
        throw new Error(
          "The created restore workspace has not been observed yet.",
        );
      return execute(
        retain({
          stage: "admission",
          instanceId: plan.instanceId,
          admission: await prepareCantripOsBackup(observed.instance, {
            action: "restore",
            workspaceId: destination.id,
            backupId: plan.backupId,
            replace: false,
          }),
        }),
      );
    }
    const result = await submitCantripOsBackup(
      draft.instanceId,
      draft.admission,
    );
    finishSaved(result);
    setBackup(null);
    setRollback(null);
    return result;
  }
  const capture = useMutation({
    retry: false,
    mutationFn: () =>
      exclusive(async () => {
        if (!workspace) throw new Error("Select a workspace to capture.");
        return execute(
          await prepare({
            action: "capture",
            workspaceId: workspace.id,
            label,
            exclusions: exclusions.split(/\r?\n/).filter(Boolean),
          }),
        );
      }, true),
    onSettled: changed,
  });
  const restore = useMutation({
    retry: false,
    mutationFn: () =>
      exclusive(async () => {
        if (!backup) throw new Error("Select a backup to restore.");
        if (target) {
          if (!replace)
            throw new Error(
              "Explicitly choose replacement before restoring over an existing workspace.",
            );
          return execute(
            await prepare({
              action: "restore",
              workspaceId: target,
              backupId: backup.operationId,
              replace: true,
            }),
          );
        }
        const current = (await refreshCantripOs(instance.id)).instance;
        assertCurrent();
        if (
          current.attachmentGeneration !== instance.attachmentGeneration ||
          !current.runtimeGeneration
        )
          throw new Error(
            "The restore destination changed or has no observed runtime.",
          );
        const operationId = crypto.randomUUID();
        // Persist the exact guarded request before sending its first admission.
        return execute(
          retain({
            stage: "workspace",
            instanceId: instance.id,
            attachmentGeneration: instance.attachmentGeneration,
            backupId: backup.operationId,
            guestWorkspaceId: newWorkspace,
            operationId,
            createRequest: {
              guestWorkspaceId: newWorkspace,
              operationId,
              attachmentGeneration: current.attachmentGeneration,
              runtimeGeneration: current.runtimeGeneration,
            },
          }),
        );
      }, true),
    onSettled: changed,
  });
  const reset = useMutation({
    retry: false,
    mutationFn: (selection: CantripOsResetSelection) =>
      exclusive(async () => {
        if (
          selection.instanceId !== instance.id ||
          selection.attachmentGeneration !== instance.attachmentGeneration ||
          selection.runtimeGeneration !== instance.runtimeGeneration ||
          selection.workspace.id !== workspace?.id ||
          selection.workspace.uid !== workspace.uid ||
          selection.workspace.gid !== workspace.gid ||
          selection.workspace.homeGuestPath !== workspace.homeGuestPath
        )
          throw new Error(
            "The confirmed reset destination changed. Review the intended workspace again.",
          );
        return execute(
          await prepare({
            action: "reset",
            workspaceId: selection.workspace.id,
            paths: selection.paths,
          }),
        );
      }, true),
    onSettled: changed,
  });
  const rollBack = useMutation({
    retry: false,
    mutationFn: () =>
      exclusive(async () => {
        if (!rollback || rollback.instanceId !== instance.id)
          throw new Error(
            "Select the original instance to undo this workspace change.",
          );
        return execute(
          await prepare({
            action: "rollback",
            workspaceId: rollback.workspaceId,
            restoreOperationId: rollback.operationId,
          }),
        );
      }, true),
    onSettled: changed,
  });
  const resume = useMutation({
    retry: false,
    mutationFn: () =>
      exclusive(async () => {
        if (!draftState.draft)
          throw new Error("There is no saved request to resume.");
        return execute(draftState.draft);
      }),
    onSettled: changed,
  });
  const recover = useMutation({
    retry: false,
    mutationFn: async ({
      entry,
      mode,
    }: {
      entry: CantripOsBackupSummary;
      mode: "observe" | "recover" | "continue";
    }) =>
      exclusive(async () => {
        assertCurrent();
        if (mode !== "continue") {
          const result = await recoverCantripOsBackup(entry, { mode });
          finishSaved(result);
          return result;
        }
        const current = (await refreshCantripOs(entry.instanceId)).instance;
        assertCurrent();
        if (!current.runtimeGeneration)
          throw new Error("The intended instance has no observed runtime.");
        const result = await recoverCantripOsBackup(entry, {
          mode,
          attachmentGeneration: current.attachmentGeneration,
          runtimeGeneration: current.runtimeGeneration,
        });
        finishSaved(result);
        return result;
      }),
    onSettled: changed,
  });
  const pending =
    reset.isPending ||
    capture.isPending ||
    restore.isPending ||
    rollBack.isPending ||
    resume.isPending ||
    recover.isPending;
  const occupied =
    !accountKey || pending || Boolean(draftState.draft || draftState.error);
  const lastAction = [
    capture,
    restore,
    reset,
    rollBack,
    resume,
    recover,
  ].reduce((latest, action) =>
    action.submittedAt > latest.submittedAt ? action : latest,
  );
  const error = lastAction.error ?? operations.error;
  useEffect(() => {
    return onClientSessionIdentityChanged(() => {
      epoch.current++;
      activeMutation.current = null;
      const next = currentAccount();
      setAccountKey(next);
      setLabel("");
      setExclusions("");
      setBackup(null);
      setRollback(null);
      for (const action of [capture, restore, reset, rollBack, resume, recover])
        action.reset();
      try {
        setDraftState({
          draft: readCantripOsBackupDraft(
            instance.id,
            undefined,
            next ?? undefined,
          ),
        });
      } catch (failure) {
        setDraftState({ draft: null, error: errorMessage(failure) });
      }
    });
  }, [instance.id]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">Private backups and recovery</h3>
      <p className="text-sm text-muted-foreground">
        Backups are encrypted on the owning Worker. Capture, restore, reset and
        undo interrupt managed work across this OS's workspaces. The personal
        desktop is independent. Ignored files are included unless explicitly
        excluded.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : null}
      {draftState.draft || draftState.error ? (
        <div className="space-y-2 border p-3">
          <p role="status" className="text-sm">
            {draftState.error ??
              "An immutable request is saved in this tab. Resume it to observe the same operation; do not create another request to recover a lost reply."}
          </p>
          {draftState.draft ? (
            <p className="break-all text-xs">
              {draftState.draft.stage === "admission"
                ? `Saved ${draftState.draft.admission.action} · Workspace ${workspaces.find((item) => item.id === (draftState.draft?.stage === "admission" ? draftState.draft.admission.workspaceId : null))?.guestWorkspaceId ?? draftState.draft.admission.workspaceId} · Operation ${draftState.draft.admission.operationId}`
                : `Saved restore workspace creation · ${draftState.draft.guestWorkspaceId} · Operation ${draftState.draft.operationId}`}
            </p>
          ) : null}
          {draftState.draft ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => resume.mutate()}
            >
              Resume saved request
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              assertCurrent();
              clearCantripOsBackupDraft(instance.id, undefined, accountKey!);
              setDraftState({ draft: null });
            }}
          >
            Discard local draft
          </Button>
          <p className="text-xs text-muted-foreground">
            Discarding this local draft does not cancel admitted work or delete
            its Server history.
          </p>
        </div>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          capture.mutate();
        }}
      >
        <p className="text-sm">
          Capture {workspace?.guestWorkspaceId ?? "the selected workspace"} ·{" "}
          {instance.name}
        </p>
        <label className="block space-y-1 text-sm">
          Backup label
          <Input
            value={label}
            maxLength={160}
            disabled={occupied}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          Excluded home-relative paths, one per line
          <textarea
            className="min-h-16 w-full rounded-md border bg-transparent p-2"
            value={exclusions}
            disabled={occupied}
            placeholder="checkouts/example/node_modules"
            onChange={(event) => setExclusions(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={occupied || !workspace}>
          Capture workspace
        </Button>
      </form>
      <CantripOsResetForm
        key={accountKey ?? "signed-out"}
        instance={instance}
        workspace={workspace}
        disabled={occupied}
        onReset={(selection) => reset.mutate(selection)}
      />
      {backup ? (
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            restore.mutate();
          }}
        >
          <h4 className="text-sm font-medium">
            Restore backup {backup.operationId} into {instance.name}
          </h4>
          <label className="block space-y-1 text-sm">
            Restore destination
            <NativeSelect
              className="w-full"
              value={target}
              disabled={occupied}
              onChange={(event) => {
                setTarget(event.target.value);
                setReplace(false);
              }}
            >
              <option value="">New empty workspace (default)</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  Replace {item.guestWorkspaceId}
                </option>
              ))}
            </NativeSelect>
          </label>
          {!target ? (
            <label className="block space-y-1 text-sm">
              New restore workspace ID
              <Input
                value={newWorkspace}
                required
                maxLength={24}
                pattern="[a-z][a-z0-9-]{0,23}"
                disabled={occupied}
                onChange={(event) => setNewWorkspace(event.target.value)}
              />
            </label>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={replace}
                disabled={occupied}
                onChange={(event) => setReplace(event.target.checked)}
              />
              Replace the selected workspace state and retain its original for
              rollback.
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Restore verifies data before activation. Source bindings and runtime
            handles are not reused. Browser authentication may require signing
            in again. The destination must use the backup's storage Worker.
          </p>
          <Button
            type="submit"
            disabled={occupied || Boolean(target && !replace)}
          >
            Restore workspace
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setBackup(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {rollback ? (
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            rollBack.mutate();
          }}
        >
          <p className="text-sm">
            Original target:{" "}
            {instances.find((item) => item.id === rollback.instanceId)?.name ??
              rollback.instanceId}{" "}
            · Workspace{" "}
            {workspaces.find((item) => item.id === rollback.workspaceId)
              ?.guestWorkspaceId ?? rollback.workspaceId}
            . Undo {rollback.action === "reset" ? "reset" : "restore"}{" "}
            {rollback.operationId}. This replaces its current home with the
            retained original and interrupts managed workspace work. The
            replaced home and subsequent writes are retained; files are not
            merged and old processes are not resumed.
          </p>
          <Button type="submit" disabled={occupied}>
            Confirm rollback
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setRollback(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <h4 className="text-sm font-medium">Backups and operation history</h4>
        <Button
          variant="ghost"
          disabled={operations.isFetching}
          onClick={() => void operations.refetch()}
        >
          Refresh history
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Observe reads durable evidence. Recover reconciles interrupted work.
        Continue explicitly authorizes a verified current runtime to finish
        known staged work; it never repeats an uncertain reset, capture or
        upload.
      </p>
      {operations.data?.pages
        .flatMap((page) => page.items)
        .map((entry) => (
          <CantripOsBackupEntry
            key={entry.operationId}
            entry={entry}
            pending={pending}
            destination={`${instances.find((item) => item.id === entry.instanceId)?.name ?? entry.instanceId} · Workspace ${workspaces.find((item) => item.id === entry.workspaceId)?.guestWorkspaceId ?? entry.workspaceId} · Worker ${workerNames[entry.workerId] ?? entry.workerId}`}
            onRestore={(item) => {
              setBackup(item);
              setRollback(null);
              setTarget("");
              setReplace(false);
              setNewWorkspace(`restore-${crypto.randomUUID().slice(0, 12)}`);
            }}
            onRollback={(item) => {
              setRollback(item);
              setBackup(null);
            }}
            onRecover={(item, mode) => recover.mutate({ entry: item, mode })}
          />
        ))}
      {operations.isSuccess && !operations.data.pages[0]?.items.length ? (
        <p className="text-sm text-muted-foreground">
          No backup operations yet.
        </p>
      ) : null}
      {operations.hasNextPage ? (
        <Button
          variant="ghost"
          disabled={operations.isFetchingNextPage}
          onClick={() => void operations.fetchNextPage()}
        >
          Load older operations
        </Button>
      ) : null}
    </section>
  );
}
