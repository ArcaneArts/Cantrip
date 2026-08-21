import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearSensitiveBytes,
  decryptSurfacePrivateState,
  deriveComponentKey,
  encryptPolicyContent,
  generateAccountMasterKey,
  randomBytes,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol/surface-stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  CANTRIP_CLI_CONNECTION_ENV,
  CantripCliBroker,
} from "../src/cli-broker.js";
import { readWorkerLogs } from "../src/logger.js";
import { TerminalManager } from "../src/terminal-manager.js";
import { WorkerEncryptionService } from "../src/worker-encryption.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../src/surface-stream-encryption.js";

const directories: string[] = [];
const originalConnection = process.env[CANTRIP_CLI_CONNECTION_ENV];
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const originalPath = process.env[pathKey];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-cli-broker-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  if (originalConnection === undefined) {
    delete process.env[CANTRIP_CLI_CONNECTION_ENV];
  } else {
    process.env[CANTRIP_CLI_CONNECTION_ENV] = originalConnection;
  }
  if (originalPath === undefined) delete process.env[pathKey];
  else process.env[pathKey] = originalPath;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Cantrip CLI worker broker", () => {
  it.skipIf(process.platform === "win32")(
    "makes the authenticated CLI available in terminal tabs",
    async () => {
      const directory = await temporaryDirectory();
      const binary = path.join(directory, "cantrip");
      await writeFile(
        binary,
        [
          "#!/bin/sh",
          'printf \'CANTRIP_TERMINAL_OK:%s:%s\\n\' "$CANTRIP_CLI_CONNECTION" "$CANTRIP_TERMINAL_ID"',
        ].join("\n"),
      );
      await chmod(binary, 0o755);
      const broker = new CantripCliBroker(
        {
          dataDirectory: path.join(directory, "worker-data"),
          serverUrl: "https://cantrip.example",
          token: "worker-token",
          workerId: "worker-example",
        },
        { binary },
      );
      await broker.start();
      const environment = broker.childEnvironment();

      if (originalConnection === undefined) {
        delete process.env[CANTRIP_CLI_CONNECTION_ENV];
      } else {
        process.env[CANTRIP_CLI_CONNECTION_ENV] = originalConnection;
      }
      if (originalPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = originalPath;

      const manager = new TerminalManager({ environment });
      let output = "";
      const exited = manager.open(
        "terminal-cli",
        "attachment-cli",
        directory,
        80,
        24,
        { type: "shell" },
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );
      try {
        manager.input("terminal-cli", "cantrip\r");
        await expect
          .poll(() => output, { timeout: 5_000 })
          .toContain(
            `CANTRIP_TERMINAL_OK:${broker.connectionPath}:terminal-cli`,
          );
        manager.input("terminal-cli", "exit\r");
        await expect(exited).resolves.toMatchObject({
          status: "exited",
          exitCode: 0,
        });
      } finally {
        manager.closeAll();
        await broker.close();
      }
    },
  );

  it("publishes a protected authenticated loopback handshake", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      { binary },
    );

    const connection = await broker.start();
    try {
      expect(process.env[CANTRIP_CLI_CONNECTION_ENV]).toBe(
        broker.connectionPath,
      );
      expect((process.env[pathKey] ?? "").split(path.delimiter)[0]).toBe(
        directory,
      );
      expect(new URL(connection.endpoint).hostname).toBe("127.0.0.1");
      const stored = JSON.parse(
        await readFile(broker.connectionPath, "utf8"),
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({
        version: 1,
        endpoint: connection.endpoint,
        serverUrl: "https://cantrip.example",
        workerId: "worker-example",
      });
      expect(stored).not.toHaveProperty("credential");
      if (process.platform !== "win32") {
        expect((await stat(broker.connectionPath)).mode & 0o777).toBe(0o600);
      }

      const unauthorized = await fetch(`${connection.endpoint}/v1/handshake`);
      expect(unauthorized.status).toBe(401);
      const handshake = await fetch(`${connection.endpoint}/v1/handshake`, {
        headers: { authorization: `Bearer ${connection.sessionToken}` },
      });
      expect(handshake.status).toBe(200);
      await expect(handshake.json()).resolves.toEqual({
        protocolVersion: 1,
        serverUrl: "https://cantrip.example",
        workerId: "worker-example",
      });
    } finally {
      await broker.close();
    }
    await expect(access(broker.connectionPath)).rejects.toThrow();
  });

  it("authenticates and relays structured CLI commands", async () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const calls: unknown[] = [];
    const ownerId = "policy-cli-owner";
    const policyId = "00000000-0000-4000-8000-000000000201";
    const policyKey = randomBytes(32);
    const protectedPolicy = await encryptPolicyContent({
      ownerId,
      policyId,
      keyRevision: 1,
      componentKey: policyKey,
      summary: {
        version: 1,
        key: "manual-change-protocol",
        name: "Manual Change Protocol",
        summary: "Read the current policy before making manual changes.",
      },
      body: { version: 1, bodyMarkdown: "# Manual Change Protocol" },
    });
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      {
        binary,
        execute: async (request, requestId, chatContext) => {
          calls.push({ chatContext, request, requestId });
          return {
            summary: "Read the current policy.",
            target: null,
            worktreeId: "worktree-one",
            continuationScheduled: false,
            mutated: false,
            data:
              request.command === "policy.list"
                ? {
                    policies: [
                      {
                        id: policyId,
                        protectedSummary: protectedPolicy.protectedSummary,
                        mandatory: true,
                        sources: [{ type: "mandatory" }],
                      },
                    ],
                  }
                : {
                    policy: {
                      id: policyId,
                      content: protectedPolicy,
                      enabled: true,
                      mandatory: true,
                      position: 0,
                      templateKey: "manual-change-protocol",
                      rowVersion: 1,
                      workspaceAssignmentCount: 0,
                      projectAssignmentCount: 0,
                      createdAt: "2026-08-20T12:00:00.000Z",
                      updatedAt: "2026-08-20T12:00:00.000Z",
                    },
                  },
          };
        },
      },
    );
    broker.setPolicyEncryptionService({
      ownerId: () => ownerId,
      componentKey: () => ({ key: new Uint8Array(policyKey), keyRevision: 1 }),
    } as unknown as WorkerEncryptionService);
    broker.bindCodexThread("thread-one", {
      chatId: "chat-one",
      executionLaneId: "lane-one",
    });

    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "policy.read",
          context: {
            codexThreadId: "thread-one",
            terminalId: null,
            cwd: "/workspace/project",
          },
          arguments: { key: "manual-change-protocol" },
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: "Read policy manual-change-protocol.",
        worktreeId: "worktree-one",
        data: {
          policy: {
            key: "manual-change-protocol",
            bodyMarkdown: "# Manual Change Protocol",
          },
        },
      });
      expect(calls).toEqual([
        {
          chatContext: {
            chatId: "chat-one",
            executionLaneId: "lane-one",
          },
          request: expect.objectContaining({
            command: "policy.list",
            context: expect.objectContaining({ codexThreadId: "thread-one" }),
            arguments: {},
          }),
          requestId: expect.stringContaining(":policy-list"),
        },
        {
          chatContext: {
            chatId: "chat-one",
            executionLaneId: "lane-one",
          },
          request: expect.objectContaining({
            command: "policy.read",
            arguments: { policyId },
          }),
          requestId: expect.stringContaining(":policy-read"),
        },
      ]);

      const unauthorized = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await broker.close();
    }
    const serializedLogs = JSON.stringify(
      readWorkerLogs({
        afterCursor,
        limit: 200,
        minimumLevel: "trace",
      }).records,
    );
    expect(serializedLogs).toContain("cli.command.completed");
    expect(serializedLogs).toContain("policy.read");
    expect(serializedLogs).toContain("chat-one");
    expect(serializedLogs).not.toContain("/workspace/project");
    expect(serializedLogs).not.toContain("worker-token");
  });

  it("keeps Explorer paths and file content opaque to the server executor", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const serverId = "https://cantrip.example";
    const ownerId = "explorer-cli-owner";
    const surfaceId = "explorer-private";
    const sentinelPath = "private/customer-notes.md";
    const sentinelContent = "private Explorer file content";
    const componentKey = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const relayed: unknown[] = [];
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: serverId,
        token: "worker-token",
        workerId: "worker-example",
      },
      {
        binary,
        execute: async (request) => {
          relayed.push(request);
          if (request.command === "target.resolve-explorer") {
            return {
              summary: "Explorer resolved.",
              target: {
                kind: "surface",
                projectId: "project-one",
                surfaceKind: "explorer",
                surfaceId,
              },
              worktreeId: "worktree-one",
              data: { serverId },
            };
          }
          if (request.command !== "explorer.read") {
            throw new Error("Unexpected command.");
          }
          const operationId = String(request.arguments.operationId);
          const sequence = Number(request.arguments.sequence);
          const opened = await openWorkerSurfaceStreamContent({
            context: {
              serverId,
              surfaceKind: "explorer",
              surfaceId,
              operationId,
              direction: "request",
              sequence,
            },
            opaque: request.arguments.protectedRequest,
            schema: explorerOperationRequestContentSchema,
            service,
          });
          expect(opened).toEqual({
            type: "explorer.file.read",
            path: sentinelPath,
          });
          const protectedResponse = await protectWorkerSurfaceStreamContent({
            context: {
              serverId,
              surfaceKind: "explorer",
              surfaceId,
              operationId,
              direction: "response",
              sequence,
            },
            content: {
              ok: true as const,
              result: {
                type: "explorer.file" as const,
                value: {
                  path: sentinelPath,
                  content: sentinelContent,
                  size: sentinelContent.length,
                  markdown: true,
                  version: "a".repeat(64),
                },
              },
            },
            schema: surfaceOperationOutcomeContentSchema,
            service,
          });
          return {
            summary: "Encrypted Explorer operation completed.",
            target: {
              kind: "surface",
              projectId: "project-one",
              surfaceKind: "explorer",
              surfaceId,
            },
            worktreeId: "worktree-one",
            data: surfaceStreamWireResponseSchema.parse({
              operationId,
              sequence,
              protectedResponse,
            }),
          };
        },
      },
    );
    broker.setSurfacePrivateStateService(service);
    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "explorer.read",
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: "/workspace/project",
          },
          arguments: { target: surfaceId, path: sentinelPath },
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { path: sentinelPath, content: sentinelContent },
      });
      const serialized = JSON.stringify(relayed);
      expect(serialized).not.toContain(sentinelPath);
      expect(serialized).not.toContain(sentinelContent);
    } finally {
      await broker.close();
    }
  });

  it("encrypts browser URLs on the worker before relaying the command", async () => {
    const directory = await temporaryDirectory();
    const serverId = "https://cantrip.example";
    const ownerId = "browser-cli-owner";
    const workerId = "worker-example";
    const surfaceId = "browser-surface";
    const sentinelUrl = "https://private.example.test/cli-sentinel";
    const service = await WorkerEncryptionService.open({
      dataDirectory: path.join(directory, "worker-data"),
      serverUrl: serverId,
      workerId,
    });
    const registration = service.registration();
    const timestamp = "2026-08-20T12:00:00.000Z";
    const principal: EncryptionPrincipal = {
      id: registration.principalId,
      ownerId,
      kind: "worker",
      workerId,
      label: "Browser CLI worker",
      publicKey: registration.publicKey,
      state: "approved",
      revision: 1,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "surface-private-state",
      keyRevision: 1,
    });
    const wrappedKey = await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component: "surface-private-state",
      componentKey,
      keyRevision: 1,
      workerPublicKey: principal.publicKey,
    });
    const grant: EncryptionKeyGrant = {
      id: crypto.randomUUID(),
      ownerId,
      principalId: principal.id,
      component: "surface-private-state",
      keyRevision: 1,
      wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await service.acceptBootstrap({ ownerId, principal, grants: [grant] });

    const calls: unknown[] = [];
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: serverId,
        token: "worker-token",
        workerId,
      },
      {
        binary: path.join(directory, "cantrip"),
        execute: async (request) => {
          calls.push(request);
          if (request.command === "target.resolve-browser") {
            return {
              summary: "Resolved browser.",
              target: {
                kind: "surface",
                projectId: "browser-project",
                surfaceKind: "browser",
                surfaceId,
              },
              worktreeId: null,
              continuationScheduled: false,
              mutated: false,
              data: { serverId, stateRevision: 3 },
            };
          }
          return {
            summary: "Opened browser.",
            target: {
              kind: "surface",
              projectId: "browser-project",
              surfaceKind: "browser",
              surfaceId,
            },
            worktreeId: null,
            continuationScheduled: false,
            mutated: true,
          };
        },
      },
    );
    broker.setSurfacePrivateStateService(service);
    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "browser.open",
          context: { codexThreadId: null, terminalId: null, cwd: null },
          arguments: { target: surfaceId, url: sentinelUrl },
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(calls)).not.toContain(sentinelUrl);
      expect(calls).toHaveLength(2);
      const encrypted = calls[1] as {
        arguments: {
          expectedStateRevision: number;
          stateProtection: Parameters<
            typeof decryptSurfacePrivateState
          >[0]["opaque"];
        };
      };
      expect(encrypted.arguments.expectedStateRevision).toBe(3);
      await expect(
        decryptSurfacePrivateState({
          ownerId,
          context: {
            serverId,
            resource: "browser-row",
            resourceId: surfaceId,
            operationId: null,
            recordKind: "browser-state",
          },
          keyRevision: 1,
          componentKey,
          opaque: encrypted.arguments.stateProtection,
        }),
      ).resolves.toMatchObject({ revision: 4, url: sentinelUrl });
    } finally {
      clearSensitiveBytes(componentKey);
      await broker.close();
    }
  });

  it("reports server transport failures as unavailable", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      {
        binary,
        execute: async () => {
          throw new Error("server connection failed");
        },
      },
    );

    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "status",
          context: { codexThreadId: null, terminalId: null, cwd: null },
          arguments: {},
        }),
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
        error: "server connection failed",
      });
    } finally {
      await broker.close();
    }
  });
});
