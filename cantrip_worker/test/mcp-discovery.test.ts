import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decryptProtectedSecret, randomBytes } from "@cantrip/crypto";
import { mcpServerConfigurationSchema } from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { discoverMcpConfigurations } from "../src/mcp/discovery.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const temporaryDirectories: string[] = [];
const ownerId = "mcp-discovery-owner";
const workerId = "mcp-discovery-worker";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("worker MCP configuration discovery", () => {
  it("encrypts supported Codex and Claude Code entries before returning them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-discovery-"));
    temporaryDirectories.push(root);
    const home = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(projectRoot, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.codex_private]",
        'command = "npx"',
        'args = ["-y", "private-package-sentinel"]',
        "[mcp_servers.codex_private.env]",
        'PRIVATE_TOKEN = "codex-secret-sentinel"',
        "[mcp_servers.cantrip]",
        'command = "must-not-import"',
      ].join("\n"),
    );
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          claude_private: {
            type: "http",
            url: "http://127.0.0.1:4545/private-sentinel",
            headers: { Authorization: "Bearer claude-secret-sentinel" },
          },
          legacy_private: { type: "sse", url: "http://secret-sse.invalid" },
        },
        projects: {
          [projectRoot]: {
            mcpServers: {
              project_private: {
                command: "project-command-sentinel",
                args: ["project-argument-sentinel"],
              },
            },
          },
        },
      }),
    );
    await writeFile(
      path.join(projectRoot, ".codex", "config.toml"),
      [
        "[mcp_servers.project_codex_private]",
        'url = "https://project-codex-sentinel.invalid/mcp"',
        "[mcp_servers.project_codex_private.http_headers]",
        'Authorization = "Bearer project-secret-sentinel"',
      ].join("\n"),
    );

    const componentKey = randomBytes(32);
    const service = {
      componentKey() {
        return { key: new Uint8Array(componentKey), keyRevision: 1 };
      },
      ownerId: () => ownerId,
    } as WorkerEncryptionService;
    const result = await discoverMcpConfigurations({
      workerId,
      projectRoot,
      service,
      homeDirectory: home,
      runningHttpDiscovery: async () => [
        mcpServerConfigurationSchema.parse({
          name: "running-private-4777",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:4777/mcp-private-sentinel",
          bearerTokenEnvironmentVariable: null,
          headers: {},
          environmentHeaders: {},
        }),
      ],
    });

    expect(result.candidates).toHaveLength(5);
    expect(
      result.candidates.every(
        ({ configuration }) => configuration.workerId === workerId,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    for (const sentinel of [
      "codex_private",
      "codex-secret-sentinel",
      "claude_private",
      "claude-secret-sentinel",
      "project_private",
      "project-command-sentinel",
      "project_codex_private",
      "project-secret-sentinel",
      "legacy_private",
      "running-private-4777",
      "mcp-private-sentinel",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }

    const opened = await Promise.all(
      result.candidates.map(({ configuration }) =>
        decryptProtectedSecret({
          ownerId,
          component: "mcp-secret",
          table: "mcp_servers",
          rowId: configuration.id,
          field: "protected_configuration",
          keyRevision: 1,
          componentKey,
          encrypted: configuration.protectedConfiguration,
          contentSchema: mcpServerConfigurationSchema,
        }),
      ),
    );
    expect(opened.map(({ name }) => name).sort()).toEqual([
      "claude_private",
      "codex_private",
      "project_codex_private",
      "project_private",
      "running-private-4777",
    ]);
    expect(result.issues).toEqual([
      {
        source: "claude",
        sourceScope: "user",
        code: "unsupported-transport",
        message:
          "An MCP entry does not use a supported stdio or HTTP transport.",
      },
    ]);
  });
});
