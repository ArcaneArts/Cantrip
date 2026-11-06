import { useRef, useState } from "react";
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
  const activeMutation = useRef(false);
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
    queryKey: ["cantrip-os-backup-operations"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getCantripOsBackupOperations(pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  function retain(draft: CantripOsBackupDraft) {
    saveCantripOsBackupDraft(draft);
    setDraftState({ draft });
    return draft;
  }
  const changed = () => {
    void queryClient.invalidateQueries({
      queryKey: ["cantrip-os-backup-operations"],
    });
    onChanged();
  };
  async function exclusive<T>(action: () => Promise<T>, creating = false) {
    if (activeMutation.current)
      throw new Error("A backup action is already in progress.");
    activeMutation.current = true;
    try {
      if (creating && readCantripOsBackupDraft(instance.id))
        throw new Error(
          "Resume or discard the saved request before creating another operation.",
        );
      return await action();
    } finally {
      activeMutation.current = false;
    }
  }
  async function prepare(
    intent: CantripOsBackupIntent,
  ): Promise<CantripOsBackupDraft> {
    const current = (await refreshCantripOs(instance.id)).instance;
    if (current.attachmentGeneration !== instance.attachmentGeneration)
      throw new Error(
        "The instance attachment changed. Select and verify the intended instance again.",
      );
    return retain({
      stage: "admission",
      instanceId: instance.id,
      admission: await prepareCantripOsBackup(current, intent),
    });
  }
  async function execute(draft: CantripOsBackupDraft) {
    if (draft.stage === "workspace") {
      const plan = draft;
      let observed = await refreshCantripOs(plan.instanceId);
      if (observed.instance.attachmentGeneration !== plan.attachmentGeneration)
        throw new Error(
          "The restore destination was reattached. Its saved request was not redirected.",
        );
      // Observe this operation's receipt, never adopt an account merely because
      // another account happens to have the requested name.
      const creation = await createCantripOsWorkspace(plan.instanceId, {
        guestWorkspaceId: plan.guestWorkspaceId,
        operationId: plan.operationId,
      });
      if (creation.state !== "ready")
        throw new Error(
          creation.error ??
            `Workspace creation is ${creation.state}. Resume this saved request to observe its original operation.`,
        );
      if (
        creation.receipt.kind !== "workspace" ||
        creation.receipt.workspace.guestWorkspaceId !== plan.guestWorkspaceId
      )
        throw new Error(
          "The new workspace receipt differs from the saved restore plan.",
        );
      observed = await refreshCantripOs(plan.instanceId);
      if (observed.instance.attachmentGeneration !== plan.attachmentGeneration)
        throw new Error(
          "The restore destination attachment changed during workspace creation.",
        );
      const destination = observed.workspaces.find(
        (item) => item.guestWorkspaceId === plan.guestWorkspaceId,
      );
      if (!destination)
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
    clearCantripOsBackupDraft(instance.id);
    setDraftState({ draft: null });
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
        // Save the account-creation identity BEFORE sending it. Lost replies and
        // reloads resume this exact plan, never a second generated workspace.
        return execute(
          retain({
            stage: "workspace",
            instanceId: instance.id,
            attachmentGeneration: instance.attachmentGeneration,
            backupId: backup.operationId,
            guestWorkspaceId: newWorkspace,
            operationId: crypto.randomUUID(),
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
            "Select the restore's original instance to roll it back.",
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
    }) => {
      if (mode !== "continue") return recoverCantripOsBackup(entry, { mode });
      const current = (await refreshCantripOs(entry.instanceId)).instance;
      if (!current.runtimeGeneration)
        throw new Error("The intended instance has no observed runtime.");
      return recoverCantripOsBackup(entry, {
        mode,
        attachmentGeneration: current.attachmentGeneration,
        runtimeGeneration: current.runtimeGeneration,
      });
    },
    onSettled: changed,
  });
  const pending =
    capture.isPending ||
    restore.isPending ||
    rollBack.isPending ||
    resume.isPending ||
    recover.isPending;
  const occupied = pending || Boolean(draftState.draft || draftState.error);
  const lastAction = [capture, restore, rollBack, resume, recover].reduce(
    (latest, action) =>
      action.submittedAt > latest.submittedAt ? action : latest,
  );
  const error = lastAction.error ?? operations.error;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">Private backups</h3>
      <p className="text-sm text-muted-foreground">
        Backups are encrypted on the owning Worker. Capture, restore and
        rollback interrupt managed work across this OS's workspaces. The
        personal desktop is independent. Ignored files are included unless
        explicitly excluded.
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
              clearCantripOsBackupDraft(instance.id);
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
            Roll back restore {rollback.operationId}. This replaces its current
            home with the retained original and interrupts managed workspace
            work.
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
        known staged work; it never repeats an uncertain capture or upload.
      </p>
      {operations.data?.pages
        .flatMap((page) => page.items)
        .map((entry) => (
          <CantripOsBackupEntry
            key={entry.operationId}
            entry={entry}
            pending={occupied}
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
