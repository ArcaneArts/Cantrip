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

import { CodeSettingsSynchronizer } from "./code-settings-sync.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-code-settings-lifecycle";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-08-24T12:00:00.000Z";
const directories: string[] = [];

class OpaqueSettingsServer {
  profile: CodeSettingsStoredProfile | null = null;
  offline = false;
  getCount = 0;
  putCount = 0;

  fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (this.offline) throw new TypeError("server unavailable");
    if (init?.method === "PUT") {
      this.putCount += 1;
      const upload = codeSettingsUploadSchema.parse(
        JSON.parse(String(init.body)),
      );
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
        updatedAt: timestamp,
        updatedByWorkerId: "test-worker",
      };
      return Response.json(this.profile, {
        status: upload.expectedRevision === null ? 201 : 200,
      });
    }
    this.getCount += 1;
    return this.profile
      ? Response.json(this.profile)
      : Response.json({ error: "uninitialized" }, { status: 404 });
  }) as typeof fetch;
}

async function encryptionService(
  workerId: string,
  componentKeys: ReadonlyMap<number, Uint8Array>,
): Promise<WorkerEncryptionService> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-code-settings-lifecycle-key-"),
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
  const grants: EncryptionKeyGrant[] = [];
  for (const [keyRevision, componentKey] of componentKeys) {
    grants.push({
      id: randomUUID(),
      ownerId,
      principalId: principal.id,
      component: "customization-content",
      keyRevision,
      wrappedKey: await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "customization-content",
        componentKey,
        keyRevision,
        workerPublicKey: registration.publicKey,
      }),
      state: "active",
      revision: keyRevision,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  await service.acceptBootstrap({
    serverId,
    ownerId,
    principal,
    grants,
  });
  return service;
}

interface TestSynchronizer {
  directory: string;
  service: WorkerEncryptionService;
  settingsPath: string;
  statePath: string;
  sync: CodeSettingsSynchronizer;
  workerId: string;
}

type WatchFactory = ConstructorParameters<
  typeof CodeSettingsSynchronizer
>[0]["watchFactory"];

class ManualWatcher {
  #closed = false;

  constructor(
    private readonly listener: (
      event: string,
      filename: string | Buffer | null,
    ) => void,
  ) {}

  close(): void {
    this.#closed = true;
  }

  once(_event: "error", _listener: () => void): this {
    return this;
  }

  change(filename = "settings.json"): void {
    if (!this.#closed) this.listener("change", filename);
  }
}

async function synchronizer(input: {
  componentKeys: ReadonlyMap<number, Uint8Array>;
  debounceMs?: number;
  directory?: string;
  pollIntervalMs?: number;
  server: OpaqueSettingsServer;
  service?: WorkerEncryptionService;
  watchFactory?: WatchFactory;
  workerId: string;
}): Promise<TestSynchronizer> {
  const directory =
    input.directory ??
    (await mkdtemp(
      path.join(tmpdir(), `cantrip-code-settings-${input.workerId}-`),
    ));
  if (!input.directory) directories.push(directory);
  const settingsPath = path.join(directory, "User", "settings.json");
  const statePath = path.join(directory, "state", "default.json");
  const service =
    input.service ??
    (await encryptionService(input.workerId, input.componentKeys));
  const sync = new CodeSettingsSynchronizer({
    credential: () => "worker-token",
    debounceMs: input.debounceMs ?? 20,
    fetch: input.server.fetch,
    pollIntervalMs: input.pollIntervalMs ?? 3_600_000,
    serverUrl: "https://cantrip.test",
    service,
    settingsPath,
    statePath,
    watchFactory: input.watchFactory,
    workerId: input.workerId,
  });
  await sync.start();
  return {
    directory,
    service,
    settingsPath,
    statePath,
    sync,
    workerId: input.workerId,
  };
}

async function writeSettings(
  pathname: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await writeFile(pathname, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function readSettings(
  pathname: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(pathname, "utf8")) as Record<
    string,
    unknown
  >;
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Code settings synchronization lifecycle", () => {
  it("re-encrypts an older canonical key revision with the current component key", async () => {
    const accountMasterKey = generateAccountMasterKey();
    const keyRevision1 = deriveComponentKey({
      accountMasterKey,
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const keyRevision2 = deriveComponentKey({
      accountMasterKey,
      ownerId,
      component: "customization-content",
      keyRevision: 2,
    });
    const server = new OpaqueSettingsServer();
    const legacy = await synchronizer({
      componentKeys: new Map([[1, keyRevision1]]),
      server,
      workerId: "legacy-key-worker",
    });
    await writeSettings(legacy.settingsPath, { "editor.fontSize": 14 });
    await legacy.sync.synchronize({ initializeIfMissing: true });
    expect(server.profile?.record.protectedContent.keyRevision).toBe(1);
    await legacy.sync.close();

    const migrating = await synchronizer({
      componentKeys: new Map([
        [1, keyRevision1],
        [2, keyRevision2],
      ]),
      server,
      workerId: "current-key-worker",
    });
    await expect(
      migrating.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "ready", revision: 2 });
    expect(server.profile?.record.revision).toBe(2);
    expect(server.profile?.record.protectedContent.keyRevision).toBe(2);
    expect(await readSettings(migrating.settingsPath)).toEqual({
      "editor.fontSize": 14,
    });
    await migrating.sync.close();
  });

  it("debounces watcher uploads and suppresses apply feedback revisions", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const keys = new Map([[1, componentKey]]);
    const server = new OpaqueSettingsServer();
    let editorWatcher!: ManualWatcher;
    const editor = await synchronizer({
      componentKeys: keys,
      debounceMs: 25,
      server,
      watchFactory: (_directory, listener) => {
        editorWatcher = new ManualWatcher(listener);
        return editorWatcher;
      },
      workerId: "watcher-editor",
    });
    await writeSettings(editor.settingsPath, { "editor.fontSize": 13 });
    await editor.sync.synchronize({ initializeIfMissing: true });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(server.profile?.record.revision).toBe(1);

    await writeSettings(editor.settingsPath, {
      "editor.fontSize": 18,
      "editor.wordWrap": "on",
    });
    editorWatcher.change();
    editorWatcher.change();
    await eventually(() => server.profile?.record.revision === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.profile?.record.revision).toBe(2);
    expect(server.putCount).toBe(2);

    let receiverWatcher!: ManualWatcher;
    const receiver = await synchronizer({
      componentKeys: keys,
      debounceMs: 25,
      server,
      watchFactory: (_directory, listener) => {
        receiverWatcher = new ManualWatcher(listener);
        return receiverWatcher;
      },
      workerId: "watcher-receiver",
    });
    await receiver.sync.synchronize({ initializeIfMissing: false });
    receiverWatcher.change();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readSettings(receiver.settingsPath)).toEqual({
      "editor.fontSize": 18,
      "editor.wordWrap": "on",
    });
    expect(server.profile?.record.revision).toBe(2);
    expect(server.putCount).toBe(2);

    await editor.sync.close();
    await receiver.sync.close();
  });

  it("catches up through invalidation and periodic polling without duplicate revisions", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const keys = new Map([[1, componentKey]]);
    const server = new OpaqueSettingsServer();
    const writer = await synchronizer({
      componentKeys: keys,
      server,
      workerId: "catchup-writer",
    });
    const receiver = await synchronizer({
      componentKeys: keys,
      pollIntervalMs: 30,
      server,
      workerId: "catchup-receiver",
    });
    await writeSettings(writer.settingsPath, { "editor.fontSize": 11 });
    await writer.sync.synchronize({ initializeIfMissing: true });
    await receiver.sync.invalidate(1);
    expect(receiver.sync.status()).toMatchObject({
      state: "ready",
      revision: 1,
    });

    await writeSettings(writer.settingsPath, {
      "editor.fontSize": 11,
      "editor.wordWrap": "bounded",
    });
    await writer.sync.synchronize({ initializeIfMissing: false });
    await expect(receiver.sync.invalidate(2)).resolves.toMatchObject({
      state: "ready",
      revision: 2,
    });

    await writeSettings(writer.settingsPath, {
      "editor.fontSize": 16,
      "editor.wordWrap": "bounded",
    });
    await writer.sync.synchronize({ initializeIfMissing: false });
    await eventually(() => receiver.sync.status().revision === 3);
    expect(await readSettings(receiver.settingsPath)).toEqual({
      "editor.fontSize": 16,
      "editor.wordWrap": "bounded",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.profile?.record.revision).toBe(3);
    expect(server.putCount).toBe(3);

    await writer.sync.close();
    await receiver.sync.close();
  });

  it("reports offline, recovers, and reuses its persisted checkpoint after restart", async () => {
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const keys = new Map([[1, componentKey]]);
    const server = new OpaqueSettingsServer();
    const worker = await synchronizer({
      componentKeys: keys,
      server,
      workerId: "restart-worker",
    });
    await writeSettings(worker.settingsPath, { "editor.fontSize": 12 });
    await worker.sync.synchronize({ initializeIfMissing: true });

    server.offline = true;
    await expect(
      worker.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "offline", revision: 1 });
    server.offline = false;
    await expect(
      worker.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "ready", revision: 1 });
    await worker.sync.close();

    const reopened = await synchronizer({
      componentKeys: keys,
      directory: worker.directory,
      server,
      service: worker.service,
      workerId: worker.workerId,
    });
    await expect(
      reopened.sync.synchronize({ initializeIfMissing: false }),
    ).resolves.toMatchObject({ state: "ready", revision: 1 });
    await writeSettings(reopened.settingsPath, {
      "editor.fontSize": 12,
      "editor.tabSize": 2,
    });
    await reopened.sync.synchronize({ initializeIfMissing: false });
    expect(server.profile?.record.revision).toBe(2);
    expect(
      JSON.parse(await readFile(reopened.statePath, "utf8")),
    ).toMatchObject({
      revision: 2,
      base: { "editor.fontSize": 12, "editor.tabSize": 2 },
    });
    await reopened.sync.close();
  });
});
