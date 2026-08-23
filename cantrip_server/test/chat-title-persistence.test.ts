import { randomUUID } from "node:crypto";
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

import { protectedProjectFields } from "./private-label-fixture.js";

it("persists chat titles only as authenticated ciphertext", async () => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-chat-title-persistence-"),
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
  const sentinel = "CHAT-TITLE-SENTINEL never persist this plaintext";
  const chatId = randomUUID();
  const accountMasterKey = generateAccountMasterKey();
  const componentKey = deriveComponentKey({
    accountMasterKey,
    ownerId: LOCAL_USER_ID,
    component: "private-surface-metadata",
    keyRevision: 1,
  });
  const titleProtection = await encryptPrivateDisplayLabel({
    ownerId: LOCAL_USER_ID,
    recordKind: "chat",
    rowId: chatId,
    keyRevision: 1,
    componentKey,
    label: sentinel,
  });
  clearSensitiveBytes(componentKey);
  clearSensitiveBytes(accountMasterKey);

  const database = await connectDatabase(config);
  try {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "chat-title-worker",
      name: "Chat Title Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.149.0",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "chat-title-worker",
        ...protectedProjectFields(),
        repositoryId: "chat-title-repository",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    );
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      "chat-title-worker",
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
        id: chatId,
        titleProtection,
        worktreeMode: "agent-managed",
      },
    );
    expect(JSON.stringify(chat)).not.toContain(sentinel);
  } finally {
    await database.close();
  }

  const scan = new PGlite(path.join(dataDirectory, "server-db"));
  try {
    const rows = await scan.query<{ record: string }>(
      "SELECT row_to_json(row)::text AS record FROM chats row WHERE id = $1",
      [chatId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain(sentinel);
    expect(rows.rows[0]?.record).toContain("protected_label");

    const columns = await scan.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chats'
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toContain(
      "protected_label",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).not.toContain(
      "title",
    );
  } finally {
    await scan.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
