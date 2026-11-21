import { describe, expect, it } from "vitest";

import {
  cantripMcpRunConfigurationSecretSetInputSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpToolHelpResultSchema,
  cantripMcpWorktreeCreateInputSchema,
} from "@cantrip/protocol";

import { cantripMcpToolHelp } from "../src/mcp/tool-catalog.js";

describe("Cantrip MCP tool help", () => {
  it("generates exact schemas and valid examples from the live catalog", () => {
    const worktree = cantripMcpToolHelpResultSchema.parse(
      cantripMcpToolHelp("worktree_create"),
    );
    expect(worktree.data.inputSchema).toMatchObject({
      $schema: expect.any(String),
    });
    expect(JSON.stringify(worktree.data.inputSchema)).toContain("baseRevision");
    expect(JSON.stringify(worktree.data.inputSchema)).not.toContain('"from"');
    for (const example of worktree.data.examples) {
      expect(
        cantripMcpWorktreeCreateInputSchema.safeParse(example).success,
      ).toBe(true);
    }

    const run = cantripMcpToolHelpResultSchema.parse(
      cantripMcpToolHelp("run_configuration_start"),
    );
    expect(run.data.examples).toHaveLength(1);
    expect(
      cantripMcpRunConfigurationStartInputSchema.safeParse(run.data.examples[0])
        .success,
    ).toBe(true);

    const secret = cantripMcpToolHelpResultSchema.parse(
      cantripMcpToolHelp("run_configuration_secret_set"),
    );
    expect(secret.data.examples).toHaveLength(1);
    expect(
      cantripMcpRunConfigurationSecretSetInputSchema.safeParse(
        secret.data.examples[0],
      ).success,
    ).toBe(true);
    expect(secret.data.notes.join(" ")).toContain("never readable back");
  });
});
