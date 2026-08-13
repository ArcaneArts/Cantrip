import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import { terminalServerMessageSchema } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { terminalWebSocketUrl } from "@/lib/api";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import {
  startDirectDesktopTerminal,
  stopDirectDesktopTerminal,
  type DesktopTerminalConnection,
} from "@/lib/desktop-terminal";
import { cn } from "@/lib/utils";

import { terminalCommandInput } from "./terminal-command-palette";
import { rowsWithoutPartiallyVisibleLastLine } from "./terminal-fit";
import { TerminalScriptCommandDialog } from "./terminal-script-command-dialog";
import { TerminalServicePanel } from "./terminal-service-panel";
import { terminalBackground } from "./terminal-theme";

import "@xterm/xterm/css/xterm.css";

const loadedTerminalIds = new Set<string>();
const DEFAULT_SERVICE_PANEL_WIDTH = 360;
const MIN_SERVICE_PANEL_WIDTH = 280;
const MAX_SERVICE_PANEL_WIDTH = 640;
const SERVICE_PANEL_WIDTH_STORAGE_KEY = "cantrip:terminal-service-panel-width";

function clampServicePanelWidth(width: number): number {
  return Math.min(
    MAX_SERVICE_PANEL_WIDTH,
    Math.max(MIN_SERVICE_PANEL_WIDTH, Math.round(width)),
  );
}

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
}: {
  commandPaletteOpen?: boolean;
  onCommandPaletteOpenChange?(open: boolean): void;
  onServicePanelOpenChange?(open: boolean): void;
  servicePanelOpen?: boolean;
  terminal: TerminalSummary;
  onExit?(): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputSenderRef = useRef<((data: string) => boolean) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalIdRef = useRef(terminal.id);
  const xtermRef = useRef<Terminal | null>(null);
  const servicePanelShellRef = useRef<HTMLDivElement>(null);
  const servicePanelWidthRef = useRef(DEFAULT_SERVICE_PANEL_WIDTH);
  const servicePanelResizePointerIdRef = useRef<number | null>(null);
  const servicePanelResizeRightRef = useRef(0);
  const servicePanelResizeStartWidthRef = useRef(DEFAULT_SERVICE_PANEL_WIDTH);
  const servicePanelResizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);
  const onExitRef = useRef(onExit);
  const [connectionKey, setConnectionKey] = useState(0);
  const [state, setState] = useState<"connecting" | "reconnecting" | "ready">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const [servicePanelResizing, setServicePanelResizing] = useState(false);
  const [servicePanelWidth, setServicePanelWidth] = useState(
    DEFAULT_SERVICE_PANEL_WIDTH,
  );
  const [loadedTerminalId, setLoadedTerminalId] = useState<string | null>(() =>
    loadedTerminalIds.has(terminal.id) ? terminal.id : null,
  );
  const hasLoaded =
    loadedTerminalId === terminal.id || loadedTerminalIds.has(terminal.id);
  onExitRef.current = onExit;

  useEffect(() => {
    const stored = Number(
      window.localStorage.getItem(SERVICE_PANEL_WIDTH_STORAGE_KEY),
    );
    if (Number.isFinite(stored) && stored > 0) {
      const next = clampServicePanelWidth(stored);
      servicePanelWidthRef.current = next;
      setServicePanelWidth(next);
    }
    return () => {
      const previous = servicePanelResizeBodyStyleRef.current;
      if (!previous) return;
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (terminalIdRef.current !== terminal.id) {
      terminalIdRef.current = terminal.id;
      reconnectAttemptRef.current = 0;
    }
    setState(reconnectAttemptRef.current === 0 ? "connecting" : "reconnecting");
    setError(null);

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

    let socket: WebSocket | null = null;
    let directConnection: DesktopTerminalConnection | null = null;
    let directFallbackStarted = false;
    let ready = false;
    let disposed = false;
    let exited = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(500 * 2 ** reconnectAttemptRef.current, 5_000);
      reconnectAttemptRef.current += 1;
      setState("reconnecting");
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
        socket.send(JSON.stringify({ type: "input", data }));
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
          return;
        }
        if (message.type === "ready") {
          ready = true;
          reconnectAttemptRef.current = 0;
          loadedTerminalIds.add(terminal.id);
          setLoadedTerminalId(terminal.id);
          setState("ready");
          requestAnimationFrame(() => {
            resize();
            xterm.focus();
          });
        } else if (message.type === "output") {
          xterm.write(message.data);
        } else if (message.type === "exit") {
          ready = false;
          exited = true;
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
        }
      });
      const fail = () => {
        if (disposed || exited || socket !== nextSocket) return;
        const wasReady = ready;
        ready = false;
        if (direct && !directFallbackStarted) {
          directFallbackStarted = true;
          releaseDirect();
          if (wasReady) scheduleReconnect();
          else connectSocket(terminalWebSocketUrl(terminal.id), false);
          return;
        }
        setError("Could not connect to the terminal session.");
        scheduleReconnect();
      };
      nextSocket.addEventListener("close", fail);
      nextSocket.addEventListener("error", fail);
    };
    void startDirectDesktopTerminal(terminal.id)
      .then((connection) => {
        if (disposed) {
          if (connection) void stopDirectDesktopTerminal(connection);
          return;
        }
        directConnection = connection;
        connectSocket(
          connection?.url ?? terminalWebSocketUrl(terminal.id),
          Boolean(connection),
        );
      })
      .catch(() => {
        if (!disposed) connectSocket(terminalWebSocketUrl(terminal.id), false);
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
      releaseDirect();
      xterm.dispose();
    };
  }, [connectionKey, terminal.id]);

  const setCommandPaletteOpen = (open: boolean) => {
    onCommandPaletteOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  const setServicePanelOpen = (open: boolean) => {
    onServicePanelOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  const applyServicePanelWidth = (width: number) => {
    const next = clampServicePanelWidth(width);
    servicePanelWidthRef.current = next;
    setServicePanelWidth(next);
  };
  const restoreServicePanelResizeBodyStyle = () => {
    const previous = servicePanelResizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    servicePanelResizeBodyStyleRef.current = null;
  };
  const beginServicePanelResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    servicePanelResizePointerIdRef.current = event.pointerId;
    servicePanelResizeRightRef.current =
      servicePanelShellRef.current?.getBoundingClientRect().right ??
      window.innerWidth;
    servicePanelResizeStartWidthRef.current = servicePanelWidthRef.current;
    servicePanelResizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setServicePanelResizing(true);
  };
  const moveServicePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (servicePanelResizePointerIdRef.current !== event.pointerId) return;
    applyServicePanelWidth(servicePanelResizeRightRef.current - event.clientX);
  };
  const finishServicePanelResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    if (servicePanelResizePointerIdRef.current !== event.pointerId) return;
    servicePanelResizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreServicePanelResizeBodyStyle();
    setServicePanelResizing(false);
    if (!persist) {
      applyServicePanelWidth(servicePanelResizeStartWidthRef.current);
    } else if (
      servicePanelWidthRef.current !== servicePanelResizeStartWidthRef.current
    ) {
      window.localStorage.setItem(
        SERVICE_PANEL_WIDTH_STORAGE_KEY,
        String(servicePanelWidthRef.current),
      );
    }
  };
  const resizeServicePanelWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const next =
      event.key === "Home"
        ? MIN_SERVICE_PANEL_WIDTH
        : event.key === "End"
          ? MAX_SERVICE_PANEL_WIDTH
          : event.key === "ArrowLeft"
            ? servicePanelWidthRef.current + 16
            : event.key === "ArrowRight"
              ? servicePanelWidthRef.current - 16
              : null;
    if (next === null) return;
    event.preventDefault();
    applyServicePanelWidth(next);
    window.localStorage.setItem(
      SERVICE_PANEL_WIDTH_STORAGE_KEY,
      String(clampServicePanelWidth(next)),
    );
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
        <div
          ref={servicePanelShellRef}
          className={cn(
            "group/terminal-service-panel absolute inset-y-0 right-0 z-20 h-full max-w-full shrink-0 md:relative md:inset-auto md:z-auto",
            servicePanelResizing
              ? "transition-none"
              : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
          )}
          data-slot="terminal-service-panel-shell"
          data-state={servicePanelOpen ? "open" : "closed"}
          style={{ width: servicePanelOpen ? servicePanelWidth : 0 }}
        >
          <div className="absolute inset-0 overflow-hidden">
            <div
              aria-hidden={!servicePanelOpen}
              inert={!servicePanelOpen}
              className={cn(
                "absolute inset-y-0 right-0 h-full max-w-[100vw] bg-background transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                servicePanelOpen
                  ? "translate-x-0 opacity-100"
                  : "pointer-events-none translate-x-2 opacity-0",
              )}
              data-slot="terminal-service-panel-surface"
              style={{ width: servicePanelWidth }}
            >
              <TerminalServicePanel
                onClose={() => setServicePanelOpen(false)}
                terminal={terminal}
              />
            </div>
          </div>
          <div
            aria-label="Resize terminal service panel"
            aria-orientation="vertical"
            aria-valuemax={MAX_SERVICE_PANEL_WIDTH}
            aria-valuemin={MIN_SERVICE_PANEL_WIDTH}
            aria-valuenow={servicePanelWidth}
            className={cn(
              "absolute inset-y-0 -left-1 z-40 w-2 cursor-col-resize touch-none outline-none",
              "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:opacity-0 after:transition-opacity after:duration-150",
              "group-hover/terminal-service-panel:after:opacity-100 hover:after:opacity-100 focus-visible:after:opacity-100",
              !servicePanelOpen && "pointer-events-none opacity-0",
              servicePanelResizing && "after:opacity-100",
            )}
            data-slot="terminal-service-panel-resize-handle"
            onKeyDown={resizeServicePanelWithKeyboard}
            onPointerCancel={(event) => finishServicePanelResize(event, false)}
            onPointerDown={beginServicePanelResize}
            onPointerMove={moveServicePanelResize}
            onPointerUp={(event) => finishServicePanelResize(event, true)}
            role="separator"
            tabIndex={servicePanelOpen ? 0 : -1}
            title="Drag to resize terminal service panel"
          />
        </div>
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
