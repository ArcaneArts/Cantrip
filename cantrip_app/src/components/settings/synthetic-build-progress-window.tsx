import { Check, Circle, CircleAlert, Loader2, OctagonX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  normalizeSyntheticBuildError,
  syntheticBuildClient,
  type SyntheticBuildJob,
  type SyntheticBuildLogEntry,
  type SyntheticBuildStep,
} from "@/lib/synthetic-build";

const CLOSE_REQUEST_EVENT = "cantrip-synthetic-build-close-requested";

function StepIcon({ step }: { step: SyntheticBuildStep }) {
  if (step.state === "complete") {
    return <Check className="size-4 text-emerald-500" />;
  }
  if (step.state === "running") {
    return <Loader2 className="size-4 animate-spin text-primary" />;
  }
  if (step.state === "failed") {
    return <CircleAlert className="size-4 text-destructive" />;
  }
  if (step.state === "cancelled") {
    return <OctagonX className="size-4 text-muted-foreground" />;
  }
  return <Circle className="size-3.5 text-muted-foreground/50" />;
}

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function SyntheticBuildProgressWindow() {
  const [job, setJob] = useState<SyntheticBuildJob | null>(null);
  const [logs, setLogs] = useState<SyntheticBuildLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());
  const consoleRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const appendLogs = (entries: SyntheticBuildLogEntry[]) => {
    if (entries.length === 0) return;
    setLogs((current) => {
      const known = new Set(current.map((entry) => entry.sequence));
      return [
        ...current,
        ...entries.filter((entry) => !known.has(entry.sequence)),
      ]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-10_000);
    });
  };

  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      syntheticBuildClient.listenState((next) => {
        if (!disposed) setJob(next);
      }),
      syntheticBuildClient.listenLogs((batch) => {
        if (!disposed) appendLogs(batch.entries);
      }),
      import("@tauri-apps/api/event").then(({ listen }) =>
        listen(CLOSE_REQUEST_EVENT, () => {
          if (!disposed) setConfirmClose(true);
        }),
      ),
    ])
      .then(async (listeners) => {
        if (disposed) {
          listeners.forEach((dispose) => dispose());
          return;
        }
        disposers.push(...listeners);
        const status = await syntheticBuildClient.status();
        if (disposed) return;
        setJob(status.job);
        const history = await syntheticBuildClient.logs(0, 2_000);
        if (!disposed) appendLogs(history.entries);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(normalizeSyntheticBuildError(reason).message);
      });
    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!followRef.current) return;
    const consoleElement = consoleRef.current;
    if (consoleElement) consoleElement.scrollTop = consoleElement.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (
      !cancelling ||
      !job ||
      job.state === "queued" ||
      job.state === "running"
    ) {
      return;
    }
    void import("@tauri-apps/api/webviewWindow").then(
      ({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().close(),
    );
  }, [cancelling, job]);

  const currentStep = useMemo(
    () => job?.steps.find((step) => step.id === job.stepId) ?? null,
    [job],
  );
  const active = job?.state === "queued" || job?.state === "running";

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {job
              ? `Building Cantrip ${job.version}`
              : "Synthetic Cantrip build"}
          </h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {job
              ? `${job.targetSha.slice(0, 12)} · ${job.platform}`
              : "Loading build state…"}
          </p>
        </div>
        {job ? (
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            <div>{elapsed(job.startedAt, now)}</div>
            <div>{job.progress}% complete</div>
          </div>
        ) : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r px-3 py-4">
          <ol className="grid gap-1">
            {job?.steps.map((step) => (
              <li
                key={step.id}
                className={`flex gap-2 rounded-md px-2 py-2 text-xs ${
                  step.state === "running" ? "bg-muted font-medium" : ""
                }`}
              >
                <span className="mt-0.5 shrink-0">
                  <StepIcon step={step} />
                </span>
                <span className="min-w-0">
                  <span className="block">{step.label}</span>
                  {step.message && step.state !== "complete" ? (
                    <span className="mt-0.5 block text-muted-foreground">
                      {step.message}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </aside>

        <section className="min-h-0 bg-black text-zinc-200">
          <div
            ref={consoleRef}
            role="log"
            aria-live="polite"
            aria-label="Synthetic build console"
            className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 selection:bg-sky-700/60"
            onScroll={(event) => {
              const element = event.currentTarget;
              followRef.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                32;
            }}
          >
            {logs.length > 0
              ? logs.map((entry) => (
                  <div
                    key={entry.sequence}
                    className={
                      entry.stream === "stderr" ? "text-amber-200" : undefined
                    }
                  >
                    {entry.message}
                  </div>
                ))
              : (error ??
                (active
                  ? "Waiting for build output…"
                  : "No build output is available."))}
          </div>
        </section>
      </div>

      <footer className="border-t bg-background">
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
          <span className="truncate">
            {job?.state === "ready-to-install"
              ? "Build complete. Ready to install."
              : job?.state === "failed"
                ? (job.error?.message ?? "Build failed.")
                : job?.state === "cancelled"
                  ? "Build cancelled."
                  : (currentStep?.label ?? "Preparing build…")}
          </span>
          <span className="shrink-0 font-mono text-muted-foreground">
            {job?.progress ?? 0}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job?.progress ?? 0}
          className="h-1 bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${job?.progress ?? 0}%` }}
          />
        </div>
      </footer>

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent className="max-w-md" showClose={!cancelling}>
          <DialogHeader>
            <DialogTitle>Cancel build?</DialogTitle>
            <DialogDescription>
              Closing this window will stop the complete build process. Verified
              downloads and shared caches will remain available for another
              build.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={cancelling}
              onClick={() => setConfirmClose(false)}
            >
              Keep building
            </Button>
            <Button
              type="button"
              variant="destructive"
              pending={cancelling}
              pendingLabel="Cancelling…"
              onClick={() => {
                if (!job || cancelling) return;
                setCancelling(true);
                void syntheticBuildClient
                  .cancel(job.id)
                  .catch((reason: unknown) => {
                    setError(normalizeSyntheticBuildError(reason).message);
                    setCancelling(false);
                  });
              }}
            >
              Cancel build
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
