import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import { terminalServerMessageSchema } from "@cantrip/protocol";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getWorkers, terminalWebSocketUrl } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import { ResizablePanel } from "@/components/ui/resizable-panel";
import {
  startDirectDesktopTerminal,
  stopDirectDesktopTerminal,
  type DesktopTerminalConnection,
} from "@/lib/desktop-terminal";
import { ensureSurfacePrivateStateWorkerEncryption } from "@/lib/surface-private-state-worker-encryption";
import {
  openSurfaceStreamContent,
  protectSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";

import { terminalCommandInput } from "./terminal-command-palette";
import { rowsWithoutPartiallyVisibleLastLine } from "./terminal-fit";
import { installTerminalLinkLayer } from "./terminal-link-layer";
import { TerminalScriptCommandDialog } from "./terminal-script-command-dialog";
import { TerminalServicePanel } from "./terminal-service-panel";
import { terminalBackground } from "./terminal-theme";

import "@xterm/xterm/css/xterm.css";

const loadedTerminalIds = new Set<string>();
const DEFAULT_SERVICE_PANEL_WIDTH = 360;
const MIN_SERVICE_PANEL_WIDTH = 280;
const MAX_SERVICE_PANEL_WIDTH = 640;
const SERVICE_PANEL_WIDTH_STORAGE_KEY = "cantrip:terminal-service-panel-width";

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: terminalBackground(
      styles.getPropertyValue("--background").trim(),
      document.documentElement.classList.contains("pro-mode"),
    ),
    foreground: styles.getPropertyValue("--foreground").trim(),
    cursor: styles.getPropertyValue("--foreground").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
  };
}

export function TerminalView({
  commandPaletteOpen = false,
  onCommandPaletteOpenChange,
  onServicePanelOpenChange,
  servicePanelOpen = false,
  terminal,
  onExit,
  onOpenExternalLink,
  onOpenLink,
}: {
  commandPaletteOpen?: boolean;
  onCommandPaletteOpenChange?(open: boolean): void;
  onServicePanelOpenChange?(open: boolean): void;
  servicePanelOpen?: boolean;
  terminal: TerminalSummary;
  onExit?(): void;
  onOpenExternalLink?(url: string): void;
  onOpenLink?(url: string): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputSenderRef = useRef<((data: string) => boolean) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalIdRef = useRef(terminal.id);
  const xtermRef = useRef<Terminal | null>(null);
  const onExitRef = useRef(onExit);
  const onOpenExternalLinkRef = useRef(onOpenExternalLink);
  const onOpenLinkRef = useRef(onOpenLink);
  const [connectionKey, setConnectionKey] = useState(0);
  const [state, setState] = useState<"connecting" | "reconnecting" | "ready">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const [loadedTerminalId, setLoadedTerminalId] = useState<string | null>(() =>
    loadedTerminalIds.has(terminal.id) ? terminal.id : null,
  );
  const hasLoaded =
    loadedTerminalId === terminal.id || loadedTerminalIds.has(terminal.id);
  onExitRef.current = onExit;
  onOpenExternalLinkRef.current = onOpenExternalLink;
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (terminalIdRef.current !== terminal.id) {
      terminalIdRef.current = terminal.id;
      reconnectAttemptRef.current = 0;
    }
    setState(reconnectAttemptRef.current === 0 ? "connecting" : "reconnecting");
    setError(null);
    const connectionStartedAt = performance.now();
    const operationId = crypto.randomUUID();
    clientLogger.info("Terminal surface connection started", {
      attempt: reconnectAttemptRef.current + 1,
      event: "surface.terminal.connecting",
      operation: "connect",
      status: reconnectAttemptRef.current === 0 ? "connecting" : "reconnecting",
      subsystem: "terminal",
      surfaceId: terminal.id,
    });

    const xterm = new Terminal({
      allowProposedApi: false,
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    xtermRef.current = xterm;
    const terminalLinks = installTerminalLinkLayer({
      terminal: xterm,
      onOpen: (url) => onOpenLinkRef.current?.(url),
      onOpenExternal: (url) => onOpenExternalLinkRef.current?.(url),
    });

    let socket: WebSocket | null = null;
    let directConnection: DesktopTerminalConnection | null = null;
    let directFallbackStarted = false;
    let ready = false;
    let disposed = false;
    let exited = false;
    let inputSequence = 0;
    let inputQueue = Promise.resolve();
    let outputSequence = 0;
    let outputQueue = Promise.resolve();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(500 * 2 ** reconnectAttemptRef.current, 5_000);
      reconnectAttemptRef.current += 1;
      setState("reconnecting");
      clientLogger.rateLimited(
        `terminal-reconnect:${terminal.id}`,
        "info",
        "Terminal surface reconnect scheduled",
        {
          attempt: reconnectAttemptRef.current,
          delayMs: delay,
          event: "surface.terminal.reconnect-scheduled",
          operation: "reconnect",
          subsystem: "terminal",
          surfaceId: terminal.id,
        },
        { summaryEvery: 10, windowMs: 30_000 },
      );
      reconnectTimer = setTimeout(
        () => setConnectionKey((key) => key + 1),
        delay,
      );
    };
    const sendSize = () => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }),
      );
    };
    const resize = () => {
      try {
        fit.fit();
        const element = xterm.element;
        if (element) {
          const rows = rowsWithoutPartiallyVisibleLastLine(
            xterm.rows,
            element.getBoundingClientRect().bottom,
            container.getBoundingClientRect().bottom,
          );
          if (rows !== xterm.rows) xterm.resize(xterm.cols, rows);
        }
        sendSize();
      } catch {
        // The terminal may be between mount and layout during navigation.
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    const sendInput = (data: string) => {
      if (ready && socket?.readyState === WebSocket.OPEN) {
        const sequence = inputSequence;
        inputSequence += 1;
        inputQueue = inputQueue
          .then(async () => {
            const protectedData = await protectSurfaceStreamContent({
              context: {
                surfaceKind: "terminal",
                surfaceId: terminal.id,
                operationId,
                direction: "input",
                sequence,
              },
              content: { type: "terminal.input" as const, data },
              schema: terminalInputContentSchema,
            });
            if (ready && socket?.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "input",
                  operationId,
                  sequence,
                  protectedData,
                }),
              );
            }
          })
          .catch(() => {
            if (!disposed) {
              setError("Terminal input encryption failed.");
              scheduleReconnect();
            }
          });
        return true;
      }
      return false;
    };
    inputSenderRef.current = sendInput;
    const input = xterm.onData(sendInput);
    const releaseDirect = () => {
      const connection = directConnection;
      directConnection = null;
      if (connection) void stopDirectDesktopTerminal(connection);
    };
    const connectSocket = (url: string, direct: boolean) => {
      if (disposed) return;
      const nextSocket = new WebSocket(url);
      socket = nextSocket;
      nextSocket.addEventListener("message", (event) => {
        let message: TerminalServerMessage;
        try {
          message = terminalServerMessageSchema.parse(JSON.parse(event.data));
        } catch {
          setError("The server sent an invalid terminal frame.");
          clientLogger.rateLimited(
            `terminal-frame:${terminal.id}`,
            "warn",
            "Terminal surface received an invalid frame",
            {
              event: "surface.terminal.protocol-error",
              operation: "decode-frame",
              reasonCode: "invalid-frame",
              subsystem: "terminal",
              surfaceId: terminal.id,
            },
          );
          return;
        }
        if (message.type === "ready") {
          ready = true;
          reconnectAttemptRef.current = 0;
          loadedTerminalIds.add(terminal.id);
          setLoadedTerminalId(terminal.id);
          setState("ready");
          clientLogger.info("Terminal surface is ready", {
            attempt: reconnectAttemptRef.current + 1,
            durationMs: Math.round(performance.now() - connectionStartedAt),
            event: "surface.terminal.ready",
            operation: "connect",
            status: "ready",
            subsystem: "terminal",
            surfaceId: terminal.id,
            transport: direct ? "direct" : "relay",
          });
          requestAnimationFrame(() => {
            resize();
            xterm.focus();
          });
        } else if (message.type === "output") {
          if (
            message.operationId !== operationId ||
            message.sequence !== outputSequence
          ) {
            setError("The protected terminal stream is out of sequence.");
            nextSocket.close(1008, "Protected terminal stream out of sequence");
            return;
          }
          const sequence = outputSequence;
          outputSequence += 1;
          outputQueue = outputQueue
            .then(async () => {
              const content = await openSurfaceStreamContent({
                context: {
                  surfaceKind: "terminal",
                  surfaceId: terminal.id,
                  operationId,
                  direction: "output",
                  sequence,
                },
                opaque: message.protectedData,
                schema: terminalOutputContentSchema,
              });
              if (!disposed) xterm.write(content.data);
            })
            .catch(() => {
              if (!disposed) {
                setError("The protected terminal output could not be opened.");
                nextSocket.close(
                  1008,
                  "Protected terminal output authentication failed",
                );
              }
            });
        } else if (message.type === "exit") {
          ready = false;
          exited = true;
          clientLogger.info("Terminal process exited", {
            event: "surface.terminal.exited",
            exitCode: message.exitCode,
            operation: "process-exit",
            status: "exited",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
          if (onExitRef.current) {
            onExitRef.current();
            nextSocket.close(1000, "Terminal process exited");
            return;
          }
          xterm.write(
            `\r\n\x1b[90m[Process exited ${message.exitCode}]\x1b[0m\r\n`,
          );
          scheduleReconnect();
          nextSocket.close(1000, "Terminal process exited");
        } else {
          ready = false;
          setError(message.message);
          scheduleReconnect();
          clientLogger.warn("Terminal surface reported an error", {
            event: "surface.terminal.remote-error",
            operation: "terminal-session",
            reasonCode: "remote-error",
            status: "failed",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
        }
      });
      const fail = () => {
        if (disposed || exited || socket !== nextSocket) return;
        const wasReady = ready;
        ready = false;
        if (direct && !directFallbackStarted) {
          directFallbackStarted = true;
          clientLogger.warn("Terminal direct transport fell back to relay", {
            event: "surface.terminal.transport-fallback",
            operation: "select-transport",
            reasonCode: "direct-unavailable",
            status: "fallback",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
          releaseDirect();
          if (wasReady) scheduleReconnect();
          else
            connectSocket(
              terminalWebSocketUrl(terminal.id, operationId),
              false,
            );
          return;
        }
        setError("Could not connect to the terminal session.");
        clientLogger.rateLimited(
          `terminal-connect:${terminal.id}`,
          "warn",
          "Terminal surface connection failed",
          {
            attempt: reconnectAttemptRef.current + 1,
            durationMs: Math.round(performance.now() - connectionStartedAt),
            event: "surface.terminal.connect.failed",
            operation: "connect",
            reasonCode: "transport-error",
            status: "failed",
            subsystem: "terminal",
            surfaceId: terminal.id,
            transport: direct ? "direct" : "relay",
          },
        );
        scheduleReconnect();
      };
      nextSocket.addEventListener("close", fail);
      nextSocket.addEventListener("error", fail);
    };
    const startTransport = () => {
      void startDirectDesktopTerminal(terminal.id)
        .then((connection) => {
          if (disposed) {
            if (connection) void stopDirectDesktopTerminal(connection);
            return;
          }
          directConnection = connection;
          clientLogger.debug("Terminal surface transport selected", {
            event: "surface.terminal.transport-selected",
            operation: "select-transport",
            subsystem: "terminal",
            surfaceId: terminal.id,
            transport: connection ? "direct" : "relay",
          });
          const url = connection
            ? new URL(connection.url)
            : new URL(terminalWebSocketUrl(terminal.id, operationId));
          url.searchParams.set("operationId", operationId);
          connectSocket(url.toString(), Boolean(connection));
        })
        .catch((error: unknown) => {
          clientLogger.warn("Terminal direct transport discovery failed", {
            ...operationalErrorMetadata(error),
            event: "surface.terminal.direct-discovery.failed",
            operation: "discover-direct",
            reasonCode: "discovery-failed",
            status: "fallback",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
          if (!disposed)
            connectSocket(
              terminalWebSocketUrl(terminal.id, operationId),
              false,
            );
        });
    };
    void getWorkers()
      .then((workers) =>
        ensureSurfacePrivateStateWorkerEncryption({
          worker: workers.find(
            (worker) => worker.workerId === terminal.activeWorkerId,
          ),
        }),
      )
      .then(() => {
        if (!disposed) startTransport();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setError("Terminal encryption is unavailable for this worker.");
        clientLogger.warn("Terminal encryption preparation failed", {
          ...operationalErrorMetadata(error),
          event: "surface.terminal.encryption.failed",
          operation: "prepare-encryption",
          reasonCode: "encryption-unavailable",
          status: "failed",
          subsystem: "terminal",
          surfaceId: terminal.id,
        });
        scheduleReconnect();
      });

    return () => {
      ready = false;
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      input.dispose();
      if (inputSenderRef.current === sendInput) inputSenderRef.current = null;
      if (xtermRef.current === xterm) xtermRef.current = null;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      socket?.close(1000, "Terminal view closed");
      clientLogger.info("Terminal surface view closed", {
        event: "surface.terminal.closed",
        operation: "disconnect",
        status: "closed",
        subsystem: "terminal",
        surfaceId: terminal.id,
      });
      releaseDirect();
      terminalLinks.dispose();
      xterm.dispose();
    };
  }, [connectionKey, terminal.activeWorkerId, terminal.id]);

  const setCommandPaletteOpen = (open: boolean) => {
    onCommandPaletteOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  const setServicePanelOpen = (open: boolean) => {
    onServicePanelOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  return (
    <div
      className="relative flex min-h-0 flex-1 bg-background"
      data-slot="terminal-view"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          ref={containerRef}
          className="min-h-0 min-w-0 flex-1 p-3"
          data-selectable-text="true"
        />
        <SurfaceLoadingVeil
          label={
            terminal.linkedChatId
              ? "Starting Codex console…"
              : error
                ? `${error} Retrying…`
                : "Starting terminal…"
          }
          visible={!hasLoaded}
        />
        {hasLoaded && state !== "ready" ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-muted/90 px-2 py-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {state === "connecting"
              ? "Connecting"
              : error
                ? `${error} Retrying…`
                : "Reconnecting…"}
          </div>
        ) : null}
      </div>
      {onServicePanelOpenChange ? (
        <ResizablePanel
          ariaLabel="Resize terminal service panel"
          className="absolute inset-y-0 right-0 z-20 max-w-full md:relative md:inset-auto md:z-auto"
          defaultWidth={DEFAULT_SERVICE_PANEL_WIDTH}
          handleDataSlot="terminal-service-panel-resize-handle"
          maxWidth={MAX_SERVICE_PANEL_WIDTH}
          minWidth={MIN_SERVICE_PANEL_WIDTH}
          open={servicePanelOpen}
          shellDataSlot="terminal-service-panel-shell"
          storageKey={SERVICE_PANEL_WIDTH_STORAGE_KEY}
          surfaceClassName="max-w-[100vw] bg-background"
          surfaceDataSlot="terminal-service-panel-surface"
          title="Drag to resize terminal service panel"
        >
          <TerminalServicePanel
            onClose={() => setServicePanelOpen(false)}
            terminal={terminal}
          />
        </ResizablePanel>
      ) : null}
      {onCommandPaletteOpenChange ? (
        <TerminalScriptCommandDialog
          terminalId={terminal.id}
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          onRun={(command) =>
            inputSenderRef.current?.(terminalCommandInput(command))
              ? null
              : "The terminal is reconnecting. Try again when it is ready."
          }
        />
      ) : null}
    </div>
  );
}
