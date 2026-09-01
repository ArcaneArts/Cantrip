import { isTauri } from "@tauri-apps/api/core";
import type {
  ServiceLogLevel,
  ServiceLogReadResult,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clipboard,
  Cpu,
  Download,
  FolderOpen,
  Laptop,
  Loader2,
  Pause,
  Play,
  Search,
  Server,
  Share2,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import {
  getServerBootstrap,
  getWorkerServiceLogs,
  getWorkers,
} from "@/lib/api";
import {
  clientLogger,
  operationalErrorMetadata,
  readClientLogs,
} from "@/lib/client-log-relay";
import {
  listDesktopWorkers,
  type DesktopWorkerStatus,
} from "@/lib/desktop-worker";
import {
  getLocalRuntimeServerUrl,
  openLocalLogsDirectory,
  readLocalServiceLogs,
  type LocalServiceLogSource,
} from "@/lib/local-service-logs";
import {
  exportMobileClientLogs,
  isMobileNativeRuntime,
} from "@/lib/mobile-log-archive";
import {
  getActiveServerConnection,
  getActiveServerUrl,
} from "@/lib/server-connections";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { cn } from "@/lib/utils";
import {
  parseWorkerLogStreamMessage,
  workerLogPageAction,
  workerLogStreamWebSocketUrl,
} from "@/lib/worker-log-stream";
import {
  appendServiceLogRecords,
  canReadLocalServerLogs,
  filterServiceLogRecords,
  formatServiceLogRecord,
  formatServiceLogRecords,
  removeServiceLogRecords,
  restoredLogScrollTop,
  scheduleLogViewportScroll,
  SERVICE_LOG_LEVELS,
  shouldJumpToNewestLogs,
  shouldLoadOlderLogs,
  shouldStopFollowingLogs,
  type ViewerLogRecord,
} from "./log-viewer-model";

const POLL_INTERVAL_MS = 750;
const MAX_BACKOFF_MS = 6_000;
const PAGE_SIZE = 200;
const TAIL_CURSOR = Number.MAX_SAFE_INTEGER;
const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 12;
const HISTORY_LOAD_THRESHOLD = ROW_HEIGHT * 2;

type LogSource = {
  fallback?: LocalServiceLogSource;
  id: string;
  kind: "client" | "server" | "worker";
  label: string;
  online: boolean;
  subtitle: string;
  workerId?: string;
};

type LogSourceState = {
  activeTransport: string | null;
  cursors: Record<string, number>;
  error: string | null;
  history: Record<string, { beforeCursor: number; hasMore: boolean }>;
  records: readonly ViewerLogRecord[];
  status: "connecting" | "live" | "local" | "offline" | "reconnecting";
  truncated: boolean;
};

const emptySourceState = (): LogSourceState => ({
  activeTransport: null,
  cursors: {},
  error: null,
  history: {},
  records: [],
  status: "connecting",
  truncated: false,
});

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function localFallbackFor(
  worker: WorkerSummary,
  desktopWorkers: readonly DesktopWorkerStatus[],
  activeServerUrl: string,
  localServer: boolean,
): LocalServiceLogSource | undefined {
  const serverOrigin = normalizedOrigin(activeServerUrl);
  const linked = desktopWorkers.find(
    (candidate) =>
      candidate.workerId === worker.workerId &&
      normalizedOrigin(candidate.serverUrl) === serverOrigin,
  );
  if (linked) return { source: "linkedWorker", workerId: worker.workerId };
  if (localServer && worker.workerId === "desktop-local") {
    return { source: "worker" };
  }
  return undefined;
}

function logReadPosition(
  transport: string,
  cursorFor: (transport: string) => number | undefined,
  direction: "automatic" | "backward",
): {
  direction: "backward" | "forward";
  position: { afterCursor: number } | { beforeCursor: number };
} {
  const cursor = cursorFor(transport);
  if (direction === "backward" || cursor === undefined) {
    return {
      direction: "backward",
      position: { beforeCursor: cursor ?? TAIL_CURSOR },
    };
  }
  return { direction: "forward", position: { afterCursor: cursor } };
}

async function readSourcePage(
  source: LogSource,
  cursorFor: (transport: string) => number | undefined,
  direction: "automatic" | "backward" = "automatic",
): Promise<{
  direction: "backward" | "forward";
  result: ServiceLogReadResult;
  status: "live" | "local";
  transport: string;
}> {
  if (source.kind === "client") {
    if (isTauri()) {
      try {
        const transport = "local:client";
        const page = logReadPosition(transport, cursorFor, direction);
        return {
          result: await readLocalServiceLogs(
            { source: "client" },
            { ...page.position, limit: PAGE_SIZE },
          ),
          direction: page.direction,
          status: "local",
          transport,
        };
      } catch {
        // The permanent in-page buffer remains useful if the native reader is
        // briefly unavailable during desktop startup.
      }
    }
    const transport = "memory:client";
    const page = logReadPosition(transport, cursorFor, direction);
    return {
      result: readClientLogs({
        ...page.position,
        limit: PAGE_SIZE,
      }),
      direction: page.direction,
      status: "live",
      transport,
    };
  }

  if (source.kind === "server") {
    const transport = "local:server";
    const page = logReadPosition(transport, cursorFor, direction);
    return {
      result: await readLocalServiceLogs(
        { source: "server" },
        { ...page.position, limit: PAGE_SIZE },
      ),
      direction: page.direction,
      status: "local",
      transport,
    };
  }

  if (source.workerId && source.online) {
    const transport = `remote:${source.workerId}`;
    const page = logReadPosition(transport, cursorFor, direction);
    try {
      return {
        result: await getWorkerServiceLogs(source.workerId, {
          ...page.position,
          limit: PAGE_SIZE,
          minimumLevel: "trace",
        }),
        direction: page.direction,
        status: "live",
        transport,
      };
    } catch (error) {
      if (!source.fallback) throw error;
    }
  }

  if (source.fallback) {
    const transport = `local:${source.workerId ?? "worker"}`;
    const page = logReadPosition(transport, cursorFor, direction);
    return {
      result: await readLocalServiceLogs(source.fallback, {
        ...page.position,
        limit: PAGE_SIZE,
      }),
      direction: page.direction,
      status: "local",
      transport,
    };
  }

  throw new Error(
    source.online
      ? "The worker log stream is reconnecting."
      : "The worker is offline.",
  );
}

function sourceIcon(kind: LogSource["kind"]) {
  if (kind === "client") return Laptop;
  if (kind === "server") return Server;
  return Cpu;
}

export function LogSourceTabs({
  onSelect,
  selectedSourceId,
  sources,
}: {
  onSelect: (sourceId: string) => void;
  selectedSourceId: string;
  sources: readonly LogSource[];
}) {
  return (
    <NavigationTabBar
      activeTab={selectedSourceId}
      ariaLabel="Log sources"
      className="w-full border-b border-border/60"
      tabs={sources.map((source) => ({
        icon: sourceIcon(source.kind),
        id: source.id,
        label: source.label,
      }))}
      onTabChange={onSelect}
    />
  );
}

function lineAccent(record: ViewerLogRecord): string {
  if (record.level === "fatal" || record.level === "error") {
    return "text-red-400";
  }
  if (record.level === "warn") return "text-amber-400";
  if (record.level === "debug" || record.level === "trace") {
    return "text-muted-foreground";
  }
  if (record.system === "server") return "text-sky-300";
  if (record.system === "worker") return "text-fuchsia-300";
  if (record.system === "client" || record.system === "desktop") {
    return "text-emerald-300";
  }
  return "text-foreground";
}

function downloadText(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function VirtualLogConsole({
  followTail,
  hasOlder = false,
  loadingOlder = false,
  onFollowTailChange,
  onLoadOlder,
  records,
}: {
  followTail: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onFollowTailChange?: (follow: boolean) => void;
  onLoadOlder?: () => Promise<void>;
  records: readonly ViewerLogRecord[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const historyRequestActive = useRef(false);
  const [viewport, setViewport] = useState({ height: 400, scrollTop: 0 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () =>
      setViewport((current) => ({ ...current, height: element.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !followTail) return;
    element.scrollTop = element.scrollHeight;
  }, [followTail, records.length]);

  const start = Math.max(
    0,
    Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const end = Math.min(
    records.length,
    Math.ceil((viewport.scrollTop + viewport.height) / ROW_HEIGHT) +
      OVERSCAN_ROWS,
  );
  const visible = records.slice(start, end);

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[22px] [scrollbar-color:color-mix(in_srgb,currentColor_30%,transparent)_transparent]"
      role="log"
      aria-live="off"
      onScroll={(event) => {
        const element = event.currentTarget;
        // React clears currentTarget after this callback. Snapshot the DOM value
        // before the state updater runs, especially when WebKit defers it.
        scheduleLogViewportScroll(element, setViewport);
        if (
          shouldStopFollowingLogs({
            clientHeight: element.clientHeight,
            followTail,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            threshold: HISTORY_LOAD_THRESHOLD,
          })
        ) {
          onFollowTailChange?.(false);
        }
        if (
          !onLoadOlder ||
          historyRequestActive.current ||
          !shouldLoadOlderLogs({
            hasOlder,
            loadingOlder,
            scrollTop: element.scrollTop,
            threshold: HISTORY_LOAD_THRESHOLD,
          })
        ) {
          return;
        }
        historyRequestActive.current = true;
        const previousScrollHeight = element.scrollHeight;
        const previousScrollTop = element.scrollTop;
        void onLoadOlder()
          .catch(() => undefined)
          .finally(() => {
            window.requestAnimationFrame(() => {
              const current = viewportRef.current;
              if (current) {
                current.scrollTop = restoredLogScrollTop({
                  nextScrollHeight: current.scrollHeight,
                  previousScrollHeight,
                  previousScrollTop,
                });
              }
              historyRequestActive.current = false;
            });
          });
      }}
    >
      {loadingOlder ? (
        <div className="sticky left-0 top-0 z-10 h-6 bg-background/90 px-3 text-[10px] leading-6 text-muted-foreground backdrop-blur-sm">
          Loading older records…
        </div>
      ) : null}
      {records.length ? (
        <div
          className="relative min-w-full"
          style={{ height: records.length * ROW_HEIGHT }}
        >
          {visible.map((record, index) => (
            <div
              key={record.viewerKey}
              className={cn(
                "absolute left-0 min-w-full whitespace-pre px-3 hover:bg-white/[0.04]",
                lineAccent(record),
              )}
              style={{
                height: ROW_HEIGHT,
                transform: `translateY(${(start + index) * ROW_HEIGHT}px)`,
              }}
            >
              {formatServiceLogRecord(record)}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid h-full min-h-56 place-items-center px-6 text-center text-xs text-zinc-500">
          No matching log records yet.
        </div>
      )}
    </div>
  );
}

export function LogSettings() {
  const tauriRuntime = isTauri();
  const mobileRuntime = isMobileNativeRuntime();
  const workerResourcesLive = useAppLiveStatus() === "live";
  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
  });
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: liveResourceRefreshInterval(workerResourcesLive, 5_000),
  });
  const desktopWorkers = useQuery({
    enabled: tauriRuntime,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
    refetchInterval: 5_000,
  });
  const localServerUrl = useQuery({
    enabled: tauriRuntime,
    queryFn: getLocalRuntimeServerUrl,
    queryKey: ["local-runtime-server-url"],
  });
  const activeConnection = getActiveServerConnection();
  const activeServerUrl = getActiveServerUrl();
  const localServer = canReadLocalServerLogs({
    bootstrap: bootstrap.data,
    connection: activeConnection,
    localServerUrl: localServerUrl.data,
    tauriRuntime,
  });
  const sources = useMemo<LogSource[]>(() => {
    const available: LogSource[] = [
      {
        id: "client",
        kind: "client",
        label: "Client · This device",
        online: true,
        subtitle: tauriRuntime
          ? "Desktop shell and webview"
          : "This app session",
      },
    ];
    if (localServer) {
      available.push({
        id: "server:local",
        kind: "server",
        label: "Server · Local internal",
        online: true,
        subtitle: "Embedded on this device",
      });
    }
    for (const worker of workers.data ?? []) {
      available.push({
        id: `worker:${worker.workerId}`,
        kind: "worker",
        label: `Worker · ${worker.name}`,
        online: worker.online,
        subtitle: worker.online
          ? `${worker.platform} · ${worker.architecture}`
          : "Offline · retained lines remain visible",
        workerId: worker.workerId,
        fallback: tauriRuntime
          ? localFallbackFor(
              worker,
              desktopWorkers.data ?? [],
              activeServerUrl,
              localServer,
            )
          : undefined,
      });
    }
    if (
      localServer &&
      !available.some((source) => source.id === "worker:desktop-local")
    ) {
      available.push({
        id: "worker:desktop-local",
        kind: "worker",
        label: "Worker · Local Worker",
        online: false,
        subtitle: "Local startup diagnostics",
        workerId: "desktop-local",
        fallback: { source: "worker" },
      });
    }
    return available;
  }, [
    activeServerUrl,
    desktopWorkers.data,
    localServer,
    tauriRuntime,
    workers.data,
  ]);
  const [selectedSourceId, setSelectedSourceId] = useState("client");
  const selectedSource =
    sources.find((source) => source.id === selectedSourceId) ?? sources[0]!;
  const states = useRef(new Map<string, LogSourceState>());
  const historyLoads = useRef(new Set<string>());
  const [, render] = useReducer((value) => value + 1, 0);
  const [retryToken, retry] = useReducer((value) => value + 1, 0);
  const [search, setSearch] = useState("");
  const [minimumLevel, setMinimumLevel] = useState<ServiceLogLevel>("trace");
  const [followTail, setFollowTail] = useState(true);
  const [pausedAt, setPausedAt] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const [archiveAction, setArchiveAction] = useState<"export" | "open" | null>(
    null,
  );
  const [archiveActionError, setArchiveActionError] = useState<string | null>(
    null,
  );

  const currentState =
    states.current.get(selectedSource.id) ?? emptySourceState();
  const paused = pausedAt[selectedSource.id] !== undefined;
  const displayedRecords = paused
    ? currentState.records.slice(0, pausedAt[selectedSource.id])
    : currentState.records;
  const filteredRecords = useMemo(
    () => filterServiceLogRecords(displayedRecords, search, minimumLevel),
    [displayedRecords, minimumLevel, search],
  );

  useEffect(() => {
    if (sources.some(({ id }) => id === selectedSourceId)) return;
    setSelectedSourceId("client");
  }, [selectedSourceId, sources]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;
    let socket: WebSocket | null = null;
    let backoff = POLL_INTERVAL_MS;
    let consecutiveFailures = 0;
    let streamFailures = 0;

    const commit = (change: (state: LogSourceState) => LogSourceState) => {
      if (cancelled) return;
      const previous =
        states.current.get(selectedSource.id) ?? emptySourceState();
      states.current.set(selectedSource.id, change(previous));
      render();
    };
    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        timeout = undefined;
        void synchronize();
      }, delay);
    };
    const recordFailure = (error: unknown) => {
      consecutiveFailures += 1;
      const message =
        error instanceof Error ? error.message : "Log stream unavailable.";
      commit((latest) => ({
        ...latest,
        error: message,
        status: selectedSource.online ? "reconnecting" : "offline",
      }));
      clientLogger.rateLimited(
        `logs-stream:${selectedSource.id}`,
        selectedSource.online ? "warn" : "info",
        "Service log stream is unavailable",
        {
          attempt: consecutiveFailures,
          ...operationalErrorMetadata(error),
          event: "surface.logs.stream.failed",
          operation: "read-logs",
          reasonCode: selectedSource.online
            ? "transport-error"
            : "source-offline",
          sourceKind: selectedSource.kind,
          status: selectedSource.online ? "reconnecting" : "offline",
          subsystem: "logs",
          workerId: selectedSource.workerId,
        },
        { summaryEvery: 10, windowMs: 30_000 },
      );
      backoff = Math.min(MAX_BACKOFF_MS, Math.max(1_500, backoff * 2));
      schedule(backoff);
    };
    const connectRemoteStream = (afterCursor: number) => {
      if (!selectedSource.workerId || cancelled) return;
      commit((latest) => ({ ...latest, status: "connecting" }));
      const candidate = new WebSocket(
        workerLogStreamWebSocketUrl(
          activeServerUrl,
          window.location.origin,
          selectedSource.workerId,
          afterCursor,
          "trace",
        ),
      );
      socket = candidate;
      candidate.addEventListener("message", (event) => {
        if (cancelled || socket !== candidate) return;
        try {
          const message = parseWorkerLogStreamMessage(String(event.data));
          if (message.type === "error") {
            candidate.close(1012, message.message);
            return;
          }
          if (message.type === "ready") {
            consecutiveFailures = 0;
            streamFailures = 0;
            backoff = POLL_INTERVAL_MS;
            commit((latest) => ({ ...latest, error: null, status: "live" }));
            return;
          }
          if (message.truncated) {
            commit((latest) => ({ ...latest, truncated: true }));
            candidate.close(1012, "Worker log cursor gap");
            return;
          }
          const transport = `remote:${selectedSource.workerId}`;
          commit((latest) => ({
            ...latest,
            activeTransport: transport,
            cursors: {
              ...latest.cursors,
              [transport]: Math.max(
                latest.cursors[transport] ?? 0,
                message.nextCursor,
              ),
            },
            error: null,
            records: appendServiceLogRecords(
              latest.records,
              message.records,
              transport,
            ),
            status: "live",
          }));
        } catch (error) {
          candidate.close(1008, "Invalid worker log stream message");
          clientLogger.warn("Invalid worker log stream message", {
            ...operationalErrorMetadata(error),
            event: "surface.logs.stream.invalid-message",
            operation: "read-logs",
            subsystem: "logs",
            workerId: selectedSource.workerId,
          });
        }
      });
      candidate.addEventListener("error", () => {
        if (candidate.readyState < WebSocket.CLOSING) candidate.close();
      });
      candidate.addEventListener("close", () => {
        if (cancelled || socket !== candidate) return;
        socket = null;
        streamFailures += 1;
        recordFailure(new Error("Worker log stream disconnected."));
      });
    };
    const synchronize = async () => {
      const current =
        states.current.get(selectedSource.id) ?? emptySourceState();
      try {
        let page = await readSourcePage(
          selectedSource,
          (transport) => current.cursors[transport],
        );
        const cursorGap = page.direction === "forward" && page.result.truncated;
        if (
          shouldJumpToNewestLogs({
            direction: page.direction,
            hasMore: page.result.hasMore,
            truncated: page.result.truncated,
          })
        ) {
          // Do not churn through a large reconnect/poll backlog. Jump to the
          // current tail; the skipped range remains available through the
          // same backward pagination used when the user scrolls upward.
          page = await readSourcePage(selectedSource, () => undefined);
        }
        if (consecutiveFailures > 0) {
          clientLogger.info("Service log stream recovered", {
            attempt: consecutiveFailures + 1,
            event: "surface.logs.stream.recovered",
            operation: "read-logs",
            sourceKind: selectedSource.kind,
            status: page.status,
            subsystem: "logs",
            workerId: selectedSource.workerId,
          });
        }
        consecutiveFailures = 0;
        backoff = POLL_INTERVAL_MS;
        commit((latest) => {
          const history =
            page.direction === "backward"
              ? {
                  ...latest.history,
                  [page.transport]: {
                    beforeCursor: Math.max(
                      1,
                      page.result.records[0]?.cursor ??
                        page.result.oldestCursor ??
                        page.result.nextCursor,
                    ),
                    hasMore: page.result.hasMore,
                  },
                }
              : latest.history;
          return {
            ...latest,
            activeTransport: page.transport,
            cursors: {
              ...latest.cursors,
              [page.transport]: Math.max(
                latest.cursors[page.transport] ?? 0,
                page.result.nextCursor,
              ),
            },
            error: null,
            history,
            records: appendServiceLogRecords(
              latest.records,
              page.result.records,
              page.transport,
            ),
            status: page.status,
            truncated: latest.truncated || cursorGap || page.result.truncated,
          };
        });
        const remote =
          page.transport.startsWith("remote:") &&
          selectedSource.kind === "worker" &&
          Boolean(selectedSource.workerId) &&
          selectedSource.online;
        const action =
          page.direction === "backward"
            ? remote
              ? "stream"
              : "poll"
            : workerLogPageAction({
                hasMore: page.result.hasMore,
                remote,
                streamFailures,
              });
        if (action === "catch-up") {
          schedule(0);
        } else if (action === "stream") {
          connectRemoteStream(page.result.nextCursor);
        } else {
          const retryDelay = remote ? MAX_BACKOFF_MS : POLL_INTERVAL_MS;
          if (remote) streamFailures = 0;
          schedule(retryDelay);
        }
      } catch (error) {
        recordFailure(error);
      }
    };

    commit((state) => ({
      ...state,
      error: null,
      status: state.records.length ? state.status : "connecting",
    }));
    void synchronize();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      socket?.close(1000, "Log viewer changed source");
      socket = null;
    };
  }, [activeServerUrl, retryToken, selectedSource]);

  const activeHistory = currentState.activeTransport
    ? currentState.history[currentState.activeTransport]
    : undefined;
  const historyLoadKey = currentState.activeTransport
    ? `${selectedSource.id}:${currentState.activeTransport}`
    : null;
  const loadingOlder = historyLoadKey
    ? historyLoads.current.has(historyLoadKey)
    : false;
  const hasOlder = !paused && (activeHistory?.hasMore ?? false);
  const loadOlder = useCallback(async () => {
    const sourceId = selectedSource.id;
    const snapshot = states.current.get(sourceId) ?? emptySourceState();
    const transport = snapshot.activeTransport;
    const history = transport ? snapshot.history[transport] : undefined;
    if (!transport || !history?.hasMore) return;

    const key = `${sourceId}:${transport}`;
    if (historyLoads.current.has(key)) return;
    historyLoads.current.add(key);
    render();

    try {
      const page = await readSourcePage(
        selectedSource,
        (candidate) =>
          candidate === transport ? history.beforeCursor : undefined,
        "backward",
      );
      // A failed remote read may switch to a local fallback. Its cursor space
      // is independent, so let the normal source synchronizer adopt it.
      if (page.transport !== transport) return;

      const latest = states.current.get(sourceId) ?? emptySourceState();
      const currentHistory = latest.history[transport];
      if (!currentHistory) return;
      states.current.set(sourceId, {
        ...latest,
        error: null,
        history: {
          ...latest.history,
          [transport]: {
            beforeCursor: Math.max(
              1,
              page.result.records[0]?.cursor ?? currentHistory.beforeCursor,
            ),
            hasMore: page.result.hasMore,
          },
        },
        records: appendServiceLogRecords(
          latest.records,
          page.result.records,
          transport,
        ),
        truncated: latest.truncated || page.result.truncated,
      });
    } catch (error) {
      const latest = states.current.get(sourceId) ?? emptySourceState();
      states.current.set(sourceId, {
        ...latest,
        error:
          error instanceof Error
            ? error.message
            : "Could not load older log records.",
      });
    } finally {
      historyLoads.current.delete(key);
      render();
    }
  }, [selectedSource]);

  const clearVisible = useCallback(() => {
    const removed = new Set(filteredRecords.map(({ viewerKey }) => viewerKey));
    const state = states.current.get(selectedSource.id) ?? emptySourceState();
    states.current.set(selectedSource.id, {
      ...state,
      records: removeServiceLogRecords(state.records, removed),
    });
    if (paused) {
      setPausedAt((current) => ({
        ...current,
        [selectedSource.id]: Math.max(
          0,
          (current[selectedSource.id] ?? 0) - removed.size,
        ),
      }));
    }
    render();
  }, [filteredRecords, paused, selectedSource.id]);

  const StatusIcon =
    currentState.status === "connecting" ||
    currentState.status === "reconnecting"
      ? Loader2
      : currentState.status === "offline"
        ? CircleAlert
        : Check;
  const statusLabel =
    currentState.status === "local"
      ? selectedSource.kind === "worker"
        ? "Local fallback"
        : "Live · Local"
      : currentState.status === "live"
        ? "Live"
        : currentState.status === "connecting"
          ? "Connecting"
          : currentState.status === "reconnecting"
            ? "Reconnecting"
            : "Offline";

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <LogSourceTabs
        selectedSourceId={selectedSource.id}
        sources={sources}
        onSelect={setSelectedSourceId}
      />

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search logs"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-ring"
            placeholder="Search logs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Minimum log level"
          className="h-9 rounded-md border bg-background px-2 text-xs"
          value={minimumLevel}
          onChange={(event) =>
            setMinimumLevel(event.target.value as ServiceLogLevel)
          }
        >
          {SERVICE_LOG_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level === "trace" ? "All levels" : `${level}+`}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          variant={followTail ? "outline" : "ghost"}
          className="h-9 px-2.5"
          onClick={() => setFollowTail((value) => !value)}
          title="Follow newest records"
        >
          <ArrowDownToLine
            className={cn("size-3.5", followTail && "text-emerald-500")}
          />
          <span className="hidden sm:inline">Follow</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-9"
          title={paused ? "Resume display" : "Pause display"}
          onClick={() =>
            setPausedAt((current) => {
              if (current[selectedSource.id] !== undefined) {
                const next = { ...current };
                delete next[selectedSource.id];
                return next;
              }
              return {
                ...current,
                [selectedSource.id]: currentState.records.length,
              };
            })
          }
        >
          {paused ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )}
          <span className="sr-only">{paused ? "Resume" : "Pause"}</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={!filteredRecords.length}
          title="Copy visible output"
          onClick={() => {
            void navigator.clipboard
              .writeText(formatServiceLogRecords(filteredRecords))
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Clipboard className="size-3.5" />
          )}
          <span className="sr-only">Copy visible output</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={!filteredRecords.length}
          title="Export visible output"
          onClick={() =>
            downloadText(
              `cantrip-${selectedSource.id.replaceAll(":", "-")}-${new Date().toISOString().replaceAll(":", "-")}.log`,
              formatServiceLogRecords(filteredRecords),
            )
          }
        >
          <Download className="size-3.5" />
          <span className="sr-only">Export visible output</span>
        </Button>
        {tauriRuntime ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9"
            disabled={archiveAction !== null}
            title="Open Logs Folder"
            onClick={() => {
              setArchiveAction("open");
              setArchiveActionError(null);
              void openLocalLogsDirectory()
                .catch((error: unknown) =>
                  setArchiveActionError(
                    error instanceof Error
                      ? error.message
                      : "Could not open the logs folder.",
                  ),
                )
                .finally(() => setArchiveAction(null));
            }}
          >
            {archiveAction === "open" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderOpen className="size-3.5" />
            )}
            <span className="sr-only">Open Logs Folder</span>
          </Button>
        ) : null}
        {mobileRuntime ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9"
            disabled={archiveAction !== null}
            title="Export Device Logs"
            onClick={() => {
              setArchiveAction("export");
              setArchiveActionError(null);
              void exportMobileClientLogs()
                .catch((error: unknown) =>
                  setArchiveActionError(
                    error instanceof Error
                      ? error.message
                      : "Could not export device logs.",
                  ),
                )
                .finally(() => setArchiveAction(null));
            }}
          >
            {archiveAction === "export" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Share2 className="size-3.5" />
            )}
            <span className="sr-only">Export Device Logs</span>
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={!filteredRecords.length}
          title="Clear visible buffer"
          onClick={clearVisible}
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Clear visible buffer</span>
        </Button>
      </div>

      {archiveActionError ? (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {archiveActionError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-9 items-center gap-2 border-b border-white/10 px-3 text-[11px] text-zinc-400">
            <StatusIcon
              className={cn(
                "size-3.5",
                (currentState.status === "connecting" ||
                  currentState.status === "reconnecting") &&
                  "animate-spin",
                currentState.status === "offline" && "text-red-400",
                (currentState.status === "live" ||
                  currentState.status === "local") &&
                  "text-emerald-400",
              )}
            />
            <span>{statusLabel}</span>
            {paused ? <span>· Display paused</span> : null}
            {currentState.truncated ? (
              <span className="text-amber-400">· Old records rotated</span>
            ) : null}
            <span className="ml-auto tabular-nums">
              {filteredRecords.length.toLocaleString()} visible ·{" "}
              {currentState.records.length.toLocaleString()} buffered
            </span>
            {currentState.status === "offline" ||
            currentState.status === "reconnecting" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white"
                onClick={() => retry()}
              >
                Retry now
              </Button>
            ) : null}
          </div>
          {currentState.error ? (
            <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              {currentState.error}
            </div>
          ) : null}
          <VirtualLogConsole
            key={selectedSource.id}
            followTail={followTail}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onFollowTailChange={setFollowTail}
            onLoadOlder={loadOlder}
            records={filteredRecords}
          />
        </div>
      </div>
    </div>
  );
}
