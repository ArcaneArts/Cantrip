import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CantripAgentOperationResult } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  createCantripMcpServer,
  operationResult,
  type CantripMcpServerOptions,
} from "../src/mcp/server.js";

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

async function withMcpClient<T>(
  options: CantripMcpServerOptions,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCantripMcpServer(async () => ({}) as never, options);
  const client = new Client({ name: "cantrip-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("Cantrip MCP tool catalog", () => {
  it("can omit redundant result schemas without changing tool inputs", async () => {
    const full = await withMcpClient({}, (client) => client.listTools());
    const optimized = await withMcpClient(
      { omitToolOutputSchemas: true },
      (client) => client.listTools(),
    );

    expect(optimized.tools).toHaveLength(full.tools.length);
    expect(optimized.tools.map(({ name }) => name)).toEqual(
      full.tools.map(({ name }) => name),
    );
    expect(
      optimized.tools.every((tool) => tool.outputSchema === undefined),
    ).toBe(true);

    const fullCreate = full.tools.find(
      ({ name }) => name === "run_configuration_create",
    );
    const optimizedCreate = optimized.tools.find(
      ({ name }) => name === "run_configuration_create",
    );
    expect(fullCreate?.outputSchema).toBeDefined();
    expect(optimizedCreate?.inputSchema).toEqual(fullCreate?.inputSchema);

    const fullBytes = Buffer.byteLength(JSON.stringify(full.tools));
    const optimizedBytes = Buffer.byteLength(JSON.stringify(optimized.tools));
    expect(fullBytes - optimizedBytes).toBeGreaterThan(300_000);
    expect(optimizedBytes).toBeLessThan(fullBytes * 0.4);
  });

  it("still validates operation results when result schemas are not advertised", async () => {
    const result = await withMcpClient(
      { omitToolOutputSchemas: true },
      (client) => client.callTool({ name: "context_get", arguments: {} }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Cantrip MCP result validation failed." },
    ]);
  });
});
