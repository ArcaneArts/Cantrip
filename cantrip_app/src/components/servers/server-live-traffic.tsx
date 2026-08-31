import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { AccountLiveTrafficSample } from "@cantrip/protocol";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { CantripApiError, getAccountLiveTraffic } from "@/lib/api";
import {
  formatBitRate,
  type LiveTrafficHistory,
  mergeLiveTrafficHistory,
} from "@/lib/live-traffic";
import { cn } from "@/lib/utils";

export type LiveTrafficStatus =
  | "available"
  | "disconnected"
  | "idle"
  | "loading"
  | "unavailable"
  | "unsupported";

export interface LiveTrafficViewState {
  history: LiveTrafficHistory | null;
  status: LiveTrafficStatus;
}

const POLL_INTERVAL_MS = 1_000;

export function useServerLiveTraffic(
  serverId: string,
  visible: boolean,
  fetchTraffic: typeof getAccountLiveTraffic = getAccountLiveTraffic,
): LiveTrafficViewState {
  const [historyState, setHistoryState] = useState<{
    history: LiveTrafficHistory | null;
    serverId: string;
  }>({ history: null, serverId });
  const [statusState, setStatusState] = useState<{
    serverId: string;
    status: LiveTrafficStatus;
  }>({ serverId, status: "idle" });
  const historyRef = useRef<LiveTrafficHistory | null>(null);

  const history =
    historyState.serverId === serverId ? historyState.history : null;
  const status =
    statusState.serverId === serverId ? statusState.status : "idle";

  useEffect(() => {
    historyRef.current = null;
    setHistoryState({ history: null, serverId });
    setStatusState({ serverId, status: "idle" });
  }, [serverId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      const startedAt = performance.now();
      const previous = historyRef.current;
      if (!previous) setStatusState({ serverId, status: "loading" });
      controller = new AbortController();
      let retry = true;
      try {
        const incoming = await fetchTraffic(
          previous
            ? { after: previous.cursor, epoch: previous.epoch }
            : undefined,
          controller.signal,
        );
        if (cancelled) return;
        const merged = mergeLiveTrafficHistory(previous, incoming);
        historyRef.current = merged;
        setHistoryState({ history: merged, serverId });
        setStatusState({ serverId, status: "available" });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (error instanceof CantripApiError && error.status === 404) {
          retry = false;
          setStatusState({ serverId, status: "unsupported" });
        } else if (
          typeof navigator !== "undefined" &&
          navigator.onLine === false
        ) {
          setStatusState({ serverId, status: "disconnected" });
        } else {
          setStatusState({ serverId, status: "unavailable" });
        }
      } finally {
        if (!cancelled && retry) {
          const elapsed = performance.now() - startedAt;
          timer = setTimeout(poll, Math.max(0, POLL_INTERVAL_MS - elapsed));
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [fetchTraffic, serverId, visible]);

  return { history, status };
}

interface SparklineSeries {
  className: string;
  label: string;
  values: number[];
}

export function LiveTrafficSparkline({
  ariaLabel,
  series,
}: {
  ariaLabel: string;
  series: SparklineSeries[];
}) {
  const maximum = Math.max(1, ...series.flatMap(({ values }) => values));
  return (
    <svg
      aria-label={ariaLabel}
      className="h-10 w-full"
      preserveAspectRatio="none"
      role="img"
      viewBox="0 0 300 40"
    >
      <title>{ariaLabel}</title>
      <line
        className="stroke-border"
        strokeWidth="1"
        x1="0"
        x2="300"
        y1="36"
        y2="36"
      />
      {series.map(({ className, label, values }) => (
        <polyline
          aria-label={label}
          className={className}
          fill="none"
          key={label}
          points={values
            .map((value, index) => {
              const x =
                values.length <= 1 ? 0 : (index / (values.length - 1)) * 300;
              const y = 36 - (Math.max(0, value) / maximum) * 32;
              return `${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ")}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function Metric({
  detail,
  label,
  value,
}: {
  detail?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-xs font-medium tabular-nums">{value}</p>
      {detail ? (
        <p className="truncate text-[9px] text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

function SeriesLabel({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", className)}
      />
      {children}
    </span>
  );
}

function TrafficCharts({ samples }: { samples: AccountLiveTrafficSample[] }) {
  const series = useMemo(
    () => ({
      download: samples.map(({ downloadBytes }) => downloadBytes * 8),
      http: samples.map(({ httpRequests }) => httpRequests),
      upload: samples.map(({ uploadBytes }) => uploadBytes * 8),
      websocket: samples.map(
        ({ websocketMessages }) => websocketMessages.total,
      ),
    }),
    [samples],
  );
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Transfer rate</span>
          <span className="flex gap-2">
            <SeriesLabel className="bg-sky-400">Download</SeriesLabel>
            <SeriesLabel className="bg-fuchsia-400">Upload</SeriesLabel>
          </span>
        </div>
        <LiveTrafficSparkline
          ariaLabel="Five-minute upload and download bit-rate history"
          series={[
            {
              className: "stroke-sky-400",
              label: "Download bit rate",
              values: series.download,
            },
            {
              className: "stroke-fuchsia-400",
              label: "Upload bit rate",
              values: series.upload,
            },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[9px] text-muted-foreground">HTTP requests/s</p>
          <LiveTrafficSparkline
            ariaLabel="Five-minute HTTP requests per second history"
            series={[
              {
                className: "stroke-amber-400",
                label: "HTTP requests per second",
                values: series.http,
              },
            ]}
          />
        </div>
        <div>
          <p className="text-[9px] text-muted-foreground">
            WebSocket messages/s
          </p>
          <LiveTrafficSparkline
            ariaLabel="Five-minute WebSocket messages per second history"
            series={[
              {
                className: "stroke-violet-400",
                label: "WebSocket messages per second",
                values: series.websocket,
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function statusMessage(status: LiveTrafficStatus): string {
  switch (status) {
    case "disconnected":
      return "The selected server is disconnected.";
    case "unavailable":
      return "Live traffic is temporarily unavailable. Retrying…";
    case "unsupported":
      return "This server version does not provide live traffic.";
    default:
      return "Loading five minutes of server traffic…";
  }
}

export function ServerLiveTrafficPanel({
  history,
  status,
}: LiveTrafficViewState) {
  if (!history) {
    return (
      <div
        aria-live="polite"
        className="grid min-h-28 place-items-center px-4 text-center text-xs text-muted-foreground"
        data-live-traffic-status={status}
      >
        {statusMessage(status)}
      </div>
    );
  }
  const { current } = history;
  return (
    <div data-live-traffic-status={status}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Live traffic</p>
          <p className="text-[9px] text-muted-foreground">
            Current server instance · last five minutes
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              status === "available" ? "bg-emerald-400" : "bg-amber-400",
            )}
          />
          {status === "available" ? "Live" : "Retrying"}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1.5">
        <Metric label="Download" value={formatBitRate(current.downloadBytes)} />
        <Metric label="Upload" value={formatBitRate(current.uploadBytes)} />
        <Metric label="HTTP" value={`${current.httpRequests} req/s`} />
        <Metric
          detail={`${current.websocketMessages.download} down · ${current.websocketMessages.upload} up`}
          label="WebSocket"
          value={`${current.websocketMessages.total} msg/s`}
        />
      </div>
      <TrafficCharts samples={history.samples} />
      <p className="mt-2 text-[9px] leading-3 text-muted-foreground">
        Application payload only; direct worker traffic and transport overhead
        are excluded.
      </p>
    </div>
  );
}

export function ActiveServerTrafficSubmenu({
  children,
  className,
  serverId,
}: {
  children: ReactNode;
  className?: string;
  serverId: string;
}) {
  const [open, setOpen] = useState(false);
  const traffic = useServerLiveTraffic(serverId, open);
  return (
    <DropdownMenuPrimitive.Sub onOpenChange={setOpen} open={open}>
      <DropdownMenuPrimitive.SubTrigger className={className}>
        {children}
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent
          aria-label="Selected server live traffic"
          className="z-[90] w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl"
          collisionPadding={12}
          sideOffset={6}
        >
          <ServerLiveTrafficPanel {...traffic} />
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
  );
}
