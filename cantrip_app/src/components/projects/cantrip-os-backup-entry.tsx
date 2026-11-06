import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { clientEncryption } from "@/lib/client-encryption";
import { errorMessage } from "@/lib/error-message";
import {
  openCantripOsBackupDetails,
  type CantripOsBackupSummary,
  type CantripOsBackupDetails,
} from "@/lib/api/cantrip-os-backups";

export function CantripOsBackupEntry({
  entry,
  destination,
  pending,
  onRestore,
  onRollback,
  onRecover,
}: {
  entry: CantripOsBackupSummary;
  destination: string;
  pending: boolean;
  onRestore(entry: CantripOsBackupSummary): void;
  onRollback(entry: CantripOsBackupSummary): void;
  onRecover(
    entry: CantripOsBackupSummary,
    mode: "observe" | "recover" | "continue",
  ): void;
}) {
  const snapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
  );
  const [opened, setOpened] = useState<{
    snapshot: typeof snapshot;
    entry: CantripOsBackupSummary;
    details?: CantripOsBackupDetails;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (snapshot.status !== "ready") {
      setOpened(null);
      return;
    }
    void openCantripOsBackupDetails(entry).then(
      (details) => {
        if (current) setOpened({ snapshot, entry, details });
      },
      (error) => {
        if (current) setOpened({ snapshot, entry, error: errorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [entry, snapshot]);
  const current =
    opened?.snapshot === snapshot && opened.entry === entry ? opened : null;
  const details = current?.details;
  const failure = current?.error;
  const result = details?.result;
  const success =
    entry.result?.state === "ready" && result && result.action !== "error";
  return (
    <article className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <strong>
          {details?.intent.action === "capture"
            ? details.intent.label || "Workspace backup"
            : `${entry.action === "restore" ? "Restore" : entry.action === "rollback" ? "Rollback" : "Backup"} operation`}
        </strong>
        <span>
          {entry.result?.state ?? "admitted"}
          {entry.result ? ` · ${entry.result.phase}` : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {destination} · {new Date(entry.createdAt).toLocaleString()}
      </p>
      <code className="block break-all text-xs">{entry.operationId}</code>
      {entry.action === "capture" ? (
        <p className="text-xs text-muted-foreground">
          {entry.archiveAvailability === "worker-offline"
            ? "Storage Worker is offline. Capture history does not confirm current archive availability."
            : "Archive availability has not been checked. Restore authenticates the complete archive before activation."}
        </p>
      ) : null}
      {snapshot.status !== "ready" ? (
        <p className="text-sm">
          Unlock encryption to read private backup details.
        </p>
      ) : failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {result?.action === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {result.message}
        </p>
      ) : entry.result?.error ? (
        <p className="text-sm">{entry.result.error}</p>
      ) : null}
      {result && result.action !== "error" ? (
        <>
          {result.action === "capture" ? (
            <p className="text-xs">
              {result.metadata.archiveBytes.toLocaleString()} archive bytes ·
              Files and profiles retained; live processes are not backed up.
            </p>
          ) : null}
          {result.cleanupWarnings.map((warning, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          <details className="text-xs">
            <summary className="cursor-pointer">
              Private{" "}
              {result.action === "capture"
                ? "manifest and exclusions"
                : "restore receipt"}
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                result.action === "capture"
                  ? result.metadata.manifest
                  : result.receipt,
                null,
                2,
              )}
            </pre>
          </details>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => onRecover(entry, "observe")}
        >
          Observe outcome
        </Button>
        {entry.result?.state !== "ready" ? (
          <>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onRecover(entry, "recover")}
            >
              Recover interrupted operation
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onRecover(entry, "continue")}
            >
              Continue staged operation
            </Button>
          </>
        ) : null}
        {success && entry.action === "capture" ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onRestore(entry)}
          >
            Restore backup
          </Button>
        ) : null}
        {success && entry.action === "restore" ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onRollback(entry)}
          >
            Roll back restore
          </Button>
        ) : null}
      </div>
    </article>
  );
}
