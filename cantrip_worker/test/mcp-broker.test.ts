import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CANTRIP_MCP_MUTATION_TOOL_NAMES,
  CANTRIP_MCP_READ_TOOL_NAMES,
  CANTRIP_MCP_TOOL_NAMES,
  cantripMcpOperationsForPermissionProfile,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CantripServerRequestError } from "../src/cli-client.js";
import { readWorkerLogs } from "../src/logger.js";
import { CantripMcpBroker } from "../src/mcp/broker.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

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
    rootKind: "git-worktree" as const,
    permissionProfileId: ":workspace-write",
    allowedOperations: ["context.get"] as Array<"context.get">,
  };
}

describe("Cantrip MCP worker broker", () => {
  it("reuses an unchanged live binding instead of invalidating its stdio host", async () => {
    const dataDirectory = await temporaryDirectory();
    const broker = new CantripMcpBroker({
      dataDirectory,
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-one",
    });
    await broker.start();
    try {
      const first = broker.createBinding(bindingInput());
      const reused = broker.createBinding(bindingInput());

      expect(reused).toEqual(first);
      await expect(access(first.connectionPath)).resolves.toBeUndefined();
      const handshake = await fetch(
        `${broker.endpoint}/v1/bindings/${first.binding.bindingId}`,
        {
          headers: {
            authorization: `Bearer ${first.connection.credential}`,
          },
        },
      );
      expect(handshake.status).toBe(200);
    } finally {
      await broker.close();
    }
  });

  it("refreshes the execution lane without replacing the stdio connection", async () => {
    const dataDirectory = await temporaryDirectory();
    let observedLane: string | null = null;
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        execute: async (binding) => {
          observedLane = binding.executionLaneId;
          return {
            summary: "Context is current.",
            target: null,
            worktreeId: binding.worktreeId,
            continuationScheduled: false,
            mutated: false,
          };
        },
      },
    );
    await broker.start();
    try {
      const first = broker.createBinding(bindingInput());
      const refreshed = broker.createBinding({
        ...bindingInput(),
        executionLaneId: "lane-two",
      });

      expect(refreshed).toMatchObject({
        binding: {
          bindingId: first.binding.bindingId,
          executionLaneId: "lane-two",
        },
        connectionPath: first.connectionPath,
      });
      expect(refreshed.connection).toEqual(first.connection);
      await expect(access(first.connectionPath)).resolves.toBeUndefined();
      const response = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: first.binding.bindingId,
          request: { operation: "context.get", arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      expect(observedLane).toBe("lane-two");
    } finally {
      await broker.close();
    }
  });

  it("refreshes mutable scope claims without replacing the stdio connection", async () => {
    const dataDirectory = await temporaryDirectory();
    const broker = new CantripMcpBroker({
      dataDirectory,
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-one",
    });
    await broker.start();
    try {
      const first = broker.createBinding({
        ...bindingInput(),
        allowedOperations: ["context.get", "policy.list"] as Array<
          "context.get" | "policy.list"
        >,
      });
      const refreshed = broker.createBinding({
        ...bindingInput(),
        executionLaneId: "lane-two",
        worktreeId: "worktree-two",
        rootKind: "folder-root",
        permissionProfileId: ":read-only",
      });

      expect(refreshed).toMatchObject({
        binding: {
          bindingId: first.binding.bindingId,
          executionLaneId: "lane-two",
          worktreeId: "worktree-two",
          rootKind: "folder-root",
          permissionProfileId: ":read-only",
          allowedOperations: ["context.get"],
        },
        connectionPath: first.connectionPath,
      });
      expect(refreshed.connection).toEqual(first.connection);
      await expect(access(first.connectionPath)).resolves.toBeUndefined();
      const forbidden = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: first.binding.bindingId,
          request: { operation: "policy.list", arguments: {} },
        }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await broker.close();
    }
  });

  it("does not authorize Run mutations for a read-only binding", async () => {
    const dataDirectory = await temporaryDirectory();
    const broker = new CantripMcpBroker({
      dataDirectory,
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-one",
    });
    await broker.start();
    try {
      const attachment = broker.createBinding({
        ...bindingInput(),
        permissionProfileId: ":read-only",
        allowedOperations: [
          ...cantripMcpOperationsForPermissionProfile(":read-only"),
        ],
      });
      expect(attachment.binding.allowedOperations).not.toEqual(
        expect.arrayContaining([
          "run-configuration.start",
          "run-configuration.stop",
        ]),
      );
      const denied = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: {
            operation: "run-configuration.start",
            arguments: {
              operationId: crypto.randomUUID(),
              configurationId: crypto.randomUUID(),
              worktreeId: null,
            },
          },
        }),
      });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({
        code: "forbidden",
      });
    } finally {
      await broker.close();
    }
  });

  it("rotates a binding when its project identity changes", async () => {
    const dataDirectory = await temporaryDirectory();
    const broker = new CantripMcpBroker({
      dataDirectory,
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-one",
    });
    await broker.start();
    try {
      const first = broker.createBinding(bindingInput());
      const rotated = broker.createBinding({
        ...bindingInput(),
        projectId: "project-two",
      });

      expect(rotated.binding.bindingId).not.toBe(first.binding.bindingId);
      await expect(access(first.connectionPath)).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

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
            data: {
              worker: {
                id: binding.workerId,
                name: "Worker one",
                online: true,
              },
              context: {
                chatId: binding.chatId,
                executionLaneId: binding.executionLaneId,
                permissionProfileId: binding.permissionProfileId,
                projectId: binding.projectId,
                rootKind: binding.rootKind,
                terminalId: null,
                workerId: binding.workerId,
                worktreeId: binding.worktreeId,
                worktreeMode: "agent-managed",
              },
              binding: {
                status: "read-only",
                mutationReady: false,
                staleClaims: [],
                recoveryInstruction:
                  "This attachment is read-only. Select a write-capable permission profile and start a new turn to enable mutations.",
                expiresAt: binding.expiresAt,
              },
            },
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
        expect(catalog.tools.map(({ name }) => name)).toEqual([
          ...CANTRIP_MCP_TOOL_NAMES,
        ]);
        for (const tool of catalog.tools) {
          const readOnly = CANTRIP_MCP_READ_TOOL_NAMES.includes(
            tool.name as (typeof CANTRIP_MCP_READ_TOOL_NAMES)[number],
          );
          const destructive = new Set([
            "run_configuration_delete",
            "run_configuration_restart",
            "run_configuration_stop",
            "worktree_release",
            "worktree_remove",
            "explorer_write",
            "terminal_send",
          ]).has(tool.name);
          const openWorld = new Set([
            "web_search",
            "web_read",
            "browser_services",
            "run_configuration_start",
            "run_configuration_restart",
            "terminal_send",
            "browser_navigate",
          ]).has(tool.name);
          const idempotent =
            readOnly || tool.name.startsWith("run_configuration_");
          expect(tool).toMatchObject({
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: destructive,
              idempotentHint: idempotent,
              openWorldHint: openWorld,
            },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          });
        }
        const result = await client.callTool({
          name: "context_get",
          arguments: {},
        });
        expect(result.content).toEqual([
          { type: "text", text: "Validated Cantrip context." },
        ]);
        expect(result).toMatchObject({
          structuredContent: {
            summary: "Validated Cantrip context.",
            worktreeId: "worktree-one",
          },
        });
        const help = await client.callTool({
          name: "tool_help",
          arguments: { tool: "worktree_create" },
        });
        expect(help).toMatchObject({
          structuredContent: {
            data: {
              tool: "worktree_create",
              inputSchema: expect.any(Object),
              examples: expect.arrayContaining([
                expect.objectContaining({
                  intent: "newBranch",
                  baseRevision: "main",
                }),
              ]),
            },
          },
        });
        expect(CANTRIP_MCP_MUTATION_TOOL_NAMES).toHaveLength(19);
      } finally {
        await client.close();
        await broker.close();
      }
    },
    20_000,
  );

  it("bounds response size and concurrent calls per binding", async () => {
    const dataDirectory = await temporaryDirectory();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        execute: async (binding) => {
          calls += 1;
          await gate;
          return {
            summary: "Context is current.",
            target: null,
            worktreeId: binding.worktreeId,
            continuationScheduled: false,
            mutated: false,
            data: { value: "x".repeat(600_000) },
          };
        },
      },
    );
    await broker.start();
    const attachment = broker.createBinding(bindingInput());
    const call = () =>
      fetch(`${broker.endpoint}/v1/execute`, {
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
    try {
      const active = [call(), call(), call(), call()];
      await expect.poll(() => calls).toBe(4);
      const busy = await call();
      expect(busy.status).toBe(429);
      await expect(busy.json()).resolves.toMatchObject({ code: "busy" });
      release();
      const completed = await Promise.all(active);
      expect(completed.map(({ status }) => status)).toEqual([
        413, 413, 413, 413,
      ]);
      await expect(completed[0]!.json()).resolves.toMatchObject({
        code: "output-too-large",
      });
    } finally {
      release();
      await broker.close();
    }
  });

  it("rejects an oversized Run configuration response at the worker broker", async () => {
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
          summary: "Found large Run configurations.",
          target: { kind: "project", projectId: binding.projectId },
          worktreeId: binding.worktreeId,
          continuationScheduled: false,
          mutated: false,
          data: {
            operation: "list",
            operationId: "00000000-0000-4000-8000-000000000099",
            projectId: binding.projectId,
            inventory: {
              directory: ".cantrip/run-configurations",
              entries: Array.from({ length: 128 }, (_, index) => {
                const id = `00000000-0000-4000-8000-${index
                  .toString()
                  .padStart(12, "0")}`;
                return {
                  relativePath: `.cantrip/run-configurations/${id}.json`,
                  revision: index.toString(16).padStart(64, "0"),
                  id,
                  status: "ready",
                  document: {
                    schema: "cantrip.run-configuration",
                    version: 1,
                    id,
                    name: `Large configuration ${index}`,
                    provider: "shell",
                    target: { kind: "command", command: "x".repeat(100_000) },
                  },
                  diagnostics: [],
                };
              }),
              diagnostics: [],
            },
            validations: Array.from({ length: 128 }, (_, index) => {
              const id = `00000000-0000-4000-8000-${index
                .toString()
                .padStart(12, "0")}`;
              return {
                configurationId: id,
                provider: "shell",
                platform: "linux",
                effectiveCommand: "run large configuration",
                valid: true,
                diagnostics: [],
              };
            }),
            runtimes: [],
          },
        }),
      },
    );
    broker.setEncryptionService({
      ownerId: () => "owner-one",
    } as unknown as WorkerEncryptionService);
    await broker.start();
    const attachment = broker.createBinding({
      ...bindingInput(),
      projectId: "00000000-0000-4000-8000-000000000010",
      allowedOperations: ["run-configuration.list"],
    });
    try {
      const response = await fetch(`${broker.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          bindingId: attachment.binding.bindingId,
          request: { operation: "run-configuration.list", arguments: {} },
        }),
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        code: "output-too-large",
      });
    } finally {
      await broker.close();
    }
  });

  it("does not echo protected validation payloads into the MCP transcript", async () => {
    const dataDirectory = await temporaryDirectory();
    const sentinel = "protected-ciphertext-sentinel";
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        execute: async (binding) => ({
          summary: "Malformed protected target catalog.",
          target: null,
          worktreeId: binding.worktreeId,
          continuationScheduled: false,
          mutated: false,
          data: { targets: [{ ciphertext: sentinel }] },
        }),
      },
    );
    broker.setEncryptionService({
      ownerId: () => "owner-one",
    } as unknown as WorkerEncryptionService);
    await broker.start();
    const attachment = broker.createBinding({
      ...bindingInput(),
      allowedOperations: ["target.list"],
    });
    try {
      const response = await fetch(`${broker.endpoint}/v1/execute`, {
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
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("validation failed");
      expect(text).not.toContain(sentinel);
    } finally {
      await broker.close();
    }
  });

  it("refreshes a binding after a transient stale server rejection", async () => {
    const dataDirectory = await temporaryDirectory();
    let calls = 0;
    const broker = new CantripMcpBroker(
      {
        dataDirectory,
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-one",
      },
      {
        execute: async (binding) => {
          calls += 1;
          if (binding.executionLaneId === "lane-one") {
            throw new CantripServerRequestError(
              "The lane changed.",
              409,
              "stale-binding",
            );
          }
          return {
            summary: "Current context loaded.",
            target: null,
            worktreeId: binding.worktreeId,
            continuationScheduled: false,
            mutated: false,
          };
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
      await expect(response.clone().json()).resolves.toMatchObject({
        code: "stale-binding",
        error: expect.stringContaining("Do not retry"),
      });
      const rejectionLog = readWorkerLogs({
        afterCursor: 0,
        limit: 200,
        minimumLevel: "trace",
      }).records.find(
        (record) =>
          record.context?.event === "mcp.request.rejected" &&
          record.context.bindingId === attachment.binding.bindingId,
      );
      expect(rejectionLog).toMatchObject({
        level: "warn",
        context: {
          operation: "context.get",
          reasonCode: "stale-binding",
          errorCode: "stale-binding",
          executionLaneId: "lane-one",
          worktreeId: "worktree-one",
          permissionProfileId: ":workspace-write",
        },
      });
      await expect(access(attachment.connectionPath)).resolves.toBeUndefined();
      const latched = await fetch(`${broker.endpoint}/v1/execute`, {
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
      expect(latched.status).toBe(409);
      await expect(latched.json()).resolves.toMatchObject({
        code: "stale-binding",
        error: expect.stringContaining("Start or resume a turn"),
      });
      expect(calls).toBe(1);
      const refreshed = broker.createBinding({
        ...bindingInput(),
        executionLaneId: "lane-two",
      });
      expect(refreshed.binding.bindingId).toBe(attachment.binding.bindingId);
      expect(refreshed.connectionPath).toBe(attachment.connectionPath);
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
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        summary: "Current context loaded.",
      });
      expect(calls).toBe(2);
    } finally {
      await broker.close();
    }
  });

  it("revokes a binding immediately after continuation is scheduled", async () => {
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
          summary: "Continuation is scheduled. Finish this turn now.",
          target: null,
          worktreeId: binding.worktreeId,
          continuationScheduled: true,
          mutated: true,
        }),
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
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        continuationScheduled: true,
      });
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
