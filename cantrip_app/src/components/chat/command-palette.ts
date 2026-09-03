import type { SkillSummary } from "@cantrip/protocol";

import {
  filterSlashCommands,
  type SlashCommandSuggestion,
} from "./slash-commands";

export type CommandPaletteSuggestion =
  | {
      kind: "builtin";
      invocation: string;
      label: string;
      description: string;
      command: SlashCommandSuggestion;
    }
  | {
      kind: "skill";
      invocation: string;
      label: string;
      description: string;
      skill: SkillSummary;
    };

const kindRank: Record<CommandPaletteSuggestion["kind"], number> = {
  builtin: 0,
  skill: 1,
};

function normalizedInvocation(suggestion: CommandPaletteSuggestion) {
  return suggestion.invocation.replace(/^[/#$]/u, "").toLocaleLowerCase();
}

export function filterCommandPalette(
  query: string,
  skills: readonly SkillSummary[],
): CommandPaletteSuggestion[] {
  const suggestions: CommandPaletteSuggestion[] = [
    ...filterSlashCommands("").map((command): CommandPaletteSuggestion => ({
      kind: "builtin",
      invocation: command.invocation,
      label: command.command.name,
      description: command.command.description,
      command,
    })),
    ...skills.map((skill): CommandPaletteSuggestion => ({
      kind: "skill",
      invocation: `$${skill.name}`,
      label: skill.displayName ?? skill.name,
      description: skill.description,
      skill,
    })),
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return suggestions
    .flatMap((suggestion) => {
      const invocation = normalizedInvocation(suggestion);
      const label = suggestion.label.toLocaleLowerCase();
      const description = suggestion.description.toLocaleLowerCase();
      const rank =
        !normalizedQuery || invocation.startsWith(normalizedQuery)
          ? 0
          : label.startsWith(normalizedQuery)
            ? 1
            : invocation.includes(normalizedQuery)
              ? 2
              : label.includes(normalizedQuery)
                ? 3
                : description.includes(normalizedQuery)
                  ? 4
                  : null;
      return rank === null ? [] : [{ rank, suggestion }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        kindRank[left.suggestion.kind] - kindRank[right.suggestion.kind] ||
        normalizedInvocation(left.suggestion).localeCompare(
          normalizedInvocation(right.suggestion),
        ),
    )
    .slice(0, 100)
    .map(({ suggestion }) => suggestion);
}
