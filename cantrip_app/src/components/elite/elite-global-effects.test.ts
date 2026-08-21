import { describe, expect, it } from "vitest";

import { ELITE_GLOBAL_CANDIDATE_SELECTOR } from "./elite-global-effects";

describe("Elite global effects", () => {
  it("targets semantic component boundaries instead of every DOM node", () => {
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain('[data-slot="card"]');
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain(
      '[data-slot="dialog-content"]',
    );
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain("button");
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain('[role="row"]');
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).not.toContain("div,");
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).not.toContain("span,");
  });
});
