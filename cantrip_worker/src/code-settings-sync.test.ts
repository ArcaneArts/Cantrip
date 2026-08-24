import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  codeSettingsUploadSchema,
  type CodeSettingsStoredProfile,
} from "@cantrip/protocol/code-settings";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodeSettingsSynchronizer,
  codeSettingsDigest,
  mergeCodeSettingsSnapshots,
  parseAndNormalizeCodeSettings,
} from "./code-settings-sync.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-code-settings-sync";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-08-23T12:00:00.000Z";
const directories: string[] = [];

class OpaqueSettingsServer {
  profile: CodeSettingsStoredProfile | null = null;
  readonly requestBodies: string[] = [];
  #nextPutGate:
    | {
        entered: () => void;
        released: Promise<void>;
      }
    | undefined;

  blockNextPut(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextPutGate = { entered: markEntered, released };
    return { entered, release };
  }

  fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const gate = this.#nextPutGate;
      if (gate) {
        this.#nextPutGate = undefined;
        gate.entered();
        await gate.released;
      }
      const body = String(init.body);
      this.requestBodies.push(body);
      const upload = codeSettingsUploadSchema.parse(JSON.parse(body));
      if (upload.expectedRevision !== (this.profile?.record.revision ?? null)) {
        return Response.json(
          {
            code: "revision-conflict",
            profileId: "default",
            currentRevision: this.profile?.record.revision ?? null,
            error: "changed",
          },
          { status: 409 },
        );
      }
      this.profile = {
        profileId: "default",
        record: upload.record,
        updatedAt: new Date().toISOString(),
        updatedByWorkerId: "test-worker",
      };
      return Response.json(this.profile, {
        status: upload.expectedRevision === null ? 201 : 200,
      });
    }
    return this.profile
      ? Response.json(this.profile)
      : Response.json({ error: "uninitialized" }, { status: 404 });
  }) as typeof fetch;
}

async function encryptionService(
  workerId: string,
  componentKey: Uint8Array,
): Promise<WorkerEncryptionService> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-code-settings-sync-key-"),
  );
  directories.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: "https://cantrip.test",
    workerId,
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: workerId,
    publicKey: registration.publicKey,
    state: "approved",
    revision: 2,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "customization-content",
    componentKey,
    keyRevision: 1,
    workerPublicKey: registration.publicKey,
  });
  const grant: EncryptionKeyGrant = {
    id: randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "customization-content",
    keyRevision: 1,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await service.acceptBootstrap({
    serverId,
    ownerId,
    principal,
    grants: [grant],
  });
  return service;
}

async function synchronizer(
  workerId: string,
  componentKey: Uint8Array,
  server: OpaqueSettingsServer,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), `cantrip-code-settings-sync-${workerId}-`),
  );
  directories.push(directory);
  const settingsPath = path.join(directory, "User", "settings.json");
  const sync = new CodeSettingsSynchronizer({
    credential: () => "worker-token",
    debounceMs: 60_000,
    fetch: server.fetch,
    pollIntervalMs: 3_600_000,
    serverUrl: "https://cantrip.test",
    service: await encryptionService(workerId, componentKey),
    settingsPath,
    statePath: path.join(directory, "state", "default.json"),
    workerId,
  });
  await sync.start();
  return { directory, settingsPath, sync };
}

async function writeSettings(pathname: string, content: string): Promise<void> {
  await writeFile(pathname, content, { encoding: "utf8", flag: "w" });
}

async function settings(pathname: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(pathname, "utf8")) as Record<
    string,
    unknown
  >;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Code settings normalization and three-way merge", () => {
  it("parses JSONC, strips only reserved keys, and hashes semantic content", () => {
    const parsed = parseAndNormalizeCodeSettings(`\ufeff{
      // comment
      "editor.fontSize": 15,
      "cantrip.bridgeToken": "never-sync",
      "cantrip.saveBeforeAgentTurn": true,
    }`);
    expect(parsed.settings).toEqual({
      "cantrip.saveBeforeAgentTurn": true,
      "editor.fontSize": 15,
    });
    expect(parsed.reserved).toEqual({ "cantrip.bridgeToken": "never-sync" });
    expect(codeSettingsDigest(parsed.settings)).toBe(
      codeSettingsDigest({
        "editor.fontSize": 15,
        "cantrip.saveBeforeAgentTurn": true,
      }),
    );
    expect(() =>
      parseAndNormalizeCodeSettings(
        '{"editor.fontSize": 1, "editor.fontSize": 2}',
      ),
    ).toThrow(/duplicate/u);
  });

  it("merges distinct top-level keys and reports same-key conflicts", () => {
    expect(
      mergeCodeSettingsSnapshots({
        base: { a: 1, b: 1 },
        local: { a: 2, b: 1 },
        remote: { a: 1, b: 2 },
      }),
    ).toEqual({ merged: { a: 2, b: 2 }, conflictCount: 0 });
    expect(
      mergeCodeSettingsSnapshots({
        base: { a: { nested: 1 } },
        local: { a: { nested: 2 } },
        remote: { a: { nested: 3 } },
      }),
    ).toEqual({ merged: null, conflictCount: 1 });
    expect(
      mergeCodeSettingsSnapshots({
        base: { a: 1 },
        local: {},
        remote: { a: 2 },
      }),
    ).toEqual({ merged: null, conflictCount: 1 });
  });
});

describe("Code settings synchronization", () => {
  it("initializes, backs up, propagates, merges, and resolves conflicts", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const server = new OpaqueSettingsServer();
    const workerA = await synchronizer("worker-a", componentKey, server);
    const workerB = await synchronizer("worker-b", componentKey, server);
    await writeSettings(
      workerA.settingsPath,
      `{
        // existing preference
        "editor.fontSize": 15,
        "cantrip.bridgeToken": "GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL",
      }`,
    );
    await writeSettings(workerB.settingsPath, '{"editor.fontSize": 12}\n');

    await expect(
      workerA.sync.synchronize({ initializeIfMissing: true }),
    ).resolves.toMatchObject({ state: "ready", revision: 1 });
    expect(server.requestBodies.join("\n")).not.toContain("editor.fontSize");
    expect(server.requestBodies.join("\n")).not.toContain(
      "GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL",
    );

    await expect(
      workerB.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({
      state: "ready",
      revision: 1,
      backupCreated: true,
    });
    expect(await settings(workerB.settingsPath)).toEqual({
      "editor.fontSize": 15,
    });
    expect(
      await readFile(
        path.join(
          path.dirname(workerB.settingsPath),
          "settings.pre-cantrip-sync.json",
        ),
        "utf8",
      ),
    ).toContain("12");

    await writeSettings(
      workerA.settingsPath,
      '{"editor.fontSize":15,"editor.wordWrap":"on","cantrip.bridgeToken":"local"}\n',
    );
    await workerA.sync.synchronize({ initializeIfMissing: false });
    expect(server.profile?.record.revision).toBe(2);

    await writeSettings(
      workerB.settingsPath,
      '{"editor.fontSize":15,"editor.tabSize":2}\n',
    );
    await expect(
      workerB.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "ready", revision: 3 });
    expect(await settings(workerB.settingsPath)).toEqual({
      "editor.fontSize": 15,
      "editor.tabSize": 2,
      "editor.wordWrap": "on",
    });

    await workerA.sync.synchronize({ initializeIfMissing: false });
    await writeSettings(
      workerA.settingsPath,
      '{"editor.fontSize":18,"editor.tabSize":2,"editor.wordWrap":"on"}\n',
    );
    await workerA.sync.synchronize({ initializeIfMissing: false });
    await writeSettings(
      workerB.settingsPath,
      '{"editor.fontSize":20,"editor.tabSize":2,"editor.wordWrap":"on"}\n',
    );
    await expect(
      workerB.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "conflict", conflictCount: 1 });
    expect((await settings(workerB.settingsPath))["editor.fontSize"]).toBe(20);

    await expect(
      workerB.sync.resolve("accept-canonical"),
    ).resolves.toMatchObject({ state: "ready", revision: 5 });
    expect(server.profile?.record.revision).toBe(5);
    expect((await settings(workerB.settingsPath))["editor.fontSize"]).toBe(18);
    expect(
      await settings(
        path.join(
          path.dirname(workerB.settingsPath),
          "settings.pre-cantrip-conflict.json",
        ),
      ),
    ).toMatchObject({ "editor.fontSize": 20 });

    await workerA.sync.synchronize({ initializeIfMissing: false });
    await writeSettings(
      workerA.settingsPath,
      '{"editor.fontSize":22,"editor.tabSize":2,"editor.wordWrap":"on"}\n',
    );
    await workerA.sync.synchronize({ initializeIfMissing: false });
    await writeSettings(
      workerB.settingsPath,
      '{"editor.fontSize":24,"editor.tabSize":2,"editor.wordWrap":"on"}\n',
    );
    await workerB.sync.synchronize({ initializeIfMissing: false });
    await expect(workerB.sync.resolve("publish-local")).resolves.toMatchObject({
      state: "ready",
      revision: 7,
    });
    expect((await settings(workerB.settingsPath))["editor.fontSize"]).toBe(24);

    await workerA.sync.close();
    await workerB.sync.close();
  }, 45_000);

  it("preserves divergent settings when two workers initialize concurrently", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const server = new OpaqueSettingsServer();
    const workerA = await synchronizer(
      "worker-initialize-a",
      componentKey,
      server,
    );
    const workerB = await synchronizer(
      "worker-initialize-b",
      componentKey,
      server,
    );
    await writeSettings(workerA.settingsPath, '{"editor.fontSize":15}\n');
    await writeSettings(workerB.settingsPath, '{"editor.fontSize":20}\n');

    const gate = server.blockNextPut();
    const initializeA = workerA.sync.synchronize({ initializeIfMissing: true });
    await gate.entered;
    await expect(
      workerB.sync.synchronize({ initializeIfMissing: true }),
    ).resolves.toMatchObject({ state: "ready", revision: 1 });
    gate.release();

    await expect(initializeA).resolves.toMatchObject({
      state: "conflict",
      revision: null,
      conflictCount: 1,
    });
    expect(await settings(workerA.settingsPath)).toEqual({
      "editor.fontSize": 15,
    });
    expect(await settings(workerB.settingsPath)).toEqual({
      "editor.fontSize": 20,
    });
    expect(server.profile?.record.revision).toBe(1);

    await workerA.sync.close();
    await workerB.sync.close();
  }, 45_000);

  it("does not overwrite an editor save made while fetching canonical settings", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const server = new OpaqueSettingsServer();
    const workerA = await synchronizer("worker-race-a", componentKey, server);
    const workerB = await synchronizer("worker-race-b", componentKey, server);
    await writeSettings(workerA.settingsPath, '{"editor.fontSize":12}\n');
    await workerA.sync.synchronize({ initializeIfMissing: true });
    await workerB.sync.synchronize({ initializeIfMissing: false });

    await writeSettings(
      workerA.settingsPath,
      '{"editor.fontSize":12,"editor.wordWrap":"on"}\n',
    );
    await workerA.sync.synchronize({ initializeIfMissing: false });
    await writeSettings(
      workerB.settingsPath,
      '{"editor.fontSize":12,"editor.tabSize":2}\n',
    );

    const gate = server.blockNextPut();
    const pending = workerB.sync.synchronize({ initializeIfMissing: false });
    await gate.entered;
    await writeSettings(
      workerB.settingsPath,
      '{"editor.fontSize":16,"editor.tabSize":2}\n',
    );
    gate.release();

    await expect(pending).resolves.toMatchObject({
      state: "error",
      error: "VS Code settings changed while synchronization was in progress.",
    });
    expect(await settings(workerB.settingsPath)).toEqual({
      "editor.fontSize": 16,
      "editor.tabSize": 2,
    });
    await expect(
      workerB.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(await settings(workerB.settingsPath)).toEqual({
      "editor.fontSize": 16,
      "editor.tabSize": 2,
      "editor.wordWrap": "on",
    });

    await workerA.sync.close();
    await workerB.sync.close();
  }, 45_000);
});
