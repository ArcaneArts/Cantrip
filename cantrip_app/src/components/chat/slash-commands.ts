export interface SlashCommand {
  aliases?: readonly string[];
  description: string;
  name: string;
}

export interface SlashCommandSuggestion {
  command: SlashCommand;
  invocation: string;
}

// Cantrip exposes the Codex commands that are useful inside a project chat.
// TUI configuration commands and actions already represented by Cantrip UI
// (such as /model, /theme, and /permissions) intentionally stay out of here.
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "clear",
    description: "Start a fresh chat and clear the current view",
  },
  { name: "rename", description: "Rename the current chat" },
  { name: "delete", description: "Permanently delete the current session" },
  { name: "compact", description: "Compact the conversation context" },
  { name: "copy", description: "Copy the latest completed response" },
  { name: "diff", description: "Review the current Git working-tree diff" },
  { name: "init", description: "Generate an AGENTS.md scaffold" },
  { name: "fork", description: "Fork the current chat" },
  { name: "goal", description: "Use Goal mode for the next message" },
  { name: "plan", description: "Use Plan mode for the next message" },
  {
    name: "pause",
    description: "Pause or resume queued and automatic chat work",
  },
  { name: "new", description: "Start a new chat in this project" },
  { name: "review", description: "Ask Codex to review the working tree" },
  { name: "status", description: "Inspect the current Codex session" },
] as const;

export function slashCommandQuery(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function filterSlashCommands(query: string): SlashCommandSuggestion[] {
  const suggestions = SLASH_COMMANDS.flatMap((command) =>
    [command.name, ...(command.aliases ?? [])].map((name) => ({
      command,
      invocation: `/${name}`,
    })),
  );
  if (!query) return suggestions;

  return suggestions
    .filter(({ invocation }) => invocation.slice(1).includes(query))
    .sort((left, right) => {
      const leftName = left.invocation.slice(1);
      const rightName = right.invocation.slice(1);
      const prefixDifference =
        Number(!leftName.startsWith(query)) -
        Number(!rightName.startsWith(query));
      return (
        prefixDifference ||
        leftName.length - rightName.length ||
        leftName.localeCompare(rightName)
      );
    });
}
