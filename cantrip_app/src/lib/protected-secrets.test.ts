import { describe, expect, it } from "vitest";

import { protectMcpServerCreate } from "./protected-secrets";

describe("protected MCP adapter", () => {
  it("rejects the managed CodeGraph name before encryption", async () => {
    await expect(
      protectMcpServerCreate({
        name: "CodeGraph",
        enabled: true,
        transport: "stdio",
        command: "codegraph",
        args: [],
        environment: {},
      }),
    ).rejects.toThrow("reserved");
  });
});
