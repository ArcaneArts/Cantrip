import type {
  ProjectTokenUsage,
  ProjectTokenUsageBreakdown,
  ProjectTokenUsageDay,
} from "@cantrip/protocol";

export const tokenChartColors = [
  "hsl(188 86% 53%)",
  "hsl(264 83% 70%)",
  "hsl(151 64% 52%)",
  "hsl(38 92% 58%)",
  "hsl(348 83% 66%)",
  "hsl(215 20% 55%)",
] as const;

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return new Intl.NumberFormat().format(tokens);
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];
  const unit = units.find(({ threshold }) => tokens >= threshold)!;
  const value = tokens / unit.threshold;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))}${unit.suffix}`;
}

export function tokenUsageIntensity(tokens: number, maximum: number): number {
  if (tokens <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tokens / maximum) * 4)));
}

export type TokenCalendarCell = ProjectTokenUsageDay | null;

export function tokenUsageCalendar(
  usage: Pick<ProjectTokenUsage, "daily" | "range">,
): TokenCalendarCell[] {
  const values = new Map(usage.daily.map((day) => [day.date, day]));
  const start = new Date(`${usage.range.start}T00:00:00.000Z`);
  const end = new Date(`${usage.range.end}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return [];
  }
  const cells: TokenCalendarCell[] = Array.from(
    { length: start.getUTCDay() },
    () => null,
  );
  for (const cursor = new Date(start); cursor <= end;) {
    const date = cursor.toISOString().slice(0, 10);
    cells.push(
      values.get(date) ?? {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cells;
}

export interface TokenUsageSlice extends ProjectTokenUsageBreakdown {
  color: string;
  percent: number;
}

export function tokenUsageSlices(
  values: readonly ProjectTokenUsageBreakdown[],
  limit = 5,
): TokenUsageSlice[] {
  const positive = values
    .filter(({ totalTokens }) => totalTokens > 0)
    .sort((left, right) => right.totalTokens - left.totalTokens);
  const total = positive.reduce((sum, value) => sum + value.totalTokens, 0);
  if (!total) return [];
  const visible = positive.slice(0, limit);
  const hidden = positive.slice(limit);
  const combined = hidden.length
    ? [
        ...visible,
        hidden.reduce<ProjectTokenUsageBreakdown>(
          (result, value) => ({
            id: null,
            name: "Other",
            inputTokens: result.inputTokens + value.inputTokens,
            outputTokens: result.outputTokens + value.outputTokens,
            cachedInputTokens:
              result.cachedInputTokens + value.cachedInputTokens,
            cacheWriteInputTokens:
              result.cacheWriteInputTokens + value.cacheWriteInputTokens,
            reasoningOutputTokens:
              result.reasoningOutputTokens + value.reasoningOutputTokens,
            totalTokens: result.totalTokens + value.totalTokens,
          }),
          {
            id: null,
            name: "Other",
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
        ),
      ]
    : visible;
  return combined.map((value, index) => ({
    ...value,
    color: tokenChartColors[index % tokenChartColors.length]!,
    percent: (value.totalTokens / total) * 100,
  }));
}

export function tokenUsageConicGradient(slices: readonly TokenUsageSlice[]) {
  if (!slices.length) return "var(--muted)";
  let offset = 0;
  const stops = slices.map((slice) => {
    const start = offset;
    offset += slice.percent;
    return `${slice.color} ${start}% ${offset}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}
