import type {
  RemoteDesktopFleetWorker,
  RemoteDesktopSummary,
  RemoteDesktopTarget,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  Check,
  Loader2,
  MonitorUp,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { getRemoteDesktopFleet } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_VISIBLE_TARGETS_PER_WORKER = 100;

export function filterRemoteDesktopFleetTargets(
  worker: Pick<RemoteDesktopFleetWorker, "inventory">,
  query: string,
) {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return worker.inventory;
  return {
    monitors: worker.inventory.monitors.filter((monitor) =>
      [
        monitor.name,
        monitor.id,
        `${monitor.width}x${monitor.height}`,
        monitor.primary ? "primary display" : "display",
      ].some((value) =>
        value.normalize("NFKC").toLocaleLowerCase().includes(needle),
      ),
    ),
    windows: worker.inventory.windows.filter((window) =>
      [window.application, window.title, window.id].some((value) =>
        value.normalize("NFKC").toLocaleLowerCase().includes(needle),
      ),
    ),
  };
}

function targetsMatch(
  left: RemoteDesktopTarget,
  right: RemoteDesktopTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "monitor" && right.kind === "monitor") {
    return left.id
      ? left.id === right.id
      : left.name
        ? left.name === right.name
        : !right.id && !right.name;
  }
  if (left.kind === "window" && right.kind === "window") {
    return left.id
      ? left.id === right.id
      : left.application === right.application && left.title === right.title;
  }
  return false;
}

function surfaceState(desktops: RemoteDesktopSummary[]): string {
  if (!desktops.length) return "No open streams";
  const active = desktops.filter(({ status }) => status === "active").length;
  const reconnecting = desktops.filter(({ status }) =>
    ["connecting", "offline"].includes(status),
  ).length;
  return [
    `${desktops.length} stream${desktops.length === 1 ? "" : "s"}`,
    active ? `${active} active` : null,
    reconnecting ? `${reconnecting} reconnecting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function RemoteDesktopFleetPanel({
  currentDesktop,
  onClose,
  onSelect,
}: {
  currentDesktop: RemoteDesktopSummary;
  onClose(): void;
  onSelect(workerId: string, target: RemoteDesktopTarget): void;
}) {
  const [search, setSearch] = useState("");
  const fleet = useQuery({
    queryKey: ["remote-desktop-fleet", currentDesktop.projectId],
    queryFn: () => getRemoteDesktopFleet(currentDesktop.projectId),
    retry: false,
    staleTime: 5_000,
  });
  const workers = useMemo(
    () =>
      (fleet.data?.workers ?? []).map((worker) => ({
        worker,
        filtered: filterRemoteDesktopFleetTargets(worker, search),
      })),
    [fleet.data?.workers, search],
  );

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex min-h-0 w-[22rem] max-w-[85vw] flex-col border-l border-border/70 bg-background shadow-xl">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Desktop fleet</div>
          <div className="truncate text-[10px] text-muted-foreground">
            Worker-specific displays, windows, and streams
          </div>
        </div>
        <Button
          aria-label="Refresh desktop fleet"
          className="size-7"
          disabled={fleet.isFetching}
          onClick={() => void fleet.refetch()}
          size="icon"
          title="Refresh desktop fleet"
          variant="ghost"
        >
          <RefreshCw
            className={cn("size-3.5", fleet.isFetching && "animate-spin")}
          />
        </Button>
        <Button
          aria-label="Close desktop fleet"
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="relative shrink-0 border-b border-border/60 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          aria-label="Search desktop fleet"
          className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search workers, displays, or windows"
          type="search"
          value={search}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {fleet.isPending ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Inspecting workers…
          </div>
        ) : fleet.isError ? (
          <div className="p-4 text-xs text-destructive">
            {fleet.error instanceof Error
              ? fleet.error.message
              : "Could not load the desktop fleet."}
          </div>
        ) : null}
        {workers.map(({ worker, filtered }) => {
          const targets: Array<{
            key: string;
            label: string;
            detail: string;
            target: RemoteDesktopTarget;
          }> = [
            ...filtered.monitors.map((monitor) => ({
              key: `monitor:${monitor.id}`,
              label: monitor.name,
              detail: `${monitor.width} × ${monitor.height}${monitor.primary ? " · primary" : ""}`,
              target: {
                kind: "monitor" as const,
                id: monitor.id,
                name: monitor.name,
              },
            })),
            ...filtered.windows.map((window) => ({
              key: `window:${window.id}`,
              label: window.application,
              detail: `${window.title}${window.minimized ? " · minimized" : ""}`,
              target: {
                kind: "window" as const,
                id: window.id,
                application: window.application,
                title: window.title,
              },
            })),
          ];
          const shownTargets = targets.slice(0, MAX_VISIBLE_TARGETS_PER_WORKER);
          const currentWorker = worker.workerId === currentDesktop.workerId;
          const workerMatchesSearch = [
            worker.workerName,
            worker.workerId,
            worker.platform,
            worker.architecture,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase());
          if (search && !workerMatchesSearch && !shownTargets.length) {
            return null;
          }
          return (
            <section
              className="border-b border-border/60 px-3 py-3 last:border-b-0"
              key={worker.workerId}
            >
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    worker.status === "ok"
                      ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                      : "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.75)]",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="truncate">{worker.workerName}</span>
                    {currentWorker ? (
                      <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                        current
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {worker.platform} · {worker.architecture} ·{" "}
                    {surfaceState(worker.desktops)}
                  </div>
                </div>
              </div>
              {worker.error ? (
                <div className="mt-2 text-[10px] leading-4 text-destructive">
                  {worker.error.message}
                </div>
              ) : shownTargets.length ? (
                <div className="mt-2 divide-y divide-border/40">
                  {shownTargets.map(({ key, label, detail, target }) => {
                    const current =
                      currentWorker &&
                      targetsMatch(currentDesktop.target, target);
                    return (
                      <button
                        className="flex w-full items-center gap-2 py-1.5 text-left hover:text-foreground"
                        key={key}
                        onClick={() => onSelect(worker.workerId, target)}
                        type="button"
                      >
                        {target.kind === "monitor" ? (
                          <MonitorUp className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px]">
                            {label}
                          </span>
                          <span className="block truncate text-[9px] text-muted-foreground">
                            {detail}
                          </span>
                        </span>
                        {current ? <Check className="size-3 shrink-0" /> : null}
                      </button>
                    );
                  })}
                  {targets.length > shownTargets.length ? (
                    <div className="py-2 text-[9px] text-muted-foreground">
                      {targets.length - shownTargets.length} more targets. Use
                      search to narrow the list.
                    </div>
                  ) : null}
                </div>
              ) : worker.status === "ok" ? (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  {search ? "No matching targets" : "No targets reported"}
                </div>
              ) : null}
            </section>
          );
        })}
        {!fleet.isPending && !fleet.isError && !workers.length ? (
          <div className="p-4 text-xs text-muted-foreground">
            No desktop-capable workers are linked.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
