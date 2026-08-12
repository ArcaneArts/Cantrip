import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { MCP_SECRET_MASK } from "@cantrip/protocol";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const key = (fill: number) => Buffer.alloc(32, fill);

describe("MCP secret persistence", () => {
  it("encrypts, masks, preserves, copies, migrates, and rotates secret maps", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const oldVault = new SecretVault({
        activeKeyId: "old",
        keys: [{ id: "old", key: key(7) }],
      });
      const repository = new ServerRepository(database, oldVault);
      await repository.ensureLocalIdentity();
      const sourceProject = await repository.createGithubProject(
        LOCAL_USER_ID,
        {
          workerId: "worker-1",
          repositoryId: "repo-source",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        },
      );
      const targetProject = await repository.createGithubProject(
        LOCAL_USER_ID,
        {
          workerId: "worker-1",
          repositoryId: "repo-target",
          nameWithOwner: "ArcaneArts/Iris",
          url: "https://github.com/ArcaneArts/Iris",
        },
      );

      const created = await repository.createMcpServer(
        LOCAL_USER_ID,
        sourceProject.id,
        {
          name: "github",
          transport: "http",
          url: "https://mcp.example.test",
          bearerTokenEnvironmentVariable: null,
          headers: {
            Authorization: "Bearer server-secret",
            "X-Organization": "cantrip",
          },
          environmentHeaders: { "X-Token": "MCP_TOKEN" },
          enabled: true,
        },
      );
      expect(created?.headers).toEqual({
        Authorization: MCP_SECRET_MASK,
        "X-Organization": MCP_SECRET_MASK,
      });

      let stored = await client.query<{
        headers: Record<string, string>;
        headers_envelope: string | null;
      }>(
        `SELECT headers, headers_envelope FROM mcp_servers WHERE id = '${created!.id}'`,
      );
      expect(stored.rows[0]?.headers).toEqual({});
      expect(stored.rows[0]?.headers_envelope).not.toContain("server-secret");
      expect(
        (
          await repository.listEffectiveMcpServers(
            LOCAL_USER_ID,
            sourceProject.id,
          )
        )[0],
      ).toMatchObject({
        headers: {
          Authorization: "Bearer server-secret",
          "X-Organization": "cantrip",
        },
      });

      await repository.updateMcpServer(
        LOCAL_USER_ID,
        sourceProject.id,
        created!.id,
        {
          name: "github",
          transport: "http",
          url: "https://mcp.example.test/v2",
          bearerTokenEnvironmentVariable: null,
          headers: {
            Authorization: MCP_SECRET_MASK,
            "X-Organization": "changed",
          },
          environmentHeaders: { "X-Token": "MCP_TOKEN" },
          enabled: true,
        },
      );
      expect(
        (
          await repository.listEffectiveMcpServers(
            LOCAL_USER_ID,
            sourceProject.id,
          )
        )[0],
      ).toMatchObject({
        headers: {
          Authorization: "Bearer server-secret",
          "X-Organization": "changed",
        },
      });

      const copied = await repository.copyProjectMcpServer(
        LOCAL_USER_ID,
        targetProject.id,
        sourceProject.id,
        created!.id,
      );
      expect(copied?.headers.Authorization).toBe(MCP_SECRET_MASK);
      expect(
        (
          await repository.listEffectiveMcpServers(
            LOCAL_USER_ID,
            targetProject.id,
          )
        )[0],
      ).toMatchObject({ headers: { Authorization: "Bearer server-secret" } });

      await client.exec(`
        INSERT INTO mcp_servers (
          id, owner_id, project_id, name, transport, command, environment
        ) VALUES (
          'legacy-mcp', '${LOCAL_USER_ID}', '${sourceProject.id}', 'legacy',
          'stdio', 'legacy-command', '{"API_TOKEN":"legacy-secret"}'::jsonb
        );
      `);
      await repository.migrateMcpServerSecrets();
      const legacy = await client.query<{
        environment: Record<string, string>;
        environment_envelope: string | null;
      }>(
        "SELECT environment, environment_envelope FROM mcp_servers WHERE id = 'legacy-mcp'",
      );
      expect(legacy.rows[0]?.environment).toEqual({});
      expect(legacy.rows[0]?.environment_envelope).not.toContain(
        "legacy-secret",
      );

      const rotatingRepository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "new",
          keys: [
            { id: "new", key: key(8) },
            { id: "old", key: key(7) },
          ],
        }),
      );
      await rotatingRepository.migrateMcpServerSecrets();
      stored = await client.query<{
        headers: Record<string, string>;
        headers_envelope: string | null;
      }>(
        `SELECT headers, headers_envelope FROM mcp_servers WHERE id = '${created!.id}'`,
      );
      expect(JSON.parse(stored.rows[0]!.headers_envelope!)).toMatchObject({
        keyId: "new",
        version: 1,
      });
      expect(
        (
          await rotatingRepository.listEffectiveMcpServers(
            LOCAL_USER_ID,
            sourceProject.id,
          )
        ).find(({ name }) => name === "github"),
      ).toMatchObject({ headers: { Authorization: "Bearer server-secret" } });
    } finally {
      await client.close();
    }
  });
});
