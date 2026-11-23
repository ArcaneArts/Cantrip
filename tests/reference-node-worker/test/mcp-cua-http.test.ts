import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import {
  CantripMcpBroker,
  type CantripMcpSessionInput,
} from "../src/mcp/broker.js";
import { managedCuaMcpHttpServer } from "../src/mcp/managed.js";

it("serves CUA over authenticated Worker-local MCP HTTP with native metadata and revocation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-cua-http-"));
  let now = Date.now();
  const calls: unknown[] = [];
  const broker = new CantripMcpBroker(
    {
      dataDirectory: directory,
      serverUrl: "https://example.invalid",
      token: "worker-only-token",
      workerId: "worker",
    },
    { now: () => now, ttlMs: 60_000 },
  );
  broker.setComputerUseExecutor(async (binding, request) => {
    calls.push({ binding, request });
    return { content: [{ type: "text", text: "Linux fixture result" }] };
  });
  const claims: CantripMcpSessionInput = {
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    projectId: "project",
    worktreeId: "worktree",
    contextKind: "project",
    rootKind: "git-worktree",
    scratchRootId: null,
    permissionProfileId: ":yolo",
    allowedOperations: ["context.get"],
    computerUse: true,
  };
  const client = new Client({
    name: "Linux-CUA-HTTP-acceptance",
    version: "1",
  });
  await broker.start();
  try {
    const session = broker.createSession(claims);
    const config = managedCuaMcpHttpServer(session.connection);
    expect(config).toMatchObject({
      name: "cantrip_cua",
      transport: "http",
      managedToolNames: ["js", "js_reset"],
    });
    if (config.transport !== "http") throw new Error("Expected network MCP");
    expect(JSON.stringify(config)).not.toContain("worker-only-token");
    const denied = await fetch(config.url, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "js",
      "js_reset",
    ]);
    const request = {
      name: "js",
      arguments: { script: "await cua.targets()" },
      _meta: {
        threadId: "native-thread",
        "x-codex-turn-metadata": { turn_id: "native-turn" },
        itemId: "item",
        callId: "call",
      },
    };
    expect((await client.callTool(request)).isError).toBe(true);
    expect(calls).toHaveLength(0);
    broker.createBinding({ ...claims, executionLaneId: "lane" });
    expect(
      (await client.callTool({ name: "js", arguments: request.arguments }))
        .isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await client.callTool(request)).isError).not.toBe(true);
    expect(calls).toMatchObject([
      {
        binding: {
          ownerId: "owner",
          workerId: "worker",
          chatId: "chat",
          executionLaneId: "lane",
        },
        request: {
          threadId: "native-thread",
          turnId: "native-turn",
          itemId: "item",
          callId: "call",
          operation: "js",
          script: "await cua.targets()",
        },
      },
    ]);
    broker.deactivateBinding(session.connection.bindingId, "lane");
    expect((await client.callTool(request)).isError).toBe(true);
    expect(calls).toHaveLength(1);
    broker.createBinding({
      ...claims,
      executionLaneId: "lane",
      computerUse: false,
    });
    const disabled = await fetch(config.url, {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(disabled.status).toBe(403);
    await expect(client.callTool(request)).rejects.toThrow(
      /Computer use is not enabled/,
    );
    expect(calls).toHaveLength(1);
    broker.createBinding({ ...claims, executionLaneId: "lane" });
    now += 60_001;
    await expect(client.callTool(request)).rejects.toThrow(/Unauthorized/);
    expect(calls).toHaveLength(1);
  } finally {
    await client.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
