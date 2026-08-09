import type { SkillSummary } from "@cantrip/protocol";
import type {
  WorkflowAutomationTrigger,
  WorkflowDefinitionSummary,
} from "@cantrip/protocol/workflows";

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
    }
  | {
      kind: "workflow";
      invocation: string;
      label: string;
      description: string;
      workflow: WorkflowDefinitionSummary;
    }
  | {
      kind: "saved-command";
      invocation: string;
      label: string;
      description: string;
      trigger: WorkflowAutomationTrigger & { type: "saved-command" };
    };

const kindRank: Record<CommandPaletteSuggestion["kind"], number> = {
  builtin: 0,
  "saved-command": 1,
  workflow: 1,
  skill: 2,
};

function normalizedInvocation(suggestion: CommandPaletteSuggestion) {
  return suggestion.invocation.replace(/^[/#$]/u, "").toLocaleLowerCase();
}

export function filterCommandPalette(
  query: string,
  skills: readonly SkillSummary[],
  workflows: readonly WorkflowDefinitionSummary[],
  projectId: string,
  triggers: readonly WorkflowAutomationTrigger[] = [],
): CommandPaletteSuggestion[] {
  const suggestions: CommandPaletteSuggestion[] = [
    ...filterSlashCommands("").map((command): CommandPaletteSuggestion => ({
      kind: "builtin",
      invocation: command.invocation,
      label: command.command.name,
      description: command.command.description,
      command,
    })),
    ...workflows
      .filter(
        (workflow) =>
          workflow.scope === "personal" || workflow.projectId === projectId,
      )
      .map((workflow): CommandPaletteSuggestion => ({
        kind: "workflow",
        invocation: `/${workflow.scope}/${workflow.slug}`,
        label: workflow.name,
        description:
          workflow.description ??
          `Open workflow revision ${workflow.latestRevision?.revision ?? "draft"}.`,
        workflow,
      })),
    ...triggers.flatMap((trigger): CommandPaletteSuggestion[] =>
      trigger.enabled &&
      trigger.projectId === projectId &&
      trigger.type === "saved-command"
        ? [
            {
              kind: "saved-command",
              invocation: `/command/${trigger.configuration.command}`,
              label: trigger.name,
              description: `Run saved workflow command ${trigger.configuration.command}.`,
              trigger,
            },
          ]
        : [],
    ),
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
