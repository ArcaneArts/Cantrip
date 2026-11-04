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
import { managedCantripMcpHttpServer } from "../src/mcp/managed.js";

const claims: CantripMcpSessionInput = {
  ownerId: "owner",
  contextKind: "project",
  projectId: "project",
  chatId: "chat",
  workerId: "worker",
  worktreeId: "worktree",
  rootKind: "git-worktree",
  scratchRootId: null,
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
  computerUse: false,
};
const contextResult = {
  summary: "Authorized Linux context.",
  target: null,
  worktreeId: "worktree",
  continuationScheduled: false,
  mutated: false,
  data: {
    worker: { id: "worker", name: "Worker", online: true },
    context: {
      chatId: "chat",
      executionLaneId: "lane",
      permissionProfileId: ":workspace-write",
      projectId: "project",
      rootKind: "git-worktree",
      terminalId: null,
      workerId: "worker",
      worktreeId: "worktree",
      worktreeMode: "agent-managed",
    },
    binding: {
      status: "ready",
      mutationReady: true,
      staleClaims: [],
      recoveryInstruction: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  },
};

it("serves real MCP HTTP with exact credential, lane activation, revocation and expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-mcp-http-"));
  let now = Date.now();
  const calls: unknown[] = [];
  const broker = new CantripMcpBroker(
    {
      dataDirectory: directory,
      serverUrl: "https://example.invalid",
      token: "not-sent-to-guest",
      workerId: "worker",
    },
    {
      now: () => now,
      ttlMs: 60_000,
      execute: async (binding, request) => {
        calls.push({ binding, request });
        return contextResult;
      },
    },
  );
  const clients: Client[] = [];
  await broker.start();
  try {
    const session = broker.createSession(claims);
    const config = managedCantripMcpHttpServer(session.connection, [
      "context_get",
    ]);
    expect(config.transport).toBe("http");
    if (config.transport !== "http") throw new Error("Expected network MCP");
    const denied = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-credential",
      },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    const client = new Client({
      name: "Linux-native-MCP-acceptance",
      version: "1",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "context_get",
    ]);
    expect(
      (await client.callTool({ name: "context_get", arguments: {} })).isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);
    const active = broker.createBinding({ ...claims, executionLaneId: "lane" });
    expect(active.connection).toEqual(session.connection);
    expect(
      (await client.callTool({ name: "context_get", arguments: {} })).isError,
    ).not.toBe(true);
    expect(calls).toMatchObject([
      {
        binding: { executionLaneId: "lane", worktreeId: "worktree" },
        request: { operation: "context.get", arguments: {} },
      },
    ]);
    expect(broker.deactivateBinding(active.binding.bindingId, "lane")).toBe(
      true,
    );
    expect(
      (await client.callTool({ name: "context_get", arguments: {} })).isError,
    ).toBe(true);
    expect(calls).toHaveLength(1);
    broker.createBinding({ ...claims, executionLaneId: "next-lane" });
    now += 60_001;
    await expect(
      client.callTool({ name: "context_get", arguments: {} }),
    ).rejects.toThrow(/Unauthorized/);
    expect(calls).toHaveLength(1);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
