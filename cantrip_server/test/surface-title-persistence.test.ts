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
  encryptSurfacePrivateState,
  encryptTaskProtectedContent,
  generateAccountMasterKey,
} from "../../packages/crypto/src/index.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

it("persists every app-facing private label and surface state only as authenticated ciphertext", async () => {
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
  const sentinel = "PROTECTED-APP-STATE-SENTINEL";
  const accountMasterKey = generateAccountMasterKey();
  const componentKey = deriveComponentKey({
    accountMasterKey,
    ownerId: LOCAL_USER_ID,
    component: "private-surface-metadata",
    keyRevision: 1,
  });
  const taskKey = deriveComponentKey({
    accountMasterKey,
    ownerId: LOCAL_USER_ID,
    component: "task-content",
    keyRevision: 1,
  });
  const surfaceStateKey = deriveComponentKey({
    accountMasterKey,
    ownerId: LOCAL_USER_ID,
    component: "surface-private-state",
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
      label: `${sentinel}-${recordKind}`,
    });
  const ids = {
    project: randomUUID(),
    chat: randomUUID(),
    task: randomUUID(),
    terminal: randomUUID(),
    explorer: randomUUID(),
    code: randomUUID(),
    browser: randomUUID(),
    desktop: randomUUID(),
    surface: randomUUID(),
    view: randomUUID(),
  } as const;
  const terminalStateProtection = await encryptSurfacePrivateState({
    ownerId: LOCAL_USER_ID,
    context: {
      serverId: "surface-title-server",
      resource: "terminal-row",
      resourceId: ids.terminal,
      operationId: null,
      recordKind: "terminal-state",
    },
    keyRevision: 1,
    componentKey: surfaceStateKey,
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: {
        kind: "relative-path",
        path: `${sentinel}/private-directory`,
      },
      serviceCommand: `${sentinel}-SERVICE-COMMAND`,
    },
  });
  const explorerStateProtection = await encryptSurfacePrivateState({
    ownerId: LOCAL_USER_ID,
    context: {
      serverId: "surface-title-server",
      resource: "explorer-row",
      resourceId: ids.explorer,
      operationId: null,
      recordKind: "explorer-state",
    },
    keyRevision: 1,
    componentKey: surfaceStateKey,
    content: {
      version: 1,
      classification: { recordKind: "explorer-state" },
      selectedPath: `${sentinel}/private-selection.ts`,
    },
  });
  const browserStateProtection = await encryptSurfacePrivateState({
    ownerId: LOCAL_USER_ID,
    context: {
      serverId: "surface-title-server",
      resource: "browser-row",
      resourceId: ids.browser,
      operationId: null,
      recordKind: "browser-state",
    },
    keyRevision: 1,
    componentKey: surfaceStateKey,
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: 1,
      url: `https://example.com/${sentinel}`,
    },
  });
  const browserRemoteSurfaceStateProtection = await encryptSurfacePrivateState({
    ownerId: LOCAL_USER_ID,
    context: {
      serverId: "surface-title-server",
      resource: "browser-remote-surface",
      resourceId: ids.surface,
      operationId: null,
      recordKind: "browser-state",
    },
    keyRevision: 1,
    componentKey: surfaceStateKey,
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: 1,
      url: `https://example.com/${sentinel}/remote`,
    },
  });
  const remoteDesktopStateProtection = await encryptSurfacePrivateState({
    ownerId: LOCAL_USER_ID,
    context: {
      serverId: "surface-title-server",
      resource: "remote-desktop-row",
      resourceId: ids.desktop,
      operationId: null,
      recordKind: "remote-desktop-state",
    },
    keyRevision: 1,
    componentKey: surfaceStateKey,
    content: {
      version: 1,
      classification: { recordKind: "remote-desktop-state" },
      revision: 1,
      target: {
        kind: "window",
        id: "private-window",
        application: `${sentinel}-application`,
        title: `${sentinel}-window`,
      },
    },
  });

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
        id: ids.project,
        nameProtection: await protectedTitle("project", ids.project),
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

    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      {
        id: ids.chat,
        titleProtection: await protectedTitle("chat", ids.chat),
        worktreeMode: "agent-managed",
      },
    );
    const taskContent = {
      version: 1 as const,
      classification: {
        state: "draft" as const,
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent" as const,
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: `${sentinel}-task-content`,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    };
    const task = await database.repository.createTask(
      LOCAL_USER_ID,
      project.id,
      {
        chatId: ids.task,
        titleProtection: await protectedTitle("chat", ids.task),
        task: {
          classification: taskContent.classification,
          protectedContent: await encryptTaskProtectedContent({
            ownerId: LOCAL_USER_ID,
            chatId: ids.task,
            keyRevision: 1,
            componentKey: taskKey,
            content: taskContent,
          }),
        },
      },
    );
    expect(chat).not.toBeNull();
    expect(task).not.toBeNull();

    const terminal = await database.repository.createTerminal(
      LOCAL_USER_ID,
      project.id,
      {
        id: ids.terminal,
        titleProtection: await protectedTitle("terminal", ids.terminal),
        stateProtection: terminalStateProtection,
      },
      () => true,
    );
    const initialLayout = await database.repository.tabLayouts.get(
      LOCAL_USER_ID,
      project.id,
    );
    const groupId = initialLayout!.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === ids.terminal),
    )!.id;
    const explorer = await database.repository.createExplorer(
      LOCAL_USER_ID,
      project.id,
      {
        id: ids.explorer,
        titleProtection: await protectedTitle("explorer", ids.explorer),
        stateProtection: explorerStateProtection,
        tabGroupId: groupId,
      },
      () => true,
    );
    const groupedLayout = await database.repository.tabLayouts.get(
      LOCAL_USER_ID,
      project.id,
    );
    await database.repository.tabLayouts.updateGroup(
      LOCAL_USER_ID,
      project.id,
      groupId,
      {
        revision: groupedLayout!.revision,
        titleProtection: await protectedTitle("tab-group", groupId),
      },
    );
    const created = await Promise.all([
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
          stateProtection: browserStateProtection,
        },
        () => true,
      ),
      database.repository.createRemoteDesktop(
        LOCAL_USER_ID,
        project.id,
        ids.desktop,
        await protectedTitle("project-view", ids.desktop),
        "surface-title-worker",
        remoteDesktopStateProtection,
      ),
      database.repository.createRemoteSurface(LOCAL_USER_ID, project.id, {
        id: ids.surface,
        workerId: "surface-title-worker",
        titleProtection: await protectedTitle("remote-surface", ids.surface),
        stateProtection: browserRemoteSurfaceStateProtection,
        configuration: {
          kind: "browser",
          profileId: null,
        },
      }),
      database.repository.createProjectView(LOCAL_USER_ID, project.id, {
        id: ids.view,
        kind: "issues",
        titleProtection: await protectedTitle("project-view", ids.view),
      }),
    ]);
    expect(terminal).not.toBeNull();
    expect(explorer).not.toBeNull();
    expect(created.every(Boolean)).toBe(true);
    expect(
      JSON.stringify([project, chat, task, terminal, explorer, created]),
    ).not.toContain(sentinel);
    await database.repository.updateTerminalService(
      LOCAL_USER_ID,
      ids.terminal,
      { enabled: true, stateProtection: terminalStateProtection },
    );
    const services = await database.repository.listTerminalServicesForWorker(
      "surface-title-worker",
      "surface-title-server",
    );
    const terminalContext =
      await database.repository.getTerminalExecutionContext(
        LOCAL_USER_ID,
        ids.terminal,
      );
    expect(JSON.stringify([services, terminalContext])).not.toContain(sentinel);
    expect(services[0]).not.toHaveProperty("cwd");
    expect(services[0]).not.toHaveProperty("command");
    expect(terminalContext).not.toHaveProperty("cwd");
    expect(terminalContext).not.toHaveProperty("service");
    const updatedExplorer = await database.repository.updateExplorerViewState(
      LOCAL_USER_ID,
      ids.explorer,
      { fileMode: "edit", stateProtection: explorerStateProtection },
    );
    expect(updatedExplorer).toMatchObject({ fileMode: "edit" });
    expect(JSON.stringify(updatedExplorer)).not.toContain(sentinel);
  } finally {
    clearSensitiveBytes(surfaceStateKey);
    clearSensitiveBytes(taskKey);
    clearSensitiveBytes(componentKey);
    clearSensitiveBytes(accountMasterKey);
    await database.close();
  }

  const scan = new PGlite(path.join(dataDirectory, "server-db"));
  try {
    const databaseTables = await scan.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    for (const { tablename } of databaseTables.rows) {
      const rows = await scan.query<{ record: string }>(
        `SELECT row_to_json(row)::text AS record FROM "${tablename}" row`,
      );
      expect(JSON.stringify(rows.rows), tablename).not.toContain(sentinel);
    }

    for (const table of [
      "projects",
      "chats",
      "terminals",
      "explorers",
      "code_tabs",
      "browsers",
      "project_views",
      "remote_surfaces",
      "tab_groups",
    ]) {
      const rows = await scan.query<{ record: string }>(
        `SELECT row_to_json(row)::text AS record FROM ${table} row`,
      );
      expect(JSON.stringify(rows.rows), table).not.toContain(sentinel);
      const columns = await scan.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const names = columns.rows.map(({ column_name }) => column_name);
      expect(names, table).toContain("protected_label");
      expect(names, table).not.toContain(
        table === "projects" ? "name" : "title",
      );
      if (table === "terminals") {
        expect(names).toContain("protected_state");
        expect(names).not.toContain("directory_path");
        expect(names).not.toContain("service_command");
      }
      if (table === "explorers") {
        expect(names).toContain("protected_state");
        expect(names).not.toContain("selected_path");
      }
      if (table === "browsers") {
        expect(names).toContain("protected_state");
        expect(names).toContain("state_revision");
        expect(names).not.toContain("url");
      }
      if (table === "remote_surfaces") {
        expect(names).toContain("protected_state");
        expect(names).toContain("state_revision");
      }
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
    const desktopStorage = await scan.query<{
      configuration: unknown;
      protected_state: unknown;
      state_revision: number;
    }>(
      `SELECT configuration, protected_state, state_revision
       FROM remote_surfaces WHERE id = $1`,
      [ids.desktop],
    );
    expect(desktopStorage.rows[0]).toMatchObject({
      configuration: { kind: "desktop" },
      protected_state: remoteDesktopStateProtection,
      state_revision: 1,
    });
    await expect(
      scan.query(
        `UPDATE remote_surfaces
         SET configuration = '{"kind":"desktop","target":{"kind":"monitor"}}'::jsonb
         WHERE id = $1`,
        [ids.desktop],
      ),
    ).rejects.toThrow(
      /remote_surfaces_(?:public_configuration|desktop_private_state)_check/u,
    );
    await expect(
      scan.query(
        `UPDATE remote_surfaces
         SET configuration = '{"kind":"browser","profileId":null,"initialUrl":"https://private.example"}'::jsonb
         WHERE id = $1`,
        [ids.browser],
      ),
    ).rejects.toThrow(/remote_surfaces_public_configuration_check/u);

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
