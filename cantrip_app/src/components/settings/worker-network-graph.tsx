import type {
  AccountSessionSummary,
  WorkerManagementSummary,
} from "@cantrip/protocol";
import type { LucideIcon } from "lucide-react";
import {
  Cloud,
  Cpu,
  Laptop,
  MonitorSmartphone,
  Network,
  Server,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type NetworkNodeKind = "client" | "server" | "worker";

type NetworkDetail = {
  label: string;
  monospace?: boolean;
  value: string;
};

type NetworkNode = {
  connected: boolean;
  details: NetworkDetail[];
  eyebrow: string;
  icon: LucideIcon;
  id: string;
  kind: NetworkNodeKind;
  local: boolean;
  subtitle: string;
  title: string;
};

type NetworkEdge = {
  active: boolean;
  id: string;
  path: string;
};

export type WorkerNetworkServer = {
  deploymentMode?: string;
  id?: string;
  kind: "local" | "remote";
  name: string;
  url: string;
  version?: string;
};

export type WorkerNetworkCurrentClient = {
  connected: boolean;
  deviceLabel: string;
  email?: string | null;
  userName?: string | null;
};

export function connectedPeerSessions(
  sessions: readonly AccountSessionSummary[],
): AccountSessionSummary[] {
  return sessions.filter((session) => session.connected && !session.current);
}

export function currentClientDeviceLabel(
  desktopApp: boolean,
  userAgent = "",
): string {
  if (desktopApp) return "Cantrip desktop";
  if (/iPad/i.test(userAgent)) return "Cantrip on iPad";
  if (/iPhone|iPod/i.test(userAgent)) return "Cantrip on iPhone";
  if (/Android/i.test(userAgent)) return "Cantrip on Android";
  return "Cantrip web client";
}

function sessionTitle(session: AccountSessionSummary): string {
  if (session.label) return session.label;
  return session.authMethod === "mobile-qr" ? "Mobile client" : "Web client";
}

function authMethodLabel(method: AccountSessionSummary["authMethod"]): string {
  switch (method) {
    case "mobile-qr":
      return "Mobile QR sign-in";
    case "account-password":
      return "Account password";
    case "password":
      return "Server password";
  }
}

function timestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function serverEndpoint(url: string): string {
  if (!url) return "Embedded service";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function workerNode(
  worker: WorkerManagementSummary,
  localWorkerIds: ReadonlySet<string>,
  server: WorkerNetworkServer,
): NetworkNode {
  const local = worker.internal || localWorkerIds.has(worker.workerId);
  const capabilities = [
    worker.code.available ? "Code" : null,
    worker.remoteSurfaces.browser ? "Browser" : null,
    worker.remoteSurfaces.desktop ? "Desktop" : null,
  ].filter(Boolean);
  return {
    connected: worker.online,
    details: [
      { label: "Worker ID", monospace: true, value: worker.workerId },
      { label: "Placement", value: local ? "This machine" : "Remote machine" },
      { label: "Connection", value: worker.online ? "Online" : "Offline" },
      { label: "Route", value: `Server-mediated through ${server.name}` },
      { label: "Runtime", value: worker.runtimeName },
      {
        label: "System",
        value: `${worker.platform} · ${worker.architecture}`,
      },
      {
        label: "Codex",
        value: worker.codexVersion ?? worker.codexRuntime.compatibility,
      },
      { label: "Started", value: timestamp(worker.startedAt) },
      { label: "Last seen", value: timestamp(worker.lastSeenAt) },
      {
        label: "Project sources",
        value: String(worker.sources.length),
      },
      {
        label: "Capabilities",
        value: capabilities.length ? capabilities.join(" · ") : "Core worker",
      },
    ],
    eyebrow: local ? "Worker · this machine" : "Worker · remote",
    icon: worker.online ? Wifi : WifiOff,
    id: `worker:${worker.workerId}`,
    kind: "worker",
    local,
    subtitle: worker.online
      ? `${worker.platform} · online`
      : `Last seen ${timestamp(worker.lastSeenAt)}`,
    title: worker.name,
  };
}

function NetworkNodeButton({
  node,
  register,
  onSelect,
}: {
  node: NetworkNode;
  onSelect(nodeId: string): void;
  register(nodeId: string, element: HTMLButtonElement | null): void;
}) {
  const Icon = node.icon;
  return (
    <button
      ref={(element) => register(node.id, element)}
      type="button"
      data-network-node-id={node.id}
      aria-label={`View details for ${node.title}`}
      className={cn(
        "group relative z-10 flex min-h-20 w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl border bg-background/95 px-3 py-3 text-left shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring motion-reduce:transform-none",
        node.kind === "server" && "border-sky-500/35 bg-sky-500/[0.07]",
        node.kind === "client" && "border-violet-500/25",
        node.kind === "worker" && node.connected && "border-emerald-500/25",
        !node.connected && "border-dashed opacity-75",
      )}
      onClick={() => onSelect(node.id)}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg border bg-muted/45",
          node.kind === "server" && "border-sky-500/30 text-sky-500",
          node.kind === "client" && "border-violet-500/25 text-violet-500",
          node.kind === "worker" &&
            (node.connected
              ? "border-emerald-500/25 text-emerald-500"
              : "text-muted-foreground"),
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {node.eyebrow}
        </span>
        <span className="mt-0.5 block truncate text-sm font-semibold">
          {node.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {node.subtitle}
        </span>
      </span>
      <span
        className={cn(
          "absolute right-2.5 top-2.5 size-1.5 rounded-full",
          node.connected
            ? "animate-pulse bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] motion-reduce:animate-none"
            : "bg-muted-foreground/35",
        )}
      />
    </button>
  );
}

function NetworkNodeGrid({
  empty,
  nodes,
  register,
  onSelect,
}: {
  empty: string;
  nodes: NetworkNode[];
  onSelect(nodeId: string): void;
  register(nodeId: string, element: HTMLButtonElement | null): void;
}) {
  if (!nodes.length) {
    return (
      <div className="grid min-h-24 place-items-center rounded-xl border border-dashed bg-background/35 px-4 text-center text-xs text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {nodes.map((node) => (
        <NetworkNodeButton
          key={node.id}
          node={node}
          register={register}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function WorkerNetworkGraph({
  currentClient,
  localWorkerIds,
  server,
  sessions,
  workers,
}: {
  currentClient: WorkerNetworkCurrentClient;
  localWorkerIds: readonly string[];
  server: WorkerNetworkServer;
  sessions: readonly AccountSessionSummary[];
  workers: readonly WorkerManagementSummary[];
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeElements = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState<NetworkEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const localWorkerIdSet = useMemo(
    () => new Set(localWorkerIds),
    [localWorkerIds],
  );
  const nodes = useMemo<NetworkNode[]>(() => {
    const serverNode: NetworkNode = {
      connected: true,
      details: [
        {
          label: "Server ID",
          monospace: true,
          value: server.id ?? "Unavailable",
        },
        {
          label: "Endpoint",
          monospace: true,
          value: server.url || "Embedded service",
        },
        {
          label: "Placement",
          value: server.kind === "local" ? "This machine" : "Remote host",
        },
        { label: "Connection", value: "Connected" },
        ...(server.version
          ? [{ label: "Version", value: server.version }]
          : []),
        ...(server.deploymentMode
          ? [{ label: "Deployment", value: server.deploymentMode }]
          : []),
        {
          label: "Routing",
          value: "Brokers authenticated traffic between clients and workers",
        },
      ],
      eyebrow:
        server.kind === "local" ? "Server · this machine" : "Server · remote",
      icon: server.kind === "local" ? Server : Cloud,
      id: "server",
      kind: "server",
      local: server.kind === "local",
      subtitle: serverEndpoint(server.url),
      title: server.name,
    };
    const currentClientNode: NetworkNode = {
      connected: currentClient.connected,
      details: [
        { label: "Device", value: currentClient.deviceLabel },
        { label: "Placement", value: "This machine" },
        {
          label: "Connection",
          value: currentClient.connected ? "Live WebSocket" : "Reconnecting",
        },
        { label: "Route", value: `Connected to ${server.name}` },
        ...(currentClient.userName
          ? [{ label: "Account", value: currentClient.userName }]
          : []),
        ...(currentClient.email
          ? [{ label: "Email", value: currentClient.email }]
          : []),
      ],
      eyebrow: "Client · you",
      icon: MonitorSmartphone,
      id: "client:current",
      kind: "client",
      local: true,
      subtitle: currentClient.connected ? "Live connection" : "Reconnecting",
      title: currentClient.deviceLabel,
    };
    const workerNodes = workers.map((worker) =>
      workerNode(worker, localWorkerIdSet, server),
    );
    const peerNodes = connectedPeerSessions(sessions).map<NetworkNode>(
      (session) => ({
        connected: true,
        details: [
          { label: "Session ID", monospace: true, value: session.id },
          { label: "Placement", value: "Another device" },
          { label: "Connection", value: "Connected" },
          {
            label: "Authentication",
            value: authMethodLabel(session.authMethod),
          },
          { label: "Created", value: timestamp(session.createdAt) },
          { label: "Last active", value: timestamp(session.lastSeenAt) },
          { label: "Expires", value: timestamp(session.expiresAt) },
          { label: "Route", value: `Connected to ${server.name}` },
        ],
        eyebrow: "Client · your account",
        icon: session.authMethod === "mobile-qr" ? Smartphone : Laptop,
        id: `client:${session.id}`,
        kind: "client",
        local: false,
        subtitle: `${authMethodLabel(session.authMethod)} · connected`,
        title: sessionTitle(session),
      }),
    );
    return [serverNode, currentClientNode, ...workerNodes, ...peerNodes];
  }, [currentClient, localWorkerIdSet, server, sessions, workers]);
  const localNodes = nodes.filter((node) => node.local);
  const remoteServer = nodes.find(
    (node) => node.kind === "server" && !node.local,
  );
  const remoteNodes = nodes.filter(
    (node) => !node.local && node.kind !== "server",
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const nodeIdentity = nodes.map((node) => node.id).join("|");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      const serverElement = nodeElements.current.get("server");
      if (!serverElement || bounds.width === 0 || bounds.height === 0) {
        setEdges([]);
        return;
      }
      const center = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left - bounds.left + rect.width / 2,
          y: rect.top - bounds.top + rect.height / 2,
        };
      };
      const source = center(serverElement);
      const next = nodes.flatMap<NetworkEdge>((node) => {
        if (node.id === "server") return [];
        const element = nodeElements.current.get(node.id);
        if (!element) return [];
        const target = center(element);
        const vertical = Math.abs(target.y - source.y);
        const bend = Math.max(28, vertical * 0.45);
        const direction = target.y >= source.y ? 1 : -1;
        return [
          {
            active: node.connected,
            id: `${node.id}:${node.connected ? "active" : "inactive"}`,
            path: `M ${source.x} ${source.y} C ${source.x} ${source.y + bend * direction}, ${target.x} ${target.y - bend * direction}, ${target.x} ${target.y}`,
          },
        ];
      });
      setEdges(next);
    };
    const frame = requestAnimationFrame(measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(canvas);
    for (const element of nodeElements.current.values()) {
      observer?.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [nodeIdentity, nodes]);

  const registerNode = (nodeId: string, element: HTMLButtonElement | null) => {
    if (element) nodeElements.current.set(nodeId, element);
    else nodeElements.current.delete(nodeId);
  };
  const onlineWorkers = workers.filter((worker) => worker.online).length;
  const connectedClients =
    connectedPeerSessions(sessions).length + (currentClient.connected ? 1 : 0);

  return (
    <>
      <div className="border-t bg-gradient-to-b from-muted/[0.14] to-transparent px-3 py-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Network className="mt-0.5 size-4 shrink-0 text-sky-500" />
            <div>
              <h3 className="text-sm font-semibold">Network map</h3>
              <p className="text-xs text-muted-foreground">
                Live server-mediated connections for this account. Select any
                node for identity and routing details.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {onlineWorkers}/{workers.length} workers online
            </Badge>
            <Badge variant="outline">
              {connectedClients} connected client
              {connectedClients === 1 ? "" : "s"}
            </Badge>
          </div>
        </div>

        <div
          ref={canvasRef}
          className="relative isolate overflow-hidden rounded-2xl border bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.08),transparent_45%)] p-3 sm:p-4"
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible"
          >
            {edges.map((edge, index) => (
              <g key={edge.id}>
                <path
                  d={edge.path}
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray={edge.active ? "8 10" : "3 9"}
                  strokeLinecap="round"
                  strokeWidth={edge.active ? 1.5 : 1}
                  className={
                    edge.active
                      ? "text-emerald-500/45"
                      : "text-muted-foreground/20"
                  }
                >
                  {edge.active ? (
                    <animate
                      attributeName="stroke-dashoffset"
                      className="motion-reduce:hidden"
                      dur="2.2s"
                      from="0"
                      repeatCount="indefinite"
                      to="-36"
                    />
                  ) : null}
                </path>
                {edge.active ? (
                  <circle r="2.5" className="fill-sky-400 motion-reduce:hidden">
                    <animateMotion
                      begin={`${-(index % 5) * 0.42}s`}
                      dur={`${2.6 + (index % 3) * 0.35}s`}
                      path={edge.path}
                      repeatCount="indefinite"
                    />
                  </circle>
                ) : null}
              </g>
            ))}
          </svg>

          {remoteServer ? (
            <div className="relative z-10 mx-auto mb-5 max-w-sm">
              <NetworkNodeButton
                node={remoteServer}
                register={registerNode}
                onSelect={setSelectedNodeId}
              />
            </div>
          ) : null}

          <div className="relative z-10 grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
            <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.035] p-3 shadow-[inset_0_0_40px_rgba(14,165,233,0.035)] sm:p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg border border-sky-500/20 bg-background/70 text-sky-500">
                  <Laptop className="size-3.5" />
                </span>
                <div>
                  <h4 className="text-xs font-semibold">This machine</h4>
                  <p className="text-[11px] text-muted-foreground">
                    Localhost boundary · this client and local runtimes
                  </p>
                </div>
              </div>
              <NetworkNodeGrid
                empty="This client is the only local node."
                nodes={localNodes}
                register={registerNode}
                onSelect={setSelectedNodeId}
              />
            </section>

            <section className="rounded-2xl border border-dashed bg-background/30 p-3 sm:p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg border bg-background/70 text-muted-foreground">
                  <Cloud className="size-3.5" />
                </span>
                <div>
                  <h4 className="text-xs font-semibold">Across the network</h4>
                  <p className="text-[11px] text-muted-foreground">
                    Remote workers and other connected account clients
                  </p>
                </div>
              </div>
              <NetworkNodeGrid
                empty="No remote workers or peer clients are connected."
                nodes={remoteNodes}
                register={registerNode}
                onSelect={setSelectedNodeId}
              />
            </section>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Active
            connection
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-muted-foreground/35" />
            Known but offline
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="size-3" /> Workers remain isolated behind the server
          </span>
        </div>
      </div>

      <Dialog
        open={Boolean(selectedNode)}
        onOpenChange={(open) => {
          if (!open) setSelectedNodeId(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selectedNode?.title ?? "Network node"}</DialogTitle>
            <DialogDescription>
              {selectedNode?.eyebrow}. Cantrip exposes identity and routing
              metadata here, while private network addresses remain hidden.
            </DialogDescription>
          </DialogHeader>
          {selectedNode ? (
            <div className="overflow-hidden rounded-xl border">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2.5">
                <span className="text-xs font-medium">Connection status</span>
                <Badge
                  variant={selectedNode.connected ? "secondary" : "outline"}
                >
                  {selectedNode.connected ? "Connected" : "Offline"}
                </Badge>
              </div>
              <dl className="divide-y">
                {selectedNode.details.map((detail) => (
                  <div
                    key={detail.label}
                    className="grid gap-1 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <dt className="text-xs text-muted-foreground">
                      {detail.label}
                    </dt>
                    <dd
                      className={cn(
                        "min-w-0 break-words text-xs sm:text-right",
                        detail.monospace && "font-mono",
                      )}
                    >
                      {detail.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
