import type { Terminal } from "@xterm/xterm";

import {
  ELITE_CHROMATIC_PAIRS,
  normalizeEliteRevealConfig,
  type EliteRevealConfig,
} from "@cantrip/glitch";

import "./terminal-content-glitch.css";

export interface TerminalViewportSnapshot {
  bufferType: "alternate" | "normal";
  columns: number;
  rows: readonly (readonly string[])[];
  viewportY: number;
}

export interface TerminalChangedSpan {
  endColumn: number;
  row: number;
  startColumn: number;
  text: string;
}

interface TerminalContentGlitchOptions {
  config(): EliteRevealConfig;
  enabled(): boolean;
}

export interface TerminalContentGlitchRenderer {
  afterWrite(): void;
  beforeWrite(): void;
  clear(): void;
  dispose(): void;
}

const TERMINAL_GLITCH_LAYER_CLASS = "terminal-content-glitch-layer";
const TERMINAL_GLITCH_FRAGMENT_CLASS = "terminal-content-glitch-fragment";
const MAX_TERMINAL_GLITCH_FRAGMENTS = 256;

function cellCharacter(
  line: ReturnType<Terminal["buffer"]["active"]["getLine"]>,
  column: number,
): string {
  const cell = line?.getCell(column);
  if (!cell) return " ";
  const characters = cell.getChars();
  if (characters) return characters;
  return cell.getWidth() === 0 ? "" : " ";
}

export function captureTerminalViewport(
  terminal: Terminal,
): TerminalViewportSnapshot {
  const buffer = terminal.buffer.active;
  return {
    bufferType: buffer.type,
    columns: terminal.cols,
    rows: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: terminal.cols }, (_, column) =>
        cellCharacter(line, column),
      );
    }),
    viewportY: buffer.viewportY,
  };
}

function rowsMatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((character, index) => character === right[index]);
}

function rowHasText(row: readonly string[]): boolean {
  return row.some((character) => character !== "" && character !== " ");
}

function rowAlignmentScore(
  before: TerminalViewportSnapshot,
  after: TerminalViewportSnapshot,
  offset: number,
): number {
  return after.rows.reduce((score, row, afterRow) => {
    if (!rowsMatch(before.rows[afterRow + offset], row)) return score;
    return score + (rowHasText(row) ? 4 : 0.1);
  }, 0);
}

/**
 * Maps an after-snapshot row to the same visual content in the before
 * snapshot. The viewport delta handles normal scrollback growth. Content
 * matching covers the point where a full scrollback buffer starts evicting
 * old rows and its absolute viewport offset no longer advances.
 */
export function terminalRowAlignmentOffset(
  before: TerminalViewportSnapshot,
  after: TerminalViewportSnapshot,
): number {
  const rowCount = Math.min(before.rows.length, after.rows.length);
  if (rowCount === 0) return 0;
  const viewportOffset = after.viewportY - before.viewportY;
  const hintedOffset = Math.abs(viewportOffset) < rowCount ? viewportOffset : 0;
  let bestOffset = hintedOffset;
  let bestScore = rowAlignmentScore(before, after, hintedOffset);

  for (let offset = -(rowCount - 1); offset < rowCount; offset += 1) {
    if (offset === hintedOffset) continue;
    const score = rowAlignmentScore(before, after, offset);
    if (
      score > bestScore + 2 ||
      (score === bestScore &&
        Math.abs(offset - viewportOffset) <
          Math.abs(bestOffset - viewportOffset))
    ) {
      bestOffset = offset;
      bestScore = score;
    }
  }
  return bestOffset;
}

function glitchCharacter(
  before: string | undefined,
  after: string | undefined,
): string {
  if (after === "") return "";
  if (after && after !== " ") return after;
  if (before === "") return "";
  return before && before !== " " ? before : " ";
}

export function terminalChangedSpans(
  before: TerminalViewportSnapshot,
  after: TerminalViewportSnapshot,
): readonly TerminalChangedSpan[] {
  if (
    before.bufferType !== after.bufferType ||
    before.columns !== after.columns ||
    before.rows.length !== after.rows.length
  ) {
    return [];
  }
  // A write that replaces the entire viewport through scrolling should not
  // flash the screen. A later write will still animate edits in the settled
  // viewport.
  if (Math.abs(after.viewportY - before.viewportY) >= after.rows.length) {
    return [];
  }

  const offset = terminalRowAlignmentOffset(before, after);
  const blankRow = Array.from({ length: after.columns }, () => " ");
  const changes: TerminalChangedSpan[] = [];

  after.rows.forEach((afterRow, row) => {
    const beforeRow = before.rows[row + offset] ?? blankRow;
    let column = 0;
    while (column < after.columns) {
      if (beforeRow[column] === afterRow[column]) {
        column += 1;
        continue;
      }
      const startColumn = column;
      while (column < after.columns && beforeRow[column] !== afterRow[column]) {
        column += 1;
      }
      const text = Array.from({ length: column - startColumn }, (_, index) =>
        glitchCharacter(
          beforeRow[startColumn + index],
          afterRow[startColumn + index],
        ),
      ).join("");
      if (text.trim()) {
        changes.push({
          endColumn: column,
          row,
          startColumn,
          text,
        });
      }
    }
  });
  return changes;
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

function randomSignedDistance(minimum: number, maximum: number): number {
  return randomBetween(minimum, maximum) * (Math.random() < 0.5 ? -1 : 1);
}

function splitPolygons(): { lower: string; upper: string } {
  const split = randomBetween(24, 76);
  const slope = randomBetween(-18, 18);
  const left = Math.max(4, Math.min(96, split - slope));
  const right = Math.max(4, Math.min(96, split + slope));
  return {
    lower: `polygon(0 ${left}%, 100% ${right}%, 100% 100%, 0 100%)`,
    upper: `polygon(0 0, 100% 0, 100% ${right}%, 0 ${left}%)`,
  };
}

function randomGlitchCount(config: EliteRevealConfig): number {
  const range = config.glitchCountMax - config.glitchCountMin + 1;
  return config.glitchCountMin + Math.floor(Math.random() * range);
}

function removeFragment(
  fragment: HTMLElement,
  timer: number,
  timers: Set<number>,
): void {
  window.clearTimeout(timer);
  timers.delete(timer);
  fragment.remove();
}

export function createTerminalContentGlitchRenderer(
  terminal: Terminal,
  options: TerminalContentGlitchOptions,
): TerminalContentGlitchRenderer {
  let beforeSnapshot: TerminalViewportSnapshot | null = null;
  let renderFrame: number | null = null;
  let disposed = false;
  let layer: HTMLElement | null = null;
  const fragmentTimers = new Set<number>();

  const clearFragments = () => {
    fragmentTimers.forEach((timer) => window.clearTimeout(timer));
    fragmentTimers.clear();
    layer?.replaceChildren();
  };
  const ensureLayer = (): HTMLElement | null => {
    const screen =
      terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    if (layer?.parentElement === screen) return layer;
    layer?.remove();
    layer = document.createElement("div");
    layer.className = TERMINAL_GLITCH_LAYER_CLASS;
    layer.dataset.eliteIgnore = "";
    layer.setAttribute("aria-hidden", "true");
    screen.append(layer);
    return layer;
  };
  const renderChanges = (
    before: TerminalViewportSnapshot,
    after: TerminalViewportSnapshot,
  ) => {
    if (!options.enabled() || disposed) return;
    const changes = terminalChangedSpans(before, after).slice(
      0,
      MAX_TERMINAL_GLITCH_FRAGMENTS,
    );
    if (!changes.length) return;
    const target = ensureLayer();
    const screen = target?.parentElement;
    const rowContainer = screen?.querySelector<HTMLElement>(".xterm-rows");
    if (!target || !screen || !rowContainer) return;

    const screenRect = screen.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) return;
    const cellWidth = screenRect.width / after.columns;
    const cellHeight = screenRect.height / after.rows.length;
    const rowStyle = window.getComputedStyle(rowContainer);
    target.style.fontFamily = rowStyle.fontFamily;
    target.style.fontKerning = "none";
    target.style.fontSize = rowStyle.fontSize;
    target.style.fontWeight = rowStyle.fontWeight;
    target.style.letterSpacing = rowStyle.letterSpacing;

    const config = normalizeEliteRevealConfig(options.config());
    const fragmentContainer = document.createDocumentFragment();
    changes.forEach((change) => {
      const fragment = document.createElement("span");
      const colors =
        ELITE_CHROMATIC_PAIRS[
          Math.floor(Math.random() * ELITE_CHROMATIC_PAIRS.length)
        ] ?? ELITE_CHROMATIC_PAIRS[0];
      const polygons = splitPolygons();
      const glitchCount = randomGlitchCount(config);
      const duration = Math.max(32, glitchCount * config.glitchShowMs);
      fragment.className = TERMINAL_GLITCH_FRAGMENT_CLASS;
      fragment.dataset.text = change.text;
      fragment.textContent = change.text;
      fragment.style.height = `${cellHeight}px`;
      fragment.style.left = `${change.startColumn * cellWidth}px`;
      fragment.style.lineHeight = `${cellHeight}px`;
      fragment.style.top = `${change.row * cellHeight}px`;
      fragment.style.width = `${(change.endColumn - change.startColumn) * cellWidth}px`;
      fragment.style.setProperty(
        "--terminal-glitch-channel-a",
        colors.channelA,
      );
      fragment.style.setProperty(
        "--terminal-glitch-channel-b",
        colors.channelB,
      );
      fragment.style.setProperty("--terminal-glitch-duration", `${duration}ms`);
      fragment.style.setProperty(
        "--terminal-glitch-lower-clip",
        polygons.lower,
      );
      fragment.style.setProperty(
        "--terminal-glitch-upper-clip",
        polygons.upper,
      );
      fragment.style.setProperty(
        "--terminal-glitch-x-a",
        `${randomSignedDistance(0.7, 2.4)}px`,
      );
      fragment.style.setProperty(
        "--terminal-glitch-x-b",
        `${randomSignedDistance(0.7, 2.4)}px`,
      );
      fragment.style.setProperty(
        "--terminal-glitch-y-a",
        `${randomSignedDistance(0.2, 1.2)}px`,
      );
      fragment.style.setProperty(
        "--terminal-glitch-y-b",
        `${randomSignedDistance(0.2, 1.2)}px`,
      );
      const timer = window.setTimeout(
        () => removeFragment(fragment, timer, fragmentTimers),
        duration + 80,
      );
      fragmentTimers.add(timer);
      fragment.addEventListener(
        "animationend",
        () => removeFragment(fragment, timer, fragmentTimers),
        { once: true },
      );
      fragmentContainer.append(fragment);
    });
    target.append(fragmentContainer);
  };
  const flush = () => {
    renderFrame = null;
    const before = beforeSnapshot;
    beforeSnapshot = null;
    if (!before || disposed || !options.enabled()) return;
    renderChanges(before, captureTerminalViewport(terminal));
  };

  return {
    afterWrite() {
      if (!beforeSnapshot || renderFrame !== null || disposed) return;
      renderFrame = window.requestAnimationFrame(flush);
    },
    beforeWrite() {
      if (disposed || !options.enabled() || beforeSnapshot) return;
      beforeSnapshot = captureTerminalViewport(terminal);
    },
    clear() {
      beforeSnapshot = null;
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
      renderFrame = null;
      clearFragments();
    },
    dispose() {
      disposed = true;
      beforeSnapshot = null;
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
      renderFrame = null;
      clearFragments();
      layer?.remove();
      layer = null;
    },
  };
}
