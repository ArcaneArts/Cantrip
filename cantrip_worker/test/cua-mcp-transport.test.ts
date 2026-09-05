import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CantripMcpBroker } from "../src/mcp/broker.js";
import { invokeCuaMcpBrokerOperation } from "../src/mcp/connection.js";
import {
  CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES,
  cuaMcpRequestSchema,
  type CuaMcpExecutor,
} from "../src/mcp/cua-contract.js";
import { createCuaMcpServer } from "../src/mcp/cua-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const claims = {
  ownerId: "owner",
  contextKind: "project" as const,
  projectId: "project",
  chatId: "chat",
  executionLaneId: "lane",
  workerId: "worker",
  worktreeId: "worktree",
  rootKind: "git-worktree" as const,
  scratchRootId: null,
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"] as ["context.get"],
};
const identity = {
  threadId: "native-child",
  turnId: "native-child-turn",
  itemId: "native-item",
  callId: "native-call",
};
const meta = {
  threadId: identity.threadId,
  "x-codex-turn-metadata": {
    turn_id: identity.turnId,
    root_turn_id: "different-root-turn",
  },
  itemId: identity.itemId,
  callId: identity.callId,
};
async function brokerFixture(execute: CuaMcpExecutor, enabled = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-cua-mcp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const broker = new CantripMcpBroker({
    dataDirectory: directory,
    serverUrl: "https://example.invalid",
    token: "worker-token",
    workerId: "worker",
  });
  broker.setComputerUseExecutor(execute);
  await broker.start();
  cleanup.push(() => broker.close());
  return {
    broker,
    attachment: broker.createBinding({ ...claims, computerUse: enabled }),
  };
}
async function stdioFixture(execute: CuaMcpExecutor) {
  const { broker, attachment } = await brokerFixture(execute);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve("src/mcp/cua-stdio.ts"),
      "--connection",
      attachment.connectionPath,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "cua-boundary-test", version: "1.0.0" });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { broker, attachment, client };
}

describe("managed CUA MCP transport", () => {
  it("delivers actual image blocks above the generic limit through real stdio and authenticated HTTP", async () => {
    const data = Buffer.alloc(600_000, 7).toString("base64");
    const execute = vi.fn<CuaMcpExecutor>(async () => ({
      content: [
        { type: "text", text: "snapshot" },
        { type: "image", mimeType: "image/png", data },
      ],
    }));
    const { client } = await stdioFixture(execute);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "js",
      "js_reset",
    ]);
    const result = await client.callTool({
      name: "js",
      arguments: { script: "await cua.snapshot()" },
      _meta: meta,
    });
    expect(result.content).toEqual([
      { type: "text", text: "snapshot" },
      { type: "image", mimeType: "image/png", data },
    ]);
    expect(execute.mock.calls[0]?.[0]).toMatchObject(claims);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      ...identity,
      operation: "js",
      script: "await cua.snapshot()",
    });
    await client.callTool({ name: "js_reset", arguments: {}, _meta: meta });
    expect(execute.mock.calls[1]?.[1]).toEqual({
      ...identity,
      operation: "js_reset",
    });
  }, 20_000);

  it("rejects missing actual metadata and caller-supplied identity before broker execution", async () => {
    const execute = vi.fn<CuaMcpExecutor>(async () => ({ content: [] }));
    const { client } = await stdioFixture(execute);
    expect(
      await client.callTool({ name: "js", arguments: { script: "1" } }),
    ).toMatchObject({ isError: true });
    expect(
      await client.callTool({
        name: "js",
        arguments: { script: "1", threadId: "forged", turnId: "forged" },
        _meta: meta,
      }),
    ).toMatchObject({ isError: true });
    expect(
      await client.callTool({
        name: "js",
        arguments: { script: "1" },
        _meta: {
          ...meta,
          "x-codex-turn-metadata": { root_turn_id: "root-only" },
        },
      }),
    ).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
    expect(
      cuaMcpRequestSchema.safeParse({
        ...identity,
        operation: "js",
        script: "😃".repeat(10_000),
      }).success,
    ).toBe(false);
  }, 20_000);

  it("requires binding credentials and an explicit worker-owned CUA grant", async () => {
    const execute = vi.fn<CuaMcpExecutor>(async () => ({ content: [] }));
    const { broker, attachment } = await brokerFixture(execute, false);
    const body = JSON.stringify({
      bindingId: attachment.binding.bindingId,
      request: { ...identity, operation: "js_reset" },
    });
    expect(
      (
        await fetch(`${broker.endpoint}/v1/computer-use`, {
          method: "POST",
          body,
        })
      ).status,
    ).toBe(401);
    await expect(
      invokeCuaMcpBrokerOperation(
        attachment.connection,
        { ...identity, operation: "js_reset" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("not enabled");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["request", "binding", "disable"] as const)(
    "cancels worker execution on %s cancellation",
    async (kind) => {
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observed!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const { broker, attachment } = await brokerFixture(
        async (_binding, _request, _id, signal) => {
          started();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                observed();
                reject(new Error("CUA cancelled"));
              },
              { once: true },
            ),
          );
          return { content: [] };
        },
      );
      const controller = new AbortController();
      const work = invokeCuaMcpBrokerOperation(
        attachment.connection,
        { ...identity, operation: "js_reset" },
        controller.signal,
      );
      const rejected = expect(work).rejects.toThrow();
      await start;
      if (kind === "request") controller.abort();
      else if (kind === "binding")
        broker.revokeBinding(attachment.binding.bindingId);
      else broker.createBinding({ ...claims, computerUse: false });
      await cancelled;
      await rejected;
    },
  );

  it.each(["notification", "host-close"])(
    "propagates actual MCP %s cancellation through stdio to the worker",
    async (kind) => {
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observed!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const { client } = await stdioFixture(
        async (_binding, _request, _id, signal) => {
          started();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                observed();
                reject(new Error("cancelled"));
              },
              { once: true },
            ),
          );
          return { content: [] };
        },
      );
      const controller = new AbortController();
      const work = client.callTool(
        {
          name: "js",
          arguments: { script: "await cua.targets()" },
          _meta: meta,
        },
        undefined,
        { signal: controller.signal },
      );
      const rejected = expect(work).rejects.toThrow();
      await start;
      if (kind === "notification") controller.abort();
      else await client.close();
      await cancelled;
      await rejected;
    },
    20_000,
  );

  it.each([
    { type: "image", mimeType: "image/png", data: "not base64" },
    { type: "image", mimeType: "image/jpeg", data: "AQ==" },
  ])(
    "rejects malformed image content at the broker boundary: $mimeType",
    async (content) => {
      const { attachment } = await brokerFixture(async () => ({
        content: [content as { type: "image"; mimeType: string; data: string }],
      }));
      await expect(
        invokeCuaMcpBrokerOperation(
          attachment.connection,
          { ...identity, operation: "js_reset" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    },
  );

  it("rejects more than two images and individual image overflow", async () => {
    let content = Array.from({ length: 3 }, () => ({
      type: "image" as const,
      mimeType: "image/png",
      data: "AQ==",
    }));
    const { attachment } = await brokerFixture(async () => ({ content }));
    await expect(
      invokeCuaMcpBrokerOperation(
        attachment.connection,
        { ...identity, operation: "js_reset" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("excessive");
    content = [
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.alloc(2.5 * 1024 * 1024 + 1).toString("base64"),
      },
    ];
    await expect(
      invokeCuaMcpBrokerOperation(
        attachment.connection,
        { ...identity, operation: "js_reset" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it("bounds the final serialized JSON-RPC envelope including its request ID", async () => {
    // Result alone fits. The actual JSON-RPC envelope makes the line too large.
    const server = createCuaMcpServer(async () => ({
      content: [
        {
          type: "text",
          text: "a".repeat(CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES - 100),
        },
      ],
    }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "line-boundary", version: "1" });
    cleanup.push(() => server.close());
    cleanup.push(() => client.close());
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let result: unknown;
    const received = new Promise<void>((resolve) => {
      clientTransport.onmessage = (message) => {
        result = message;
        resolve();
      };
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: "id".repeat(100),
      method: "tools/call",
      params: { name: "js", arguments: { script: "1" }, _meta: meta },
    });
    await received;
    expect(result).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("8 MiB") }],
      },
    });
  });
});
