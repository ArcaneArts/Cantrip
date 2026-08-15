import { describe, expect, it } from "vitest";

import { redactCodexDiagnosticPayload } from "../src/codex/diagnostic-redaction.js";

describe("Codex diagnostic redaction", () => {
  it("redacts OAuth fields, bearer headers, and known token values", () => {
    const secret = "leased-access-token";
    const redacted = redactCodexDiagnosticPayload(
      {
        accessToken: secret,
        nested: {
          message: `request failed for ${secret}`,
          authorization: `Bearer ${secret}`,
        },
      },
      new Set([secret]),
    );
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toEqual({
      accessToken: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        message: "request failed for [REDACTED]",
      },
    });
  });
});
