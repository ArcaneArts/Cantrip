import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import { protectedProjectFields } from "./private-label-fixture.js";

function testConfig(dataDirectory: string): ServerConfig {
  return {
    agentModel: "test-model",
    agentModelProvider: "ollama",
    appOrigins: ["http://127.0.0.1:5173"],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    workerToken: "test-worker-token",
  };
}

describe("MCP server settings repository", () => {
  it("reserves the managed CodeGraph name case-insensitively", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-mcp-reserved-"),
    );
    const database = await connectDatabase(testConfig(dataDirectory));
    try {
      await expect(
        database.repository.createMcpServer(LOCAL_USER_ID, null, {
          name: "CodeGraph",
          transport: "stdio",
          command: "shadow",
          args: [],
          environment: {},
          enabled: false,
        }),
      ).rejects.toThrow("managed by Cantrip");

      const mutable = await database.repository.createMcpServer(
        LOCAL_USER_ID,
        null,
        {
          name: "mutable",
          transport: "stdio",
          command: "example",
          args: [],
          environment: {},
          enabled: true,
        },
      );
      await expect(
        database.repository.updateMcpServer(LOCAL_USER_ID, null, mutable!.id, {
          name: "CODEGRAPH",
          transport: "stdio",
          command: "shadow",
          args: [],
          environment: {},
          enabled: true,
        }),
      ).rejects.toThrow("managed by Cantrip");
    } finally {
      await database.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("inherits globals, overrides by project, and copies independent configurations", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-mcp-settings-"),
    );
    const database = await connectDatabase(testConfig(dataDirectory));
    try {
      const sourceProject = await database.repository.createGithubProject(
        LOCAL_USER_ID,
        {
          workerId: "worker-1",
          ...protectedProjectFields(),
          repositoryId: "repository-1",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        },
      );
      const targetProject = await database.repository.createGithubProject(
        LOCAL_USER_ID,
        {
          workerId: "worker-1",
          ...protectedProjectFields(),
          repositoryId: "repository-2",
          nameWithOwner: "ArcaneArts/Iris",
          url: "https://github.com/ArcaneArts/Iris",
        },
      );

      await database.repository.createMcpServer(LOCAL_USER_ID, null, {
        name: "shared",
        transport: "stdio",
        command: "global-command",
        args: [],
        environment: {},
        enabled: true,
      });
      await database.repository.createMcpServer(
        LOCAL_USER_ID,
        sourceProject.id,
        {
          name: "shared",
          transport: "http",
          url: "https://project.example/mcp",
          bearerTokenEnvironmentVariable: null,
          headers: {},
          environmentHeaders: {},
          enabled: true,
        },
      );
      const sourceOnly = await database.repository.createMcpServer(
        LOCAL_USER_ID,
        sourceProject.id,
        {
          name: "database",
          transport: "stdio",
          command: "database-command",
          args: ["serve"],
          environment: { DATABASE_URL: "postgres://localhost/cantrip" },
          enabled: true,
        },
      );
      expect(sourceOnly).not.toBeNull();

      const sourceEffective = await database.repository.listEffectiveMcpServers(
        LOCAL_USER_ID,
        sourceProject.id,
      );
      expect(sourceEffective).toHaveLength(2);
      expect(
        sourceEffective.find(({ name }) => name === "shared"),
      ).toMatchObject({
        transport: "http",
        url: "https://project.example/mcp",
      });

      const targetEffective = await database.repository.listEffectiveMcpServers(
        LOCAL_USER_ID,
        targetProject.id,
      );
      expect(targetEffective).toEqual([
        expect.objectContaining({
          name: "shared",
          transport: "stdio",
          command: "global-command",
        }),
      ]);

      const copied = await database.repository.copyProjectMcpServer(
        LOCAL_USER_ID,
        targetProject.id,
        sourceProject.id,
        sourceOnly!.id,
      );
      expect(copied).toMatchObject({
        name: "database",
        projectId: targetProject.id,
        scope: "project",
      });
      expect(copied?.id).not.toBe(sourceOnly?.id);

      await database.repository.updateMcpServer(
        LOCAL_USER_ID,
        sourceProject.id,
        sourceOnly!.id,
        {
          name: "database",
          transport: "stdio",
          command: "changed-source-command",
          args: [],
          environment: {},
          enabled: true,
        },
      );
      const targetServers = await database.repository.listMcpServers(
        LOCAL_USER_ID,
        targetProject.id,
      );
      expect(targetServers?.[0]).toMatchObject({
        command: "database-command",
        args: ["serve"],
      });

      await expect(
        database.repository.copyProjectMcpServer(
          LOCAL_USER_ID,
          targetProject.id,
          sourceProject.id,
          sourceOnly!.id,
        ),
      ).rejects.toThrow();
      await expect(
        database.repository.listMcpServers(LOCAL_USER_ID, "missing-project"),
      ).resolves.toBeNull();
    } finally {
      await database.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
