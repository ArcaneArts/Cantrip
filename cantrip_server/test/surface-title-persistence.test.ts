import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import type { PrivateDisplayLabelRecordKind } from "@cantrip/protocol/private-labels";
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

import { protectedProjectFields } from "./private-label-fixture.js";

it("persists surface and project-view titles only as authenticated ciphertext", async () => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-surface-title-persistence-"),
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
  const protectedTitle = async (
    recordKind: PrivateDisplayLabelRecordKind,
    rowId: string,
  ) =>
    encryptPrivateDisplayLabel({
      ownerId: LOCAL_USER_ID,
      recordKind,
      rowId,
      keyRevision: 1,
      componentKey,
      label: `SURFACE-TITLE-SENTINEL-${recordKind}`,
    });
  const ids = {
    terminal: randomUUID(),
    explorer: randomUUID(),
    code: randomUUID(),
    browser: randomUUID(),
    desktop: randomUUID(),
    surface: randomUUID(),
    view: randomUUID(),
  } as const;

  const database = await connectDatabase(config);
  try {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "surface-title-worker",
      name: "Surface Title Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.147.0",
      codexRuntime: unprobedCodexRuntimeReport,
      code: {
        available: true,
        version: "1.109.5",
        upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
        patchset: 1,
        transport: "web-proxy",
        maxSessions: 4,
        reason: null,
      },
      remoteSurfaces: {
        browser: true,
        desktop: true,
        transports: ["websocket"],
        maxSessions: 8,
      },
      startedAt: new Date().toISOString(),
    });
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "surface-title-worker",
        ...protectedProjectFields(),
        repositoryId: "surface-title-repository",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    );
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      "surface-title-worker",
      {
        path: path.join(dataDirectory, "repository"),
        displayPath: "ArcaneArts/Cantrip",
        reused: false,
        updated: false,
        warning: null,
      },
    );

    const created = await Promise.all([
      database.repository.createTerminal(
        LOCAL_USER_ID,
        project.id,
        {
          id: ids.terminal,
          titleProtection: await protectedTitle("terminal", ids.terminal),
        },
        () => true,
      ),
      database.repository.createExplorer(
        LOCAL_USER_ID,
        project.id,
        {
          id: ids.explorer,
          titleProtection: await protectedTitle("explorer", ids.explorer),
        },
        () => true,
      ),
      database.repository.createCodeTab(
        LOCAL_USER_ID,
        project.id,
        {
          id: ids.code,
          profileId: "default",
          themeMode: "follow-cantrip",
          titleProtection: await protectedTitle("code-tab", ids.code),
        },
        () => true,
      ),
      database.repository.createBrowser(
        LOCAL_USER_ID,
        project.id,
        {
          id: ids.browser,
          titleProtection: await protectedTitle("browser", ids.browser),
        },
        () => true,
      ),
      database.repository.createRemoteDesktop(
        LOCAL_USER_ID,
        project.id,
        ids.desktop,
        await protectedTitle("project-view", ids.desktop),
        "surface-title-worker",
      ),
      database.repository.createRemoteSurface(LOCAL_USER_ID, project.id, {
        id: ids.surface,
        workerId: "surface-title-worker",
        titleProtection: await protectedTitle("remote-surface", ids.surface),
        configuration: {
          kind: "browser",
          initialUrl: "https://example.com",
          profileId: null,
        },
      }),
      database.repository.createProjectView(LOCAL_USER_ID, project.id, {
        id: ids.view,
        kind: "issues",
        titleProtection: await protectedTitle("project-view", ids.view),
      }),
    ]);
    expect(created.every(Boolean)).toBe(true);
    expect(JSON.stringify(created)).not.toContain("SURFACE-TITLE-SENTINEL");
  } finally {
    clearSensitiveBytes(componentKey);
    clearSensitiveBytes(accountMasterKey);
    await database.close();
  }

  const scan = new PGlite(path.join(dataDirectory, "server-db"));
  try {
    for (const table of [
      "terminals",
      "explorers",
      "code_tabs",
      "browsers",
      "project_views",
      "remote_surfaces",
    ]) {
      const rows = await scan.query<{ record: string }>(
        `SELECT row_to_json(row)::text AS record FROM ${table} row`,
      );
      expect(JSON.stringify(rows.rows), table).not.toContain(
        "SURFACE-TITLE-SENTINEL",
      );
      const columns = await scan.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const names = columns.rows.map(({ column_name }) => column_name);
      expect(names, table).toContain("protected_label");
      expect(names, table).not.toContain("title");
    }

    const remoteLabels = await scan.query<{
      id: string;
      protected_label: unknown | null;
    }>(
      `SELECT id, protected_label
       FROM remote_surfaces
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[ids.browser, ids.desktop, ids.surface]],
    );
    expect(
      remoteLabels.rows.find(({ id }) => id === ids.browser)?.protected_label,
    ).toBeNull();
    expect(
      remoteLabels.rows.find(({ id }) => id === ids.desktop)?.protected_label,
    ).toBeNull();
    expect(
      remoteLabels.rows.find(({ id }) => id === ids.surface)?.protected_label,
    ).not.toBeNull();

    const canonicalLabels = await scan.query<{ protected_label: unknown }>(
      `SELECT protected_label FROM browsers WHERE id = $1
       UNION ALL
       SELECT protected_label FROM project_views WHERE id = ANY($2::text[])`,
      [ids.browser, [ids.desktop, ids.view]],
    );
    expect(canonicalLabels.rows).toHaveLength(3);
    expect(
      canonicalLabels.rows.every(({ protected_label }) =>
        Boolean(protected_label),
      ),
    ).toBe(true);
  } finally {
    await scan.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
