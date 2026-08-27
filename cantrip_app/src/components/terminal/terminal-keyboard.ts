export interface TerminalKeyboardInput {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

export function isTerminalClearShortcut(
  input: TerminalKeyboardInput,
  linkedChatId: string | null,
): boolean {
  return (
    linkedChatId === null &&
    input.type === "keydown" &&
    input.metaKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.shiftKey &&
    input.key.toLowerCase() === "k"
  );
}
