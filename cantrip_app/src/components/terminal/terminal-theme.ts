export const transparentTerminalBackground = "#00000000";

export function terminalBackground(
  themeBackground: string,
  proMode: boolean,
): string {
  return proMode ? transparentTerminalBackground : themeBackground;
}
