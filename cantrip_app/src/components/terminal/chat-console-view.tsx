import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  ChatMessage,
  ChatSummary,
  SettingsBundle,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  deleteTerminal,
  getMessages,
  interruptChat,
  startTurn,
} from "@/lib/api";

import "@xterm/xterm/css/xterm.css";

function consoleTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--background").trim(),
    foreground: styles.getPropertyValue("--foreground").trim(),
    cursor: styles.getPropertyValue("--foreground").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
  };
}

function messageText(message: ChatMessage): string {
  return message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n\n");
}

function formatMessage(message: ChatMessage): string {
  const text = messageText(message).replaceAll("\n", "\r\n");
  if (text) {
    const color =
      message.role === "user"
        ? "\x1b[96m"
        : message.role === "system"
          ? "\x1b[91m"
          : "\x1b[0m";
    const prefix =
      message.role === "user" ? "› " : message.role === "system" ? "! " : "";
    return `\r\n${color}${prefix}${text}\x1b[0m\r\n`;
  }

  return message.content
    .flatMap((item) => {
      if (item.type !== "activity") return [];
      const activity = item.activity;
      if (activity.type === "command") {
        const marker = activity.status === "running" ? "…" : "✓";
        return [`\r\n\x1b[90m${marker} Ran ${activity.command}\x1b[0m\r\n`];
      }
      const files = activity.changes
        .map((change) => `${change.kind} ${change.path}`)
        .join(", ");
      return [
        `\r\n\x1b[90m${activity.status === "running" ? "…" : "✓"} ${files}\x1b[0m\r\n`,
      ];
    })
    .join("");
}

export function ChatConsoleView({
  chat,
  onClosed,
  settings,
  terminal,
}: {
  chat: ChatSummary;
  onClosed(): void;
  settings: SettingsBundle | undefined;
  terminal: TerminalSummary;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const lineRef = useRef("");
  const renderedRef = useRef(new Map<string, string>());
  const closingRef = useRef(false);
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
      xtermRef.current?.write(
        `\r\n\x1b[91m${error instanceof Error ? error.message : "Could not start the turn."}\x1b[0m\r\n`,
      );
    },
  });
  const statusRef = useRef(chat.status);
  const modelIdRef = useRef(selectedModelId);
  const sendRef = useRef(send.mutate);
  const onClosedRef = useRef(onClosed);
  statusRef.current = chat.status;
  modelIdRef.current = selectedModelId;
  sendRef.current = send.mutate;
  onClosedRef.current = onClosed;

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm || !messages.data) return;
    for (const message of messages.data) {
      const fingerprint = JSON.stringify(message.content);
      if (renderedRef.current.get(message.id) === fingerprint) continue;
      renderedRef.current.set(message.id, fingerprint);
      xterm.write("\r\x1b[2K");
      xterm.write(formatMessage(message));
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
      `\x1b[1mCantrip Codex console\x1b[0m · linked to ${chat.title}\r\n\x1b[90mMessages entered here use the same Codex thread. Ctrl+C closes this console.\x1b[0m\r\n`,
    );
    for (const message of messages.data ?? []) {
      renderedRef.current.set(message.id, JSON.stringify(message.content));
      xterm.write(formatMessage(message));
    }
    xterm.write("\r\n› ");

    const closeConsole = async () => {
      if (closingRef.current) return;
      closingRef.current = true;
      xterm.write("^C\r\n\x1b[90mClosing linked console…\x1b[0m\r\n");
      try {
        await interruptChat(chat.id);
      } finally {
        await deleteTerminal(terminal.id).catch(() => undefined);
        onClosedRef.current();
      }
    };
    xterm.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.ctrlKey &&
        event.key.toLowerCase() === "c"
      ) {
        void closeConsole();
        return false;
      }
      return true;
    });
    const interceptInterrupt = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        void closeConsole();
      }
    };
    window.addEventListener("keydown", interceptInterrupt, true);
    const input = xterm.onData((data) => {
      if (data === "\x03") {
        void closeConsole();
        return;
      }
      if (closingRef.current || data.startsWith("\x1b")) return;
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
      input.dispose();
      window.removeEventListener("keydown", interceptInterrupt, true);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      xtermRef.current = null;
      xterm.dispose();
    };
  }, [chat.id, chat.title, terminal.id]);

  return (
    <div className="relative flex min-h-0 flex-1 bg-background">
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 p-3" />
    </div>
  );
}
