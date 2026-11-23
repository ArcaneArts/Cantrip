import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CantripOsPackageSummary } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { clientEncryption } from "@/lib/client-encryption";
import { errorMessage } from "@/lib/error-message";
import { openCantripOsPackageResult } from "@/lib/cantrip-os-package-encryption";
import {
  observeCantripOsPackageOperation,
  controlCantripOsPackageOperation,
} from "@/lib/api/cantrip-os-packages";

const states = {
  admitted: "Admitted",
  running: "In progress",
  ready: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown",
};
export function CantripOsPackageEntry({
  entry,
  accountKey,
  pending,
  canControl,
  onRun,
}: {
  entry: CantripOsPackageSummary;
  accountKey: string;
  pending: boolean;
  canControl: boolean;
  onRun(run: () => Promise<CantripOsPackageSummary>): void;
}) {
  const snapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
  );
  const [opened, setOpened] = useState<{
    entry: CantripOsPackageSummary;
    snapshot: typeof snapshot;
    value?: Awaited<ReturnType<typeof openCantripOsPackageResult>>;
    error?: string;
  } | null>(null);
  const [opening, setOpening] = useState(false),
    [control, setControl] = useState<"continue" | "abandon" | null>(null);
  const active = useRef<object | null>(null);
  useEffect(() => {
    active.current = null;
    setOpened(null);
    setOpening(false);
    setControl(null);
    return () => {
      active.current = null;
    };
  }, [entry, snapshot, accountKey]);
  const visible =
    opened?.entry === entry &&
    opened.snapshot === snapshot &&
    snapshot.status === "ready"
      ? opened
      : null;
  const terminal = entry.state === "ready" || entry.state === "failed";
  async function inspect() {
    const token = {};
    active.current = token;
    setOpening(true);
    try {
      const value = await openCantripOsPackageResult(entry);
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
      aria-label={`Package operation ${entry.operationId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <strong>
          {entry.action === "repair" ? "Repair" : "Update"} ·{" "}
          {states[entry.state]}
        </strong>
        <span className="text-muted-foreground">
          {new Date(entry.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {entry.operationId}
      </p>
      <ul className="space-y-1 text-xs">
        {entry.packages.map((pkg) => (
          <li key={pkg.name}>
            {pkg.name} {pkg.version} · {pkg.architecture} ·{" "}
            {pkg.sha256.slice(0, 12)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {entry.configuration === "preserve"
          ? "Keep configuration"
          : "Use package defaults"}
        {entry.phase === "ready-to-install" ? " · Waiting to start" : ""}
      </p>
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
            onRun(() => observeCantripOsPackageOperation(entry, accountKey))
          }
        >
          Check original operation
        </Button>
        {entry.protectedResult ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={opening}
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
        {!terminal && canControl ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setControl("continue")}
            >
              Continue staging
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setControl("abandon")}
            >
              Abandon before start
            </Button>
          </>
        ) : null}
      </div>
      {control ? (
        <div
          className="space-y-2 rounded-md border p-3"
          aria-label={`Confirm ${control} package operation`}
        >
          <p className="text-sm">
            {control === "continue"
              ? "Continue this original request with its selected builds and configuration choice. Installation may start if it is still staged."
              : "Abandon this request before installation starts. An installer already running will continue."}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                const mode = control;
                setControl(null);
                onRun(() =>
                  controlCantripOsPackageOperation(entry, mode, accountKey),
                );
              }}
            >
              Confirm {control === "continue" ? "continuation" : "abandonment"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setControl(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {opened?.error &&
      opened.entry === entry &&
      opened.snapshot === snapshot ? (
        <p role="alert" className="text-sm text-destructive">
          {opened.error}
        </p>
      ) : null}
      {visible?.value ? (
        <pre
          aria-label="Private package outcome"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
        >
          {JSON.stringify(visible.value, null, 2)}
        </pre>
      ) : null}
    </article>
  );
}
