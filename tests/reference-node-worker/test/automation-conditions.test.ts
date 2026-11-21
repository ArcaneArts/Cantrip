import { describe, expect, it, vi } from "vitest";

import { evaluateProjectAutomationCondition } from "../src/automation-conditions.js";

describe("project automation conditions", () => {
  it("allows only script exit code zero", async () => {
    const runScript = vi
      .fn<(script: string, cwd: string) => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(7);
    const dependencies = {
      countOpenIssues: vi.fn<() => Promise<number>>(),
      runScript,
    };

    await expect(
      evaluateProjectAutomationCondition(
        { type: "script", script: "pnpm test" },
        "/project",
        null,
        dependencies,
      ),
    ).resolves.toEqual({
      allowed: true,
      detail: "Condition script exited with code 0.",
    });
    await expect(
      evaluateProjectAutomationCondition(
        { type: "script", script: "pnpm test" },
        "/project",
        null,
        dependencies,
      ),
    ).resolves.toEqual({
      allowed: false,
      detail: "Condition script exited with code 7.",
    });
    expect(runScript).toHaveBeenCalledWith("pnpm test", "/project");
  });

  it("checks the GitHub open-issue count against the configured minimum", async () => {
    const countOpenIssues = vi.fn(async () => 2);

    await expect(
      evaluateProjectAutomationCondition(
        { type: "open-issues", minimum: 3 },
        "/project",
        "ArcaneArts/Cantrip",
        { countOpenIssues },
      ),
    ).resolves.toEqual({
      allowed: false,
      detail: "2 open issues; 3 required.",
    });
    expect(countOpenIssues).toHaveBeenCalledWith("ArcaneArts/Cantrip");
  });

  it("rejects issue conditions for projects without a GitHub repository", async () => {
    await expect(
      evaluateProjectAutomationCondition(
        { type: "open-issues", minimum: 1 },
        "/project",
        null,
        { countOpenIssues: vi.fn() },
      ),
    ).rejects.toThrow("GitHub-backed project");
  });
});
