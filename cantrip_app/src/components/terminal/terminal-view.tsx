import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  type EliteRevealConfig,
} from "@cantrip/glitch";
import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getWorkers } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import { ResizablePanel } from "@/components/ui/resizable-panel";
import { ensureSurfacePrivateStateWorkerEncryption } from "@/lib/surface-private-state-worker-encryption";
import {
  openSurfaceStreamContent,
  protectSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";
import {
  openTerminalWorkerLink,
  type TerminalWorkerLinkConnection,
} from "@/lib/terminal-worker-link";

import { terminalCommandInput } from "./terminal-command-palette";
import {
  TerminalHydrationController,
  terminalHydrationRecoveryError,
} from "./terminal-hydration";
import {
  createTerminalContentGlitchRenderer,
  type TerminalContentGlitchRenderer,
} from "./terminal-content-glitch";
import {
  MobileTerminalCommandBar,
  mobileTerminalKeyInput,
  type MobileTerminalKey,
} from "./mobile-terminal-command-bar";
import {
  rowsWithoutPartiallyVisibleLastLine,
  terminalViewportCanFit,
} from "./terminal-fit";
import { isTerminalClearShortcut } from "./terminal-keyboard";
import { installTerminalLinkLayer } from "./terminal-link-layer";
import { TerminalScriptCommandDialog } from "./terminal-script-command-dialog";
import { TerminalServicePanel } from "./terminal-service-panel";
import { terminalBackground } from "./terminal-theme";
import { useMobileTerminalKeyboard } from "./use-mobile-terminal-keyboard";

import "@xterm/xterm/css/xterm.css";

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
  eliteContentGlitchEnabled = false,
  eliteRevealConfig = DEFAULT_ELITE_REVEAL_CONFIG,
  onCommandPaletteOpenChange,
  onPendingInputSent,
  onServicePanelOpenChange,
  pendingInput = null,
  servicePanelOpen = false,
  terminal,
  visible = true,
  onExit,
  onOpenExternalLink,
  onOpenLink,
}: {
  commandPaletteOpen?: boolean;
  eliteContentGlitchEnabled?: boolean;
  eliteRevealConfig?: EliteRevealConfig;
  onCommandPaletteOpenChange?(open: boolean): void;
  onPendingInputSent?(inputId: string): void;
  onServicePanelOpenChange?(open: boolean): void;
  pendingInput?: { data: string; id: string } | null;
  servicePanelOpen?: boolean;
  terminal: TerminalSummary;
  visible?: boolean;
  onExit?(): void;
  onOpenExternalLink?(url: string): void;
  onOpenLink?(url: string): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const eliteContentGlitchEnabledRef = useRef(eliteContentGlitchEnabled);
  const eliteRevealConfigRef = useRef(eliteRevealConfig);
  const inputSenderRef = useRef<((data: string) => boolean) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalSurfaceRef = useRef<HTMLDivElement>(null);
  const terminalContentGlitchRendererRef =
    useRef<TerminalContentGlitchRenderer | null>(null);
  const terminalIdRef = useRef(terminal.id);
  const visibleRef = useRef(visible);
  const restoreVisibleSurfaceRef = useRef<(() => void) | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const onExitRef = useRef(onExit);
  const onOpenExternalLinkRef = useRef(onOpenExternalLink);
  const onOpenLinkRef = useRef(onOpenLink);
  const onPendingInputSentRef = useRef(onPendingInputSent);
  const pendingInputRef = useRef(pendingInput);
  const [connectionKey, setConnectionKey] = useState(0);
  const [state, setState] = useState<"connecting" | "reconnecting" | "ready">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [loadedTerminalId, setLoadedTerminalId] = useState<string | null>(null);
  const [terminalFocused, setTerminalFocused] = useState(false);
  const mobileKeyboard = useMobileTerminalKeyboard(terminalSurfaceRef);
  const hasLoaded = loadedTerminalId === terminal.id;
  const mobileCommandBarVisible =
    visible && mobileKeyboard.open && terminalFocused;
  eliteContentGlitchEnabledRef.current = eliteContentGlitchEnabled;
  eliteRevealConfigRef.current = eliteRevealConfig;
  onExitRef.current = onExit;
  onOpenExternalLinkRef.current = onOpenExternalLink;
  onOpenLinkRef.current = onOpenLink;
  onPendingInputSentRef.current = onPendingInputSent;
  pendingInputRef.current = pendingInput;
  visibleRef.current = visible;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (terminalIdRef.current !== terminal.id) {
      terminalIdRef.current = terminal.id;
      reconnectAttemptRef.current = 0;
    }
    setState(reconnectAttemptRef.current === 0 ? "connecting" : "reconnecting");
    setError(null);
    setRecoveryError(null);
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
    xterm.attachCustomKeyEventHandler((event) => {
      if (!isTerminalClearShortcut(event, terminal.linkedChatId)) return true;
      event.preventDefault();
      event.stopPropagation();
      xterm.clear();
      return false;
    });
    xtermRef.current = xterm;
    const terminalContentGlitchRenderer = createTerminalContentGlitchRenderer(
      xterm,
      {
        config: () => eliteRevealConfigRef.current,
        enabled: () => eliteContentGlitchEnabledRef.current,
      },
    );
    terminalContentGlitchRendererRef.current = terminalContentGlitchRenderer;
    const terminalLinks = installTerminalLinkLayer({
      terminal: xterm,
      onOpen: (url) => onOpenLinkRef.current?.(url),
      onOpenExternal: (url) => onOpenExternalLinkRef.current?.(url),
    });
    setTerminalFocused(false);
    let terminalFocusFrame: number | null = null;
    const updateTerminalFocus = () => {
      terminalFocusFrame = null;
      setTerminalFocused(container.contains(document.activeElement));
    };
    const handleTerminalFocusOut = () => {
      if (terminalFocusFrame !== null) cancelAnimationFrame(terminalFocusFrame);
      terminalFocusFrame = requestAnimationFrame(updateTerminalFocus);
    };
    container.addEventListener("focusin", updateTerminalFocus);
    container.addEventListener("focusout", handleTerminalFocusOut);

    let connection: TerminalWorkerLinkConnection | null = null;
    let ready = false;
    let disposed = false;
    let exited = false;
    let inputSequence = 0;
    let inputQueue = Promise.resolve();
    let outputSequence = 0;
    let outputQueue = Promise.resolve();
    const hydration = new TerminalHydrationController();
    let hydrationStartedAt: number | null = null;
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
    const sendSize = (beforeReady = false) => {
      if ((!ready && !beforeReady) || !connection) return false;
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (
        !connection.send({
          type: "resize",
          cols,
          rows,
        })
      ) {
        connection.close("congested");
        return false;
      }
      clientLogger.debug("Terminal surface size sent", {
        event: "surface.terminal.resize-sent",
        operation: "resize",
        status: "completed",
        subsystem: "terminal",
        surfaceId: terminal.id,
        dimensions: { cols, rows },
        phase: beforeReady ? "initial" : "layout",
      });
      return true;
    };
    const resize = () => {
      if (
        !terminalViewportCanFit(
          visibleRef.current,
          container.clientWidth,
          container.clientHeight,
        )
      ) {
        return;
      }
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
      } catch (fitError) {
        clientLogger.rateLimited(
          `terminal-fit:${terminal.id}`,
          "warn",
          "Terminal surface fit failed",
          {
            ...operationalErrorMetadata(fitError),
            event: "surface.terminal.fit.failed",
            operation: "fit",
            reasonCode: "layout-unavailable",
            status: "failed",
            subsystem: "terminal",
            surfaceId: terminal.id,
            dimensions: {
              cols: xterm.cols,
              rows: xterm.rows,
              width: container.clientWidth,
              height: container.clientHeight,
            },
          },
          { summaryEvery: 10, windowMs: 30_000 },
        );
      }
    };
    const restoreVisibleSurface = () => {
      if (!visibleRef.current) return;
      resize();
      if (xterm.rows > 0) xterm.refresh(0, xterm.rows - 1);
      terminalLinks.refresh();
      if (ready) xterm.focus();
    };
    restoreVisibleSurfaceRef.current = restoreVisibleSurface;
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
      if (ready && connection) {
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
            if (
              ready &&
              connection &&
              !connection.send({
                type: "input",
                operationId,
                sequence,
                protectedData,
              })
            ) {
              throw new Error("Terminal input queue is full.");
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
    const handleMessage = (message: TerminalServerMessage): Promise<void> => {
      if (message.type === "ready") {
        let completedHydration: ReturnType<
          TerminalHydrationController["assertReady"]
        >;
        try {
          completedHydration = hydration.assertReady();
        } catch (hydrationError) {
          setError("The terminal snapshot was incomplete.");
          clientLogger.warn("Terminal snapshot hydration failed", {
            ...operationalErrorMetadata(hydrationError),
            event: "surface.terminal.hydration.failed",
            operation: "hydrate",
            reasonCode: "incomplete-snapshot",
            status: "failed",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
          connection?.close("protocol-error");
          return Promise.resolve();
        }
        if (completedHydration) {
          const recoveryWarning =
            terminalHydrationRecoveryError(completedHydration);
          const fallbackFailed = recoveryWarning !== null;
          if (recoveryWarning) setRecoveryError(recoveryWarning);
          clientLogger.info("Terminal snapshot hydration completed", {
            durationMs:
              hydrationStartedAt === null
                ? undefined
                : Math.round(performance.now() - hydrationStartedAt),
            event: "surface.terminal.hydration.completed",
            operation: "hydrate",
            status: fallbackFailed ? "degraded" : "completed",
            subsystem: "terminal",
            surfaceId: terminal.id,
            snapshot: {
              characters: completedHydration.snapshotCharacters,
              chunks: completedHydration.snapshotChunks,
              format: completedHydration.format,
              generation: completedHydration.generation,
              outputBoundary: completedHydration.outputBoundary,
              processGeneration: completedHydration.processGeneration,
              recovery:
                completedHydration.format === "legacy-raw"
                  ? completedHydration.recovery
                  : "not-needed",
              version: completedHydration.version,
            },
          });
          hydrationStartedAt = null;
        }
        // xterm can answer capability queries while parsing scrollback. Keep
        // input closed until every replay write ahead of ready has finished.
        outputQueue = outputQueue.then(() => {
          if (disposed || !connection) return;
          ready = true;
          reconnectAttemptRef.current = 0;
          setLoadedTerminalId(terminal.id);
          setState("ready");
          const queuedInput = pendingInputRef.current;
          if (queuedInput && sendInput(queuedInput.data)) {
            pendingInputRef.current = null;
            onPendingInputSentRef.current?.(queuedInput.id);
          }
          clientLogger.info("Terminal surface is ready", {
            attempt: reconnectAttemptRef.current + 1,
            durationMs: Math.round(performance.now() - connectionStartedAt),
            event: "surface.terminal.ready",
            operation: "connect",
            status: "ready",
            subsystem: "terminal",
            surfaceId: terminal.id,
            transport: connection.route,
          });
          requestAnimationFrame(() => {
            resize();
            if (visibleRef.current) xterm.focus();
          });
        });
      } else if (message.type === "output") {
        if (
          message.operationId !== operationId ||
          message.sequence !== outputSequence
        ) {
          setError("The protected terminal stream is out of sequence.");
          connection?.close("protocol-error");
          return Promise.resolve();
        }
        const sequence = outputSequence;
        outputSequence += 1;
        outputQueue = outputQueue
          .then(async () => {
            if (message.hydration) {
              hydrationStartedAt = performance.now();
              hydration.begin(message.hydration, xterm);
              clientLogger.info("Terminal snapshot hydration started", {
                event: "surface.terminal.hydration.started",
                operation: "hydrate",
                status: "started",
                subsystem: "terminal",
                surfaceId: terminal.id,
                snapshot: {
                  characters: message.hydration.snapshotCharacters,
                  chunks: message.hydration.snapshotChunks,
                  format: message.hydration.format,
                  generation: message.hydration.generation,
                  outputBoundary: message.hydration.outputBoundary,
                  processGeneration: message.hydration.processGeneration,
                  version: message.hydration.version,
                },
              });
            }
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
            if (!disposed) {
              const animateContent =
                ready &&
                visibleRef.current &&
                eliteContentGlitchEnabledRef.current;
              if (animateContent) {
                terminalContentGlitchRenderer.beforeWrite();
              }
              await new Promise<void>((resolve) => {
                xterm.write(content.data, resolve);
              });
              if (animateContent) {
                terminalContentGlitchRenderer.afterWrite();
              }
            }
            hydration.consumedOutput();
          })
          .catch((outputError: unknown) => {
            if (!disposed) {
              setError("The protected terminal output could not be opened.");
              clientLogger.warn("Terminal output or hydration failed", {
                ...operationalErrorMetadata(outputError),
                event: "surface.terminal.hydration.failed",
                operation: "hydrate-output",
                reasonCode: "invalid-protected-output",
                status: "failed",
                subsystem: "terminal",
                surfaceId: terminal.id,
              });
              connection?.close("protocol-error");
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
          connection?.close("normal");
          return Promise.resolve();
        }
        xterm.write(
          `\r\n\x1b[90m[Process exited ${message.exitCode}]\x1b[0m\r\n`,
        );
        scheduleReconnect();
        connection?.close("normal");
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
      return outputQueue;
    };
    const fail = () => {
      if (disposed || exited) return;
      ready = false;
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
          transport: connection?.route ?? "relay",
        },
      );
      scheduleReconnect();
    };
    const startTransport = () => {
      void openTerminalWorkerLink({
        onClose: fail,
        onMessage: handleMessage,
        operationId,
        terminalId: terminal.id,
        workerId: terminal.activeWorkerId,
      })
        .then((nextConnection) => {
          if (disposed) {
            nextConnection.close("normal");
            return;
          }
          connection = nextConnection;
          clientLogger.debug("Terminal surface transport selected", {
            event: "surface.terminal.transport-selected",
            operation: "select-transport",
            subsystem: "terminal",
            surfaceId: terminal.id,
            transport: nextConnection.route,
          });
          // Fit and send the real viewport before replay is consumed. The
          // resulting PTY resize gives alternate-screen TUIs a fresh redraw
          // opportunity after a detached browser terminal is reconstructed.
          resize();
          if (!sendSize(true)) return;
          nextConnection.activate();
        })
        .catch((error: unknown) => {
          clientLogger.warn("Terminal WorkerLink connection failed", {
            ...operationalErrorMetadata(error),
            event: "surface.terminal.connect.failed",
            operation: "connect-worker-link",
            reasonCode: "transport-error",
            status: "failed",
            subsystem: "terminal",
            surfaceId: terminal.id,
          });
          fail();
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
      if (terminalFocusFrame !== null) cancelAnimationFrame(terminalFocusFrame);
      container.removeEventListener("focusin", updateTerminalFocus);
      container.removeEventListener("focusout", handleTerminalFocusOut);
      if (inputSenderRef.current === sendInput) inputSenderRef.current = null;
      if (xtermRef.current === xterm) xtermRef.current = null;
      if (restoreVisibleSurfaceRef.current === restoreVisibleSurface) {
        restoreVisibleSurfaceRef.current = null;
      }
      if (
        terminalContentGlitchRendererRef.current ===
        terminalContentGlitchRenderer
      ) {
        terminalContentGlitchRendererRef.current = null;
      }
      resizeObserver.disconnect();
      themeObserver.disconnect();
      connection?.close("normal");
      clientLogger.info("Terminal surface view closed", {
        event: "surface.terminal.closed",
        operation: "disconnect",
        status: "closed",
        subsystem: "terminal",
        surfaceId: terminal.id,
      });
      terminalLinks.dispose();
      terminalContentGlitchRenderer.dispose();
      xterm.dispose();
    };
  }, [connectionKey, terminal.activeWorkerId, terminal.id]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!visible) {
      setTerminalFocused(false);
      terminalContentGlitchRendererRef.current?.clear();
      clientLogger.info("Terminal surface parked", {
        dimensions: xterm ? { cols: xterm.cols, rows: xterm.rows } : undefined,
        event: "surface.terminal.parked",
        operation: "park-surface",
        reasonCode: "surface-hidden",
        status: "parked",
        subsystem: "terminal",
        surfaceId: terminal.id,
      });
      return;
    }
    let restoreFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        restoreVisibleSurfaceRef.current?.();
        const restoredXterm = xtermRef.current;
        clientLogger.info("Terminal surface restored", {
          dimensions: restoredXterm
            ? { cols: restoredXterm.cols, rows: restoredXterm.rows }
            : undefined,
          event: "surface.terminal.restored",
          operation: "restore-surface",
          reasonCode: "surface-selected",
          status: "restored",
          subsystem: "terminal",
          surfaceId: terminal.id,
        });
      });
    });
    return () => cancelAnimationFrame(restoreFrame);
  }, [terminal.id, visible]);

  useEffect(() => {
    if (!eliteContentGlitchEnabled) {
      terminalContentGlitchRendererRef.current?.clear();
    }
  }, [eliteContentGlitchEnabled]);

  useEffect(() => {
    if (!pendingInput) return;
    if (!inputSenderRef.current?.(pendingInput.data)) return;
    pendingInputRef.current = null;
    onPendingInputSentRef.current?.(pendingInput.id);
  }, [pendingInput]);

  const setCommandPaletteOpen = (open: boolean) => {
    onCommandPaletteOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  const setServicePanelOpen = (open: boolean) => {
    onServicePanelOpenChange?.(open);
    if (!open) requestAnimationFrame(() => xtermRef.current?.focus());
  };
  const runMobileTerminalKey = (key: MobileTerminalKey, shift: boolean) => {
    const xterm = xtermRef.current;
    if (xterm) {
      inputSenderRef.current?.(
        mobileTerminalKeyInput(
          key,
          shift,
          xterm.modes.applicationCursorKeysMode,
        ),
      );
    }
    requestAnimationFrame(() => xtermRef.current?.focus());
  };
  return (
    <div
      className="relative flex min-h-0 flex-1 bg-background"
      data-slot="terminal-view"
      ref={terminalSurfaceRef}
    >
      <div
        className="relative flex min-h-0 min-w-0 flex-1"
        data-elite-global={hasLoaded ? "" : undefined}
        style={{
          paddingBottom: mobileCommandBarVisible
            ? `${mobileKeyboard.contentInset}px`
            : undefined,
        }}
      >
        <div
          ref={containerRef}
          className="min-h-0 min-w-0 flex-1 p-3"
          data-selectable-text="true"
        />
        <SurfaceLoadingVeil
          fade={false}
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
        {hasLoaded && recoveryError ? (
          <div
            className="absolute inset-x-4 bottom-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{recoveryError}</span>
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
          workerId={terminal.activeWorkerId}
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          onRun={(command) =>
            inputSenderRef.current?.(terminalCommandInput(command))
              ? null
              : "The terminal is reconnecting. Try again when it is ready."
          }
        />
      ) : null}
      {mobileCommandBarVisible ? (
        <MobileTerminalCommandBar
          bottomInset={mobileKeyboard.bottomInset}
          disabled={state !== "ready"}
          onKey={runMobileTerminalKey}
        />
      ) : null}
    </div>
  );
}
