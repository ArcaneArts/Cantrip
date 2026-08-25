import type {
  CodeAppearance,
  CodeAttachment,
  CodeSettingsResolution,
  CodeSettingsWorkerStatus,
  CodeSettingsWorkbenchAttachmentWire,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  createProtectedCodeSettingsAttachment,
  getCodeSettingsWorkerStatus,
  getWorkers,
  releaseCodeAttachment,
  resolveCodeSettingsWorker,
  synchronizeCodeSettingsWorker,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  CodeWorkbenchFrameLoadTracker,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
} from "@/lib/code-workbench-frame";
import {
  openDirectCodeAttachmentSettings,
  preferProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  stopDirectCodeAttachment,
} from "@/lib/desktop-code";
import { errorMessage } from "@/lib/error-message";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import {
  retireAttachmentBestEffort,
  SerializedAttachmentLifecycle,
} from "@/lib/serialized-attachment-lifecycle";
import { cn } from "@/lib/utils";

const WORKER_REFRESH_MS = 5_000;
const SETTINGS_STATUS_REFRESH_MS = 3_000;
const DIRECT_HEALTH_REFRESH_MS = 5_000;

function workerCanHostCodeSettings(worker: WorkerSummary): boolean {
  return (
    worker.online &&
    worker.code.available &&
    worker.encryption.supported &&
    ["pending-approval", "ready"].includes(worker.encryption.state)
  );
}

export function selectCodeSettingsWorker(
  workers: readonly WorkerSummary[],
  defaultWorkerId: string | null,
): WorkerSummary | null {
  const eligible = workers.filter(workerCanHostCodeSettings);
  return (
    eligible.find(({ workerId }) => workerId === defaultWorkerId) ??
    eligible[0] ??
    null
  );
}

function statusMessage(status: CodeSettingsWorkerStatus | null): string {
  if (!status) return "Preparing encrypted settings…";
  if (status.state === "conflict") {
    return `${status.conflictCount} conflicting ${status.conflictCount === 1 ? "setting needs" : "settings need"} a decision.`;
  }
  if (status.initializedFromWorker && status.revision === 1) {
    return "Global Code settings were initialized from this worker.";
  }
  if (status.state === "ready") {
    return status.revision
      ? `Encrypted settings synchronized · revision ${status.revision}`
      : "Encrypted settings synchronized";
  }
  return status.error ?? `Code settings are ${status.state}.`;
}

export function CodeSettings({
  active,
  appearance,
  defaultWorkerId,
}: {
  active: boolean;
  appearance: CodeAppearance;
  defaultWorkerId: string | null;
}) {
  const queryClient = useQueryClient();
  const resourcesLive = useAppLiveStatus() === "live";
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: liveResourceRefreshInterval(
      resourcesLive,
      WORKER_REFRESH_MS,
    ),
  });
  const eligibleWorkers = (workers.data ?? []).filter(
    workerCanHostCodeSettings,
  );
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<CodeAttachment | null>(null);
  const [synchronization, setSynchronization] =
    useState<CodeSettingsWorkerStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [frameDocumentVersion, setFrameDocumentVersion] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameReadyNonce, setFrameReadyNonce] = useState<string | null>(null);
  const [openedNonce, setOpenedNonce] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameLoadsRef = useRef(new CodeWorkbenchFrameLoadTracker());
  const connectionGeneration = useRef(0);
  const lifecycleRef =
    useRef<SerializedAttachmentLifecycle<CodeSettingsWorkbenchAttachmentWire> | null>(
      null,
    );
  lifecycleRef.current ??=
    new SerializedAttachmentLifecycle<CodeSettingsWorkbenchAttachmentWire>(
      (wire) =>
        retireAttachmentBestEffort(
          () => stopDirectCodeAttachment(wire.attachment),
          () => releaseCodeAttachment(wire.attachment.attachmentId),
        ),
    );

  useEffect(() => {
    if (selectedWorkerId !== null || workers.isLoading) return;
    setSelectedWorkerId(
      selectCodeSettingsWorker(workers.data ?? [], defaultWorkerId)?.workerId ??
        null,
    );
  }, [defaultWorkerId, selectedWorkerId, workers.data, workers.isLoading]);

  const selectedWorker = (workers.data ?? []).find(
    ({ workerId }) => workerId === selectedWorkerId,
  );
  const status = useQuery({
    enabled: Boolean(selectedWorkerId && attachment),
    queryFn: () => getCodeSettingsWorkerStatus(selectedWorkerId!),
    queryKey: ["code-settings-worker-status", selectedWorkerId],
    // Conflict/offline state can change locally without a server live event.
    refetchInterval: SETTINGS_STATUS_REFRESH_MS,
    retry: false,
  });

  useEffect(() => {
    if (status.data) setSynchronization(status.data);
  }, [status.data]);

  const retry = useCallback(() => {
    const fallback = selectCodeSettingsWorker(
      workers.data ?? [],
      defaultWorkerId,
    );
    if (!selectedWorker || !workerCanHostCodeSettings(selectedWorker)) {
      setSelectedWorkerId(fallback?.workerId ?? null);
      setReloadVersion((version) => version + 1);
      return;
    }
    setConnecting(true);
    void synchronizeCodeSettingsWorker(selectedWorker.workerId)
      .then(setSynchronization)
      .catch(() => undefined)
      .finally(() => setReloadVersion((version) => version + 1));
  }, [defaultWorkerId, selectedWorker, workers.data]);

  useEffect(() => {
    if (!selectedWorkerId) return;
    const generation = ++connectionGeneration.current;
    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    setAttachment(null);
    setSynchronization(null);
    setConnectionError(null);
    setFrameError(null);
    setFrameReadyNonce(null);
    setOpenedNonce(null);
    setConnecting(true);

    const connect = async () => {
      try {
        const selected = await lifecycleRef.current!.replace(
          () =>
            createProtectedCodeSettingsAttachment(selectedWorkerId, appearance),
          async (wire, signal) => {
            if (wire.synchronization.state === "conflict") {
              return { preferred: null, wire };
            }
            if (wire.synchronization.state !== "ready") {
              throw new Error(statusMessage(wire.synchronization));
            }
            return {
              preferred: await preferProtectedCodeAttachment(wire.attachment, {
                signal,
              }),
              wire,
            };
          },
        );
        if (
          !selected ||
          cancelled ||
          generation !== connectionGeneration.current
        ) {
          return;
        }
        setSynchronization(selected.wire.synchronization);
        setConnecting(false);
        if (!selected.preferred) return;
        setAttachment(selected.preferred.attachment);
        if (selected.preferred.directTunnelId) {
          const checkHealth = async () => {
            if (cancelled) return;
            const recovery = await recoverPreferredCodeAttachmentRoute(
              selected.preferred!,
            );
            if (cancelled) return;
            if (recovery === "replace-required") {
              setConnectionError("The Code settings connection was lost.");
              return;
            }
            healthTimer = setTimeout(checkHealth, DIRECT_HEALTH_REFRESH_MS);
          };
          healthTimer = setTimeout(checkHealth, DIRECT_HEALTH_REFRESH_MS);
        }
      } catch (error) {
        if (cancelled || generation !== connectionGeneration.current) return;
        setConnecting(false);
        setConnectionError(errorMessage(error));
      }
    };

    // Let StrictMode discard its probe effect before creating a server resource.
    startTimer = setTimeout(() => void connect(), 0);
    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      if (healthTimer) clearTimeout(healthTimer);
      void lifecycleRef.current!.retire("Code settings connection replaced.");
    };
  }, [appearance, reloadVersion, selectedWorkerId]);

  const frameMount = useMemo(
    () => (attachment ? createCodeWorkbenchFrameMount(attachment.url) : null),
    [attachment?.attachmentId, attachment?.url, frameDocumentVersion],
  );

  useLayoutEffect(() => {
    if (!attachment || !frameMount) return;
    let settled = false;
    let opening = false;
    const controller = new AbortController();
    setFrameReadyNonce(null);
    setOpenedNonce(null);
    const receiveReady = (event: MessageEvent<unknown>) => {
      if (
        settled ||
        opening ||
        !isCodeWorkbenchReadyEvent(
          event,
          frameRef.current?.contentWindow ?? null,
          frameMount,
        )
      ) {
        return;
      }
      opening = true;
      setFrameReadyNonce(frameMount.nonce);
      void openDirectCodeAttachmentSettings(attachment, {
        signal: controller.signal,
      }).then(
        () => {
          if (settled) return;
          settled = true;
          setFrameError(null);
          setOpenedNonce(frameMount.nonce);
        },
        (error) => {
          if (settled || controller.signal.aborted) return;
          settled = true;
          setFrameError(errorMessage(error));
        },
      );
    };
    window.addEventListener("message", receiveReady);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      setFrameError("The embedded Code settings workbench timed out.");
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      controller.abort();
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [attachment, frameMount]);

  const resolveConflict = useMutation({
    mutationFn: (resolution: CodeSettingsResolution) =>
      resolveCodeSettingsWorker(selectedWorkerId!, resolution),
    onSuccess: async (next) => {
      setSynchronization(next);
      await queryClient.invalidateQueries({
        queryKey: ["code-settings-worker-status", selectedWorkerId],
      });
      if (!attachment) setReloadVersion((version) => version + 1);
    },
  });

  const ready = openedNonce !== null && openedNonce === frameMount?.nonce;
  const conflict = synchronization?.state === "conflict";
  const noWorker = !workers.isLoading && eligibleWorkers.length === 0;

  return (
    <section
      aria-hidden={!active}
      data-slot="code-settings-surface"
      className={cn(
        "h-full min-h-0 min-w-0 overflow-hidden bg-background",
        active ? "flex flex-col" : "hidden",
      )}
    >
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {attachment && frameMount ? (
          <iframe
            key={frameMount.nonce}
            allow="clipboard-read; clipboard-write"
            aria-hidden={!ready}
            className="size-full min-h-0 min-w-0 border-0 bg-background"
            onError={() =>
              setFrameError(
                "The embedded Code settings document failed to load.",
              )
            }
            onLoad={() => {
              if (frameLoadsRef.current.observe(frameMount.nonce)) {
                setFrameDocumentVersion((version) => version + 1);
              }
            }}
            ref={frameRef}
            referrerPolicy="no-referrer"
            src={frameMount.url}
            tabIndex={active && ready ? 0 : -1}
            title="VS Code settings"
          />
        ) : null}

        {!ready || conflict || connectionError || frameError ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background p-6 text-center">
            <div className="grid max-w-lg justify-items-center gap-3">
              {conflict || connectionError || frameError || noWorker ? (
                <AlertTriangle className="size-6 text-destructive" />
              ) : (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {noWorker
                    ? "No compatible Code worker is available"
                    : conflict
                      ? "Global Code settings need a decision"
                      : connectionError || frameError
                        ? "Code settings could not open"
                        : connecting
                          ? "Synchronizing encrypted Code settings…"
                          : frameReadyNonce
                            ? "Opening graphical settings…"
                            : "Starting the Code settings workbench…"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {noWorker
                    ? "Connect an encryption-capable worker with Cantrip Code installed."
                    : conflict
                      ? statusMessage(synchronization)
                      : (connectionError ??
                        frameError ??
                        statusMessage(synchronization))}
                </p>
                {conflict && synchronization?.backupCreated ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    The original pre-sync recovery copy is available on this
                    worker.
                  </p>
                ) : null}
              </div>
              {conflict ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    disabled={resolveConflict.isPending}
                    onClick={() => resolveConflict.mutate("accept-canonical")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Use synced settings
                  </Button>
                  <Button
                    disabled={resolveConflict.isPending}
                    onClick={() => resolveConflict.mutate("publish-local")}
                    size="sm"
                    type="button"
                  >
                    Keep this worker’s settings
                  </Button>
                </div>
              ) : connectionError || frameError || noWorker ? (
                <Button
                  onClick={retry}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw className="size-4" /> Retry
                </Button>
              ) : null}
              {resolveConflict.isError ? (
                <p className="text-xs text-destructive">
                  {errorMessage(resolveConflict.error)}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
