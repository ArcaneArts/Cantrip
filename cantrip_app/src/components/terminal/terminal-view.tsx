import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import { terminalServerMessageSchema } from "@cantrip/protocol";
import { CircleAlert, Loader2, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
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

export function TerminalView({ terminal }: { terminal: TerminalSummary }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connectionKey, setConnectionKey] = useState(0);
  const [state, setState] = useState<"connecting" | "ready" | "closed">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setState("connecting");
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
    let ended = false;
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
        setState("ready");
        requestAnimationFrame(() => {
          resize();
          xterm.focus();
        });
      } else if (message.type === "output") {
        xterm.write(message.data);
      } else if (message.type === "exit") {
        ready = false;
        ended = true;
        setState("closed");
        xterm.write(
          `\r\n\x1b[90m[Process exited ${message.exitCode}]\x1b[0m\r\n`,
        );
        socket.close(1000, "Terminal process exited");
      } else {
        ready = false;
        setState("closed");
        setError(message.message);
      }
    });
    socket.addEventListener("close", () => {
      ready = false;
      setState((current) => (current === "ready" ? "closed" : current));
    });
    socket.addEventListener("error", () => {
      if (ended) return;
      setError("Could not connect to the terminal session.");
      setState("closed");
    });

    return () => {
      ready = false;
      ended = true;
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
      {state === "connecting" ? (
        <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-muted/90 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Connecting
        </div>
      ) : null}
      {state === "closed" ? (
        <div className="absolute right-4 top-3 flex items-center gap-2 rounded-lg border bg-popover p-2 text-xs shadow-lg">
          {error ? <CircleAlert className="size-3.5 text-destructive" /> : null}
          <span className="max-w-72 truncate text-muted-foreground">
            {error ?? "Terminal session ended"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => setConnectionKey((key) => key + 1)}
          >
            <RotateCw className="size-3" /> Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}
