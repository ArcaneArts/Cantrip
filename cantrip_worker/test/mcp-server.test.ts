import type { CantripAgentOperationResult } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { operationResult } from "../src/mcp/server.js";

describe("Cantrip MCP result encoding", () => {
  it("keeps representative worktree data out of duplicate text content", () => {
    const uniqueMarker = "lease-history-marker-only-in-structured-data";
    const result: CantripAgentOperationResult = {
      summary: "Found 100 validated worktrees; more worktrees are available.",
      target: null,
      worktreeId: "worktree-current",
      continuationScheduled: false,
      mutated: false,
      data: {
        currentWorktreeId: "worktree-current",
        worktrees: Array.from({ length: 100 }, (_, index) => ({
          id: `worktree-${index}`,
          name: `Agent cycle ${index}`,
          branch: `codex/cycle-${index}`,
          head: index.toString(16).padStart(40, "0"),
        })),
        leases: [{ id: "lease-one", purpose: uniqueMarker }],
        cursor: 0,
        nextCursor: 100,
        total: 500,
        truncated: true,
      },
    };

    const encoded = operationResult(result);
    const legacyEncoded = {
      ...encoded,
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
    const serialized = JSON.stringify(encoded);

    expect(encoded.content).toEqual([{ type: "text", text: result.summary }]);
    expect(encoded.structuredContent).toBe(result);
    expect(serialized.match(new RegExp(uniqueMarker, "g"))).toHaveLength(1);
    expect(serialized.length).toBeLessThan(
      JSON.stringify(legacyEncoded).length * 0.65,
    );
  });
});
