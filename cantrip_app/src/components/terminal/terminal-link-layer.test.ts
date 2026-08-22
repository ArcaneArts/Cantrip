import type { IBuffer, IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";

import { describe, expect, it } from "vitest";

import {
  TerminalLinkScanCache,
  type TerminalLinkDirtyRows,
  type VisibleLinkSegment,
} from "./terminal-link-layer";

interface CellSpec {
  chars: string;
  width: number;
}

interface ScanMetrics {
  cellReads: number;
  translations: number;
}

const testRuntime = globalThis as typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
    memoryUsage?(): { heapUsed: number };
  };
};

function heapUsed(): number {
  return testRuntime.process?.memoryUsage?.().heapUsed ?? 0;
}

interface TerminalFixture {
  metrics: ScanMetrics;
  replaceLine(row: number, line: IBufferLine): void;
  setViewport(viewportY: number): void;
  terminal: Terminal;
}

function cell(chars: string, width = 1): CellSpec {
  return { chars, width };
}

function textCells(text: string): CellSpec[] {
  return Array.from(text, (character) =>
    cell(character, character.codePointAt(0)! > 0xffff ? 2 : 1),
  );
}

function fakeCell(spec: CellSpec): IBufferCell {
  return {
    getChars: () => spec.chars,
    getWidth: () => spec.width,
  } as IBufferCell;
}

function fakeLine(
  sourceCells: readonly CellSpec[],
  columns: number,
  isWrapped: boolean,
  metrics: ScanMetrics,
): IBufferLine {
  const cells: CellSpec[] = [];
  for (const source of sourceCells) {
    if (cells.length >= columns) break;
    cells.push(source);
    for (
      let continuation = 1;
      continuation < source.width && cells.length < columns;
      continuation += 1
    ) {
      cells.push(cell("", 0));
    }
  }
  while (cells.length < columns) cells.push(cell(" "));
  return {
    getCell: (column) => {
      metrics.cellReads += 1;
      const value = cells[column];
      return value ? fakeCell(value) : undefined;
    },
    isWrapped,
    length: columns,
    translateToString: (trimRight, startColumn = 0, endColumn = columns) => {
      metrics.translations += 1;
      let result = "";
      for (let column = startColumn; column < endColumn; column += 1) {
        const value = cells[column];
        if (!value || value.width === 0) continue;
        result += value.chars || " ";
        column += Math.max(1, value.width) - 1;
      }
      return trimRight ? result.trimEnd() : result;
    },
  } as IBufferLine;
}

function terminalFixture(
  lines: IBufferLine[],
  columns: number,
  rows = lines.length,
  metrics: ScanMetrics = { cellReads: 0, translations: 0 },
): TerminalFixture {
  let viewportY = 0;
  const buffer = {
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    get length() {
      return lines.length;
    },
    getLine: (row: number) => lines[row],
    getNullCell: () => fakeCell(cell("")),
    type: "normal",
    get viewportY() {
      return viewportY;
    },
  } as IBuffer;
  return {
    metrics,
    replaceLine: (row, line) => {
      lines[row] = line;
    },
    setViewport: (value) => {
      viewportY = value;
    },
    terminal: {
      buffer: { active: buffer },
      cols: columns,
      rows,
    } as Terminal,
  };
}

function collectSegments(
  cache: TerminalLinkScanCache,
  terminal: Terminal,
  dirtyRows: TerminalLinkDirtyRows | null = null,
): VisibleLinkSegment[] {
  const segments: VisibleLinkSegment[] = [];
  cache.visitVisible(terminal, dirtyRows, (segment) => segments.push(segment));
  return segments;
}

describe("TerminalLinkScanCache", () => {
  it("reuses unchanged URL-free rows and reparses only dirty rows", () => {
    const metrics: ScanMetrics = { cellReads: 0, translations: 0 };
    const columns = 80;
    const lines = Array.from({ length: 40 }, (_, row) =>
      fakeLine(textCells(`build output ${row}`), columns, false, metrics),
    );
    const fixture = terminalFixture(lines, columns, lines.length, metrics);
    const cache = new TerminalLinkScanCache();

    expect(collectSegments(cache, fixture.terminal)).toEqual([]);
    expect(metrics).toEqual({ cellReads: 0, translations: 40 });

    expect(collectSegments(cache, fixture.terminal)).toEqual([]);
    expect(metrics).toEqual({ cellReads: 0, translations: 40 });

    expect(
      collectSegments(cache, fixture.terminal, { end: 17, start: 17 }),
    ).toEqual([]);
    expect(metrics).toEqual({ cellReads: 0, translations: 41 });
  });

  it("maps wrapped Unicode string offsets to terminal cell columns", () => {
    const metrics: ScanMetrics = { cellReads: 0, translations: 0 };
    const columns = 16;
    const first = fakeLine(
      [cell("界", 2), cell("é"), cell(" "), ...textCells("https://exam")],
      columns,
      false,
      metrics,
    );
    const second = fakeLine(
      [...textCells("ple.com/"), cell("🙂", 2)],
      columns,
      true,
      metrics,
    );
    const fixture = terminalFixture([first, second], columns, 2, metrics);
    const cache = new TerminalLinkScanCache();

    const expected = [
      expect.objectContaining({
        endColumn: 16,
        row: 0,
        startColumn: 4,
        url: "https://example.com/🙂",
      }),
      expect.objectContaining({
        endColumn: 10,
        row: 1,
        startColumn: 0,
        url: "https://example.com/🙂",
      }),
    ];
    expect(collectSegments(cache, fixture.terminal)).toEqual(expected);
    const afterFirstScan = { ...metrics };

    expect(collectSegments(cache, fixture.terminal)).toEqual(expected);
    expect(metrics).toEqual(afterFirstScan);

    expect(
      collectSegments(cache, fixture.terminal, { end: 1, start: 1 }),
    ).toEqual(expected);
    expect(metrics.translations - afterFirstScan.translations).toBe(2);
  });

  it("invalidates a cached group when xterm replaces a buffer line", () => {
    const metrics: ScanMetrics = { cellReads: 0, translations: 0 };
    const columns = 40;
    const initial = fakeLine(
      textCells("https://old.example/path"),
      columns,
      false,
      metrics,
    );
    const lines = [initial];
    const fixture = terminalFixture(lines, columns, lines.length, metrics);
    const cache = new TerminalLinkScanCache();

    expect(collectSegments(cache, fixture.terminal)[0]?.url).toBe(
      "https://old.example/path",
    );
    fixture.replaceLine(
      0,
      fakeLine(textCells("https://new.example/path"), columns, false, metrics),
    );

    expect(collectSegments(cache, fixture.terminal)[0]?.url).toBe(
      "https://new.example/path",
    );
  });

  it("retains overlapping cached rows while the viewport scrolls", () => {
    const metrics: ScanMetrics = { cellReads: 0, translations: 0 };
    const columns = 40;
    const lines = Array.from({ length: 4 }, (_, row) =>
      fakeLine(
        textCells(`https://example.com/${row}`),
        columns,
        false,
        metrics,
      ),
    );
    const fixture = terminalFixture(lines, columns, 2, metrics);
    const cache = new TerminalLinkScanCache();

    expect(
      collectSegments(cache, fixture.terminal).map(({ row }) => row),
    ).toEqual([0, 1]);
    expect(metrics.translations).toBe(2);

    fixture.setViewport(1);
    expect(
      collectSegments(cache, fixture.terminal).map(({ row }) => row),
    ).toEqual([1, 2]);
    expect(metrics.translations).toBe(3);
  });
});

interface BenchmarkResult {
  cellReads: number;
  frameBudgetMisses: number;
  heapDeltaBytes: number;
  mainThreadMs: number;
  medianRefreshMs: number;
  p95InteractionLatencyMs: number;
  segmentCount: number;
  translations: number;
}

type BenchmarkKind = "url-free" | "url-heavy" | "wrapped-unicode";

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
  ]!;
}

function benchmarkRefreshes(
  kind: BenchmarkKind,
  fixture: TerminalFixture,
  cache: TerminalLinkScanCache,
  clearEveryRefresh: boolean,
): BenchmarkResult {
  const warmups = 5;
  const iterations = 25;
  const prepare = (iteration: number) => {
    const row = iteration % fixture.terminal.rows;
    fixture.replaceLine(
      row,
      benchmarkLine(
        kind,
        row,
        iteration,
        fixture.terminal.cols,
        fixture.metrics,
      ),
    );
  };
  const refresh = (iteration: number) => {
    const row = iteration % fixture.terminal.rows;
    if (clearEveryRefresh) cache.clear();
    return collectSegments(cache, fixture.terminal, { end: row, start: row });
  };
  for (let index = 0; index < warmups; index += 1) {
    prepare(index);
    refresh(index);
  }
  fixture.metrics.cellReads = 0;
  fixture.metrics.translations = 0;
  const startingHeapBytes = heapUsed();
  const durations: number[] = [];
  let segmentCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    prepare(index + warmups);
    const startedAt = performance.now();
    segmentCount = refresh(index + warmups).length;
    durations.push(performance.now() - startedAt);
  }
  return {
    cellReads: fixture.metrics.cellReads,
    frameBudgetMisses: durations.filter((duration) => duration > 16.67).length,
    heapDeltaBytes: heapUsed() - startingHeapBytes,
    mainThreadMs: durations.reduce((sum, duration) => sum + duration, 0),
    medianRefreshMs: percentile(durations, 0.5),
    p95InteractionLatencyMs: percentile(durations, 0.95),
    segmentCount,
    translations: fixture.metrics.translations,
  };
}

function benchmarkLine(
  kind: BenchmarkKind,
  row: number,
  iteration: number,
  columns: number,
  metrics: ScanMetrics,
): IBufferLine {
  if (kind === "wrapped-unicode") {
    const urlStart = `https://example.com/${row}/chunk-${iteration}-`;
    const urlPadding = "a".repeat(Math.max(0, columns - 4 - urlStart.length));
    return row % 2 === 0
      ? fakeLine(
          [
            cell("界", 2),
            cell("é"),
            cell(" "),
            ...textCells(`${urlStart}${urlPadding}`),
          ],
          columns,
          false,
          metrics,
        )
      : fakeLine(
          [...textCells(`ation-${row}/`), cell("🙂", 2)],
          columns,
          true,
          metrics,
        );
  }
  const text =
    kind === "url-heavy"
      ? `界é https://example.com/${row}/${iteration}/alpha https://cantrip.dev/${row}/beta`
      : `界é build output row ${row} chunk ${iteration} completed without a link`;
  return fakeLine(textCells(text), columns, false, metrics);
}

function benchmarkFixture(kind: BenchmarkKind): TerminalFixture {
  const metrics: ScanMetrics = { cellReads: 0, translations: 0 };
  const columns = kind === "wrapped-unicode" ? 80 : 180;
  const lines = Array.from({ length: 120 }, (_, row) =>
    benchmarkLine(kind, row, 0, columns, metrics),
  );
  return terminalFixture(lines, columns, lines.length, metrics);
}

it.skipIf(testRuntime.process?.env?.CANTRIP_BENCHMARK_TERMINAL_LINKS !== "1")(
  "benchmarks incremental URL-heavy, URL-free, and wrapped-Unicode renders",
  () => {
    const results: Record<
      string,
      { baseline: BenchmarkResult; incremental: BenchmarkResult }
    > = {};
    for (const kind of ["url-free", "url-heavy", "wrapped-unicode"] as const) {
      const baselineFixture = benchmarkFixture(kind);
      const incrementalFixture = benchmarkFixture(kind);
      const baseline = benchmarkRefreshes(
        kind,
        baselineFixture,
        new TerminalLinkScanCache(),
        true,
      );
      const incremental = benchmarkRefreshes(
        kind,
        incrementalFixture,
        new TerminalLinkScanCache(),
        false,
      );

      expect(incremental.segmentCount).toBe(baseline.segmentCount);
      expect(incremental.translations).toBeLessThan(baseline.translations / 10);
      expect(incremental.cellReads).toBeLessThanOrEqual(baseline.cellReads);
      expect(incremental.medianRefreshMs).toBeLessThan(
        baseline.medianRefreshMs * 0.95,
      );
      results[kind] = { baseline, incremental };
    }

    console.info("terminal link overlay benchmark", results);
  },
);
