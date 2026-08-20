import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { expect, it } from "vitest";

import {
  clearSensitiveBytes,
  deriveComponentKey,
  encryptPrivateDisplayLabel,
  generateAccountMasterKey,
} from "../../packages/crypto/src/index.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import {
  protectedDisplayLabelFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

it("persists custom tab-group titles only as authenticated ciphertext", async () => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-tab-group-title-persistence-"),
  );
  const config: ServerConfig = {
    agentModel: "gemma4:26b",
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
  const accountMasterKey = generateAccountMasterKey();
  const componentKey = deriveComponentKey({
    accountMasterKey,
    ownerId: LOCAL_USER_ID,
    component: "private-surface-metadata",
    keyRevision: 1,
  });

  let groupId = "";
  let projectId = "";
  const database = await connectDatabase(config);
  try {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "tab-group-title-worker",
      name: "Tab Group Title Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.147.0",
      codexRuntime: unprobedCodexRuntimeReport,
      startedAt: new Date().toISOString(),
    });
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "tab-group-title-worker",
        ...protectedProjectFields(),
        repositoryId: "tab-group-title-repository",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    );
    projectId = project.id;
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      "tab-group-title-worker",
      {
        path: path.join(dataDirectory, "repository"),
        displayPath: "ArcaneArts/Cantrip",
        reused: false,
        updated: false,
        warning: null,
      },
    );
    const terminal = await database.repository.createTerminal(
      LOCAL_USER_ID,
      project.id,
      protectedTerminalFields(),
    );
    expect(terminal).not.toBeNull();
    let layout = await database.repository.tabLayouts.get(
      LOCAL_USER_ID,
      project.id,
    );
    groupId = layout!.groups[0]!.id;
    const explorer = await database.repository.createExplorer(
      LOCAL_USER_ID,
      project.id,
      {
        ...protectedDisplayLabelFields("explorer"),
        tabGroupId: groupId,
      },
    );
    expect(explorer).not.toBeNull();
    layout = await database.repository.tabLayouts.get(
      LOCAL_USER_ID,
      project.id,
    );
    const titleProtection = await encryptPrivateDisplayLabel({
      ownerId: LOCAL_USER_ID,
      recordKind: "tab-group",
      rowId: groupId,
      keyRevision: 1,
      componentKey,
      label: "TAB-GROUP-TITLE-SENTINEL",
    });
    const renamed = await database.repository.tabLayouts.updateGroup(
      LOCAL_USER_ID,
      project.id,
      groupId,
      { revision: layout!.revision, titleProtection },
    );
    expect(renamed?.groups[0]).toMatchObject({
      id: groupId,
      titleProtection: {
        classification: { recordKind: "tab-group" },
      },
    });
    expect(JSON.stringify(renamed)).not.toContain("TAB-GROUP-TITLE-SENTINEL");
  } finally {
    await database.close();
  }

  const restored = await connectDatabase(config);
  try {
    const layout = await restored.repository.tabLayouts.get(
      LOCAL_USER_ID,
      projectId,
    );
    expect(layout?.groups.find(({ id }) => id === groupId)).toMatchObject({
      titleProtection: {
        classification: { recordKind: "tab-group" },
      },
      members: expect.arrayContaining([
        expect.objectContaining({ tabKind: "terminal" }),
        expect.objectContaining({ tabKind: "explorer" }),
      ]),
    });
    expect(JSON.stringify(layout)).not.toContain("TAB-GROUP-TITLE-SENTINEL");
  } finally {
    await restored.close();
  }

  const scan = new PGlite(path.join(dataDirectory, "server-db"));
  try {
    const rows = await scan.query<{ record: string }>(
      "SELECT row_to_json(row)::text AS record FROM tab_groups row",
    );
    expect(JSON.stringify(rows.rows)).not.toContain("TAB-GROUP-TITLE-SENTINEL");
    const columns = await scan.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tab_groups'`,
    );
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toContain("protected_label");
    expect(names).not.toContain("title");
    const protectedRows = await scan.query<{ protected_label: unknown }>(
      "SELECT protected_label FROM tab_groups WHERE id = $1",
      [groupId],
    );
    expect(protectedRows.rows[0]?.protected_label).toBeTruthy();
  } finally {
    clearSensitiveBytes(componentKey);
    clearSensitiveBytes(accountMasterKey);
    await scan.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
