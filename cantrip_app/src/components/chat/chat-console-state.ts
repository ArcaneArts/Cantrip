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
