export function shouldStartDirectTerminalTransport(
  terminalId: string,
  directUnavailableTerminalId: string | null,
): boolean {
  return directUnavailableTerminalId !== terminalId;
}
