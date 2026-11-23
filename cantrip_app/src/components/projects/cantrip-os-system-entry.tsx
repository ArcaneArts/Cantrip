import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { clientEncryption } from "@/lib/client-encryption";
import { errorMessage } from "@/lib/error-message";
import { openCantripOsSystemResult } from "@/lib/cantrip-os-system-encryption";
import type { CantripOsSystemSummary } from "@/lib/cantrip-os-system-draft";
import {
  observeCantripOsSystemOperation,
  controlCantripOsSystemOperation,
  recoverCantripOsSystemOperation,
} from "@/lib/api/cantrip-os-systems";

export function cantripOsSystemActionLabel(
  entry: Pick<CantripOsSystemSummary, "request">,
) {
  const request = entry.request;
  return request.action === "capture"
    ? "System checkpoint"
    : request.action === "rollback"
      ? "Replacement rollback"
      : request.source.kind === "base"
        ? "Base-image reset"
        : "Checkpoint restore";
}
const states = {
  admitted: "Admitted",
  running: "In progress",
  ready: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown",
  rejected: "Not dispatched",
};
export const cantripOsSystemStateLabel = (entry: CantripOsSystemSummary) =>
  states[entry.state];
export function canRecoverSystemIdentity(
  entry: CantripOsSystemSummary,
  instance: CantripOsInstanceSummary,
  managementSupported: boolean,
) {
  return (
    entry.instanceId === instance.id &&
    entry.workerId === instance.workerId &&
    !entry.retiredBy &&
    entry.state === "ready" &&
    entry.request.action !== "capture" &&
    Boolean(entry.root?.targetContainerId) &&
    instance.attachmentGeneration === entry.attachmentGeneration &&
    managementSupported
  );
}
export function CantripOsSystemEntry({
  entry,
  instance,
  account,
  pending,
  managementSupported,
  onRun,
  onRecovery,
  onRollback,
}: {
  entry: CantripOsSystemSummary;
  instance: CantripOsInstanceSummary;
  account: string;
  pending: boolean;
  managementSupported: boolean;
  onRun(run: () => Promise<CantripOsSystemSummary>): void;
  onRecovery(run: () => Promise<CantripOsInstanceSummary>): void;
  onRollback(entry: CantripOsSystemSummary): void;
}) {
  const snapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
  );
  const [opened, setOpened] = useState<{
    entry: CantripOsSystemSummary;
    snapshot: typeof snapshot;
    value?: Awaited<ReturnType<typeof openCantripOsSystemResult>>;
    error?: string;
  } | null>(null);
  const [opening, setOpening] = useState(false),
    active = useRef<object | null>(null);
  useEffect(() => {
    active.current = null;
    setOpened(null);
    setOpening(false);
    return () => {
      active.current = null;
    };
  }, [entry, snapshot, account]);
  const visible =
    opened?.entry === entry &&
    opened.snapshot === snapshot &&
    snapshot.status === "ready"
      ? opened
      : null;
  const terminal = ["ready", "failed", "rejected"].includes(entry.state);
  const owned =
    entry.instanceId === instance.id && entry.workerId === instance.workerId;
  const originalFence =
    owned && instance.attachmentGeneration === entry.attachmentGeneration;
  const recovered =
    entry.recoveryGeneration !== null &&
    instance.attachmentGeneration === entry.recoveryGeneration;
  const canRecover = canRecoverSystemIdentity(
    entry,
    instance,
    managementSupported,
  );
  async function inspect() {
    const token = {};
    active.current = token;
    setOpening(true);
    try {
      const value = await openCantripOsSystemResult(entry);
      if (
        active.current === token &&
        clientEncryption.getSnapshot() === snapshot
      )
        setOpened({ entry, snapshot, value });
    } catch (error) {
      if (active.current === token)
        setOpened({ entry, snapshot, error: errorMessage(error) });
    } finally {
      if (active.current === token) setOpening(false);
    }
  }
  return (
    <article
      className="space-y-2 rounded-md border p-3"
      aria-label={`System operation ${entry.operationId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <strong>
          {cantripOsSystemActionLabel(entry)} · {states[entry.state]}
        </strong>
        <span className="text-muted-foreground">
          {new Date(entry.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {entry.operationId}
      </p>
      {!terminal ? (
        <p className="text-xs text-muted-foreground">
          {entry.dispatchStage === "preparing"
            ? "Execution has not been dispatched."
            : "Execution was authorized; check the original outcome before continuing."}
        </p>
      ) : null}
      {entry.retiredBy ? (
        <p className="text-xs text-muted-foreground">
          A rollback retired this replacement. Its continuation is no longer
          available.
        </p>
      ) : null}
      {recovered ? (
        <p className="text-xs text-muted-foreground">
          System identity recovered. Use Check recovery and verify the intended
          source before opening fresh work.
        </p>
      ) : null}
      {entry.state === "ready" && entry.request.action === "capture" ? (
        <p className="text-xs text-muted-foreground">
          Root customization captured. Mounted workspace files are excluded. Use
          Check recovery before opening fresh work.
        </p>
      ) : null}
      {entry.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {entry.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            onRun(() => observeCantripOsSystemOperation(entry, account))
          }
        >
          Check original operation
        </Button>
        {entry.protectedResult ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={opening || snapshot.status !== "ready"}
            onClick={() => {
              if (visible) setOpened(null);
              else void inspect();
            }}
          >
            {visible
              ? "Hide private outcome"
              : opening
                ? "Opening private outcome…"
                : "Inspect private outcome"}
          </Button>
        ) : null}
        {!terminal &&
        !entry.retiredBy &&
        originalFence &&
        managementSupported ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                onRun(() =>
                  controlCantripOsSystemOperation(entry, "continue", account),
                )
              }
            >
              Continue original operation
            </Button>
            {entry.dispatchStage === "preparing" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  onRun(() =>
                    controlCantripOsSystemOperation(entry, "abandon", account),
                  )
                }
              >
                Abandon before execution
              </Button>
            ) : null}
          </>
        ) : null}
        {canRecover ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              onRecovery(() => recoverCantripOsSystemOperation(entry, account))
            }
          >
            Recover resulting system
          </Button>
        ) : null}
        {owned &&
        managementSupported &&
        entry.request.action === "replace" &&
        entry.dispatchStage === "executing" &&
        entry.state !== "rejected" &&
        !entry.retiredBy ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => onRollback(entry)}
          >
            Roll back replacement
          </Button>
        ) : null}
      </div>
      {entry.protectedResult && snapshot.status !== "ready" ? (
        <p className="text-xs text-muted-foreground">
          Unlock encryption to inspect the private system outcome.
        </p>
      ) : null}
      {canRecover ? (
        <p className="text-xs text-muted-foreground">
          Recovery adopts only this completed transition’s exact system
          identity. Old chats, terminals and desktop handles remain retired.
        </p>
      ) : null}
      {visible ? (
        <div className="space-y-2">
          {visible.error ? (
            <p role="alert" className="text-sm text-destructive">
              {visible.error}
            </p>
          ) : (
            <pre
              className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs"
              aria-label="Private system outcome"
            >
              {JSON.stringify(visible.value, null, 2)}
            </pre>
          )}
        </div>
      ) : null}
    </article>
  );
}
