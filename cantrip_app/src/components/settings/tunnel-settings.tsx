import type {
  ProjectSummary,
  TunnelProtocolHint,
  TunnelSummary,
  TunnelUserCreate,
  TunnelUserUpdate,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createTunnel,
  deleteTunnel,
  getTunnels,
  getWorkers,
  updateTunnel,
} from "@/lib/api";
import { getProjects } from "@/lib/project-encryption";
import { useAppLiveStatus } from "@/lib/app-live-react";
import {
  desktopTunnelAvailable,
  listDesktopTunnels,
  startDesktopTunnel,
  stopDesktopTunnel,
  type DesktopTunnelForwardSummary,
} from "@/lib/desktop-tunnel";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import { SettingsSearchField } from "./settings-controls";

const protocols: Array<{ label: string; value: TunnelProtocolHint }> = [
  { value: "tcp", label: "TCP" },
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "http-websocket", label: "HTTP + WebSocket" },
  { value: "https-websocket", label: "HTTPS + WebSocket" },
  { value: "webdav", label: "WebDAV" },
];

const inputClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";

interface TunnelDraft {
  description: string;
  host: "127.0.0.1" | "localhost" | "::1";
  name: string;
  port: string;
  projectId: string;
  protocolHint: TunnelProtocolHint;
  workerId: string;
}

function emptyDraft(projectId: string | null): TunnelDraft {
  return {
    description: "",
    host: "127.0.0.1",
    name: "",
    port: "",
    projectId: projectId ?? "",
    protocolHint: "tcp",
    workerId: "",
  };
}

function draftFor(tunnel: TunnelSummary): TunnelDraft {
  if (tunnel.destination.kind !== "worker-tcp") {
    return emptyDraft(tunnel.projectId);
  }
  return {
    description: tunnel.description ?? "",
    host: tunnel.destination.host,
    name: tunnel.name,
    port: String(tunnel.destination.port),
    projectId: tunnel.projectId ?? "",
    protocolHint: tunnel.protocolHint,
    workerId: tunnel.destination.workerId,
  };
}

export function tunnelLocalUrl(
  tunnel: TunnelSummary,
  attachment: DesktopTunnelForwardSummary | undefined,
): string | null {
  if (!attachment) return null;
  const scheme =
    tunnel.protocolHint === "https" || tunnel.protocolHint === "https-websocket"
      ? "https"
      : tunnel.protocolHint === "http" ||
          tunnel.protocolHint === "http-websocket" ||
          tunnel.protocolHint === "webdav"
        ? "http"
        : null;
  return scheme
    ? `${scheme}://${attachment.localHost}:${attachment.localPort}`
    : null;
}

export function tunnelMatchesSearch(
  tunnel: TunnelSummary,
  query: string,
  projects: ReadonlyMap<string, string>,
  workers: ReadonlyMap<string, string>,
): boolean {
  const search = query.trim().toLowerCase();
  if (!search) return true;
  const destination = tunnel.destination;
  const values = [
    tunnel.name,
    tunnel.description,
    tunnel.origin,
    tunnel.management,
    tunnel.protocolHint,
    tunnel.status,
    tunnel.projectId ? projects.get(tunnel.projectId) : "unspecified",
    destination.workerId,
    workers.get(destination.workerId),
    destination.kind === "worker-tcp"
      ? `${destination.host}:${destination.port}`
      : `${destination.adapter}:${destination.resourceId}`,
    tunnel.managedBy?.kind,
  ];
  return values.some((value) => value?.toLowerCase().includes(search));
}

export function summarizeDesktopTransports(
  forwards: DesktopTunnelForwardSummary[],
) {
  return forwards.reduce(
    (summary, forward) => {
      if (forward.routeState === "local-direct") summary.direct += 1;
      else if (forward.routeState === "relayed") summary.relayed += 1;
      else summary.degraded += 1;
      summary.bytes +=
        (forward.bytesFromLocal ?? 0) + (forward.bytesToLocal ?? 0);
      summary.connections += forward.connectionsOpened ?? 0;
      return summary;
    },
    { bytes: 0, connections: 0, degraded: 0, direct: 0, relayed: 0 },
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}

function statusTone(status: TunnelSummary["status"]): string {
  if (status === "active") return "bg-emerald-500";
  if (status === "failed" || status === "degraded") return "bg-destructive";
  if (status === "starting" || status === "stopping") return "bg-amber-500";
  return "bg-muted-foreground/60";
}

function projectLabel(
  tunnel: TunnelSummary,
  projects: ReadonlyMap<string, string>,
): string {
  return tunnel.projectId
    ? (projects.get(tunnel.projectId) ?? tunnel.projectId)
    : "Unspecified";
}

function managementLabel(tunnel: TunnelSummary): string {
  return tunnel.management === "user-managed"
    ? "Custom"
    : `Managed by ${tunnel.managedBy?.kind ?? tunnel.origin}`;
}

function TunnelRows({
  attachments,
  emptyText,
  items,
  onCopy,
  onDelete,
  onEdit,
  onOpen,
  onOpenOwner,
  onStart,
  onStop,
  projects,
  starting,
  stopping,
  workers,
}: {
  attachments: ReadonlyMap<string, DesktopTunnelForwardSummary>;
  emptyText: string;
  items: TunnelSummary[];
  onCopy(tunnel: TunnelSummary, url: string): void;
  onDelete(tunnel: TunnelSummary): void;
  onEdit(tunnel: TunnelSummary): void;
  onOpen(tunnel: TunnelSummary, url: string): void;
  onOpenOwner?(tunnel: TunnelSummary): void;
  onStart(tunnel: TunnelSummary): void;
  onStop(tunnel: TunnelSummary, attachment: DesktopTunnelForwardSummary): void;
  projects: ReadonlyMap<string, string>;
  starting: boolean;
  stopping: boolean;
  workers: ReadonlyMap<string, WorkerSummary>;
}) {
  const desktopAvailable = desktopTunnelAvailable();
  return (
    <div className="overflow-hidden border-y">
      <div className="hidden grid-cols-[minmax(12rem,1fr)_minmax(9rem,.55fr)_minmax(9rem,.65fr)_minmax(11rem,.7fr)_auto] gap-3 border-b bg-muted/25 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Tunnel</span>
        <span>Project</span>
        <span>Type</span>
        <span>Status / local endpoint</span>
        <span className="text-right">Actions</span>
      </div>
      <div className="divide-y">
        {items.map((tunnel) => {
          const destination = tunnel.destination;
          const worker = workers.get(destination.workerId);
          const local = attachments.get(tunnel.id);
          const localUrl = tunnelLocalUrl(tunnel, local);
          return (
            <div
              data-high-contrast-row
              key={tunnel.id}
              className="grid gap-2 px-3 py-2.5 lg:grid-cols-[minmax(12rem,1fr)_minmax(9rem,.55fr)_minmax(9rem,.65fr)_minmax(11rem,.7fr)_auto] lg:items-center lg:gap-3"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Link2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {tunnel.name}
                  </span>
                  {tunnel.management !== "user-managed" ? (
                    <LockKeyhole
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label="Managed tunnel"
                    />
                  ) : null}
                </div>
                <p className="mt-1 truncate pl-6 font-mono text-[10px] text-muted-foreground">
                  {worker?.name ?? destination.workerId} ·{" "}
                  {destination.kind === "worker-tcp"
                    ? `${destination.host}:${destination.port}`
                    : `${destination.adapter}:${destination.resourceId}`}
                </p>
              </div>
              <div className="min-w-0 text-xs text-muted-foreground">
                <span className="lg:hidden">Project · </span>
                <span className="truncate">
                  {projectLabel(tunnel, projects)}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{tunnel.protocolHint}</Badge>
                <Badge variant="outline">{managementLabel(tunnel)}</Badge>
              </div>
              <div className="min-w-0 text-xs">
                <span className="inline-flex items-center gap-1.5 capitalize">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      statusTone(tunnel.status),
                    )}
                  />
                  {tunnel.status}
                  {!worker?.online ? " · worker offline" : ""}
                </span>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {local
                    ? `${local.routeState === "local-direct" ? "Local direct" : local.routeState === "relayed" ? "Server relayed" : "Reconnecting"} · ${local.localHost}:${local.localPort}`
                    : tunnel.attachments.length
                      ? `${tunnel.attachments.length} remote ${tunnel.attachments.length === 1 ? "attachment" : "attachments"}`
                      : "Not attached on this device"}
                </p>
              </div>
              <div className="flex items-center justify-end gap-0.5">
                {localUrl ? (
                  <>
                    <Button
                      aria-label={`Open ${tunnel.name}`}
                      className="size-8"
                      size="icon"
                      title="Open local endpoint"
                      variant="ghost"
                      onClick={() => onOpen(tunnel, localUrl)}
                    >
                      <ExternalLink className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={`Copy ${tunnel.name} URL`}
                      className="size-8"
                      size="icon"
                      title="Copy local URL"
                      variant="ghost"
                      onClick={() => onCopy(tunnel, localUrl)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </>
                ) : null}
                {local ? (
                  <Button
                    aria-label={`Stop ${tunnel.name}`}
                    className="size-8"
                    disabled={stopping}
                    size="icon"
                    title="Disconnect this device"
                    variant="ghost"
                    onClick={() => onStop(tunnel, local)}
                  >
                    {stopping ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                  </Button>
                ) : tunnel.capabilities.canAttach ? (
                  <Button
                    aria-label={`Start ${tunnel.name}`}
                    className="size-8"
                    disabled={!desktopAvailable || starting || !worker?.online}
                    size="icon"
                    title={
                      !desktopAvailable
                        ? "Local ports are only available in the desktop app"
                        : !worker?.online
                          ? "The destination worker is offline"
                          : "Attach a local port"
                    }
                    variant="ghost"
                    onClick={() => onStart(tunnel)}
                  >
                    {starting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                  </Button>
                ) : null}
                {tunnel.capabilities.canOpenOwner ? (
                  <Button
                    aria-label={`Open owner of ${tunnel.name}`}
                    className="h-8 px-2 text-xs"
                    disabled={!onOpenOwner}
                    size="sm"
                    title="Managed tunnels are edited from their owning feature"
                    variant="ghost"
                    onClick={() => onOpenOwner?.(tunnel)}
                  >
                    Open owner
                  </Button>
                ) : null}
                {tunnel.capabilities.canEdit ? (
                  <Button
                    aria-label={`Edit ${tunnel.name}`}
                    className="size-8"
                    size="icon"
                    title="Edit tunnel"
                    variant="ghost"
                    onClick={() => onEdit(tunnel)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                ) : null}
                {tunnel.capabilities.canDelete ? (
                  <Button
                    aria-label={`Delete ${tunnel.name}`}
                    className="size-8"
                    size="icon"
                    title="Delete tunnel"
                    variant="ghost"
                    onClick={() => onDelete(tunnel)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        {!items.length ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TunnelSettings({
  onOpenOwner,
  project,
}: {
  onOpenOwner?(tunnel: TunnelSummary): void;
  project?: ProjectSummary;
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const allTunnels = useQuery({
    queryFn: () => getTunnels(),
    queryKey: ["tunnels"],
  });
  const projectTunnels = useQuery({
    enabled: Boolean(project),
    queryFn: () => getTunnels(project!.id),
    queryKey: ["project-tunnels", project?.id],
  });
  const projects = useQuery({ queryFn: getProjects, queryKey: ["projects"] });
  const workers = useQuery({ queryFn: getWorkers, queryKey: ["workers"] });
  const [searchQuery, setSearchQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelSummary | null>(null);
  const [draft, setDraft] = useState<TunnelDraft>(() =>
    emptyDraft(project?.id ?? null),
  );
  const [deleteTarget, setDeleteTarget] = useState<TunnelSummary | null>(null);
  const [startTarget, setStartTarget] = useState<TunnelSummary | null>(null);
  const [preferredPort, setPreferredPort] = useState("");
  const [localTunnels, setLocalTunnels] = useState<
    DesktopTunnelForwardSummary[]
  >([]);
  const [copiedTunnelId, setCopiedTunnelId] = useState<string | null>(null);

  const refreshLocalTunnels = () =>
    listDesktopTunnels()
      .then(setLocalTunnels)
      .catch(() => setLocalTunnels([]));
  useEffect(() => {
    void refreshLocalTunnels();
    const timer = window.setInterval(() => void refreshLocalTunnels(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
      ...(project
        ? [
            queryClient.invalidateQueries({
              queryKey: ["project-tunnels", project.id],
            }),
          ]
        : []),
    ]);
  };

  const save = useMutation({
    mutationFn: async () => {
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Enter a destination port between 1 and 65535.");
      }
      const common = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        projectId: draft.projectId || null,
        protocolHint: draft.protocolHint,
        destination: {
          kind: "worker-tcp" as const,
          workerId: draft.workerId,
          host: draft.host,
          port,
        },
      };
      return editing
        ? updateTunnel(editing.id, common satisfies TunnelUserUpdate)
        : createTunnel(common satisfies TunnelUserCreate);
    },
    onSuccess: async () => {
      setEditorOpen(false);
      setEditing(null);
      await refreshQueries();
    },
  });
  const remove = useMutation({
    mutationFn: (tunnel: TunnelSummary) => deleteTunnel(tunnel.id),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refreshQueries();
    },
  });
  const start = useMutation({
    mutationFn: async (tunnel: TunnelSummary) => {
      const port = preferredPort.trim() ? Number(preferredPort) : undefined;
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port < 1 || port > 65_535)
      ) {
        throw new Error("Enter a preferred local port between 1 and 65535.");
      }
      return startDesktopTunnel(tunnel.id, { preferredLocalPort: port });
    },
    onSuccess: async (attachment) => {
      setStartTarget(null);
      setPreferredPort("");
      setLocalTunnels((current) => [
        ...current.filter(({ tunnelId }) => tunnelId !== attachment.tunnelId),
        attachment,
      ]);
      await refreshQueries();
    },
  });
  const stop = useMutation({
    mutationFn: ({
      attachment,
      tunnel,
    }: {
      attachment: DesktopTunnelForwardSummary;
      tunnel: TunnelSummary;
    }) => stopDesktopTunnel(tunnel.id, attachment.attachmentId),
    onSuccess: async () => {
      await refreshLocalTunnels();
      await refreshQueries();
    },
  });

  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((item) => [item.id, item.name])),
    [projects.data],
  );
  const workerRecords = useMemo(
    () =>
      new Map((workers.data ?? []).map((worker) => [worker.workerId, worker])),
    [workers.data],
  );
  const workerNames = useMemo(
    () =>
      new Map(
        [...workerRecords].map(([workerId, worker]) => [workerId, worker.name]),
      ),
    [workerRecords],
  );
  const localByTunnel = useMemo(
    () => new Map(localTunnels.map((item) => [item.tunnelId, item])),
    [localTunnels],
  );
  const transportSummary = useMemo(
    () => summarizeDesktopTransports(localTunnels),
    [localTunnels],
  );
  const filteredAll = (allTunnels.data ?? []).filter((tunnel) =>
    tunnelMatchesSearch(tunnel, searchQuery, projectNames, workerNames),
  );
  const filteredProject = (projectTunnels.data ?? []).filter((tunnel) =>
    tunnelMatchesSearch(tunnel, searchQuery, projectNames, workerNames),
  );
  const operationError =
    save.error ?? remove.error ?? start.error ?? stop.error ?? null;

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft(project?.id ?? null));
    setEditorOpen(true);
  };
  const openEdit = (tunnel: TunnelSummary) => {
    setEditing(tunnel);
    setDraft(draftFor(tunnel));
    setEditorOpen(true);
  };
  const openEndpoint = async (_tunnel: TunnelSummary, url: string) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  };
  const copyEndpoint = (tunnel: TunnelSummary, url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedTunnelId(tunnel.id);
      window.setTimeout(() => setCopiedTunnelId(null), 1_500);
    });
  };
  const rowsProps = {
    attachments: localByTunnel,
    onCopy: copyEndpoint,
    onDelete: setDeleteTarget,
    onEdit: openEdit,
    onOpen: openEndpoint,
    onOpenOwner,
    onStart: (tunnel: TunnelSummary) => {
      setPreferredPort("");
      setStartTarget(tunnel);
    },
    onStop: (tunnel: TunnelSummary, attachment: DesktopTunnelForwardSummary) =>
      stop.mutate({ tunnel, attachment }),
    projects: projectNames,
    starting: start.isPending,
    stopping: stop.isPending,
    workers: workerRecords,
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {project ? "Project tunnels" : "Tunnels"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Saved and feature-managed routes through Cantrip. Project selection
            is organizational; every destination worker is selected explicitly.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={allTunnels.isFetching || projectTunnels.isFetching}
            onClick={() => {
              void Promise.all([
                allTunnels.refetch(),
                ...(project ? [projectTunnels.refetch()] : []),
                refreshLocalTunnels(),
              ]);
            }}
          >
            <RefreshCw
              className={cn(
                "size-4",
                (allTunnels.isFetching || projectTunnels.isFetching) &&
                  "animate-spin",
              )}
            />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> New tunnel
          </Button>
        </div>
      </div>

      <SettingsSearchField
        ariaLabel="Search tunnels"
        placeholder="Search tunnels, projects, workers, ports, and status"
        value={searchQuery}
        onValueChange={setSearchQuery}
      />

      {desktopTunnelAvailable() ? (
        <section className="flex flex-wrap items-center gap-x-5 gap-y-1 border-y px-3 py-2 text-xs">
          <span className="font-medium">Desktop data plane</span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {transportSummary.direct} local direct
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-500" />
            {transportSummary.relayed} server relayed
            {transportSummary.degraded > 0
              ? ` · ${transportSummary.degraded} reconnecting`
              : ""}
          </span>
          <span className="text-muted-foreground">
            {transportSummary.connections} connections ·{" "}
            {formatBytes(transportSummary.bytes)}
          </span>
        </section>
      ) : null}

      {liveStatus !== "live" ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          Live updates are {liveStatus.replaceAll("-", " ")}. This snapshot
          remains available; use Refresh if you need the latest server state.
        </p>
      ) : null}
      {!desktopTunnelAvailable() ? (
        <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          Local port attachments are available in the desktop app. Tunnel
          definitions remain viewable and manageable here.
        </p>
      ) : null}
      {allTunnels.isError || projectTunnels.isError ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(allTunnels.error ?? projectTunnels.error)}
        </p>
      ) : null}
      {operationError ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(operationError)}
        </p>
      ) : null}
      {copiedTunnelId ? (
        <p className="sr-only" role="status">
          Local tunnel URL copied.
        </p>
      ) : null}

      {project ? (
        <section
          aria-labelledby="project-tunnel-list-title"
          className="space-y-2"
        >
          <div className="px-3">
            <h3
              id="project-tunnel-list-title"
              className="text-sm font-semibold"
            >
              Project Tunnels
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Automatic and custom tunnels organized under {project.name}.
            </p>
          </div>
          <TunnelRows
            {...rowsProps}
            items={filteredProject}
            emptyText={
              searchQuery.trim()
                ? `No project tunnels match “${searchQuery.trim()}”.`
                : "No tunnels are associated with this project."
            }
          />
        </section>
      ) : null}

      <section
        aria-labelledby="all-tunnel-list-title"
        className={cn("space-y-2", project && "border-t pt-4")}
      >
        <div className="px-3">
          <h3 id="all-tunnel-list-title" className="text-sm font-semibold">
            {project ? "All Tunnels" : "Tunnel Inventory"}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {project
              ? "Every tunnel owned by your account, including Unspecified and other projects."
              : "Every custom and feature-managed tunnel owned by your account."}
          </p>
        </div>
        <TunnelRows
          {...rowsProps}
          items={filteredAll}
          emptyText={
            searchQuery.trim()
              ? `No tunnels match “${searchQuery.trim()}”.`
              : "No tunnels have been created yet."
          }
        />
      </section>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl">
          <form
            className="grid gap-4"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit tunnel" : "New tunnel"}
              </DialogTitle>
              <DialogDescription>
                Project is only an organizational label. Choose the destination
                worker and port independently.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm sm:col-span-2">
                <span className="font-medium">Name</span>
                <input
                  autoFocus
                  className={inputClass}
                  maxLength={120}
                  required
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Project</span>
                <NativeSelect
                  className={inputClass}
                  value={draft.projectId}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                    }))
                  }
                >
                  <option value="">Unspecified</option>
                  {(projects.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Destination worker</span>
                <NativeSelect
                  className={inputClass}
                  required
                  value={draft.workerId}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      workerId: event.target.value,
                    }))
                  }
                >
                  <option value="" disabled>
                    Select a worker
                  </option>
                  {(workers.data ?? []).map((worker) => (
                    <option key={worker.workerId} value={worker.workerId}>
                      {worker.name}
                      {worker.online ? "" : " (offline)"}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Protocol</span>
                <NativeSelect
                  className={inputClass}
                  value={draft.protocolHint}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      protocolHint: event.target.value as TunnelProtocolHint,
                    }))
                  }
                >
                  {protocols.map((protocol) => (
                    <option key={protocol.value} value={protocol.value}>
                      {protocol.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Worker host</span>
                <NativeSelect
                  className={inputClass}
                  value={draft.host}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      host: event.target.value as TunnelDraft["host"],
                    }))
                  }
                >
                  <option value="127.0.0.1">127.0.0.1</option>
                  <option value="localhost">localhost</option>
                  <option value="::1">::1</option>
                </NativeSelect>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Destination port</span>
                <input
                  className={inputClass}
                  inputMode="numeric"
                  max={65_535}
                  min={1}
                  required
                  type="number"
                  value={draft.port}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      port: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1.5 text-sm sm:col-span-2">
                <span className="font-medium">Description (optional)</span>
                <textarea
                  className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
                  maxLength={1_000}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            {save.isError ? (
              <p className="text-sm text-destructive">
                {errorMessage(save.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditorOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={save.isPending} type="submit">
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {editing ? "Save changes" : "Create tunnel"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(startTarget)}
        onOpenChange={(open) => !open && setStartTarget(null)}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (startTarget) start.mutate(startTarget);
            }}
          >
            <DialogHeader>
              <DialogTitle>Attach local port</DialogTitle>
              <DialogDescription>
                Cantrip will bind only to 127.0.0.1 on this device. Leave the
                port empty to allocate one automatically.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">
                Preferred local port (optional)
              </span>
              <input
                autoFocus
                className={inputClass}
                inputMode="numeric"
                max={65_535}
                min={1}
                placeholder="Automatic"
                type="number"
                value={preferredPort}
                onChange={(event) => setPreferredPort(event.target.value)}
              />
            </label>
            {start.isError ? (
              <p className="text-sm text-destructive">
                {errorMessage(start.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStartTarget(null)}
              >
                Cancel
              </Button>
              <Button disabled={start.isPending} type="submit">
                {start.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Start
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This removes the saved tunnel definition. Active attachments must
              be stopped first. Managed tunnels are removed from their owning
              feature instead.
            </DialogDescription>
          </DialogHeader>
          {remove.isError ? (
            <p className="text-sm text-destructive">
              {errorMessage(remove.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
