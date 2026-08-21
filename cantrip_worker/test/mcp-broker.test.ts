import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { CantripServerRequestError } from "../src/cli-client.js";
import { CantripMcpBroker } from "../src/mcp/broker.js";

const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-mcp-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

function bindingInput() {
  return {
    ownerId: "owner-one",
    projectId: "project-one",
    chatId: "chat-one",
    executionLaneId: "lane-one",
    workerId: "worker-one",
    worktreeId: "worktree-one",
    canonicalRoot: "/worktrees/one",
    rootKind: "git-worktree" as const,
    permissionProfileId: ":workspace-write",
    allowedOperations: ["context.get"] as Array<"context.get">,
  };
}

describe("Cantrip MCP worker broker", () => {
  it("creates, authenticates, expires, and revokes protected bindings", async () => {
    const dataDirectory = await temporaryDirectory();
    let now = Date.parse("2026-08-21T12:00:00.000Z");
    const calls: unknown[] = [];
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        now: () => now,
        ttlMs: 1_000,
        execute: async (binding, request, requestId) => {
          calls.push({ binding, request, requestId });
          return {
            summary: "Context is current.",
            target: null,
            worktreeId: binding.worktreeId,
            continuationScheduled: false,
            mutated: false,
            data: { chatId: binding.chatId },
          };
        },
      },
    );
    await broker.start();
    const attachment = broker.createBinding(bindingInput());
    try {
      const stored = JSON.parse(
        await readFile(attachment.connectionPath, "utf8"),
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({
        protocolVersion: 1,
        endpoint: broker.endpoint,
        bindingId: attachment.binding.bindingId,
        credential: expect.any(String),
      });
      expect(stored).not.toHaveProperty("ownerId");
      expect(stored).not.toHaveProperty("workerToken");
      if (process.platform !== "win32") {
        expect((await stat(attachment.connectionPath)).mode & 0o777).toBe(
          0o600,
        );
      }

      const unauthorized = await fetch(
        `${broker.endpoint}/v1/bindings/${attachment.binding.bindingId}`,
      );
      expect(unauthorized.status).toBe(401);
      const handshake = await fetch(
        `${broker.endpoint}/v1/bindings/${attachment.binding.bindingId}`,
        {
          headers: {
            authorization: `Bearer ${attachment.connection.credential}`,
          },
        },
      );
      expect(handshake.status).toBe(200);

      const denied = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: { operation: "target.list", arguments: {} },
        }),
      });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: { operation: "context.get", arguments: {} },
        }),
      });
      expect(allowed.status).toBe(200);
      await expect(allowed.json()).resolves.toMatchObject({
        summary: "Context is current.",
        worktreeId: "worktree-one",
      });
      expect(calls).toHaveLength(1);

      now += 1_000;
      const expired = await fetch(
        `${broker.endpoint}/v1/bindings/${attachment.binding.bindingId}`,
        {
          headers: {
            authorization: `Bearer ${attachment.connection.credential}`,
          },
        },
      );
      expect(expired.status).toBe(401);
      await expect(access(attachment.connectionPath)).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "supports stdio initialize, list, call, and shutdown against the packaged host entry",
    async () => {
      const dataDirectory = await temporaryDirectory();
      const broker = new CantripMcpBroker(
        {
          dataDirectory,
          serverUrl: "https://cantrip.example",
          token: "worker-token",
          workerId: "worker-one",
        },
        {
          execute: async (binding) => ({
            summary: "Validated Cantrip context.",
            target: null,
            worktreeId: binding.worktreeId,
            continuationScheduled: false,
            mutated: false,
            data: { projectId: binding.projectId },
          }),
        },
      );
      await broker.start();
      const attachment = broker.createBinding(bindingInput());
      const transport = new StdioClientTransport({
        command: path.resolve("../node_modules/.bin/tsx"),
        args: [
          path.resolve("src/mcp/stdio.ts"),
          "--connection",
          attachment.connectionPath,
        ],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client(
        { name: "cantrip-worker-test", version: "1.0.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(transport);
        expect(transport.pid).not.toBeNull();
        const catalog = await client.listTools();
        expect(catalog.tools).toEqual([
          expect.objectContaining({
            name: "context_get",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          }),
        ]);
        const result = await client.callTool({
          name: "context_get",
          arguments: {},
        });
        expect(result).toMatchObject({
          structuredContent: {
            summary: "Validated Cantrip context.",
            worktreeId: "worktree-one",
          },
        });
      } finally {
        await client.close();
        await broker.close();
      }
    },
    20_000,
  );

  it("revokes a binding when the durable server rejects it as stale", async () => {
    const dataDirectory = await temporaryDirectory();
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        execute: async () => {
          throw new CantripServerRequestError(
            "The lane changed.",
            409,
            "stale-binding",
          );
        },
      },
    );
    await broker.start();
    const attachment = broker.createBinding(bindingInput());
    try {
      const response = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: { operation: "context.get", arguments: {} },
        }),
      });
      expect(response.status).toBe(409);
      await expect(access(attachment.connectionPath)).rejects.toThrow();
      const retry = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: { operation: "context.get", arguments: {} },
        }),
      });
      expect(retry.status).toBe(401);
    } finally {
      await broker.close();
    }
  });
});
