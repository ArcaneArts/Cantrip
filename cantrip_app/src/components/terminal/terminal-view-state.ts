import type { Terminal } from "@xterm/xterm";
import {
  captureTerminalAnchor,
  resolveTerminalAnchor,
  terminalLogicalLines,
  type TerminalViewAnchor,
} from "./terminal-view-anchors";
export interface TerminalViewState {
  version: 1;
  terminalId: string;
  workerId: string;
  buffer: "normal" | "alternate";
  cols: number;
  /** Absent only in snapshots produced before row-preserving handoff. */
  rows?: number;
  viewportY: number;
  followingOutput: boolean;
  anchors?: {
    viewport: TerminalViewAnchor | null;
    start: TerminalViewAnchor | null;
    end: TerminalViewAnchor | null;
  };
  selection: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null;
}
const invalid = (): never => {
  throw new Error("Invalid terminal view state.");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();
}
export function parseTerminalViewState(value: unknown): TerminalViewState {
  const state = object(value);
  if (
    state.version !== 1 ||
    typeof state.terminalId !== "string" ||
    !state.terminalId ||
    typeof state.workerId !== "string" ||
    !state.workerId ||
    (state.buffer !== "normal" && state.buffer !== "alternate") ||
    typeof state.followingOutput !== "boolean"
  )
    return invalid();
  const cols = integer(state.cols);
  if (!cols) return invalid();
  const rows = state.rows === undefined ? undefined : integer(state.rows);
  if (rows === 0) return invalid();
  const position = (value: unknown) => {
    const p = object(value);
    return { x: integer(p.x), y: integer(p.y) };
  };
  const range = state.selection === null ? null : object(state.selection);
  const selection = range
    ? { start: position(range.start), end: position(range.end) }
    : null;
  if (
    selection &&
    (selection.start.x >= cols ||
      selection.end.x > cols ||
      selection.end.y < selection.start.y ||
      (selection.end.y === selection.start.y &&
        selection.end.x < selection.start.x))
  )
    return invalid();
  const anchor = (value: unknown): TerminalViewAnchor | null => {
    if (value === null) return null;
    const a = object(value);
    if (typeof a.text !== "string") return invalid();
    const occurrences =
      a.occurrences === undefined ? undefined : integer(a.occurrences);
    if (occurrences === 0) return invalid();
    const context = (value: unknown) => {
      const c = object(value);
      const distance = integer(c.distance);
      if (typeof c.text !== "string" || distance === 0) return invalid();
      return { text: c.text, distance };
    };
    return {
      text: a.text,
      offset: integer(a.offset),
      ...(occurrences === undefined ? {} : { occurrences }),
      ...(a.before === undefined ? {} : { before: context(a.before) }),
      ...(a.after === undefined ? {} : { after: context(a.after) }),
    };
  };
  const rawAnchors = state.anchors === undefined ? null : object(state.anchors);
  const anchors = rawAnchors
    ? {
        viewport: anchor(rawAnchors.viewport),
        start: anchor(rawAnchors.start),
        end: anchor(rawAnchors.end),
      }
    : undefined;
  if (
    anchors &&
    ((!state.followingOutput && !anchors.viewport) ||
      (selection && (!anchors.start || !anchors.end)))
  )
    return invalid();
  return {
    version: 1,
    terminalId: state.terminalId,
    workerId: state.workerId,
    buffer: state.buffer,
    cols,
    ...(rows === undefined ? {} : { rows }),
    viewportY: integer(state.viewportY),
    followingOutput: state.followingOutput,
    selection,
    ...(anchors ? { anchors } : {}),
  };
}
type View = Pick<
  Terminal,
  | "buffer"
  | "cols"
  | "rows"
  | "getSelectionPosition"
  | "scrollToBottom"
  | "scrollToLine"
  | "select"
  | "clearSelection"
>;

export function captureTerminalViewState(
  view: View,
  terminalId: string,
  workerId: string,
): TerminalViewState {
  const buffer = view.buffer.active;
  const selection = view.getSelectionPosition() ?? null;
  const followingOutput = buffer.viewportY === buffer.baseY;
  const lines =
    !followingOutput || selection ? terminalLogicalLines(buffer) : [];
  return parseTerminalViewState({
    version: 1,
    terminalId,
    workerId,
    buffer: buffer.type,
    cols: view.cols,
    rows: view.rows,
    viewportY: buffer.viewportY,
    followingOutput,
    selection,
    anchors: {
      viewport: followingOutput
        ? null
        : captureTerminalAnchor(lines, { x: 0, y: buffer.viewportY }),
      start: selection ? captureTerminalAnchor(lines, selection.start) : null,
      end: selection ? captureTerminalAnchor(lines, selection.end) : null,
    },
  });
}

/** Restore only after canonical worker hydration. Buffer contents remain worker-owned. */
export function restoreTerminalViewState(
  view: View,
  input: unknown,
  terminalId: string,
  workerId: string,
): void {
  const state = parseTerminalViewState(input);
  if (state.terminalId !== terminalId || state.workerId !== workerId)
    throw new Error("Terminal view state belongs to another session.");
  const buffer = view.buffer.active;
  if (state.buffer !== buffer.type)
    throw new Error("Terminal buffer changed while transferring its view.");
  const lines =
    state.anchors && (!state.followingOutput || state.selection)
      ? terminalLogicalLines(buffer)
      : [];
  const range =
    state.selection && state.anchors
      ? {
          start: resolveTerminalAnchor(lines, state.anchors.start!),
          end: resolveTerminalAnchor(lines, state.anchors.end!),
        }
      : state.selection;
  const viewportY = state.anchors?.viewport
    ? resolveTerminalAnchor(lines, state.anchors.viewport).y
    : state.viewportY;
  // Physical cell ranges cannot be interpreted after a column reflow. Do not
  // select unrelated output; coordinate reflow needs logical-line anchors.
  if (
    range &&
    ((!state.anchors && view.cols !== state.cols) ||
      range.end.y >= buffer.length)
  )
    throw new Error("Terminal selection needs remapping after buffer reflow.");
  const length = range
    ? (range.end.y - range.start.y) * view.cols + range.end.x - range.start.x
    : 0;
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error("Terminal selection is too large.");
  // Validate the complete restore before changing any destination view state.
  // A failed handoff must not clear an existing selection or move its viewport.
  if (state.followingOutput) view.scrollToBottom();
  else view.scrollToLine(Math.min(viewportY, buffer.baseY));
  view.clearSelection();
  if (range && length > 0) view.select(range.start.x, range.start.y, length);
}
