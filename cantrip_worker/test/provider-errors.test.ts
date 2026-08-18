import { describe, expect, it } from "vitest";

import { readableCodexProviderError } from "../src/codex/provider-errors.js";

describe("Codex provider errors", () => {
  it.each([
    [401, "rejected the Coding Plan API key"],
    [403, "denied this Coding Plan request"],
    [404, "could not find the Responses endpoint or selected model"],
    [422, "rejected this model capability or request option"],
    [429, "rate limit reached"],
  ])("classifies Z.ai HTTP %i failures", (status, expected) => {
    expect(
      readableCodexProviderError(`unexpected status ${status}`, { zai: true }),
    ).toContain(expected);
  });

  it("redacts leased keys from unknown provider diagnostics", () => {
    const secret = "zai-private-key";
    const message = readableCodexProviderError(
      `provider failed while using ${secret}`,
      { secrets: new Set([secret]), zai: true },
    );
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
  });

  it.each([1305, 1308, 1310])(
    "classifies documented Z.ai business code %i as a limit",
    (code) => {
      expect(
        readableCodexProviderError(`provider error code: ${code}`, {
          zai: true,
        }),
      ).toContain("rate limit reached");
    },
  );

  it("surfaces reset and retry hints when Codex includes them", () => {
    expect(
      readableCodexProviderError(
        'status 429; retry-after: 45; message="too many requests"',
        { zai: true },
      ),
    ).toContain("Retry after 45");
    expect(
      readableCodexProviderError(
        'error code: 1310, next_flush_time: "2026-08-19T00:00:00Z"',
        { zai: true },
      ),
    ).toContain("Provider reset: 2026-08-19T00:00:00Z");
  });
});
