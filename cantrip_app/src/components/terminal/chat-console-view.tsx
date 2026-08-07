import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ChatSummary, SettingsBundle } from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getMessages, interruptChat, startTurn } from "@/lib/api";

import "@xterm/xterm/css/xterm.css";

import { formatConsoleMessage } from "./chat-console-format";

function consoleTheme() {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains("dark");
  return {
    background: styles.getPropertyValue("--background").trim(),
    foreground: styles.getPropertyValue("--foreground").trim(),
    cursor: styles.getPropertyValue("--foreground").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
    black: dark ? "#000000" : "#1f2329",
    red: dark ? "#e06c75" : "#c62828",
    green: dark ? "#98c379" : "#2e7d32",
    yellow: dark ? "#e5c07b" : "#9a6700",
    blue: dark ? "#61afef" : "#1565c0",
    magenta: dark ? "#c678dd" : "#8e24aa",
    cyan: dark ? "#56b6c2" : "#007c91",
    white: dark ? "#d7dae0" : "#4b5563",
    brightBlack: dark ? "#7f848e" : "#6b7280",
    brightRed: dark ? "#ff7b86" : "#d32f2f",
    brightGreen: dark ? "#b3dc8c" : "#388e3c",
    brightYellow: dark ? "#f1d58a" : "#a86f00",
    brightBlue: dark ? "#75bfff" : "#1976d2",
    brightMagenta: dark ? "#dc8aef" : "#9c27b0",
    brightCyan: dark ? "#67d4df" : "#008ba3",
    brightWhite: dark ? "#ffffff" : "#111827",
  };
}

export function ChatConsoleView({
  chat,
  onReturnToChat,
  settings,
}: {
  chat: ChatSummary;
  onReturnToChat(): void;
  settings: SettingsBundle | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const lineRef = useRef("");
  const renderedRef = useRef(new Map<string, string>());
  const interruptingRef = useRef(false);
  const interruptedTurnRef = useRef(false);
  const returningRef = useRef(false);
  const statusRef = useRef(chat.status);
  const selectedModelId =
    chat.modelId ?? settings?.preferences.defaultModelId ?? "";
  const messages = useQuery({
    queryFn: () => getMessages(chat.id),
    queryKey: ["messages", chat.id],
    refetchInterval: chat.status === "running" ? 500 : 1_500,
  });
  const send = useMutation({
    mutationFn: (text: string) => startTurn(chat.id, text, selectedModelId),
    onError: (error) => {
      statusRef.current = "idle";
      xtermRef.current?.write(
        `\r\n\x1b[91m${error instanceof Error ? error.message : "Could not start the turn."}\x1b[0m\r\n`,
      );
    },
  });
  const modelIdRef = useRef(selectedModelId);
  const sendRef = useRef(send.mutate);
  const onReturnToChatRef = useRef(onReturnToChat);
  if (chat.status !== "running") interruptedTurnRef.current = false;
  statusRef.current = chat.status;
  modelIdRef.current = selectedModelId;
  sendRef.current = send.mutate;
  onReturnToChatRef.current = onReturnToChat;

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm || !messages.data) return;
    for (const message of messages.data) {
      const fingerprint = JSON.stringify(message.content);
      if (renderedRef.current.get(message.id) === fingerprint) continue;
      renderedRef.current.set(message.id, fingerprint);
      xterm.write("\r\x1b[2K");
      xterm.write(formatConsoleMessage(message));
      xterm.write(`› ${lineRef.current}`);
    }
  }, [messages.data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const xterm = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: consoleTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    xtermRef.current = xterm;
    xterm.write(
      `\x1b[1mCantrip Codex console\x1b[0m · linked to ${chat.title}\r\n\x1b[90mMessages use the same Codex thread. Ctrl+C returns to chat, interrupting active work first.\x1b[0m\r\n`,
    );
    for (const message of messages.data ?? []) {
      renderedRef.current.set(message.id, JSON.stringify(message.content));
      xterm.write(formatConsoleMessage(message));
    }
    xterm.write("\r\n› ");
    let disposed = false;

    const interruptOrReturn = async () => {
      if (statusRef.current !== "running" || interruptedTurnRef.current) {
        if (returningRef.current) return;
        returningRef.current = true;
        onReturnToChatRef.current();
        return;
      }
      if (interruptingRef.current) return;
      interruptingRef.current = true;
      interruptedTurnRef.current = true;
      xterm.write("^C\r\n\x1b[93mInterrupting active turn…\x1b[0m\r\n");
      try {
        await interruptChat(chat.id);
        statusRef.current = "idle";
        if (!disposed) {
          xterm.write(
            "\x1b[90mTurn interrupted. Press Ctrl+C again to return to chat.\x1b[0m\r\n› ",
          );
        }
      } catch (error) {
        interruptedTurnRef.current = false;
        if (!disposed) {
          xterm.write(
            `\x1b[91m${error instanceof Error ? error.message : "Could not interrupt the turn."}\x1b[0m\r\n› `,
          );
        }
      } finally {
        interruptingRef.current = false;
      }
    };
    xterm.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.ctrlKey &&
        event.key.toLowerCase() === "c"
      ) {
        void interruptOrReturn();
        return false;
      }
      return true;
    });
    const interceptInterrupt = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        void interruptOrReturn();
      }
    };
    window.addEventListener("keydown", interceptInterrupt, true);
    const input = xterm.onData((data) => {
      if (data === "\x03") {
        void interruptOrReturn();
        return;
      }
      if (interruptingRef.current || data.startsWith("\x1b")) return;
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          const text = lineRef.current.trim();
          lineRef.current = "";
          xterm.write("\r\n");
          if (!text) {
            xterm.write("› ");
          } else if (!modelIdRef.current) {
            xterm.write("\x1b[91mChoose a model before sending.\x1b[0m\r\n› ");
          } else if (statusRef.current === "running") {
            xterm.write("\x1b[93mCodex is already working.\x1b[0m\r\n› ");
          } else {
            statusRef.current = "running";
            interruptedTurnRef.current = false;
            sendRef.current(text);
            xterm.write("\x1b[90mQueued…\x1b[0m\r\n› ");
          }
        } else if (character === "\x7f" || character === "\b") {
          if (lineRef.current) {
            lineRef.current = lineRef.current.slice(0, -1);
            xterm.write("\b \b");
          }
        } else if (character >= " ") {
          lineRef.current += character;
          xterm.write(character);
        }
      }
    });
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The console can briefly be hidden while switching tabs.
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = consoleTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    requestAnimationFrame(() => {
      resize();
      xterm.focus();
    });

    return () => {
      disposed = true;
      input.dispose();
      window.removeEventListener("keydown", interceptInterrupt, true);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      xtermRef.current = null;
      xterm.dispose();
    };
  }, [chat.id, chat.title]);

  return (
    <div className="relative flex min-h-0 flex-1 bg-background">
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 p-3" />
    </div>
  );
}
