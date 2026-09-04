import type {
  CodeAppearance,
  CodeAttachment,
  CodeSettingsResolution,
  CodeSettingsWorkerStatus,
  CodeSettingsWorkbenchAttachmentWire,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { codeWorkbenchSurfaceBackground } from "@/components/code/code-view";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { bindBrowserCodeAttachmentFrame } from "@/lib/browser-code-tunnel";
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
  installDirectCodeAttachmentVsix,
  openDirectCodeAttachmentExtensions,
  preferProtectedCodeAttachment,
  stopDirectCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
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
export const CODE_SETTINGS_SURFACE_CLASS_NAME =
  "h-full min-h-0 min-w-0 overflow-hidden";
export const CODE_SETTINGS_FRAME_CLASS_NAME =
  "size-full min-h-0 min-w-0 border-0";
export const CODE_SETTINGS_LOADING_COVER_CLASS_NAME =
  "absolute inset-0 z-10 grid place-items-center p-6 text-center";

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
  const eligibleWorkers = useMemo(
    () => (workers.data ?? []).filter(workerCanHostCodeSettings),
    [workers.data],
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
  const [openedFrameNonce, setOpenedFrameNonce] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [vsixInstall, setVsixInstall] = useState<
    | { state: "idle" }
    | { state: "installing"; name: string }
    | { state: "installed"; name: string }
    | { state: "failed"; message: string }
  >({ state: "idle" });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const vsixInputRef = useRef<HTMLInputElement>(null);
  const vsixInstallControllerRef = useRef<AbortController | null>(null);
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
    if (workers.isLoading) return;
    if (
      selectedWorkerId !== null &&
      eligibleWorkers.some(({ workerId }) => workerId === selectedWorkerId)
    ) {
      return;
    }
    setSelectedWorkerId(
      selectCodeSettingsWorker(workers.data ?? [], defaultWorkerId)?.workerId ??
        null,
    );
  }, [
    defaultWorkerId,
    eligibleWorkers,
    selectedWorkerId,
    workers.data,
    workers.isLoading,
  ]);

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
    let unsubscribeUnavailable: (() => void) | null = null;
    setAttachment(null);
    setSynchronization(null);
    setConnectionError(null);
    setFrameError(null);
    setFrameReadyNonce(null);
    setOpenedFrameNonce(null);
    setConnecting(true);

    const connect = async () => {
      try {
        const selected = await lifecycleRef.current!.replace(
          () =>
            createProtectedCodeSettingsAttachment(selectedWorkerId, appearance),
          async (wire, signal) => {
            if (
              wire.synchronization.state !== "ready" &&
              wire.synchronization.state !== "conflict"
            ) {
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
        setAttachment(selected.preferred.attachment);
        unsubscribeUnavailable = subscribePreferredCodeAttachmentUnavailable(
          selected.preferred,
          () => {
            if (!cancelled) setReloadVersion((version) => version + 1);
          },
        );
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
      unsubscribeUnavailable?.();
      unsubscribeUnavailable = null;
      void lifecycleRef.current!.retire("Code settings connection replaced.");
    };
  }, [appearance, reloadVersion, selectedWorkerId]);

  const frameMount = useMemo(
    () => (attachment ? createCodeWorkbenchFrameMount(attachment.url) : null),
    [attachment?.attachmentId, attachment?.url, frameDocumentVersion],
  );

  useEffect(() => {
    setVsixInstall({ state: "idle" });
    return () => {
      vsixInstallControllerRef.current?.abort(
        new DOMException("The Code attachment changed.", "AbortError"),
      );
      vsixInstallControllerRef.current = null;
    };
  }, [attachment?.attachmentId]);

  useLayoutEffect(() => {
    if (!attachment || !frameMount) return;
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    return bindBrowserCodeAttachmentFrame(
      attachment.attachmentId,
      frame,
      frameMount.nonce,
    );
  }, [attachment, frameMount]);

  useLayoutEffect(() => {
    if (!attachment || !frameMount) return;
    let settled = false;
    setFrameReadyNonce(null);
    setOpenedFrameNonce(null);
    const receiveReady = (event: MessageEvent<unknown>) => {
      if (
        settled ||
        !isCodeWorkbenchReadyEvent(
          event,
          frameRef.current?.contentWindow ?? null,
          frameMount,
        )
      ) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      setFrameReadyNonce(frameMount.nonce);
    };
    window.addEventListener("message", receiveReady);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setFrameError("The embedded Code customization workbench timed out.");
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [attachment, frameMount]);

  useLayoutEffect(() => {
    if (!attachment || !frameMount || frameReadyNonce !== frameMount.nonce) {
      return;
    }
    let settled = false;
    const controller = new AbortController();
    setOpenedFrameNonce((current) =>
      current === frameMount.nonce ? current : null,
    );
    setFrameError(null);
    void openDirectCodeAttachmentExtensions(attachment, {
      signal: controller.signal,
    }).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        setOpenedFrameNonce(frameMount.nonce);
      },
      (error) => {
        if (settled || controller.signal.aborted) return;
        settled = true;
        clearTimeout(timeout);
        setFrameError(errorMessage(error));
      },
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      setFrameError(
        "The embedded Code settings and extensions view timed out.",
      );
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [attachment, frameMount, frameReadyNonce]);

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

  const installVsix = useCallback(
    async (file: File) => {
      if (!attachment) return;
      vsixInstallControllerRef.current?.abort();
      const controller = new AbortController();
      vsixInstallControllerRef.current = controller;
      setVsixInstall({ state: "installing", name: file.name });
      try {
        await installDirectCodeAttachmentVsix(attachment, file, {
          signal: controller.signal,
        });
        if (vsixInstallControllerRef.current !== controller) return;
        setVsixInstall({ state: "installed", name: file.name });
      } catch (error) {
        if (
          controller.signal.aborted ||
          vsixInstallControllerRef.current !== controller
        ) {
          return;
        }
        setVsixInstall({ state: "failed", message: errorMessage(error) });
      } finally {
        if (vsixInstallControllerRef.current === controller) {
          vsixInstallControllerRef.current = null;
        }
      }
    },
    [attachment],
  );

  const ready = openedFrameNonce === frameMount?.nonce;
  const settingsConflict = synchronization?.state === "conflict";
  const noWorker = !workers.isLoading && eligibleWorkers.length === 0;
  const workbenchSurfaceBackground = codeWorkbenchSurfaceBackground();

  return (
    <section
      aria-hidden={!active}
      data-slot="code-settings-surface"
      className={cn(
        CODE_SETTINGS_SURFACE_CLASS_NAME,
        active ? "flex flex-col" : "hidden",
      )}
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
        role="note"
      >
        <p className="min-w-64 flex-1">
          Treat extensions as trusted code: they can access this worker&apos;s
          files, processes, credentials, and network with the same authority as
          its terminal. Installs from Open VSX or VSIX stay on{" "}
          {selectedWorker?.name ?? "the selected worker"} and apply to its
          default Cantrip Code profile.
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">Worker</span>
            <NativeSelect
              aria-label="Code customization worker"
              className="max-w-56 min-w-36"
              disabled={workers.isLoading || eligibleWorkers.length === 0}
              size="sm"
              value={selectedWorkerId ?? ""}
              onChange={(event) =>
                setSelectedWorkerId(event.target.value || null)
              }
            >
              {eligibleWorkers.length === 0 ? (
                <option value="">No compatible worker</option>
              ) : null}
              {eligibleWorkers.map((worker) => (
                <option key={worker.workerId} value={worker.workerId}>
                  {worker.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <input
            accept=".vsix,application/vsix,application/octet-stream"
            aria-label="Choose a VSIX extension package"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void installVsix(file);
            }}
            ref={vsixInputRef}
            type="file"
          />
          <Button
            disabled={
              !attachment || !ready || vsixInstall.state === "installing"
            }
            onClick={() => vsixInputRef.current?.click()}
            size="sm"
            title="Fallback when the native Code-OSS VSIX picker is unavailable"
            type="button"
            variant="outline"
          >
            {vsixInstall.state === "installing" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileUp className="size-3.5" />
            )}
            Upload VSIX
          </Button>
          {vsixInstall.state === "installing" ? (
            <span className="max-w-56 truncate" role="status">
              Installing {vsixInstall.name}…
            </span>
          ) : vsixInstall.state === "installed" ? (
            <span className="flex max-w-64 items-center gap-1" role="status">
              <CheckCircle2 className="size-3.5 shrink-0" />
              <span className="truncate">Installed {vsixInstall.name}.</span>
              Code will prompt if a reload or extension-host restart is needed.
            </span>
          ) : vsixInstall.state === "failed" ? (
            <span className="max-w-72 text-destructive" role="alert">
              {vsixInstall.message}
            </span>
          ) : null}
        </div>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {attachment && frameMount ? (
          <iframe
            key={frameMount.nonce}
            allow="clipboard-read; clipboard-write"
            aria-hidden={!ready || settingsConflict}
            className={CODE_SETTINGS_FRAME_CLASS_NAME}
            onError={() =>
              setFrameError(
                "The embedded Code customization document failed to load.",
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
            style={{ backgroundColor: workbenchSurfaceBackground }}
            tabIndex={active && ready && !settingsConflict ? 0 : -1}
            title="VS Code settings and extensions"
          />
        ) : null}

        {!ready || settingsConflict || connectionError || frameError ? (
          <div
            className={CODE_SETTINGS_LOADING_COVER_CLASS_NAME}
            style={{ backgroundColor: workbenchSurfaceBackground }}
          >
            <div className="grid max-w-lg justify-items-center gap-3">
              {settingsConflict || connectionError || frameError || noWorker ? (
                <AlertTriangle className="size-6 text-destructive" />
              ) : (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {noWorker
                    ? "No compatible Code worker is available"
                    : settingsConflict
                      ? "Global Code settings need a decision"
                      : connectionError || frameError
                        ? "Code settings could not open"
                        : connecting
                          ? "Synchronizing encrypted Code settings…"
                          : frameReadyNonce
                            ? "Opening Code settings and extensions…"
                            : "Starting the Code customization workbench…"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {noWorker
                    ? "Connect an encryption-capable worker with Cantrip Code installed."
                    : settingsConflict
                      ? statusMessage(synchronization)
                      : (connectionError ??
                        frameError ??
                        statusMessage(synchronization))}
                </p>
                {settingsConflict && synchronization?.backupCreated ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    The original pre-sync recovery copy is available on this
                    worker.
                  </p>
                ) : null}
              </div>
              {settingsConflict ? (
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
