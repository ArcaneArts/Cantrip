import {
  remoteBrowserClipboardMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  type BrowserSummary,
  type BrowserService,
  type BrowserFleetService,
  type BrowserServiceFleetDiscovery,
  type RemoteBrowserClientMessage,
} from "@cantrip/protocol";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  ExternalLink,
  Globe2,
  Loader2,
  Network,
  RefreshCw,
  RotateCw,
  Search,
  Route,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  RemoteSurfaceCanvas,
  type RemoteSurfaceCanvasHandle,
} from "@/components/remote-surface/remote-surface-canvas";
import { Button } from "@/components/ui/button";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import {
  createTunnel,
  ensureBrowserTunnel,
  getBrowserServices,
  getProjectBrowserServices,
  remoteSurfaceWebSocketUrl,
} from "@/lib/api";
import {
  desktopTunnelAvailable,
  startDesktopTunnel,
  type DesktopTunnelForwardSummary,
} from "@/lib/desktop-tunnel";
import { errorMessage } from "@/lib/error-message";
import {
  forwardRemoteSurfaceClipboard,
  remoteSurfacePointerCoordinates,
  remoteSurfaceTouchPoints,
} from "@/lib/remote-surface-input";
import {
  useRemoteSurfaceTransport,
  type RemoteSurfaceFrameContext,
  type RemoteSurfaceInboundFrame,
} from "@/lib/use-remote-surface-transport";

const decoder = new TextDecoder();
const browserTransportMessages = {
  closeReason: "Browser view closed",
  congestionReason: "Remote Surface connection is congested",
  connectionError: "Could not connect to the worker browser.",
  invalidConnectionMessage:
    "The server sent an invalid browser connection message.",
  invalidFrame: "The server sent an invalid browser frame.",
};

function isBrowserServiceFleetDiscovery(
  value: BrowserService[] | BrowserServiceFleetDiscovery | undefined,
): value is BrowserServiceFleetDiscovery {
  return Boolean(value && !Array.isArray(value));
}

export function browserServiceDisplayName(service: BrowserService): string {
  return service.title ?? service.processName ?? `Port ${service.port}`;
}

export function filterBrowserServices<T extends BrowserService>(
  services: T[],
  query: string,
): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return services;
  return services.filter((service) => {
    const searchable = [
      browserServiceDisplayName(service),
      service.title,
      service.processName,
      service.protocol,
      service.host,
      service.port,
      service.statusCode,
      service.url,
      "workerName" in service ? service.workerName : null,
    ]
      .filter((value) => value !== null && value !== undefined)
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export function normalizeBrowserAddress(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function browserAddressRequiresTunnel(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["127.0.0.1", "0.0.0.0", "localhost", "::1", "[::1]"].includes(
      hostname,
    );
  } catch {
    return false;
  }
}

export function browserServiceRequiresNewSurface(
  browser: Pick<BrowserSummary, "workerId">,
  service: BrowserService | BrowserFleetService,
): service is BrowserFleetService {
  return (
    "placement" in service &&
    Boolean(browser.workerId) &&
    service.workerId !== browser.workerId
  );
}

export function browserTunnelLocalUrl(
  targetUrl: string,
  attachment: DesktopTunnelForwardSummary,
): string {
  const local = new URL(targetUrl);
  local.hostname = attachment.localHost;
  local.port = String(attachment.localPort);
  return local.toString();
}

async function openBrowserExternally(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function browserPointerCoordinates(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: { width: number; height: number },
) {
  return remoteSurfacePointerCoordinates(point, bounds, viewport);
}

export function browserTouchPoints(
  touches: ArrayLike<
    Pick<Touch, "clientX" | "clientY" | "identifier"> & {
      force?: number;
      radiusX?: number;
      radiusY?: number;
    }
  >,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: { width: number; height: number },
) {
  return remoteSurfaceTouchPoints(touches, bounds, viewport);
}

export function BrowserView({
  browser,
  fleetDiscovery,
  onOpenService,
  onPageState,
}: {
  browser: BrowserSummary;
  fleetDiscovery: boolean;
  onOpenService(service: BrowserFleetService): void;
  onPageState(state: {
    previousTitle: string | null;
    title: string;
    url: string;
  }): void;
}) {
  const remoteCanvasRef = useRef<RemoteSurfaceCanvasHandle>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputFocusedRef = useRef(false);
  const onPageStateRef = useRef(onPageState);
  const pageStateRef = useRef<{ title: string; url: string } | null>(null);
  const viewportRef = useRef({
    width: 1_280,
    height: 720,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  const [address, setAddress] = useState(browser.url);
  const [currentUrl, setCurrentUrl] = useState(browser.url);
  const [invalidAddress, setInvalidAddress] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<
    "ready" | "recovering" | "error"
  >("ready");
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [clipboardMessage, setClipboardMessage] = useState<string | null>(null);
  const [serviceMenuOpen, setServiceMenuOpen] = useState(false);
  const [serviceSearch, setServiceSearch] = useState("");
  const [currentWorkerId, setCurrentWorkerId] = useState<string | undefined>();
  const [externalActionPending, setExternalActionPending] = useState(false);
  const [externalActionMessage, setExternalActionMessage] = useState<
    string | null
  >(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [renderedSurfaceId, setRenderedSurfaceId] = useState<string | null>(
    null,
  );
  const surfaceReady = renderedSurfaceId === browser.id;
  const servicesQuery = useQuery<
    BrowserService[] | BrowserServiceFleetDiscovery
  >({
    queryKey: [
      "browser-services",
      fleetDiscovery ? browser.projectId : browser.id,
      fleetDiscovery ? "fleet" : "legacy",
    ],
    queryFn: () =>
      fleetDiscovery
        ? getProjectBrowserServices(browser.projectId)
        : getBrowserServices(browser.id),
    enabled: serviceMenuOpen,
    retry: false,
    staleTime: 5_000,
  });
  const discovery = servicesQuery.data;
  const fleetResult = isBrowserServiceFleetDiscovery(discovery)
    ? discovery
    : null;
  const services: Array<BrowserService | BrowserFleetService> = Array.isArray(
    discovery,
  )
    ? discovery
    : (fleetResult?.workers.flatMap((worker) => worker.services) ?? []);
  const workerFailures =
    fleetResult?.workers.filter((worker) => worker.status !== "ok") ?? [];
  const filteredServices = filterBrowserServices(services, serviceSearch);
  onPageStateRef.current = onPageState;

  const handleFrame = useCallback(
    (frame: RemoteSurfaceInboundFrame, context: RemoteSurfaceFrameContext) => {
      if (frame.header.channel === "frame") {
        remoteCanvasRef.current?.pushFrame(frame.payload);
      } else if (frame.header.channel === "control") {
        const state = remoteBrowserServerMessageSchema.parse(
          JSON.parse(decoder.decode(frame.payload)),
        );
        if (state.type === "browser-runtime") {
          setRuntimeStatus(state.status);
          setRuntimeMessage(state.message);
          if (state.status === "ready") context.reportError(null);
        } else {
          const normalized = normalizeBrowserAddress(state.url);
          if (normalized) {
            setCurrentUrl(normalized);
            if (!inputFocusedRef.current) setAddress(normalized);
            const previous = pageStateRef.current;
            if (
              previous?.url !== normalized ||
              previous?.title !== state.title
            ) {
              pageStateRef.current = {
                title: state.title,
                url: normalized,
              };
              onPageStateRef.current({
                previousTitle: previous?.title ?? null,
                title: state.title,
                url: normalized,
              });
            }
          }
          setCanGoBack(state.canGoBack);
          setCanGoForward(state.canGoForward);
          setLoading(state.loading);
        }
      } else if (frame.header.channel === "cursor") {
        const cursor = remoteBrowserCursorMessageSchema.parse(
          JSON.parse(decoder.decode(frame.payload)),
        ).cursor;
        if (CSS.supports("cursor", cursor)) setCursor(cursor);
      } else if (frame.header.channel === "clipboard") {
        const clipboard = remoteBrowserClipboardMessageSchema.parse(
          JSON.parse(decoder.decode(frame.payload)),
        );
        void navigator.clipboard.writeText(clipboard.text).then(
          () => {
            if (context.isCurrent()) setClipboardMessage("Selection copied");
          },
          () => {
            if (context.isCurrent()) {
              setClipboardMessage(
                "Clipboard access was denied by this app environment.",
              );
            }
          },
        );
      }
    },
    [browser.id],
  );

  const { connectionState, error, sendFrame, setError } =
    useRemoteSurfaceTransport({
      surfaceId: browser.id,
      webSocketUrl: () =>
        remoteSurfaceWebSocketUrl(browser.id, viewportRef.current),
      messages: browserTransportMessages,
      onConnecting: () => remoteCanvasRef.current?.reset(),
      onFrame: handleFrame,
    });

  const send = useCallback(
    (message: RemoteBrowserClientMessage) =>
      sendFrame(
        "control",
        new TextEncoder().encode(
          JSON.stringify(remoteBrowserClientMessageSchema.parse(message)),
        ),
      ),
    [sendFrame],
  );

  useEffect(() => {
    setAddress(browser.url);
    setCurrentUrl(browser.url);
    setInvalidAddress(false);
    pageStateRef.current = null;
    setRuntimeStatus("ready");
    setRuntimeMessage(null);
    setCurrentWorkerId(undefined);
    setExternalActionMessage(null);
  }, [browser.id]);

  useEffect(() => {
    if (pageStateRef.current?.url === browser.url) return;
    setCurrentUrl(browser.url);
    if (!inputFocusedRef.current) setAddress(browser.url);
  }, [browser.url]);

  useEffect(() => {
    if (!clipboardMessage) return;
    const timeout = setTimeout(() => setClipboardMessage(null), 3_000);
    return () => clearTimeout(timeout);
  }, [clipboardMessage]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const updateViewport = () => {
      const bounds = surface.getBoundingClientRect();
      const viewport = {
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      viewportRef.current = viewport;
      send({ type: "viewport", viewport });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [send]);

  useEffect(() => {
    if (connectionState === "ready") {
      send({ type: "viewport", viewport: viewportRef.current });
    }
  }, [connectionState, send]);

  const navigateTo = (value: string, workerId?: string) => {
    const normalized = normalizeBrowserAddress(value);
    if (!normalized) {
      setInvalidAddress(true);
      return false;
    }
    setInvalidAddress(false);
    setAddress(normalized);
    setCurrentUrl(normalized);
    setCurrentWorkerId(workerId);
    setLoading(true);
    send({ type: "navigate", url: normalized });
    return true;
  };

  const openDiscoveredService = (
    service: BrowserService | BrowserFleetService,
  ) => {
    if (!browserServiceRequiresNewSurface(browser, service)) {
      navigateTo(service.url, service.workerId);
      return;
    }
    onOpenService(service);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigateTo(address);
  };

  const pasteClipboard = async () => {
    setClipboardMessage(
      await forwardRemoteSurfaceClipboard((text) =>
        send({ type: "clipboard", operation: "paste-text", text }),
      ),
    );
  };

  const tunnelCurrentPage = async () => {
    if (!desktopTunnelAvailable()) {
      setExternalActionMessage(
        "Opening a worker-local service requires the Cantrip desktop app.",
      );
      return;
    }
    setExternalActionPending(true);
    setExternalActionMessage(null);
    try {
      const tunnel = await ensureBrowserTunnel(browser.id, {
        url: currentUrl,
        ...(currentWorkerId ? { workerId: currentWorkerId } : {}),
      });
      const attachment = await startDesktopTunnel(tunnel.id);
      await openBrowserExternally(
        browserTunnelLocalUrl(currentUrl, attachment),
      );
      setExternalActionMessage(
        `Opened through local port ${attachment.localPort}.`,
      );
    } catch (error) {
      setExternalActionMessage(errorMessage(error));
    } finally {
      setExternalActionPending(false);
    }
  };

  const saveCurrentTunnel = async () => {
    setExternalActionPending(true);
    setExternalActionMessage(null);
    try {
      const managed = await ensureBrowserTunnel(browser.id, {
        url: currentUrl,
        ...(currentWorkerId ? { workerId: currentWorkerId } : {}),
      });
      if (managed.destination.kind !== "worker-tcp") {
        throw new Error("This Browser route cannot be saved as a TCP tunnel.");
      }
      const target = new URL(currentUrl);
      const saved = await createTunnel({
        name: `${browser.title} · ${target.host}`.slice(0, 120),
        description: `Saved from Browser: ${currentUrl}`.slice(0, 1_000),
        projectId: browser.projectId,
        protocolHint: managed.protocolHint,
        destination: managed.destination,
      });
      setExternalActionMessage(`Saved “${saved.name}” as a custom tunnel.`);
    } catch (error) {
      setExternalActionMessage(errorMessage(error));
    } finally {
      setExternalActionPending(false);
    }
  };

  const openCurrentPage = async () => {
    setExternalActionPending(true);
    setExternalActionMessage(null);
    try {
      await openBrowserExternally(currentUrl);
    } catch (error) {
      setExternalActionMessage(errorMessage(error));
    } finally {
      setExternalActionPending(false);
    }
  };

  const currentPageNeedsTunnel = browserAddressRequiresTunnel(currentUrl);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 bg-background px-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!canGoBack}
          onClick={() => send({ type: "history", delta: -1 })}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!canGoForward}
          onClick={() => send({ type: "history", delta: 1 })}
        >
          <ArrowRight className="size-4" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title={loading ? "Stop loading" : "Reload"}
          onClick={() => send({ type: loading ? "stop" : "reload" })}
        >
          {loading ? (
            <X className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          <span className="sr-only">{loading ? "Stop" : "Reload"}</span>
        </Button>
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <div className="relative">
            <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="Address"
              value={address}
              onFocus={() => {
                inputFocusedRef.current = true;
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                setAddress(currentUrl);
              }}
              onChange={(event) => {
                setAddress(event.target.value);
                setInvalidAddress(false);
              }}
              className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              placeholder="Enter a URL"
              spellCheck={false}
            />
          </div>
        </form>
        <DropdownMenuPrimitive.Root
          open={serviceMenuOpen}
          onOpenChange={(open) => {
            setServiceMenuOpen(open);
            if (!open) setServiceSearch("");
          }}
        >
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5 px-2.5"
              title="Open a web service running on a connected worker"
            >
              <Network className="size-3.5" />
              <span className="hidden sm:inline">Services</span>
              {services.length > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {services.length}
                </span>
              ) : null}
              {fleetResult?.partial ? (
                <CircleAlert className="size-3 text-amber-500" />
              ) : null}
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={6}
              className="z-50 flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 flex-col overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <DropdownMenuPrimitive.Label className="shrink-0 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {fleetDiscovery ? "Fleet web services" : "Worker web services"}
              </DropdownMenuPrimitive.Label>
              <div className="relative shrink-0 px-1 pb-1.5">
                <Search className="pointer-events-none absolute left-3 top-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  aria-label="Search services"
                  value={serviceSearch}
                  onChange={(event) => setServiceSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") event.stopPropagation();
                  }}
                  className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
                  placeholder="Search services"
                  spellCheck={false}
                />
              </div>
              <div className="min-h-0 max-h-80 flex-1 overflow-y-auto overscroll-contain">
                {servicesQuery.isLoading ? (
                  <DropdownMenuPrimitive.Item
                    disabled
                    className="flex items-center gap-2 rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none"
                  >
                    <Loader2 className="size-3.5 animate-spin" />
                    Scanning listening ports…
                  </DropdownMenuPrimitive.Item>
                ) : servicesQuery.isError ? (
                  <DropdownMenuPrimitive.Item
                    disabled
                    className="rounded-sm px-2 py-2 text-xs text-destructive outline-none"
                  >
                    Could not scan worker services.
                  </DropdownMenuPrimitive.Item>
                ) : services.length === 0 ? (
                  <DropdownMenuPrimitive.Item
                    disabled
                    className="rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none"
                  >
                    No HTTP services found.
                  </DropdownMenuPrimitive.Item>
                ) : filteredServices.length === 0 ? (
                  <DropdownMenuPrimitive.Item
                    disabled
                    className="rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none"
                  >
                    No services match “{serviceSearch.trim()}”.
                  </DropdownMenuPrimitive.Item>
                ) : (
                  filteredServices.map((service, index) => (
                    <DropdownMenuPrimitive.Item
                      key={`${service.url}-${index}`}
                      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-2 outline-none focus:bg-accent focus:text-accent-foreground"
                      onSelect={() => openDiscoveredService(service)}
                    >
                      <Network className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {browserServiceDisplayName(service)}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {service.processName &&
                          service.processName !== service.title
                            ? `${service.processName} · `
                            : ""}
                          {service.protocol}://{service.host}:{service.port}
                          {"workerName" in service
                            ? ` · ${service.workerName}`
                            : ""}
                        </span>
                      </span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {service.statusCode}
                      </span>
                    </DropdownMenuPrimitive.Item>
                  ))
                )}
                {workerFailures.length > 0 ? (
                  <>
                    <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                    {workerFailures.map((worker) => (
                      <DropdownMenuPrimitive.Item
                        key={worker.workerId}
                        disabled
                        title={worker.error?.message ?? undefined}
                        className="flex items-center gap-2 rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none"
                      >
                        <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
                        <span className="min-w-0 flex-1 truncate">
                          {worker.workerName}
                        </span>
                        <span className="text-[10px]">
                          {worker.status === "timed-out"
                            ? "Timed out"
                            : worker.status === "offline"
                              ? "Offline"
                              : "Scan failed"}
                        </span>
                      </DropdownMenuPrimitive.Item>
                    ))}
                  </>
                ) : null}
                {fleetResult?.truncated ? (
                  <DropdownMenuPrimitive.Item
                    disabled
                    className="flex items-center gap-2 rounded-sm px-2 py-2 text-xs text-amber-500 outline-none"
                  >
                    <CircleAlert className="size-3.5" />
                    Fleet result limit reached
                  </DropdownMenuPrimitive.Item>
                ) : null}
              </div>
              <DropdownMenuPrimitive.Separator className="my-1 h-px shrink-0 bg-border" />
              <DropdownMenuPrimitive.Item
                className="flex shrink-0 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent focus:text-accent-foreground"
                onSelect={(event) => {
                  event.preventDefault();
                  void servicesQuery.refetch();
                }}
              >
                <RefreshCw
                  className={`size-3.5 ${servicesQuery.isFetching ? "animate-spin" : ""}`}
                />
                Scan again
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Copy selected page text"
          onClick={() =>
            send({
              type: "clipboard",
              operation: "copy-selection",
              text: "",
            })
          }
        >
          <ClipboardCopy className="size-3.5" />
          <span className="sr-only">Copy selected page text</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Paste clipboard into the page"
          onClick={() => void pasteClipboard()}
        >
          <ClipboardPaste className="size-3.5" />
          <span className="sr-only">Paste clipboard into the page</span>
        </Button>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              disabled={externalActionPending}
              title={
                currentPageNeedsTunnel
                  ? "Tunnel this worker-local page to your computer"
                  : "Open in your system browser"
              }
            >
              {externalActionPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : currentPageNeedsTunnel ? (
                <Route className="size-3.5" />
              ) : (
                <ExternalLink className="size-3.5" />
              )}
              <span className="sr-only">
                {currentPageNeedsTunnel
                  ? "Tunnel or save local page"
                  : "Open externally"}
              </span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={6}
              className="z-50 w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {currentPageNeedsTunnel ? (
                <>
                  <DropdownMenuPrimitive.Label className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Worker-local address
                  </DropdownMenuPrimitive.Label>
                  <DropdownMenuPrimitive.Item
                    disabled={!desktopTunnelAvailable()}
                    className="flex cursor-default items-start gap-2 rounded-sm px-2 py-2 outline-none focus:bg-accent data-[disabled]:opacity-50"
                    onSelect={() => void tunnelCurrentPage()}
                  >
                    <Route className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="block text-xs font-medium">
                        Tunnel / Open locally
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {desktopTunnelAvailable()
                          ? "Attach a loopback port and launch your system browser."
                          : "Available in the Cantrip desktop app."}
                      </span>
                    </span>
                  </DropdownMenuPrimitive.Item>
                  <DropdownMenuPrimitive.Item
                    className="flex cursor-default items-start gap-2 rounded-sm px-2 py-2 outline-none focus:bg-accent"
                    onSelect={() => void saveCurrentTunnel()}
                  >
                    <CopyPlus className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="block text-xs font-medium">
                        Save as custom tunnel
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        Keep an editable project-organized definition.
                      </span>
                    </span>
                  </DropdownMenuPrimitive.Item>
                </>
              ) : (
                <DropdownMenuPrimitive.Item
                  className="flex cursor-default items-start gap-2 rounded-sm px-2 py-2 outline-none focus:bg-accent"
                  onSelect={() => void openCurrentPage()}
                >
                  <ExternalLink className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="block text-xs font-medium">
                      Open externally
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      This address is directly reachable from your computer.
                    </span>
                  </span>
                </DropdownMenuPrimitive.Item>
              )}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      </div>
      {invalidAddress ? (
        <p className="shrink-0 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          Enter a valid HTTP or HTTPS address.
        </p>
      ) : null}
      {externalActionMessage ? (
        <p className="shrink-0 border-y bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
          {externalActionMessage}
        </p>
      ) : null}
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
      >
        <RemoteSurfaceCanvas
          ref={remoteCanvasRef}
          allowAltModifiedText
          ariaLabel={`${browser.title} worker browser surface`}
          className="absolute inset-0 size-full touch-none object-fill outline-none"
          coordinateLimit="edge"
          cursor={cursor}
          framePolicy="ordered"
          getCoordinateSpace={() => viewportRef.current}
          onFocus={() => send({ type: "focus" })}
          onFrameError={() =>
            setError("The worker sent an unreadable browser frame.")
          }
          onKey={send}
          onPointer={send}
          onRendered={() => setRenderedSurfaceId(browser.id)}
          onTouch={send}
        />
        <SurfaceLoadingVeil
          label={
            runtimeStatus === "recovering"
              ? runtimeMessage || "Restarting browser…"
              : connectionState === "reconnecting"
                ? "Reconnecting to browser…"
                : "Starting browser…"
          }
          visible={!surfaceReady}
        />
        {surfaceReady &&
        (connectionState !== "ready" || runtimeStatus === "recovering") ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {runtimeStatus === "recovering"
              ? runtimeMessage || "Restarting Chromium…"
              : connectionState === "connecting"
                ? "Starting browser"
                : "Reconnecting…"}
          </div>
        ) : null}
        {error || runtimeStatus === "error" ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground shadow-lg">
            {error ?? runtimeMessage ?? "The worker browser could not recover."}
          </div>
        ) : null}
        {clipboardMessage ? (
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-background/90 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-xl">
            {clipboardMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}
