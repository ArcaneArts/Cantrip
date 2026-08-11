import type { ScriptCommand } from "@cantrip/protocol";

const kindRank: Record<ScriptCommand["kind"], number> = {
  package: 0,
  dart: 1,
  just: 2,
  cargo: 3,
  gradle: 4,
  make: 5,
};

export function filterTerminalScriptCommands(
  query: string,
  commands: readonly ScriptCommand[],
): ScriptCommand[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return commands
    .flatMap((command) => {
      const name = command.name.toLocaleLowerCase();
      const invocation = command.command.toLocaleLowerCase();
      const description = command.description?.toLocaleLowerCase() ?? "";
      const source = command.source.toLocaleLowerCase();
      const rank =
        !normalizedQuery || name.startsWith(normalizedQuery)
          ? 0
          : invocation.startsWith(normalizedQuery)
            ? 1
            : name.includes(normalizedQuery)
              ? 2
              : invocation.includes(normalizedQuery)
                ? 3
                : source.includes(normalizedQuery)
                  ? 4
                  : description.includes(normalizedQuery)
                    ? 5
                    : null;
      return rank === null ? [] : [{ command, rank }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        kindRank[left.command.kind] - kindRank[right.command.kind] ||
        left.command.name.localeCompare(right.command.name) ||
        left.command.command.localeCompare(right.command.command),
    )
    .slice(0, 100)
    .map(({ command }) => command);
}

export function moveTerminalCommandSelection(
  currentIndex: number,
  direction: -1 | 1,
  commandCount: number,
): number {
  if (commandCount <= 0) return 0;
  return (currentIndex + direction + commandCount) % commandCount;
}

export type TerminalCommandSelectionSource = "keyboard" | "pointer" | "reset";

export function ensureTerminalCommandSelectionVisible(
  element: Pick<HTMLElement, "scrollIntoView"> | null,
  source: TerminalCommandSelectionSource,
): void {
  if (source !== "keyboard") return;
  element?.scrollIntoView({ block: "nearest" });
}

export function terminalCommandInput(command: ScriptCommand): string {
  return `${command.command}\r`;
}
