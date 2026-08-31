import type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  IDisposable,
  Terminal,
} from "@xterm/xterm";

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
  height: number;
  left: number;
  seenGeneration: number;
  top: number;
  width: number;
}

export interface TerminalLinkLayer extends IDisposable {
  refresh(): void;
}

export interface VisibleLinkSegment {
  endColumn: number;
  key: string;
  row: number;
  startColumn: number;
  url: string;
}

export interface TerminalLinkDirtyRows {
  end: number;
  start: number;
}

interface CachedLinkGroup {
  endRow: number;
  rawSegments: ReturnType<typeof segmentTerminalWebLinks>;
  seenGeneration: number;
  segments: VisibleLinkSegment[];
  sourceLines: IBufferLine[];
  texts: string[];
}

function stringOffsetColumns(
  line: IBufferLine,
  textLength: number,
  columns: number,
  reusableCell: IBufferCell,
): Uint32Array {
  const result = new Uint32Array(textLength + 1);
  let stringOffset = 0;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column, reusableCell);
    if (!cell || cell.getWidth() === 0) continue;
    const width = Math.max(1, cell.getWidth());
    const characters = cell.getChars() || " ";
    const nextOffset = Math.min(textLength, stringOffset + characters.length);
    const endColumn = Math.min(columns, column + width);
    result.fill(endColumn, stringOffset + 1, nextOffset + 1);
    stringOffset = nextOffset;
    if (stringOffset >= textLength) break;
    column += width - 1;
  }
  if (stringOffset < textLength) result.fill(columns, stringOffset + 1);
  return result;
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function groupIntersectsDirtyRows(
  groupStart: number,
  groupEnd: number,
  dirtyRows: TerminalLinkDirtyRows | null,
): boolean {
  return Boolean(
    dirtyRows && dirtyRows.start < groupEnd && dirtyRows.end >= groupStart,
  );
}

function sourceLinesMatch(
  buffer: IBuffer,
  groupStart: number,
  groupEnd: number,
  cached: CachedLinkGroup,
): boolean {
  if (cached.endRow !== groupEnd) return false;
  for (let row = groupStart; row < groupEnd; row += 1) {
    if (buffer.getLine(row) !== cached.sourceLines[row - groupStart]) {
      return false;
    }
  }
  return true;
}

function parseLinkGroup(
  buffer: IBuffer,
  columns: number,
  groupStart: number,
  groupEnd: number,
  previous: CachedLinkGroup | undefined,
  reusableCell: IBufferCell,
): CachedLinkGroup | undefined {
  const sourceLines: IBufferLine[] = [];
  const lines: TerminalWebLinkLine[] = [];
  for (let row = groupStart; row < groupEnd; row += 1) {
    const line = buffer.getLine(row);
    if (!line) return undefined;
    sourceLines.push(line);
    lines.push({
      row,
      text: line.translateToString(row === groupEnd - 1, 0, columns),
    });
  }
  const texts = lines.map(({ text }) => text);
  const rawSegments =
    previous && sameTexts(previous.texts, texts)
      ? previous.rawSegments
      : segmentTerminalWebLinks(lines);
  const offsetMaps: Array<Uint32Array | undefined> = new Array(lines.length);
  const segments: VisibleLinkSegment[] = [];
  for (const segment of rawSegments) {
    const lineIndex = segment.row - groupStart;
    const source = sourceLines[lineIndex];
    const text = texts[lineIndex];
    if (!source || text === undefined) continue;
    const offsets =
      offsetMaps[lineIndex] ??
      (offsetMaps[lineIndex] = stringOffsetColumns(
        source,
        text.length,
        columns,
        reusableCell,
      ));
    const startColumn = offsets[segment.startColumn] ?? columns;
    const endColumn = offsets[segment.endColumn] ?? columns;
    if (endColumn <= startColumn) continue;
    segments.push({
      endColumn,
      key: `${groupStart}:${segment.start}:${segment.end}:${segment.row}:${segment.url}`,
      row: segment.row,
      startColumn,
      url: segment.url,
    });
  }
  return {
    endRow: groupEnd,
    rawSegments,
    seenGeneration: 0,
    segments,
    sourceLines,
    texts,
  };
}

export class TerminalLinkScanCache {
  readonly #groups = new Map<number, CachedLinkGroup>();
  #buffer: IBuffer | null = null;
  #columns = -1;
  #generation = 0;

  clear(): void {
    this.#buffer = null;
    this.#columns = -1;
    this.#groups.clear();
  }

  visitVisible(
    terminal: Terminal,
    dirtyRows: TerminalLinkDirtyRows | null,
    visitor: (segment: VisibleLinkSegment) => void,
  ): void {
    const buffer = terminal.buffer.active;
    if (this.#buffer !== buffer || this.#columns !== terminal.cols) {
      this.clear();
      this.#buffer = buffer;
      this.#columns = terminal.cols;
    }
    this.#generation += 1;
    const generation = this.#generation;
    const viewportStart = buffer.viewportY;
    const viewportEnd = Math.min(buffer.length, viewportStart + terminal.rows);
    let scanStart = viewportStart;
    while (scanStart > 0 && buffer.getLine(scanStart)?.isWrapped) {
      scanStart -= 1;
    }
    let scanEnd = viewportEnd;
    while (scanEnd < buffer.length && buffer.getLine(scanEnd)?.isWrapped) {
      scanEnd += 1;
    }

    let reusableCell: IBufferCell | null = null;
    let groupStart = scanStart;
    while (groupStart < scanEnd) {
      if (!buffer.getLine(groupStart)) {
        groupStart += 1;
        continue;
      }
      let groupEnd = groupStart + 1;
      while (groupEnd < buffer.length && buffer.getLine(groupEnd)?.isWrapped) {
        groupEnd += 1;
      }
      const previous = this.#groups.get(groupStart);
      const dirty = groupIntersectsDirtyRows(groupStart, groupEnd, dirtyRows);
      let cached =
        previous &&
        !dirty &&
        sourceLinesMatch(buffer, groupStart, groupEnd, previous)
          ? previous
          : undefined;
      if (!cached) {
        reusableCell ??= buffer.getNullCell();
        cached = parseLinkGroup(
          buffer,
          terminal.cols,
          groupStart,
          groupEnd,
          previous,
          reusableCell,
        );
        if (!cached) {
          this.#groups.delete(groupStart);
          groupStart = groupEnd;
          continue;
        }
        this.#groups.set(groupStart, cached);
      }
      cached.seenGeneration = generation;
      for (const segment of cached.segments) {
        if (segment.row >= viewportStart && segment.row < viewportEnd) {
          visitor(segment);
        }
      }
      groupStart = groupEnd;
    }
    for (const [start, cached] of this.#groups) {
      if (cached.seenGeneration !== generation) this.#groups.delete(start);
    }
  }
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
    height: Number.NaN,
    left: Number.NaN,
    seenGeneration: 0,
    top: Number.NaN,
    width: Number.NaN,
  };
}

function updateLinkElementLayout(
  element: TerminalLinkElement,
  layout: { height: number; left: number; top: number; width: number },
): void {
  if (element.left !== layout.left) {
    element.left = layout.left;
    element.button.style.left = `${layout.left}px`;
  }
  if (element.top !== layout.top) {
    element.top = layout.top;
    element.button.style.top = `${layout.top}px`;
  }
  if (element.width !== layout.width) {
    element.width = layout.width;
    element.button.style.width = `${layout.width}px`;
  }
  if (element.height !== layout.height) {
    element.height = layout.height;
    element.button.style.height = `${layout.height}px`;
  }
}

export function installTerminalLinkLayer(
  options: TerminalLinkLayerOptions,
): TerminalLinkLayer {
  const { terminal } = options;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return { dispose() {}, refresh() {} };
  const overlay = document.createElement("div");
  overlay.className = "cantrip-terminal-link-layer";
  screen.appendChild(overlay);

  const elements = new Map<string, TerminalLinkElement>();
  const scanCache = new TerminalLinkScanCache();
  let animationFrame: number | null = null;
  let cellHeight = 0;
  let cellWidth = 0;
  let dirtyRows: TerminalLinkDirtyRows | null = null;
  let disposed = false;
  let elementGeneration = 0;
  let geometryDirty = true;
  let renderedBaseY = -1;
  let renderedBufferLength = -1;
  let renderedViewportY = -1;
  const refresh = () => {
    animationFrame = null;
    if (disposed) return;
    if (geometryDirty) {
      const bounds = screen.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      cellWidth = bounds.width / terminal.cols;
      cellHeight = bounds.height / terminal.rows;
      geometryDirty = false;
    }
    const buffer = terminal.buffer.active;
    const viewportY = buffer.viewportY;
    elementGeneration += 1;
    const generation = elementGeneration;
    scanCache.visitVisible(terminal, dirtyRows, (segment) => {
      let element = elements.get(segment.key);
      if (!element) {
        element = createLinkElement(segment.url, options);
        elements.set(segment.key, element);
        overlay.appendChild(element.button);
      }
      element.seenGeneration = generation;
      updateLinkElementLayout(element, {
        height: cellHeight,
        left: segment.startColumn * cellWidth,
        top: (segment.row - viewportY) * cellHeight,
        width: (segment.endColumn - segment.startColumn) * cellWidth,
      });
    });
    dirtyRows = null;
    for (const [key, element] of elements) {
      if (element.seenGeneration === generation) continue;
      element.dispose();
      elements.delete(key);
    }
    renderedBaseY = buffer.baseY;
    renderedBufferLength = buffer.length;
    renderedViewportY = viewportY;
  };
  const scheduleRefresh = () => {
    if (disposed || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(refresh);
  };
  const render = terminal.onRender(({ end, start }) => {
    const active = terminal.buffer.active;
    const pureViewportScroll =
      renderedViewportY >= 0 &&
      start === 0 &&
      active.viewportY !== renderedViewportY &&
      active.baseY === renderedBaseY &&
      active.length === renderedBufferLength;
    if (!pureViewportScroll) {
      const absoluteStart = active.viewportY + start;
      const absoluteEnd = active.viewportY + end;
      dirtyRows = dirtyRows
        ? {
            end: Math.max(dirtyRows.end, absoluteEnd),
            start: Math.min(dirtyRows.start, absoluteStart),
          }
        : { end: absoluteEnd, start: absoluteStart };
    }
    scheduleRefresh();
  });
  const resize = terminal.onResize(() => {
    geometryDirty = true;
    dirtyRows = null;
    scanCache.clear();
    scheduleRefresh();
  });
  const scroll = terminal.onScroll(scheduleRefresh);
  const buffer = terminal.buffer.onBufferChange(() => {
    dirtyRows = null;
    scanCache.clear();
    scheduleRefresh();
  });
  const resizeObserver = new ResizeObserver(() => {
    geometryDirty = true;
    scheduleRefresh();
  });
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
    refresh: () => {
      geometryDirty = true;
      dirtyRows = null;
      scanCache.clear();
      scheduleRefresh();
    },
  };
}
