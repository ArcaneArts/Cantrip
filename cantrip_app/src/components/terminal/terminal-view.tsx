import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import { terminalServerMessageSchema } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { terminalWebSocketUrl } from "@/lib/api";

import "@xterm/xterm/css/xterm.css";

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--background").trim(),
    foreground: styles.getPropertyValue("--foreground").trim(),
    cursor: styles.getPropertyValue("--foreground").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
  };
}

export function TerminalView({
  terminal,
  onExit,
}: {
  terminal: TerminalSummary;
  onExit?(): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalIdRef = useRef(terminal.id);
  const onExitRef = useRef(onExit);
  const [connectionKey, setConnectionKey] = useState(0);
  const [state, setState] = useState<"connecting" | "reconnecting" | "ready">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  onExitRef.current = onExit;

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

    const socket = new WebSocket(terminalWebSocketUrl(terminal.id));
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
      if (!ready || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }),
      );
    };
    const resize = () => {
      try {
        fit.fit();
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
    const input = xterm.onData((data) => {
      if (ready && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    socket.addEventListener("message", (event) => {
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
          socket.close(1000, "Terminal process exited");
          return;
        }
        xterm.write(
          `\r\n\x1b[90m[Process exited ${message.exitCode}]\x1b[0m\r\n`,
        );
        scheduleReconnect();
        socket.close(1000, "Terminal process exited");
      } else {
        ready = false;
        setError(message.message);
        scheduleReconnect();
      }
    });
    socket.addEventListener("close", () => {
      ready = false;
      if (disposed || exited) return;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (disposed) return;
      setError("Could not connect to the terminal session.");
      scheduleReconnect();
    });

    return () => {
      ready = false;
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      input.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      socket.close(1000, "Terminal view closed");
      xterm.dispose();
    };
  }, [connectionKey, terminal.id]);

  return (
    <div className="relative flex min-h-0 flex-1 bg-background">
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 p-3" />
      {state !== "ready" ? (
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
  );
}
