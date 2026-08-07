import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexAccountHome } from "../src/codex/account-home.js";

describe("ChatGPT account homes", () => {
  it("isolates credentials by provider without exposing its id as a path", () => {
    const first = codexAccountHome("/worker", "personal-account");
    const second = codexAccountHome("/worker", "work-account");

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join("/worker", "codex-accounts"));
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("personal-account");
  });
});
