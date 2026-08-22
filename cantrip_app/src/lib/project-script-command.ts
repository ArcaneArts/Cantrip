import type { TerminalSummary } from "@cantrip/protocol";

export type ProjectScriptCommandDestination =
  | {
      kind: "current-terminal";
      terminalId: string;
    }
  | {
      kind: "new-terminal";
      tabGroupId?: string;
      worktreeId?: string;
    };

export function projectScriptCommandDestination(input: {
  activeWorktreeId: string | null;
  currentSurface: { groupId: string; kind: string } | null;
  selectedTerminal: Pick<TerminalSummary, "id" | "status"> | null;
}): ProjectScriptCommandDestination {
  if (
    input.currentSurface?.kind === "terminal" &&
    input.selectedTerminal?.status === "idle"
  ) {
    return {
      kind: "current-terminal",
      terminalId: input.selectedTerminal.id,
    };
  }

  return {
    kind: "new-terminal",
    ...(input.currentSurface
      ? { tabGroupId: input.currentSurface.groupId }
      : {}),
    ...(input.activeWorktreeId ? { worktreeId: input.activeWorktreeId } : {}),
  };
}
