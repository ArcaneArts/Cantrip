import type {
  AccountSessionSummary,
  WorkerLinkRoute,
  WorkerManagementSummary,
} from "@cantrip/protocol";
import type { LucideIcon } from "lucide-react";
import {
  Cloud,
  Laptop,
  MonitorSmartphone,
  Network,
  Server,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
import {
  workerLinkManager,
  type WorkerLinkStatusSnapshot,
} from "@/lib/worker-link";

const EMPTY_WORKER_LINK_STATUSES: readonly WorkerLinkStatusSnapshot[] = [];
const WORKER_LINK_ROUTES: readonly WorkerLinkRoute[] = [
  "local",
  "lan",
  "wan",
  "relay",
];

function subscribeWorkerLinkStatus(listener: () => void): () => void {
  return workerLinkManager.subscribeStatus(listener);
}

function getWorkerLinkStatus(): readonly WorkerLinkStatusSnapshot[] {
  return workerLinkManager.getStatusSnapshot();
}

type NetworkNodeKind = "client" | "server" | "worker";

export type WorkerNetworkRouteDetail = {
  label: string;
  monospace?: boolean;
  value: string;
};

type NetworkDetail = WorkerNetworkRouteDetail;

export type WorkerNetworkRoutePresentation = {
  active: boolean;
  activeChannelCount: number;
  activeLinkCount: number;
  edgeRoutes: readonly WorkerLinkRoute[];
  effectiveRoutes: readonly WorkerLinkRoute[];
  fallbackLabel: string | null;
  freshness: "active" | "last-used" | "none";
  freshnessLabel: string;
  label:
    | "LOCAL"
    | "LAN"
    | "WAN"
    | "RELAY"
    | "MIXED"
    | "IDLE"
    | "CONNECTING"
    | "RECONNECTING"
    | "OFFLINE";
  latencyMs: number | null;
  routeChannelCounts: readonly {
    channelCount: number;
    route: WorkerLinkRoute;
  }[];
};

export type WorkerNetworkDataEdgeSegment =
  "direct" | "client-server" | "server-worker";

type NetworkNode = {
  connected: boolean;
  details: NetworkDetail[];
  eyebrow: string;
  icon: LucideIcon;
  id: string;
  kind: NetworkNodeKind;
  local: boolean;
  route: WorkerNetworkRoutePresentation | null;
  subtitle: string;
  title: string;
};

type NetworkEdge = {
  active: boolean;
  freshness: "active" | "last-used" | null;
  id: string;
  path: string;
  plane: "control" | "data";
  route: WorkerLinkRoute | null;
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

function fallbackLabel(
  reason: WorkerLinkStatusSnapshot["fallbackReason"],
): string | null {
  switch (reason) {
    case null:
      return null;
    case "local-unsupported":
      return "LOCAL unsupported";
    case "local-unavailable":
      return "LOCAL unavailable";
    case "local-identity-mismatch":
      return "LOCAL identity mismatch";
    case "local-capability-expired":
      return "LOCAL capability expired";
    case "local-capability-rejected":
      return "LOCAL capability rejected";
    case "local-connect-timeout":
      return "LOCAL connection timed out";
    case "local-disconnected":
      return "LOCAL disconnected";
    case "policy-relay-only":
      return "Policy requires RELAY";
    case "route-replaced":
      return "Route replaced";
  }
}

function routeName(route: WorkerLinkRoute): "LOCAL" | "LAN" | "WAN" | "RELAY" {
  return route.toUpperCase() as "LOCAL" | "LAN" | "WAN" | "RELAY";
}

export function workerNetworkDataEdgeSegments(
  route: WorkerLinkRoute,
): readonly WorkerNetworkDataEdgeSegment[] {
  return route === "relay" ? ["client-server", "server-worker"] : ["direct"];
}

export function workerNetworkRoutePresentation(
  workerOnline: boolean,
  status: WorkerLinkStatusSnapshot | undefined,
): WorkerNetworkRoutePresentation {
  const routeChannelCounts = WORKER_LINK_ROUTES.map((route) => ({
    channelCount:
      status?.routeChannelCounts.find((entry) => entry.route === route)
        ?.channelCount ?? 0,
    route,
  }));
  const effectiveRoutes = [
    ...new Set([
      ...(status?.effectiveRoutes ?? []),
      ...routeChannelCounts
        .filter((entry) => entry.channelCount > 0)
        .map((entry) => entry.route),
    ]),
  ];
  let label: WorkerNetworkRoutePresentation["label"];
  if (!status) label = workerOnline ? "IDLE" : "OFFLINE";
  else if (status.state === "connecting") label = "CONNECTING";
  else if (status.state === "degraded" || status.state === "reconnecting") {
    label = "RECONNECTING";
  } else if (effectiveRoutes.length > 1) label = "MIXED";
  else if (effectiveRoutes[0]) label = routeName(effectiveRoutes[0]);
  else if (status.state === "offline") label = "OFFLINE";
  else label = "IDLE";
  const active = status?.freshness === "active" && status.state === "active";
  const retainLastUsed = status?.freshness === "last-used";
  return {
    active,
    activeChannelCount: status?.activeChannelCount ?? 0,
    activeLinkCount: status?.activeLinkCount ?? 0,
    edgeRoutes: active || retainLastUsed ? effectiveRoutes : [],
    effectiveRoutes,
    fallbackLabel: fallbackLabel(status?.fallbackReason ?? null),
    freshness: status?.freshness ?? "none",
    freshnessLabel: !status
      ? workerOnline
        ? "No current data route"
        : "Worker offline"
      : status.freshness === "last-used"
        ? "Last used"
        : status.state === "active"
          ? "Active now"
          : status.state === "connecting"
            ? "Connecting"
            : status.state === "degraded" || status.state === "reconnecting"
              ? "Reconnecting"
              : status.state === "offline"
                ? "Offline"
                : "Idle",
    label,
    latencyMs: status?.latencyMs ?? null,
    routeChannelCounts,
  };
}

export function workerNetworkRouteDetails(
  workerOnline: boolean,
  serverName: string,
  status: WorkerLinkStatusSnapshot | undefined,
): WorkerNetworkRouteDetail[] {
  const route = workerNetworkRoutePresentation(workerOnline, status);
  return [
    {
      label: "Control plane",
      value: workerOnline
        ? `Connected to ${serverName}`
        : `Offline from ${serverName}`,
    },
    {
      label: "Data plane state",
      value: `${route.label} · ${route.freshnessLabel}`,
    },
    {
      label: "Preferred route",
      value: status?.preferredRoute ? routeName(status.preferredRoute) : "None",
    },
    {
      label: "Effective routes",
      value: route.effectiveRoutes.length
        ? route.effectiveRoutes.map(routeName).join(" · ")
        : "None",
    },
    { label: "Active links", value: String(route.activeLinkCount) },
    { label: "Active channels", value: String(route.activeChannelCount) },
    {
      label: "Channels by route",
      value: route.routeChannelCounts
        .map(
          ({ channelCount, route: channelRoute }) =>
            `${routeName(channelRoute)} ${channelCount}`,
        )
        .join(" · "),
    },
    {
      label: "Route generation",
      value:
        status?.routeGeneration === null || !status
          ? "None"
          : String(status.routeGeneration),
    },
    {
      label: "Latency",
      value:
        status?.latencyMs === null || !status
          ? "Unknown"
          : `${status.latencyMs} ms`,
    },
    { label: "Fallback", value: route.fallbackLabel ?? "None" },
    {
      label: "Last transition",
      value: status ? timestamp(status.changedAt) : "No WorkerLink activity",
    },
    { label: "Route freshness", value: route.freshnessLabel },
  ];
}

function workerNode(
  worker: WorkerManagementSummary,
  localWorkerIds: ReadonlySet<string>,
  server: WorkerNetworkServer,
  status: WorkerLinkStatusSnapshot | undefined,
): NetworkNode {
  const local = worker.internal || localWorkerIds.has(worker.workerId);
  const route = workerNetworkRoutePresentation(worker.online, status);
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
      ...workerNetworkRouteDetails(worker.online, server.name, status),
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
    route,
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
      data-worker-route={node.route?.label}
      data-worker-route-active={
        node.route ? String(node.route.active) : undefined
      }
      data-worker-route-freshness={node.route?.freshness}
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
        {node.route ? (
          <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 py-0 text-[10px] font-semibold tracking-wide",
                node.route.label === "LOCAL" &&
                  "border-emerald-500/35 text-emerald-500",
                node.route.label === "RELAY" &&
                  "border-amber-500/35 text-amber-500",
                (node.route.label === "LAN" ||
                  node.route.label === "WAN" ||
                  node.route.label === "MIXED") &&
                  "border-cyan-500/35 text-cyan-500",
              )}
            >
              {node.route.label}
            </Badge>
            {node.route.label === "MIXED"
              ? node.route.effectiveRoutes.map((effectiveRoute) => {
                  const channelCount =
                    node.route?.routeChannelCounts.find(
                      (entry) => entry.route === effectiveRoute,
                    )?.channelCount ?? 0;
                  return (
                    <Badge
                      key={effectiveRoute}
                      variant="outline"
                      data-worker-route-segment={effectiveRoute}
                      className="h-5 px-1.5 py-0 text-[10px]"
                    >
                      {routeName(effectiveRoute)} {channelCount}
                    </Badge>
                  );
                })
              : null}
            <span className="basis-full text-[10px] leading-4 text-muted-foreground">
              {node.route.freshnessLabel} · {node.route.activeLinkCount} link
              {node.route.activeLinkCount === 1 ? "" : "s"} ·{" "}
              {node.route.activeChannelCount} channel
              {node.route.activeChannelCount === 1 ? "" : "s"}
              {node.route.latencyMs === null
                ? ""
                : ` · ${node.route.latencyMs} ms`}
            </span>
            {node.route.fallbackLabel ? (
              <span
                data-worker-route-fallback={node.route.fallbackLabel}
                className="basis-full text-[10px] leading-4 text-amber-500"
              >
                {node.route.fallbackLabel}
              </span>
            ) : null}
          </span>
        ) : null}
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
  routeStatuses,
  server,
  sessions,
  workers,
}: {
  currentClient: WorkerNetworkCurrentClient;
  localWorkerIds: readonly string[];
  routeStatuses?: readonly WorkerLinkStatusSnapshot[];
  server: WorkerNetworkServer;
  sessions: readonly AccountSessionSummary[];
  workers: readonly WorkerManagementSummary[];
}) {
  const liveRouteStatuses = useSyncExternalStore(
    subscribeWorkerLinkStatus,
    getWorkerLinkStatus,
    () => EMPTY_WORKER_LINK_STATUSES,
  );
  const currentRouteStatuses = routeStatuses ?? liveRouteStatuses;
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeElements = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState<NetworkEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const localWorkerIdSet = useMemo(
    () => new Set(localWorkerIds),
    [localWorkerIds],
  );
  const routeStatusByWorker = useMemo(
    () =>
      new Map(currentRouteStatuses.map((status) => [status.workerId, status])),
    [currentRouteStatuses],
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
          label: "Control plane",
          value: "Authentication, commands, settings, and durable state",
        },
        {
          label: "WorkerLink data plane",
          value: "Carries traffic only when the current route is RELAY",
        },
      ],
      eyebrow:
        server.kind === "local" ? "Server · this machine" : "Server · remote",
      icon: server.kind === "local" ? Server : Cloud,
      id: "server",
      kind: "server",
      local: server.kind === "local",
      route: null,
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
        { label: "Control plane", value: `Connected to ${server.name}` },
        {
          label: "WorkerLink data plane",
          value: "Shown independently on each current-client worker route",
        },
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
      route: null,
      subtitle: currentClient.connected ? "Live connection" : "Reconnecting",
      title: currentClient.deviceLabel,
    };
    const workerNodes = workers.map((worker) =>
      workerNode(
        worker,
        localWorkerIdSet,
        server,
        routeStatusByWorker.get(worker.workerId),
      ),
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
          { label: "Control plane", value: `Connected to ${server.name}` },
          {
            label: "WorkerLink data plane",
            value: "Unknown — peer client routes are not observable",
          },
        ],
        eyebrow: "Client · your account",
        icon: session.authMethod === "mobile-qr" ? Smartphone : Laptop,
        id: `client:${session.id}`,
        kind: "client",
        local: false,
        route: null,
        subtitle: `${authMethodLabel(session.authMethod)} · data route unknown`,
        title: sessionTitle(session),
      }),
    );
    return [serverNode, currentClientNode, ...workerNodes, ...peerNodes];
  }, [
    currentClient,
    localWorkerIdSet,
    routeStatusByWorker,
    server,
    sessions,
    workers,
  ]);
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
      const pathBetween = (
        source: { x: number; y: number },
        target: { x: number; y: number },
      ) => {
        const horizontal = Math.abs(target.x - source.x);
        const vertical = Math.abs(target.y - source.y);
        if (horizontal >= vertical) {
          const bend = (target.x - source.x) * 0.45;
          return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${target.x - bend} ${target.y}, ${target.x} ${target.y}`;
        }
        const bend = (target.y - source.y) * 0.45;
        return `M ${source.x} ${source.y} C ${source.x} ${source.y + bend}, ${target.x} ${target.y - bend}, ${target.x} ${target.y}`;
      };
      const serverCenter = center(serverElement);
      const controlEdges = nodes.flatMap<NetworkEdge>((node) => {
        if (node.id === "server") return [];
        const element = nodeElements.current.get(node.id);
        if (!element) return [];
        return [
          {
            active: node.connected,
            freshness: null,
            id: `control:${node.id}:${node.connected ? "active" : "inactive"}`,
            path: pathBetween(serverCenter, center(element)),
            plane: "control",
            route: null,
          },
        ];
      });
      const currentClientElement = nodeElements.current.get("client:current");
      const dataEdges = currentClientElement
        ? nodes.flatMap<NetworkEdge>((node) => {
            const nodeRoute = node.route;
            if (node.kind !== "worker" || !nodeRoute) return [];
            const workerElement = nodeElements.current.get(node.id);
            if (!workerElement) return [];
            const clientCenter = center(currentClientElement);
            const workerCenter = center(workerElement);
            return nodeRoute.edgeRoutes.flatMap<NetworkEdge>((route) => {
              const common = {
                active: nodeRoute.active,
                freshness:
                  nodeRoute.freshness === "none" ? null : nodeRoute.freshness,
                plane: "data" as const,
                route,
              };
              return workerNetworkDataEdgeSegments(route).map((segment) => ({
                ...common,
                id: `data:${node.id}:${route}:${segment}`,
                path:
                  segment === "direct"
                    ? pathBetween(clientCenter, workerCenter)
                    : segment === "client-server"
                      ? pathBetween(clientCenter, serverCenter)
                      : pathBetween(serverCenter, workerCenter),
              }));
            });
          })
        : [];
      setEdges([...controlEdges, ...dataEdges]);
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
                Live server control paths and current-client WorkerLink data
                routes. Select any node for identity and routing details.
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
                  data-network-plane={edge.plane}
                  data-network-route={edge.route ?? undefined}
                  data-network-route-freshness={edge.freshness ?? undefined}
                  d={edge.path}
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray={
                    edge.plane === "control"
                      ? edge.active
                        ? "2 7"
                        : "2 10"
                      : edge.active
                        ? "10 7"
                        : "3 9"
                  }
                  strokeLinecap="round"
                  strokeWidth={
                    edge.plane === "control" ? 1 : edge.active ? 2.25 : 1.25
                  }
                  className={cn(
                    edge.plane === "control" &&
                      (edge.active
                        ? "text-sky-400/35"
                        : "text-muted-foreground/15"),
                    edge.plane === "data" &&
                      edge.route === "local" &&
                      (edge.active
                        ? "text-emerald-400/65"
                        : "text-emerald-400/25"),
                    edge.plane === "data" &&
                      edge.route === "relay" &&
                      (edge.active ? "text-amber-400/65" : "text-amber-400/25"),
                    edge.plane === "data" &&
                      (edge.route === "lan" || edge.route === "wan") &&
                      (edge.active ? "text-cyan-400/65" : "text-cyan-400/25"),
                  )}
                >
                  {edge.plane === "data" && edge.active ? (
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
                {edge.plane === "data" && edge.active ? (
                  <circle
                    r="2.5"
                    className={cn(
                      "motion-reduce:hidden",
                      edge.route === "local" && "fill-emerald-400",
                      edge.route === "relay" && "fill-amber-400",
                      (edge.route === "lan" || edge.route === "wan") &&
                        "fill-cyan-400",
                    )}
                  >
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
            <span className="w-5 border-t border-dashed border-sky-400/70" />
            Server control plane
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t-2 border-dashed border-emerald-400" />
            LOCAL direct data
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t-2 border-dashed border-amber-400" />
            RELAY data through server
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t border-dotted border-muted-foreground/50" />
            Last used; IDLE has no data edge
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
                <span className="text-xs font-medium">
                  Control-plane status
                </span>
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
