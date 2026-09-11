import type { TerminalSummary } from "@cantrip/protocol";

export function updateChatConsoleOpenChats(
  current: ReadonlySet<string>,
  chatId: string,
  open: boolean,
): Set<string> {
  const next = new Set(current);
  if (open) next.add(chatId);
  else next.delete(chatId);
  return next;
}

export function chatConsoleTerminal(
  chatId: string | undefined,
  openChats: ReadonlySet<string> | undefined,
  terminals: readonly TerminalSummary[] | undefined,
): TerminalSummary | undefined {
  return chatId && openChats?.has(chatId)
    ? terminals?.find((terminal) => terminal.linkedChatId === chatId)
    : undefined;
}
