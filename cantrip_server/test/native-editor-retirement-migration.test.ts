import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { expect, it } from "vitest";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import { SecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";
import {
  protectedDisplayLabelFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));

it("retires the workbench while preserving native tab ciphertext, placement and file authority", async () => {
  const client = new PGlite();
  try {
    // Upgrade the actual pre-removal schema, rather than mocking a runtime table.
    for (const name of (await readdir(migrations))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort()) {
      if (name.startsWith("0229_")) break;
      await client.exec(await readFile(`${migrations}/${name}`, "utf8"));
    }
    const database = drizzle(client, { schema });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: randomBytes(32) }],
      }),
    );
    await repository.ensureLocalIdentity();
    await repository.ensureDefaultModelConfiguration(
      LOCAL_USER_ID,
      "test-model",
      "http://127.0.0.1:11434/v1",
    );
    const workerId = "native-editor-worker";
    await repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name: "Native editor",
      platform: "linux",
      architecture: "x64",
      codexVersion: null,
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    const project = await repository.createGithubProject(LOCAL_USER_ID, {
      workerId,
      ...protectedProjectFields(),
      repositoryBlindIndex: "R".repeat(43),
      repositoryId: "native-editor",
      nameWithOwner: "fixture/native-editor",
      url: "https://github.com/fixture/native-editor",
    });
    await repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      workerId,
      {
        path: "/tmp/native-editor-fixture",
        displayPath: "fixture/native-editor",
        reused: false,
        updated: false,
        warning: null,
      },
    );
    const fields = protectedDisplayLabelFields("code-tab");
    const tab = await repository.createCodeTab(
      LOCAL_USER_ID,
      project.id,
      fields,
      () => true,
    );
    expect(tab).not.toBeNull();
    const layout = await repository.tabLayouts.get(LOCAL_USER_ID, project.id);
    const retiredTunnelId = randomUUID();
    const retainedTunnelId = randomUUID();
    const tunnelFields = {
      ownerId: LOCAL_USER_ID,
      projectId: project.id,
      protocolHint: "http-websocket",
      sourceKind: "desktop-loopback",
      destinationWorkerId: workerId,
      protectedRevision: 1,
      protectedContent: {
        ...fields.titleProtection.protectedLabel,
        domain: "tunnel-content" as const,
      },
    };
    await database.insert(schema.tunnels).values([
      {
        ...tunnelFields,
        id: retiredTunnelId,
        origin: "code",
        management: "managed-ephemeral",
        destinationKind: "worker-adapter",
        destinationAdapter: "code",
        destinationResourceId: retiredTunnelId,
        protectedOperationId: retiredTunnelId,
        managedByKind: "code",
        managedById: retiredTunnelId,
      },
      {
        ...tunnelFields,
        id: retainedTunnelId,
        origin: "user",
        management: "user-managed",
        destinationKind: "worker-tcp",
        protectedOperationId: retainedTunnelId,
      },
    ]);
    await database.insert(schema.tunnelAttachments).values(
      [retiredTunnelId, retainedTunnelId].map((tunnelId) => ({
        id: tunnelId,
        tunnelId,
        kind: "desktop-loopback",
      })),
    );
    await client.query(
      `INSERT INTO code_settings_profiles (owner_id, profile_id, revision, protected_operation_id, protected_content) VALUES ($1,'default',1,$2,$3)`,
      [
        LOCAL_USER_ID,
        randomUUID(),
        {
          ...tunnelFields.protectedContent,
          domain: "customization-content",
        },
      ],
    );
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO code_sessions (id, code_tab_id, project_id, worker_id, worktree_id, profile_id, editor_version, editor_upstream_revision, editor_patchset, editor_fingerprint) VALUES ($1,$2,$3,$4,$5,'default','old-editor',$6,1,$7)`,
      [
        sessionId,
        tab!.id,
        project.id,
        workerId,
        tab!.worktreeId,
        "a".repeat(40),
        "b".repeat(64),
      ],
    );
    await client.exec(
      await readFile(`${migrations}/0229_remove_vscode_runtime.sql`, "utf8"),
    );
    expect(await repository.listCodeTabs(LOCAL_USER_ID, project.id)).toEqual([
      tab,
    ]);
    expect(await repository.tabLayouts.get(LOCAL_USER_ID, project.id)).toEqual(
      layout,
    );
    expect((await client.query(`SELECT id FROM tunnels`)).rows).toEqual([
      { id: retainedTunnelId },
    ]);
    expect(
      (await client.query(`SELECT tunnel_id FROM tunnel_attachments`)).rows,
    ).toEqual([{ tunnel_id: retainedTunnelId }]);
    expect(
      await repository.getExplorerExecutionContext(LOCAL_USER_ID, tab!.id),
    ).toMatchObject({
      explorerId: tab!.id,
      workerId,
      worktreeId: tab!.worktreeId,
      root: "/tmp/native-editor-fixture",
    });
    expect(
      await repository.getExplorerExecutionContext("another-owner", tab!.id),
    ).toBeNull();
    const tables = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_name IN ('code_sessions','code_settings_profiles')`,
    );
    expect(tables.rows).toEqual([]);
    const columns = await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE (table_name='code_tabs' AND column_name IN ('profile_id','theme_mode','status','last_error')) OR (table_name='workers' AND column_name='code_capabilities')`,
    );
    expect(columns.rows).toEqual([]);
  } finally {
    await client.close();
  }
}, 60_000);
