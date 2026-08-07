import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  brightBlack: "\x1b[90m",
  brightCyan: "\x1b[96m",
} as const;

function safeTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function inlineMarkdown(text: string): string {
  const fragments: string[] = [];
  const stash = (value: string) => {
    const token = `\ue000${fragments.length}\ue001`;
    fragments.push(value);
    return token;
  };

  let formatted = text
    .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_match, label, url) =>
      stash(
        `${ansi.underline}${ansi.brightCyan}${label}${ansi.reset} ${ansi.dim}${url}${ansi.reset}`,
      ),
    )
    .replace(/`([^`\n]+)`/g, (_match, code) =>
      stash(`${ansi.yellow}${code}${ansi.reset}`),
    )
    .replace(/\*\*([^*\n]+)\*\*/g, `${ansi.bold}$1${ansi.reset}`)
    .replace(/__([^_\n]+)__/g, `${ansi.bold}$1${ansi.reset}`)
    .replace(/~~([^~\n]+)~~/g, `${ansi.dim}$1${ansi.reset}`)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ansi.italic}$1${ansi.reset}`)
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, `${ansi.italic}$1${ansi.reset}`);

  formatted = formatted.replace(/\ue000(\d+)\ue001/g, (_match, index) => {
    return fragments[Number(index)] ?? "";
  });
  return formatted;
}

export function markdownToAnsi(markdown: string): string {
  const lines = safeTerminalText(markdown).split("\n");
  let fenced = false;

  return lines
    .map((line) => {
      const fence = line.match(/^\s*```\s*([^`]*)$/);
      if (fence) {
        fenced = !fenced;
        const language = fence[1]?.trim();
        return language
          ? `${ansi.dim}${ansi.cyan}${language}${ansi.reset}`
          : "";
      }
      if (fenced) return `${ansi.cyan}${line}${ansi.reset}`;

      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
      if (heading) {
        return `${ansi.bold}${ansi.brightCyan}${inlineMarkdown(heading[1]!)}${ansi.reset}`;
      }

      const task = line.match(/^(\s*)[-*+]\s+\[([ xX])]\s+(.+)$/);
      if (task) {
        const checked = task[2]!.toLowerCase() === "x";
        return `${task[1]}${checked ? `${ansi.green}✓` : `${ansi.brightBlack}○`}${ansi.reset} ${inlineMarkdown(task[3]!)}`;
      }

      const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (bullet) {
        return `${bullet[1]}${ansi.cyan}•${ansi.reset} ${inlineMarkdown(bullet[2]!)}`;
      }

      const ordered = line.match(/^(\s*)(\d+[.)])\s+(.+)$/);
      if (ordered) {
        return `${ordered[1]}${ansi.cyan}${ordered[2]}${ansi.reset} ${inlineMarkdown(ordered[3]!)}`;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        return `${ansi.cyan}│${ansi.reset} ${ansi.dim}${inlineMarkdown(quote[1]!)}${ansi.reset}`;
      }

      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        return `${ansi.brightBlack}────────────────────────────────────────${ansi.reset}`;
      }

      return inlineMarkdown(line);
    })
    .join("\r\n");
}

function activityMarker(activity: AgentActivity): string {
  if (activity.status === "running") return `${ansi.yellow}…${ansi.reset}`;
  if (activity.status === "completed") return `${ansi.green}✓${ansi.reset}`;
  return `${ansi.red}✗${ansi.reset}`;
}

function formatActivity(activity: AgentActivity): string {
  const marker = activityMarker(activity);
  if (activity.type === "command") {
    const action = activity.status === "running" ? "Running" : "Ran";
    const exit =
      activity.exitCode !== null && activity.exitCode !== 0
        ? ` ${ansi.red}(exit ${activity.exitCode})${ansi.reset}`
        : "";
    return `\r\n${marker} ${ansi.dim}${action}${ansi.reset} ${safeTerminalText(activity.command)}${exit}\r\n`;
  }

  return activity.changes
    .map((change) => {
      const color =
        change.kind === "add"
          ? ansi.green
          : change.kind === "delete"
            ? ansi.red
            : ansi.yellow;
      const verb =
        change.kind === "add"
          ? "Added"
          : change.kind === "delete"
            ? "Deleted"
            : "Edited";
      return `\r\n${marker} ${color}${verb}${ansi.reset} ${safeTerminalText(change.path)}\r\n`;
    })
    .join("");
}

export function formatConsoleMessage(message: ChatMessage): string {
  const text = message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n\n");
  if (text) {
    const safeText = safeTerminalText(text);
    if (message.role === "assistant") {
      return `\r\n${markdownToAnsi(safeText)}${ansi.reset}\r\n`;
    }
    const terminalText = safeText.replaceAll("\n", "\r\n");
    if (message.role === "system") {
      return `\r\n${ansi.red}! ${terminalText}${ansi.reset}\r\n`;
    }
    return `\r\n${ansi.brightCyan}› ${terminalText}${ansi.reset}\r\n`;
  }

  return message.content
    .flatMap((item) =>
      item.type === "activity" ? [formatActivity(item.activity)] : [],
    )
    .join("");
}
