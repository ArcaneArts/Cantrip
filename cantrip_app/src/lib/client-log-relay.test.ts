import { describe, expect, it } from "vitest";

import { formatClientLogArguments } from "./client-log-relay";

describe("client log relay", () => {
  it("formats structured and error arguments for the terminal", () => {
    expect(
      formatClientLogArguments([
        "request failed",
        { status: 502 },
        new Error("worker unavailable"),
      ]),
    ).toContain('request failed {"status":502} Error: worker unavailable');
  });

  it("handles circular data and bigint values", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatClientLogArguments([circular, 12n])).toBe(
      '{"self":"[Circular]"} 12n',
    );
  });

  it("bounds terminal messages", () => {
    const message = formatClientLogArguments(["x".repeat(20_000)]);
    expect(message.length).toBeLessThan(16_500);
    expect(message.endsWith("… [truncated]")).toBe(true);
  });
});
