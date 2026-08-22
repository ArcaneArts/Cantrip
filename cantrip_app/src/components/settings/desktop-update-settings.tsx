import type { DesktopUpdateActiveWorkSummary } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
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
  desktopUpdateActiveWorkLabels,
  desktopUpdateActiveWorkTotal,
  desktopUpdateClient,
  formatDesktopUpdateBytes,
  formatDesktopUpdateDate,
  normalizeDesktopUpdateError,
  type DesktopUpdateCapability,
  type DesktopUpdateClient,
  type DesktopUpdateErrorShape,
  type DesktopUpdatePhase,
  type DesktopUpdateProgress,
  type DesktopUpdateRelease,
} from "@/lib/desktop-update";
import { openExternalUrl } from "@/lib/external-url";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { DesktopUpdateHistory } from "./desktop-update-history";
import {
  SyntheticBuildCache,
  SyntheticBuildSettings,
} from "./synthetic-build-settings";

const AUTOMATIC_UPDATE_REFRESH_MS = 30_000;
const automaticCheckTimes = new WeakMap<DesktopUpdateClient, number>();
const historyCache = new WeakMap<
  DesktopUpdateClient,
  { fetchedAt: number; promise: Promise<DesktopUpdateRelease[]> }
>();

export function desktopUpdateAutoRefreshDue(
  lastCheckAt: number | null,
  now = Date.now(),
): boolean {
  return (
    lastCheckAt === null || now - lastCheckAt >= AUTOMATIC_UPDATE_REFRESH_MS
  );
}

function loadDesktopUpdateHistory(
  client: DesktopUpdateClient,
  force = false,
): Promise<DesktopUpdateRelease[]> {
  const now = Date.now();
  const cached = historyCache.get(client);
  if (
    !force &&
    cached &&
    now - cached.fetchedAt < AUTOMATIC_UPDATE_REFRESH_MS
  ) {
    return cached.promise;
  }
  const promise = client.history();
  historyCache.set(client, { fetchedAt: now, promise });
  return promise;
}

export type DesktopUpdateFlowStage =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "preparing"
  | "confirm-active-work"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "failed";

export interface DesktopUpdateFlowState {
  activeWork: DesktopUpdateActiveWorkSummary | null;
  downloadedBytes: number | null;
  error: DesktopUpdateErrorShape | null;
  errorContext: "check" | "install" | null;
  installedVersion: string;
  message: string | null;
  release: DesktopUpdateRelease | null;
  restartingCurrentVersion: boolean;
  stage: DesktopUpdateFlowStage;
  totalBytes: number | null;
}

export type DesktopUpdateFlowEvent =
  | { type: "check-started" }
  | { type: "check-current"; installedVersion: string }
  | { type: "check-available"; release: DesktopUpdateRelease }
  | { type: "active-work-started" }
  | {
      type: "active-work-confirmation";
      activeWork: DesktopUpdateActiveWorkSummary;
    }
  | { type: "install-started" }
  | { type: "progress"; progress: DesktopUpdateProgress }
  | {
      type: "failed";
      context: "check" | "install";
      error: DesktopUpdateErrorShape;
    }
  | { type: "reset" };

export function initialDesktopUpdateFlowState(
  installedVersion: string,
): DesktopUpdateFlowState {
  return {
    activeWork: null,
    downloadedBytes: null,
    error: null,
    errorContext: null,
    installedVersion,
    message: null,
    release: null,
    restartingCurrentVersion: false,
    stage: "idle",
    totalBytes: null,
  };
}

function progressStage(
  phase: DesktopUpdatePhase,
): DesktopUpdateFlowStage | null {
  return phase === "downloading" ||
    phase === "verifying" ||
    phase === "installing" ||
    phase === "restarting"
    ? phase
    : null;
}

export function desktopUpdateFlowReducer(
  state: DesktopUpdateFlowState,
  event: DesktopUpdateFlowEvent,
): DesktopUpdateFlowState {
  switch (event.type) {
    case "check-started":
      return {
        ...initialDesktopUpdateFlowState(state.installedVersion),
        stage: "checking",
      };
    case "check-current":
      return {
        ...initialDesktopUpdateFlowState(event.installedVersion),
        stage: "current",
      };
    case "check-available":
      return {
        ...initialDesktopUpdateFlowState(event.release.currentVersion),
        release: event.release,
        stage: "available",
      };
    case "active-work-started":
      return { ...state, error: null, errorContext: null, stage: "preparing" };
    case "active-work-confirmation":
      return {
        ...state,
        activeWork: event.activeWork,
        stage: "confirm-active-work",
      };
    case "install-started":
      return {
        ...state,
        downloadedBytes: 0,
        error: null,
        errorContext: null,
        message: "Downloading the signed update…",
        restartingCurrentVersion: false,
        stage: "downloading",
        totalBytes: null,
      };
    case "progress": {
      if (
        ![
          "preparing",
          "confirm-active-work",
          "downloading",
          "verifying",
          "installing",
          "restarting",
          "failed",
        ].includes(state.stage)
      ) {
        return state;
      }
      if (event.progress.phase === "failed") {
        return {
          ...state,
          error: {
            code: "desktop_update_failed",
            message:
              event.progress.message ??
              "The desktop update could not be completed.",
            retryable: !event.progress.restartingCurrentVersion,
          },
          errorContext: "install",
          message: event.progress.message,
          restartingCurrentVersion: event.progress.restartingCurrentVersion,
          stage: "failed",
        };
      }
      const stage = progressStage(event.progress.phase);
      if (!stage) return state;
      return {
        ...state,
        downloadedBytes: event.progress.downloadedBytes,
        message: event.progress.message,
        restartingCurrentVersion: event.progress.restartingCurrentVersion,
        stage,
        totalBytes: event.progress.totalBytes,
      };
    }
    case "failed":
      return {
        ...state,
        error: event.error,
        errorContext: event.context,
        restartingCurrentVersion:
          state.restartingCurrentVersion && event.context === "install",
        stage: "failed",
      };
    case "reset":
      return initialDesktopUpdateFlowState(state.installedVersion);
  }
}

export function useDesktopUpdateCapability(
  client: DesktopUpdateClient = desktopUpdateClient,
) {
  return useQuery({
    enabled: client.isSupportedEnvironment(),
    queryFn: () => client.capability(),
    queryKey: ["desktop-update-capability"],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

function UpdateProgress({ state }: { state: DesktopUpdateFlowState }) {
  const percent =
    state.stage === "downloading" &&
    state.downloadedBytes !== null &&
    state.totalBytes !== null &&
    state.totalBytes > 0
      ? Math.min(100, (state.downloadedBytes / state.totalBytes) * 100)
      : null;
  const labels: Record<
    Extract<
      DesktopUpdateFlowStage,
      "preparing" | "downloading" | "verifying" | "installing" | "restarting"
    >,
    string
  > = {
    preparing: "Checking local work",
    downloading: "Downloading update",
    verifying: "Verifying signature",
    installing: "Installing Cantrip",
    restarting: "Restarting Cantrip",
  };

  if (
    state.stage !== "preparing" &&
    state.stage !== "downloading" &&
    state.stage !== "verifying" &&
    state.stage !== "installing" &&
    state.stage !== "restarting"
  ) {
    return null;
  }

  return (
    <div className="grid gap-2 border-y py-4" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="size-4 animate-spin" />
        {labels[state.stage]}
      </div>
      {state.stage === "downloading" ? (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${percent ?? 0}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {state.downloadedBytes === null
              ? "Preparing download…"
              : state.totalBytes === null
                ? `${formatDesktopUpdateBytes(state.downloadedBytes)} downloaded`
                : `${formatDesktopUpdateBytes(state.downloadedBytes)} of ${formatDesktopUpdateBytes(state.totalBytes)}${percent === null ? "" : ` · ${Math.round(percent)}%`}`}
          </p>
        </>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
    </div>
  );
}

function ReleaseDetails({
  release,
  targetLabel = "Available",
}: {
  release: DesktopUpdateRelease;
  targetLabel?: "Available" | "Selected";
}) {
  const publishedAt = formatDesktopUpdateDate(release.publishedAt);
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-y py-3 text-sm">
        <dt className="text-muted-foreground">Installed</dt>
        <dd className="font-mono">{release.currentVersion}</dd>
        <dt className="text-muted-foreground">{targetLabel}</dt>
        <dd className="font-mono">{release.version}</dd>
        {publishedAt ? (
          <>
            <dt className="text-muted-foreground">Published</dt>
            <dd>{publishedAt}</dd>
          </>
        ) : null}
      </dl>
      <div
        data-elite-global="desktop-update-release-notes"
        className="min-h-0 max-h-[45vh] overflow-y-auto py-1"
      >
        <h3 className="mb-2 text-sm font-semibold">What changed</h3>
        {release.releaseNotes ? (
          <Markdown
            onOpenLink={(url) => {
              void openExternalUrl(url).catch((error: unknown) => {
                clientLogger.warn(
                  "Desktop update release link failed to open",
                  {
                    ...operationalErrorMetadata(error),
                    event: "desktop.update.release-link.failed",
                    operation: "open-release-link",
                    reasonCode: "external-open-failed",
                    status: "failed",
                    subsystem: "desktop-update",
                  },
                );
              });
            }}
          >
            {release.releaseNotes}
          </Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            No release notes were provided.
          </p>
        )}
      </div>
    </>
  );
}

export function DesktopUpdateDialogBody({
  releaseLabel,
  state,
}: {
  releaseLabel?: "Available" | "Selected";
  state: DesktopUpdateFlowState;
}) {
  const activeWorkLabels = state.activeWork
    ? desktopUpdateActiveWorkLabels(state.activeWork)
    : [];
  return (
    <>
      {state.release ? (
        <ReleaseDetails release={state.release} targetLabel={releaseLabel} />
      ) : null}
      {state.stage === "confirm-active-work" ? (
        <div className="grid gap-2 border-y py-4">
          <h3 className="text-sm font-semibold">Active local work will stop</h3>
          <p className="text-sm text-muted-foreground">
            Updating replaces the complete desktop bundle and restarts its local
            server and workers. Confirm that Cantrip may stop:
          </p>
          <ul className="list-disc pl-5 text-sm">
            {activeWorkLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <UpdateProgress state={state} />
      {state.stage === "failed" && state.error ? (
        <div className="grid gap-1 border-y py-4" role="alert">
          <p className="text-sm font-medium text-destructive">
            {state.restartingCurrentVersion
              ? "The update failed. Restarting the current version."
              : "Cantrip could not update."}
          </p>
          <p className="text-sm text-muted-foreground">{state.error.message}</p>
        </div>
      ) : null}
    </>
  );
}

export function DesktopUpdateStatusMessage({
  state,
}: {
  state: DesktopUpdateFlowState;
}) {
  if (state.stage === "current") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-emerald-500">
        <CheckCircle2 className="size-3.5" /> Cantrip is up to date.
      </p>
    );
  }
  if (state.stage === "available" && state.release) {
    return (
      <p className="mt-1 text-xs text-sky-600 dark:text-sky-400">
        Cantrip {state.release.version} is available.
      </p>
    );
  }
  if (state.stage === "failed" && state.errorContext === "check") {
    return (
      <p className="mt-1 text-xs text-destructive" role="alert">
        {state.error?.message}
      </p>
    );
  }
  return null;
}

export function DesktopUpdateSettings({
  capability,
  client = desktopUpdateClient,
}: {
  capability: DesktopUpdateCapability;
  client?: DesktopUpdateClient;
}) {
  const [state, dispatch] = useReducer(
    desktopUpdateFlowReducer,
    capability.installedVersion,
    initialDesktopUpdateFlowState,
  );
  const [history, setHistory] = useState<DesktopUpdateRelease[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [releaseDialogRequested, setReleaseDialogRequested] = useState(false);
  const [selectedFromHistory, setSelectedFromHistory] = useState(false);
  const operation = useRef(0);
  const actionInFlight = useRef(false);
  const cancellationInFlight = useRef(false);
  const dialogOpen =
    releaseDialogRequested &&
    (state.stage === "available" ||
      state.stage === "preparing" ||
      state.stage === "confirm-active-work" ||
      state.stage === "downloading" ||
      state.stage === "verifying" ||
      state.stage === "installing" ||
      state.stage === "restarting" ||
      (state.stage === "failed" && state.errorContext === "install"));
  const dismissible =
    state.stage === "available" ||
    state.stage === "preparing" ||
    state.stage === "confirm-active-work" ||
    state.stage === "downloading" ||
    (state.stage === "failed" && !state.restartingCurrentVersion);
  const busy =
    state.stage === "checking" ||
    state.stage === "preparing" ||
    state.stage === "confirm-active-work" ||
    state.stage === "downloading" ||
    state.stage === "verifying" ||
    state.stage === "installing" ||
    state.stage === "restarting";

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void client
      .listen((progress) => {
        if (!disposed) dispatch({ type: "progress", progress });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      operation.current += 1;
      unlisten?.();
    };
  }, [client]);

  const checkForUpdate = useCallback(
    async (openIfAvailable: boolean) => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      const currentOperation = ++operation.current;
      dispatch({ type: "check-started" });
      try {
        const result = await client.check();
        if (operation.current !== currentOperation) return;
        if (result.status === "current") {
          dispatch({
            type: "check-current",
            installedVersion: result.installedVersion,
          });
          setSelectedFromHistory(false);
          setReleaseDialogRequested(false);
        } else if (result.release) {
          dispatch({ type: "check-available", release: result.release });
          setSelectedFromHistory(false);
          setReleaseDialogRequested(openIfAvailable);
        } else {
          throw new Error(
            "The update service returned no release information.",
          );
        }
      } catch (error) {
        if (operation.current !== currentOperation) return;
        dispatch({
          type: "failed",
          context: "check",
          error: normalizeDesktopUpdateError(
            error,
            "Could not check for updates. Check your connection and try again.",
          ),
        });
      } finally {
        if (operation.current === currentOperation) {
          actionInFlight.current = false;
        }
      }
    },
    [client],
  );

  const refreshHistory = useCallback(
    async (force = false) => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        setHistory(await loadDesktopUpdateHistory(client, force));
      } catch (error) {
        setHistoryError(
          normalizeDesktopUpdateError(
            error,
            "Could not load Cantrip version history.",
          ).message,
        );
      } finally {
        setHistoryLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void refreshHistory();
    const now = Date.now();
    const lastCheck = automaticCheckTimes.get(client) ?? null;
    if (desktopUpdateAutoRefreshDue(lastCheck, now)) {
      automaticCheckTimes.set(client, now);
      void checkForUpdate(false);
    }
  }, [checkForUpdate, client, refreshHistory]);

  const install = async (
    activeWork: DesktopUpdateActiveWorkSummary,
    confirmActiveWork: boolean,
    currentOperation: number,
  ) => {
    dispatch({ type: "install-started" });
    try {
      await client.install({ activeWork, confirmActiveWork });
      if (operation.current !== currentOperation) return;
      dispatch({
        type: "progress",
        progress: {
          phase: "restarting",
          downloadedBytes: null,
          totalBytes: null,
          message: "Restarting Cantrip…",
          restartingCurrentVersion: false,
        },
      });
    } catch (error) {
      if (operation.current !== currentOperation) return;
      dispatch({
        type: "failed",
        context: "install",
        error: normalizeDesktopUpdateError(error),
      });
    } finally {
      if (operation.current === currentOperation) {
        actionInFlight.current = false;
      }
    }
  };

  const prepareActiveWork = async (currentOperation: number) => {
    dispatch({ type: "active-work-started" });
    try {
      const activeWork = await client.getActiveWork();
      if (operation.current !== currentOperation) return;
      if (desktopUpdateActiveWorkTotal(activeWork) > 0) {
        dispatch({ type: "active-work-confirmation", activeWork });
        actionInFlight.current = false;
        return;
      }
      await install(activeWork, false, currentOperation);
    } catch (error) {
      if (operation.current !== currentOperation) return;
      dispatch({
        type: "failed",
        context: "install",
        error: normalizeDesktopUpdateError(error),
      });
      actionInFlight.current = false;
    }
  };

  const prepareInstall = () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const currentOperation = ++operation.current;
    void prepareActiveWork(currentOperation);
  };

  const prepareSelectedVersion = async () => {
    if (!state.release || actionInFlight.current) return;
    actionInFlight.current = true;
    const currentOperation = ++operation.current;
    dispatch({ type: "active-work-started" });
    try {
      const release = await client.select(state.release.version);
      if (operation.current !== currentOperation) return;
      dispatch({ type: "check-available", release });
      await prepareActiveWork(currentOperation);
    } catch (error) {
      if (operation.current !== currentOperation) return;
      dispatch({
        type: "failed",
        context: "install",
        error: normalizeDesktopUpdateError(
          error,
          "Could not prepare the selected Cantrip version.",
        ),
      });
      actionInFlight.current = false;
    }
  };

  const confirmActiveWork = () => {
    if (!state.activeWork || actionInFlight.current) return;
    actionInFlight.current = true;
    const currentOperation = operation.current;
    void install(state.activeWork, true, currentOperation);
  };

  const dismiss = async () => {
    if (!dismissible || cancellationInFlight.current) return;
    cancellationInFlight.current = true;
    operation.current += 1;
    if (state.stage === "downloading") {
      await client.cancel().catch(() => undefined);
    }
    actionInFlight.current = false;
    cancellationInFlight.current = false;
    setReleaseDialogRequested(false);
    setSelectedFromHistory(false);
    dispatch({ type: "reset" });
  };

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Download className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Cantrip updates</h2>
            <p className="text-xs text-muted-foreground">
              Installed version {state.installedVersion}
            </p>
            <DesktopUpdateStatusMessage state={state} />
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || dialogOpen}
          onClick={() => {
            void checkForUpdate(true);
            void refreshHistory(true);
          }}
        >
          {state.stage === "checking" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : state.stage === "failed" && state.errorContext === "check" ? (
            <RefreshCw className="size-3.5" />
          ) : (
            <Download className="size-3.5" />
          )}
          {state.stage === "checking"
            ? "Checking…"
            : state.stage === "failed" && state.errorContext === "check"
              ? "Try again"
              : "Check for updates"}
        </Button>
      </div>

      <DesktopUpdateHistory
        headerAction={<SyntheticBuildSettings />}
        error={historyError}
        installedVersion={state.installedVersion}
        loading={historyLoading}
        releases={history}
        onOpenRelease={(release) => {
          if (busy || dialogOpen) return;
          dispatch({ type: "check-available", release });
          setSelectedFromHistory(true);
          setReleaseDialogRequested(true);
        }}
      />
      <SyntheticBuildCache />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) void dismiss();
        }}
      >
        <DialogContent
          className="max-w-2xl"
          showClose={dismissible}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {selectedFromHistory && state.release
                ? `Cantrip ${state.release.version}`
                : "Update Cantrip"}
            </DialogTitle>
            <DialogDescription>
              {selectedFromHistory
                ? "Review this release, then explicitly choose whether to install it."
                : "The complete signed desktop bundle will be replaced. Your data, settings, credentials, conversations, and projects stay in place."}
            </DialogDescription>
          </DialogHeader>

          <DesktopUpdateDialogBody
            releaseLabel={selectedFromHistory ? "Selected" : "Available"}
            state={state}
          />

          <DialogFooter>
            {dismissible ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void dismiss()}
              >
                {state.stage === "downloading" ? "Cancel update" : "Cancel"}
              </Button>
            ) : null}
            {state.stage === "available" ? (
              <Button
                type="button"
                disabled={
                  selectedFromHistory &&
                  state.release?.version === state.installedVersion
                }
                onClick={() =>
                  void (selectedFromHistory
                    ? prepareSelectedVersion()
                    : prepareInstall())
                }
              >
                <RotateCcw className="size-4" />
                {selectedFromHistory
                  ? state.release?.version === state.installedVersion
                    ? "Current version"
                    : "Change Version"
                  : "Update and restart"}
              </Button>
            ) : null}
            {state.stage === "confirm-active-work" ? (
              <Button type="button" onClick={confirmActiveWork}>
                <ShieldCheck className="size-4" /> Stop work, update and restart
              </Button>
            ) : null}
            {state.stage === "failed" &&
            !state.restartingCurrentVersion &&
            state.error?.retryable ? (
              <Button
                type="button"
                onClick={() =>
                  void (selectedFromHistory
                    ? prepareSelectedVersion()
                    : checkForUpdate(true))
                }
              >
                <RefreshCw className="size-4" />
                {selectedFromHistory ? "Try this version again" : "Check again"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
