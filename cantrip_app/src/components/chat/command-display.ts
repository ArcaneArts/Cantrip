const loginShellCommandPattern =
  /^(?:\/(?:[^\s/]+\/)*)?(?:bash|zsh|sh)\s+-lc\s+([\s\S]+)$/u;

function unwrapQuotedCommand(command: string): string {
  if (command.length < 2) return command;
  const quote = command[0];
  if (quote !== command.at(-1)) return command;
  const inner = command.slice(1, -1);
  if (quote === "'") return inner;
  if (quote !== '"') return command;
  return inner.replace(/\\\r?\n/gu, "").replace(/\\(["\\$`])/gu, "$1");
}

export function displayCommand(command: string): string {
  const match = loginShellCommandPattern.exec(command);
  if (!match) return command;
  return unwrapQuotedCommand(match[1]!.trim());
}
