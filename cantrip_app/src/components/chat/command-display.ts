const loginShellCommandPattern =
  /^(?:\/(?:[^\s/]+\/)*)?(?:bash|zsh|sh)\s+-lc\s+([\s\S]+)$/u;
const powershellCommandPattern =
  /^(?:"(?:(?:[A-Za-z]:)?[^"\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|(?:(?:[A-Za-z]:)?[^\s"'`\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)|(?:-ExecutionPolicy\s+\S+\s+))*(?:-Command|-c)\s+([\s\S]+)$/iu;
const quotedWorkerRepositoryPathPattern =
  /(["'])(?:[A-Za-z]:)?[\\/][^"'\r\n]*?[\\/]worker[\\/]repositories[\\/]([^\\/"'\s]+)[\\/]([^\\/"'\s]+)/gu;
const unquotedWorkerRepositoryPathPattern =
  /(^|[\s=(:,])(?:[A-Za-z]:)?[\\/][^\s"'`\r\n]*?[\\/]worker[\\/]repositories[\\/]([^\\/"'\s]+)[\\/]([^\\/"'\s]+)/gu;

function unwrapQuotedCommand(command: string): string {
  if (command.length < 2) return command;
  const quote = command[0];
  if (quote !== command.at(-1)) return command;
  const inner = command.slice(1, -1);
  if (quote === "'") return inner;
  if (quote !== '"') return command;
  return inner.replace(/\\\r?\n/gu, "").replace(/\\(["\\$`])/gu, "$1");
}

function normalizeWorkerRepositoryPaths(command: string): string {
  return command
    .replace(
      quotedWorkerRepositoryPathPattern,
      (_match, quote: string, _owner: string, repository: string) =>
        `${quote}${repository}`,
    )
    .replace(
      unquotedWorkerRepositoryPathPattern,
      (_match, boundary: string, _owner: string, repository: string) =>
        `${boundary}${repository}`,
    );
}

export function displayCommand(command: string): string {
  const match =
    loginShellCommandPattern.exec(command) ??
    powershellCommandPattern.exec(command);
  const unwrapped = match ? unwrapQuotedCommand(match[1]!.trim()) : command;
  return normalizeWorkerRepositoryPaths(unwrapped);
}
