const TERMINAL_EDGE_TOLERANCE_PX = 0.5;

export function terminalViewportCanFit(
  visible: boolean,
  width: number,
  height: number,
): boolean {
  return visible && width > 0 && height > 0;
}

export function rowsWithoutPartiallyVisibleLastLine(
  rows: number,
  renderedBottom: number,
  visibleBottom: number,
): number {
  if (
    rows <= 1 ||
    !Number.isFinite(renderedBottom) ||
    !Number.isFinite(visibleBottom) ||
    renderedBottom <= visibleBottom + TERMINAL_EDGE_TOLERANCE_PX
  ) {
    return rows;
  }
  return rows - 1;
}
