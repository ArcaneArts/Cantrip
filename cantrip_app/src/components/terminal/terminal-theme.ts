export const transparentTerminalBackground = "#00000000";
export const proModeTerminalCellBackgroundFactor = 0.65;

const sourceBackgroundData = "cantripTerminalBackgroundSource";
const inlineBackgroundData = "cantripTerminalInlineBackground";
const inlineBackgroundPriorityData = "cantripTerminalInlineBackgroundPriority";

export function terminalBackground(
  themeBackground: string,
  proMode: boolean,
): string {
  return proMode ? transparentTerminalBackground : themeBackground;
}

export function proModeTerminalCellBackgroundOpacity(
  proModeOpacity: string,
): number {
  const parsed = Number.parseFloat(proModeOpacity);
  const normalized = Number.isFinite(parsed)
    ? Math.max(0, Math.min(100, parsed)) / 100
    : 0.8;
  return normalized * proModeTerminalCellBackgroundFactor;
}

export function attenuatedTerminalBackgroundColor(
  color: string,
  opacity: number,
): string | null {
  const match = color.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d?(?:\.\d+)?))?\s*\)$/iu,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const sourceAlpha = match[4] ? Number.parseFloat(match[4]) : 1;
  if (!Number.isFinite(sourceAlpha) || sourceAlpha <= 0) return null;
  const alpha = Math.max(0, Math.min(1, sourceAlpha * opacity));
  return `rgba(${Math.round(Number(match[1]))}, ${Math.round(Number(match[2]))}, ${Math.round(Number(match[3]))}, ${Number(alpha.toFixed(3))})`;
}

function terminalRows(element: HTMLElement): HTMLCollection | null {
  return element.querySelector<HTMLElement>(".xterm-rows")?.children ?? null;
}

function hasPaintedBackground(element: HTMLElement): boolean {
  return (
    Boolean(element.style.backgroundColor) ||
    [...element.classList].some((name) => name.startsWith("xterm-bg-"))
  );
}

function restoreTerminalCellBackground(element: HTMLElement): void {
  if (!(sourceBackgroundData in element.dataset)) return;
  const inline = element.dataset[inlineBackgroundData] ?? "";
  const priority = element.dataset[inlineBackgroundPriorityData] ?? "";
  if (inline) {
    element.style.setProperty("background-color", inline, priority);
  } else {
    element.style.removeProperty("background-color");
  }
  delete element.dataset[sourceBackgroundData];
  delete element.dataset[inlineBackgroundData];
  delete element.dataset[inlineBackgroundPriorityData];
}

export function restoreTerminalCellBackgrounds(element: HTMLElement): void {
  for (const cell of element.querySelectorAll<HTMLElement>(
    "[data-cantrip-terminal-background-source]",
  )) {
    restoreTerminalCellBackground(cell);
  }
}

export function attenuateTerminalCellBackgrounds(
  element: HTMLElement,
  startRow: number,
  endRow: number,
  opacity: number,
): void {
  const rows = terminalRows(element);
  if (!rows) return;
  const start = Math.max(0, startRow);
  const end = Math.min(rows.length - 1, endRow);
  for (let rowIndex = start; rowIndex <= end; rowIndex += 1) {
    const row = rows.item(rowIndex);
    if (!(row instanceof HTMLElement)) continue;
    for (const cell of row.children) {
      if (
        !(cell instanceof HTMLElement) ||
        cell.classList.contains("xterm-cursor") ||
        (!hasPaintedBackground(cell) && !(sourceBackgroundData in cell.dataset))
      ) {
        continue;
      }
      const source =
        cell.dataset[sourceBackgroundData] ??
        getComputedStyle(cell).backgroundColor;
      const attenuated = attenuatedTerminalBackgroundColor(source, opacity);
      if (!attenuated) continue;
      if (!(sourceBackgroundData in cell.dataset)) {
        cell.dataset[sourceBackgroundData] = source;
        cell.dataset[inlineBackgroundData] = cell.style.backgroundColor;
        cell.dataset[inlineBackgroundPriorityData] =
          cell.style.getPropertyPriority("background-color");
      }
      cell.style.setProperty("background-color", attenuated, "important");
    }
  }
}
