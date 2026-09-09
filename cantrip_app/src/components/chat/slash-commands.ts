export interface SlashCommand {
  aliases?: readonly string[];
  description: string;
  name: string;
}

export interface SlashCommandSuggestion {
  command: SlashCommand;
  invocation: string;
}

// Cantrip exposes the Codex commands that are useful inside a project agent.
// Settings commands open the same controls as the composer. Terminal-only
// presentation commands such as /theme stay outside the agent command list.
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "model",
    description: "Choose the agent model and reasoning settings",
  },
  { name: "permissions", description: "Choose the agent permission profile" },
  {
    name: "clear",
    description: "Start a fresh agent and clear the current view",
  },
  { name: "rename", description: "Rename the current agent" },
  { name: "delete", description: "Permanently delete the current session" },
  { name: "compact", description: "Compact the conversation context" },
  { name: "copy", description: "Copy the latest completed response" },
  { name: "diff", description: "Review the current Git working-tree diff" },
  { name: "init", description: "Generate an AGENTS.md scaffold" },
  { name: "fork", description: "Fork the current agent" },
  { name: "goal", description: "Use Goal mode for the next message" },
  { name: "plan", description: "Use Plan mode for the next message" },
  {
    name: "pause",
    description: "Pause or resume queued and automatic agent work",
  },
  { name: "new", description: "Start a new agent in this project" },
  { name: "review", description: "Ask Codex to review the working tree" },
  { name: "status", description: "Inspect the current Codex session" },
] as const;

export type SettingsPicker = "model" | "permissions";

/** Consume recognized settings commands even with unsupported arguments: they
 * must not accidentally become model prompts when the suggestion menu closes. */
export function settingsSlashCommand(draft: string): {
  name: SettingsPicker;
  arguments: string;
} | null {
  const match = /^\/(model|permissions)(?:\s+([\s\S]*))?$/i.exec(draft.trim());
  if (!match) return null;
  return {
    name: match[1]!.toLowerCase() as SettingsPicker,
    arguments: match[2]?.trim() ?? "",
  };
}

export function slashCommandQuery(draft: string): string | null {
  const match = /^\/([^\s]*)$/.exec(draft);
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
