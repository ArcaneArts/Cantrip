import type { IBufferLine, IDisposable, Terminal } from "@xterm/xterm";

import {
  segmentTerminalWebLinks,
  type TerminalWebLinkLine,
} from "./terminal-links";

const LONG_PRESS_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE = 10;

interface TerminalLinkLayerOptions {
  onOpen(url: string): void;
  onOpenExternal(url: string): void;
  terminal: Terminal;
}

interface TerminalLinkElement {
  button: HTMLButtonElement;
  dispose(): void;
}

interface VisibleLinkSegment {
  endColumn: number;
  key: string;
  row: number;
  startColumn: number;
  url: string;
}

function cellColumnForStringOffset(
  line: IBufferLine,
  offset: number,
  columns: number,
): number {
  if (offset <= 0) return 0;
  let stringOffset = 0;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const width = Math.max(1, cell.getWidth());
    const characters = cell.getChars() || " ";
    const nextOffset = stringOffset + characters.length;
    if (offset <= nextOffset) return Math.min(columns, column + width);
    stringOffset = nextOffset;
    column += width - 1;
  }
  return columns;
}

function visibleLinkSegments(terminal: Terminal): VisibleLinkSegment[] {
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const viewportEnd = Math.min(buffer.length, viewportStart + terminal.rows);
  let scanStart = viewportStart;
  while (scanStart > 0 && buffer.getLine(scanStart)?.isWrapped) scanStart -= 1;
  let scanEnd = viewportEnd;
  while (scanEnd < buffer.length && buffer.getLine(scanEnd)?.isWrapped) {
    scanEnd += 1;
  }

  const result: VisibleLinkSegment[] = [];
  let row = scanStart;
  while (row < scanEnd) {
    const groupStart = row;
    const sourceLines: IBufferLine[] = [];
    do {
      const line = buffer.getLine(row);
      if (!line) break;
      sourceLines.push(line);
      row += 1;
    } while (row < buffer.length && buffer.getLine(row)?.isWrapped);
    if (sourceLines.length === 0) {
      row += 1;
      continue;
    }
    const lines: TerminalWebLinkLine[] = sourceLines.map((line, index) => ({
      row: groupStart + index,
      text: line.translateToString(
        index === sourceLines.length - 1,
        0,
        terminal.cols,
      ),
    }));
    for (const segment of segmentTerminalWebLinks(lines)) {
      if (segment.row < viewportStart || segment.row >= viewportEnd) continue;
      const source = sourceLines[segment.row - groupStart]!;
      const startColumn = cellColumnForStringOffset(
        source,
        segment.startColumn,
        terminal.cols,
      );
      const endColumn = cellColumnForStringOffset(
        source,
        segment.endColumn,
        terminal.cols,
      );
      if (endColumn <= startColumn) continue;
      result.push({
        endColumn,
        key: `${groupStart}:${segment.start}:${segment.end}:${segment.row}:${segment.url}`,
        row: segment.row,
        startColumn,
        url: segment.url,
      });
    }
  }
  return result;
}

function createLinkElement(
  url: string,
  options: Pick<TerminalLinkLayerOptions, "onOpen" | "onOpenExternal">,
): TerminalLinkElement {
  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.className = "cantrip-terminal-link";
  button.setAttribute("aria-label", `Open ${url}`);
  button.title = "Open in Cantrip Browser · Shift-click to open externally";

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = false;
  let pointerStart: { x: number; y: number } | null = null;
  const cancelLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    pointerStart = null;
  };
  const onPointerDown = (event: PointerEvent) => {
    event.stopPropagation();
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    pointerStart = { x: event.clientX, y: event.clientY };
    longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressTriggered = true;
      options.onOpenExternal(url);
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (
      !pointerStart ||
      Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      ) <= LONG_PRESS_MOVE_TOLERANCE
    ) {
      return;
    }
    cancelLongPress();
  };
  const onPointerEnd = (event: PointerEvent) => {
    event.stopPropagation();
    cancelLongPress();
  };
  const onMouseEvent = (event: MouseEvent) => event.stopPropagation();
  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    if (event.shiftKey) options.onOpenExternal(url);
    else options.onOpen(url);
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointermove", onPointerMove);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.addEventListener("mousedown", onMouseEvent);
  button.addEventListener("mouseup", onMouseEvent);
  button.addEventListener("click", onClick);
  button.addEventListener("contextmenu", onContextMenu);

  return {
    button,
    dispose: () => {
      cancelLongPress();
      button.remove();
    },
  };
}

export function installTerminalLinkLayer(
  options: TerminalLinkLayerOptions,
): IDisposable {
  const { terminal } = options;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return { dispose() {} };
  const overlay = document.createElement("div");
  overlay.className = "cantrip-terminal-link-layer";
  screen.appendChild(overlay);

  const elements = new Map<string, TerminalLinkElement>();
  let animationFrame: number | null = null;
  let disposed = false;
  const refresh = () => {
    animationFrame = null;
    if (disposed) return;
    const bounds = screen.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const cellWidth = bounds.width / terminal.cols;
    const cellHeight = bounds.height / terminal.rows;
    const segments = visibleLinkSegments(terminal);
    const active = new Set(segments.map(({ key }) => key));
    for (const [key, element] of elements) {
      if (active.has(key)) continue;
      element.dispose();
      elements.delete(key);
    }
    for (const segment of segments) {
      let element = elements.get(segment.key);
      if (!element) {
        element = createLinkElement(segment.url, options);
        elements.set(segment.key, element);
        overlay.appendChild(element.button);
      }
      element.button.style.left = `${segment.startColumn * cellWidth}px`;
      element.button.style.top = `${(segment.row - terminal.buffer.active.viewportY) * cellHeight}px`;
      element.button.style.width = `${(segment.endColumn - segment.startColumn) * cellWidth}px`;
      element.button.style.height = `${cellHeight}px`;
    }
  };
  const scheduleRefresh = () => {
    if (disposed || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(refresh);
  };
  const render = terminal.onRender(scheduleRefresh);
  const resize = terminal.onResize(scheduleRefresh);
  const scroll = terminal.onScroll(scheduleRefresh);
  const buffer = terminal.buffer.onBufferChange(scheduleRefresh);
  const resizeObserver = new ResizeObserver(scheduleRefresh);
  resizeObserver.observe(screen);
  scheduleRefresh();

  return {
    dispose: () => {
      disposed = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      render.dispose();
      resize.dispose();
      scroll.dispose();
      buffer.dispose();
      resizeObserver.disconnect();
      for (const element of elements.values()) element.dispose();
      elements.clear();
      overlay.remove();
    },
  };
}
