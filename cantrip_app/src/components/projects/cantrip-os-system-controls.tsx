import { useState } from "react";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  CantripOsSystemEntry,
  cantripOsSystemActionLabel,
  cantripOsSystemStateLabel,
  canRecoverSystemIdentity,
} from "./cantrip-os-system-entry";
import { useCantripOsSystems } from "./use-cantrip-os-systems";
import type {
  CantripOsSystemIntent,
  CantripOsSystemSummary,
} from "@/lib/cantrip-os-system-draft";

export function CantripOsSystemControls({
  instance,
  onChanged,
}: {
  instance: CantripOsInstanceSummary;
  onChanged(): void;
}) {
  const state = useCantripOsSystems(instance, onChanged);
  const [checkpoint, setCheckpoint] = useState(""),
    [base, setBase] = useState("");
  const target = state.status?.target;
  const checkpoints = state.entries.filter(
    (entry) => entry.request.action === "capture" && entry.state === "ready",
  );
  const selectedCheckpoint = checkpoints.find(
    (entry) => entry.operationId === checkpoint,
  );
  const selectedBase = state.status?.bases.find(
    (image) => image.imageId === base,
  );
  const disabled =
    !state.account || state.pending || Boolean(state.saved.draft);
  function choose(intent: CantripOsSystemIntent) {
    if (!target) return;
    state.choose(
      {
        instanceId: target.instanceId,
        workerId: target.workerId,
        attachmentGeneration: target.attachmentGeneration,
        targetGeneration: target.generation,
      },
      intent,
    );
  }
  function rollback(entry: CantripOsSystemSummary) {
    state.choose(
      {
        instanceId: instance.id,
        workerId: instance.workerId,
        attachmentGeneration: instance.attachmentGeneration,
        targetGeneration: entry.targetGeneration,
      },
      {
        action: "rollback",
        replacementOperationId: entry.operationId,
        startTarget: true,
      },
    );
  }
  const review = state.review?.draft.request;
  const replacesSaved =
    review?.action === "rollback" &&
    state.saved.draft?.request.operationId === review.replacementOperationId;
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label="System checkpoints and recovery"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">System checkpoints and recovery</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={!state.account || state.pending}
          onClick={state.changed}
        >
          Refresh system
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Preserve or replace shared system customization on {instance.name}.
        Mounted workspace files keep their current contents; use workspace
        backups to restore those files.
      </p>
      {state.failure ? (
        <p role="alert" className="text-sm text-destructive">
          {state.failure}
        </p>
      ) : null}
      {state.status?.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.status.error}
        </p>
      ) : null}
      {state.status && !state.status.supported ? (
        <p className="text-sm text-muted-foreground">
          System image management needs the owning Worker’s Docker control path.
          SSH alone cannot replace a machine’s system image.
        </p>
      ) : null}
      {target ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Destination: {instance.name} ·{" "}
            {target.architecture ?? "Architecture not reported"} ·{" "}
            {target.running === null
              ? "Power state not reported"
              : target.running
                ? "Running"
                : "Stopped"}
          </p>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => choose({ action: "capture", resumeOriginal: true })}
          >
            Create system checkpoint
          </Button>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              System checkpoint
              <NativeSelect
                className="w-full"
                aria-label="System checkpoint"
                value={selectedCheckpoint?.operationId ?? ""}
                disabled={disabled}
                onChange={(event) => setCheckpoint(event.target.value)}
              >
                <option value="">Choose a completed checkpoint</option>
                {checkpoints.map((entry) => (
                  <option key={entry.operationId} value={entry.operationId}>
                    {new Date(entry.createdAt).toLocaleString()} ·{" "}
                    {entry.operationId.slice(0, 8)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button
              variant="ghost"
              disabled={disabled || !selectedCheckpoint}
              onClick={() =>
                selectedCheckpoint &&
                choose({
                  action: "replace",
                  source: {
                    kind: "checkpoint",
                    operationId: selectedCheckpoint.operationId,
                  },
                  startTarget: true,
                })
              }
            >
              Restore system checkpoint
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              Base image
              <NativeSelect
                className="w-full"
                aria-label="System base image"
                value={selectedBase?.imageId ?? ""}
                disabled={disabled}
                onChange={(event) => setBase(event.target.value)}
              >
                <option value="">Choose an observed base image</option>
                {state.status?.bases.map((image) => (
                  <option key={image.imageId} value={image.imageId}>
                    {image.tags.find((tag) => tag !== "<none>:<none>") ??
                      "Base image"}{" "}
                    · {image.imageId.slice(7, 19)} · {image.architecture}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button
              variant="ghost"
              disabled={disabled || !selectedBase}
              onClick={() =>
                selectedBase &&
                choose({
                  action: "replace",
                  source: { kind: "base", imageId: selectedBase.imageId },
                  startTarget: true,
                })
              }
            >
              Reset system to base image
            </Button>
          </div>
          {state.status?.bases.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No reusable base image is available. Build or load a CantripOS
              foundation image on the owning Worker to enable a base reset.
            </p>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <div
          className="space-y-3 rounded-md border p-3"
          role="group"
          aria-label="Review system action"
        >
          <strong className="text-sm">
            Review{" "}
            {cantripOsSystemActionLabel({ request: review }).toLowerCase()}
          </strong>
          <p className="text-sm">
            Destination: {instance.name}. This affects every workspace on this
            instance and may stop its applications and processes.
          </p>
          <p className="text-sm text-muted-foreground">
            {review.action === "capture"
              ? "Capture the root filesystem, including installed software and shared configuration. A running instance is stopped for consistency and then resumed. Mounted files are excluded."
              : review.action === "rollback"
                ? "Return to the exact original container retained by this replacement. Keep the replaced container and its later root changes. Mounted files retain their current contents."
                : review.source.kind === "base"
                  ? "Reset the root filesystem to the selected base image. Root customization does not merge into the base; the original writable layer remains in its retained container for rollback."
                  : "Restore the checkpoint’s root customization. Keep the original writable layer in its retained container for rollback. Mounted files retain their current contents."}
          </p>
          {review.action === "replace" ? (
            <p className="break-all text-xs text-muted-foreground">
              Selected{" "}
              {review.source.kind === "base"
                ? `image: ${review.source.imageId}`
                : `checkpoint: ${review.source.operationId}`}
            </p>
          ) : review.action === "rollback" ? (
            <p className="break-all text-xs text-muted-foreground">
              Original replacement: {review.replacementOperationId}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Old execution and desktop handles are retired. Explicit recovery and
            source verification are required before opening fresh work.
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={
                !state.account ||
                state.pending ||
                (Boolean(state.saved.draft) && !replacesSaved)
              }
              onClick={state.confirm}
            >
              Confirm system action
            </Button>
            <Button variant="ghost" onClick={state.cancelReview}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {state.saved.draft ? (
        <div
          className="space-y-2 rounded-md border p-3"
          aria-label="Saved system request"
        >
          <p className="text-sm">
            {state.saved.draft.submitted
              ? "A system request was sent. Check its original admission before making another request."
              : "This exact request was saved before sending. You can resume it without creating another UUID."}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {state.saved.draft.request.operationId}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={state.pending || !state.account}
              onClick={state.checkSaved}
            >
              {state.saved.draft.submitted
                ? "Observe saved system request"
                : "Send saved system request"}
            </Button>
            {state.saved.draft.submitted ? (
              <Button
                variant="ghost"
                disabled={state.pending || !state.account}
                onClick={state.resubmitSaved}
              >
                Retry same admission
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={state.pending || !state.account}
              onClick={state.dismiss}
            >
              Dismiss saved reminder
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Retry uses the same saved UUID and request. An existing admission is
            only observed. Dismissing a reminder does not cancel an admitted
            operation.
          </p>
        </div>
      ) : null}
      {state.recovered ? (
        <p role="status" className="text-sm text-muted-foreground">
          System identity recovered. Use Check recovery and verify the intended
          source before opening fresh work.
        </p>
      ) : null}
      {state.entries[0] ? (
        <p role="status" className="text-sm text-muted-foreground">
          Latest recorded action: {cantripOsSystemActionLabel(state.entries[0])}{" "}
          · {cantripOsSystemStateLabel(state.entries[0])}
        </p>
      ) : null}
      <details
        className="space-y-2"
        open={state.entries.some(
          (entry) =>
            (!["ready", "failed", "rejected"].includes(entry.state) &&
              !entry.retiredBy) ||
            canRecoverSystemIdentity(
              entry,
              instance,
              state.status?.supported !== false,
            ),
        )}
      >
        <summary className="cursor-pointer text-sm font-medium">
          System history
        </summary>
        {state.account
          ? state.entries.map((entry) => (
              <CantripOsSystemEntry
                key={entry.operationId}
                entry={entry}
                instance={instance}
                account={state.account!}
                pending={state.pending}
                managementSupported={state.status?.supported !== false}
                onRun={state.runOperation}
                onRecovery={state.runRecovery}
                onRollback={rollback}
              />
            ))
          : null}
        {state.history.hasNextPage ? (
          <Button
            variant="ghost"
            disabled={state.history.isFetchingNextPage}
            onClick={() => void state.history.fetchNextPage()}
          >
            Load older system operations
          </Button>
        ) : null}
        {!state.entries.length ? (
          <p className="text-xs text-muted-foreground">
            No system operations recorded.
          </p>
        ) : null}
      </details>
    </section>
  );
}
