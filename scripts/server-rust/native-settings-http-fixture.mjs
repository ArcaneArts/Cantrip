import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { label, json, literal } from "./project-target-state.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { readProtectedNativeSettings } from "../../cantrip_worker/src/native-settings-read.ts";
import {
  openNativeSettingsSnapshot,
  protectNativeSettingsSnapshot,
} from "../../cantrip_worker/src/native-settings-content.ts";
import { updateProtectedNativeSettings } from "../../cantrip_worker/src/native-settings-update.ts";
import { protectedNativeAccountDefaults } from "../../cantrip_worker/src/native-account-defaults.ts";
export const settingsChat = "22222222-2222-4222-8222-222222222222",
  settingsProject = "11111111-1111-4111-8111-111111111111",
  settingsTree = "33333333-3333-4333-8333-333333333333",
  otherChat = "44444444-4444-4444-8444-444444444444",
  settingsWorker = "native-settings-worker",
  componentKey = new Uint8Array(32).fill(41),
  privateMarker = "private-settings-fixture";
export async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.ok(predicate(value), "native settings fixture deadline");
}
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out = Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, scrub(x)]),
    );
    if (v.context && v.contentFingerprint && v.protectedContent) {
      out.contentFingerprint = "<verified fingerprint>";
      out.protectedContent = "<verified endpoint ciphertext>";
      if (out.modelAttribution)
        out.modelAttribution.fingerprint = "<verified attribution fingerprint>";
    }
    if (v.protectedResult)
      out.protectedResult = "<verified endpoint ciphertext>";
    return out;
  }
  return v;
}
export async function settingsHttpFixture({
  kind,
  profile,
  root,
  executable,
  repositoryExecutable,
  databaseMode,
  url,
  passwordHash,
  result,
  configure,
  prepare,
  onLogicalCompletion,
  observeCompletions = false,
  environment = {},
}) {
  const fixture = new HttpFixture({
    kind,
    executable,
    root,
    name: profile,
    databaseMode,
    environment: {
      CANTRIP_AUTH_MODE: profile,
      CANTRIP_REGISTRATION_ENABLED: "true",
      ...(observeCompletions
        ? { CANTRIP_TEST_COMPLETION_OBSERVATIONS: "true" }
        : {}),
      ...(profile === "password"
        ? { CANTRIP_PASSWORD_HASH: passwordHash }
        : {}),
      ...(url ? { DATABASE_URL: url } : {}),
      ...(kind === "rust" && databaseMode === "bundled-postgres"
        ? {
            CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
          }
        : {}),
      ...environment,
    },
  });
  let repository,
    worker,
    live,
    owner,
    serverId,
    connections = 0,
    epoch = "epoch",
    revision = "1",
    mode = "normal",
    hold;
  const updates = [],
    defaultsCalls = [];
  const scope = {
    chatId: settingsChat,
    workerId: settingsWorker,
    threadId: "thread",
    contextKind: "project",
    projectId: settingsProject,
    placementId: settingsTree,
    modelRouteId: null,
    providerAccountId: null,
  };
  const encryption = {
    ownerId: () => owner,
    serverIdentity: () => serverId,
    componentKey: () => ({ key: new Uint8Array(componentKey), keyRevision: 1 }),
  };
  const nativeSettings = () => ({
    settingsVersion: { epoch, revision },
    cwd: "/" + privateMarker,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspace-write" },
    activePermissionProfile: null,
    model: privateMarker,
    modelProvider: "controlled-native",
    effort: "medium",
    serviceTier: null,
    summary: null,
    collaborationMode: { mode: "default", settings: {} },
    personality: null,
    futureField: { preserved: privateMarker },
  });
  let defaults = {
    version: "defaults-v1",
    stored: { model: privateMarker },
    effective: { model: privateMarker },
  };
  const runtime = {
    transportGeneration: "runtime",
    readNativeThreadSettings: async () => ({
      confirmed: { settings: nativeSettings() },
    }),
    updateNativeThreadSettings: async (input) => {
      updates.push(input);
      return {
        operationId:
          mode === "wrong-operation" ? "unrelated" : input.operationId,
        submissionId: "submission",
        status: "applied",
      };
    },
    nativeAccountDefaults: async (input) => {
      defaultsCalls.push(input);
      if (hold) {
        hold.requested = true;
        await new Promise((resolve) => (hold.release = resolve));
      }
      if (input.write) {
        defaults = {
          version: "defaults-v2",
          stored: input.write.values,
          effective: input.write.values,
        };
        return {
          snapshot: defaults,
          write: { status: "ok", version: defaults.version },
          verification: "confirmed",
        };
      }
      return { snapshot: defaults, write: null, verification: "read" };
    },
  };
  async function prove(v) {
    if (Array.isArray(v)) {
      for (const x of v) await prove(x);
    } else if (v && typeof v === "object") {
      if (v.context && v.contentFingerprint && v.protectedContent) {
        const opened = await openNativeSettingsSnapshot({
          service: encryption,
          context: v.context,
          snapshot: v,
        });
        assert.equal(opened.cwd, "/" + privateMarker);
        assert.equal(opened.futureField.preserved, privateMarker);
        result.snapshotProofs++;
      }
      for (const x of Object.values(v)) await prove(x);
    }
  }
  const visit = async (name, method, route, options = {}) => {
    const observation = await fixture.observe(name, method, route, {
      csrf:
        !["GET", "HEAD"].includes(method) &&
        !!fixture.client(options.client).csrf,
      ...options,
    });
    const raw = fixture.records.get(name);
    await prove(raw);
    assert.equal(
      JSON.stringify(raw).includes(privateMarker),
      false,
      "native settings remain opaque on HTTP",
    );
    result.observations.push({ name, ...scrub(observation) });
    return raw;
  };
  async function close() {
    worker?.close();
    try {
      await live?.close();
    } finally {
      await fixture.close();
      await repository?.close();
    }
  }
  try {
    await fixture.start();
    if (profile === "accounts")
      await visit("register", "POST", "/api/auth/register", {
        status: 201,
        json: {
          email: "settings@example.invalid",
          displayName: "Settings owner",
          password,
        },
      });
    else {
      await visit("session", "GET", "/api/auth/session");
      if (profile === "password")
        await visit("login", "POST", "/api/auth/login", { json: { password } });
    }
    if (profile === "accounts")
      await visit("register foreign owner", "POST", "/api/auth/register", {
        client: "other",
        status: 201,
        json: {
          email: "other-settings@example.invalid",
          displayName: "Other owner",
          password,
        },
      });
    serverId = (await visit("bootstrap", "GET", "/api/bootstrap")).server.id;
    await visit("enrollment code", "POST", "/api/workers/enrollment-codes", {
      status: 201,
      json: { label: "Native settings worker" },
    });
    const enrollment = await visit(
      "enrollment",
      "POST",
      "/api/internal/workers/enroll",
      {
        client: "worker",
        status: 201,
        json: {
          code: fixture.records.get("enrollment code").code,
          heartbeat: { ...heartbeat, workerId: settingsWorker },
        },
      },
    );
    await fixture.close();
    repository = await repositoryFixture({
      kind,
      executable: repositoryExecutable,
      root: path.join(root, profile),
      databaseMode,
      databaseUrl: url,
    });
    const owned = await repository.request({
      op: "query-json",
      sql: `SELECT jsonb_build_object('owner',owner_id) result FROM workers WHERE id=${literal(settingsWorker)}`,
    });
    assert.equal(owned.rejected, false, owned.diagnostic);
    owner = owned.value.owner;
    const statements = [
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(settingsProject)},${literal(owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(settingsWorker)},'settings-project')`,
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('settings-source',${literal(settingsProject)},${literal(settingsWorker)},'git','/worker-owned/settings','/worker-owned/settings')`,
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(settingsTree)},'settings-source',${literal(settingsWorker)},'main','/worker-owned/settings','/worker-owned/settings',true,'cantrip','ready')`,
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) VALUES(${literal(settingsChat)},${literal(owner)},${literal(settingsProject)},${literal(settingsTree)},${literal(settingsWorker)},${json(label("chat"))},'agent')`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('settings-runtime',${literal(settingsChat)},${literal(settingsWorker)},${literal(settingsTree)},'thread')`,
      ...(configure?.(owner, scope) ?? []),
    ];
    const seeded = await repository.request({ op: "transaction", statements });
    assert.equal(seeded.rejected, false, seeded.diagnostic);
    await prepare?.({ owner, scope, repository });
    await repository.close();
    repository = null;
    await fixture.start();
    live = await new LiveProbe(fixture).open();
    await live.initialized();
    await live.subscribed("native-settings", [
      { kind: "chat", chatId: settingsChat },
    ]);
    const config = {
      dataDirectory: path.join(root, profile, kind, "controlled-worker"),
      name: "Native settings transport",
      serverUrl: fixture.server.origin,
      enrollmentCode: null,
      replacement: null,
      token: enrollment.credential,
      tokenSource: "persisted",
      workerId: settingsWorker,
    };
    saveWorkerCredential({
      credential: config.token,
      dataDirectory: config.dataDirectory,
      serverUrl: config.serverUrl,
      workerId: settingsWorker,
    });
    worker = new WorkerConnection(
      config,
      async (command) => {
        if (
          command.type === "chat.native-logical.complete" &&
          onLogicalCompletion
        )
          return onLogicalCompletion(command);
        if (command.type === "chat.scratch.reconcile")
          return {
            retainedRootIds: command.roots.map((r) => r.rootId),
            missingRootIds: [],
            orphanedRootIds: [],
            dueRootIds: [],
          };
        if (command.type === "chat.settings.read")
          return readProtectedNativeSettings({
            scope: command.scope,
            resolve: () => ({ scope, runtime, generation: "runtime" }),
            service: encryption,
          });
        if (command.type === "chat.settings.update")
          return updateProtectedNativeSettings({
            request: command,
            resolve: () => ({ scope, runtime, generation: "runtime" }),
            service: encryption,
          });
        if (command.type === "chat.account-defaults")
          return protectedNativeAccountDefaults({
            command,
            resolve: () => ({ scope, runtime, generation: "runtime" }),
            service: encryption,
          });
        throw new Error("Controlled settings worker command is unsupported");
      },
      undefined,
      undefined,
      undefined,
      1000,
      () => connections++,
    );
    worker.start();
    await until(
      () => connections,
      (n) => n === 1,
    );
    return {
      fixture,
      visit,
      live,
      worker,
      encryption,
      scope,
      owner,
      serverId,
      updates,
      defaultsCalls,
      close,
      setMode: (v) => (mode = v),
      setVersion: (e, r) => {
        epoch = e;
        revision = r;
      },
      snapshot: () =>
        protectNativeSettingsSnapshot({
          service: encryption,
          context: {
            chatId: settingsChat,
            workerId: settingsWorker,
            threadId: "thread",
            runtimeGeneration: "runtime",
            settingsVersion: { epoch, revision },
          },
          settings: nativeSettings(),
          modelAttribution: { status: "unavailable" },
        }),
      hold: () => {
        hold = { requested: false };
        return () => hold;
      },
      release: () => {
        hold.release();
        hold = null;
      },
      credential: enrollment.credential,
      connectionCount: () => connections,
      diagnostics: () => fixture.server?.diagnostics() ?? "",
    };
  } catch (error) {
    await close();
    throw error;
  }
}
