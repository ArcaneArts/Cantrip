// Old packaged Node -> native backend -> old packaged Node -> native backend.
// Conversion is offline; every serving process uses an ordinary production entry.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { snapshot, assertImportedProfile } from "./profile-snapshots.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { heartbeat } from "./security-fixtures.mjs";
import * as crypto from "../../packages/crypto/dist/index.js";
import {
  ids,
  password,
  masterKey,
  makeMaterial,
  verifyMaterial,
  seed,
} from "./historical-product-profile-material.mjs";
const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");
const execute = promisify(execFile),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "root",
      "legacy-profile",
      "legacy-server",
      "artifact",
      "converter",
      "snapshot-probe",
      "modes",
      "expected-legacy-version",
    ].map((name) => [name, { type: "string" }]),
  ),
});
const required = (name) => {
  assert.ok(values[name], "--" + name + " is required");
  return path.resolve(values[name]);
};
const root = values.root
  ? path.resolve(values.root)
  : await mkdtemp(path.join(tmpdir(), "cantrip-historical-product-profile-"));
if (values.root) await mkdir(root);
const source = required("legacy-profile"),
  legacy = required("legacy-server"),
  artifact = required("artifact"),
  executable = path.join(
    artifact,
    "bin",
    "cantrip-server" + (process.platform === "win32" ? ".exe" : ""),
  ),
  converter = path.join(required("converter"), "dist/index.mjs");
const probe = required("snapshot-probe");
const manifest = JSON.parse(
  await readFile(path.join(artifact, "native-server.json"), "utf8"),
);
const base = [
  "--bundled-pglite-runtime-dir",
  path.join(artifact, "pglite"),
  "--bundled-postgres-bin-dir",
  path.join(artifact, manifest.postgres.bin),
];
const auth = {
  CANTRIP_AUTH_MODE: "password",
  CANTRIP_PASSWORD_HASH: await hashPassword(password),
};
const environment = (data) => {
  const env = {
    ...fixtureEnvironment(data),
    ...auth,
    CANTRIP_BOOTSTRAP_MODE: "tauri",
    CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
    CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
    CANTRIP_TEST_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
    PGLITE_RUNTIME_DIR: path.join(artifact, "pglite"),
  };
  delete env.CANTRIP_WORKER_TOKEN;
  return env;
};
const report = {
  suite: "populated-actual-historical-profile-roundtrip",
  root,
  completeReplacement: false,
  stages: [],
  modes: [],
  versions: {},
  observations: [],
  status: "running",
  artifacts: {},
};
for (const [name, file] of Object.entries({
  nativeServer: executable,
  nativeManifest: path.join(artifact, "native-server.json"),
  snapshotProbe: probe,
  converter,
})) {
  const bytes = await readFile(file);
  report.artifacts[name] = { file, bytes: bytes.length, sha256: sha(bytes) };
}
const record = (value) => {
  report.stages.push(value);
  console.log(JSON.stringify(value));
};
let server, database, postgres, csrf, clientKeyPair;
const cookies = new Map();
async function files(directory, relative = "", result = {}) {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name),
      p = path.join(directory, name);
    if (entry.isDirectory()) await files(directory, name, result);
    else {
      assert.equal(entry.isFile(), true);
      const bytes = await readFile(p);
      result[name] = {
        bytes: bytes.length,
        mode: (await stat(p)).mode & 0o777,
        sha256: sha(bytes),
      };
    }
  }
  return result;
}
const original = await files(source);
await writeFile(
  path.join(root, "original-files.json"),
  JSON.stringify(original, null, 2) + "\n",
);
async function save(name, value) {
  await writeFile(
    path.join(root, name + ".json"),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}
async function run(command, args, env = environment(root)) {
  const { stdout, stderr } = await execute(command, args, {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout,
    stderr,
    events: stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    }),
  };
}
async function native(data, mode, args, env) {
  return run(
    executable,
    [
      ...base,
      "--data-dir",
      data,
      "--database",
      mode,
      "--shutdown-on-stdin-close",
      ...args,
    ],
    env,
  );
}
async function stop(label) {
  if (!server) return;
  await writeFile(path.join(root, label + ".log"), server.diagnostics());
  await server.close();
  server = undefined;
}
async function request(route, method = "GET", json, expected = 200) {
  const response = await fetch(server.origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
      ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(20000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const item = cookie.split(";")[0],
      at = item.indexOf("=");
    cookies.set(item.slice(0, at), item.slice(at + 1));
  }
  const body = await response.json();
  assert.equal(
    response.status,
    expected,
    method + " " + route + ": " + JSON.stringify(body),
  );
  if (body.csrfToken) csrf = body.csrfToken;
  return body;
}
async function observe(material, previous) {
  const session = await request("/api/auth/session");
  assert.equal(session.currentUser.id, ids.owner);
  assert.equal(session.csrfToken, report.originalCsrfToken);
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.server.id, report.serverId);
  report.versions[material.phase + ":" + (report.activeMode ?? "legacy")] =
    bootstrap.server.version.version;
  report.observations.push({
    phase: material.phase,
    mode: report.activeMode ?? "legacy",
    pid: server.child.pid,
    origin: server.origin,
    version: bootstrap.server.version.version,
  });
  const credentials = await request(
    "/api/workers/" + ids.worker + "/credentials",
  );
  assert.deepEqual(credentials, [report.originalWorkerCredentialSummary]);
  const profile = await request("/api/encryption/profile");
  assert.equal(profile.status, "initialized");
  const unwrapped = await crypto.unwrapAccountMasterKeyWithPassword({
    password,
    ownerId: ids.owner,
    wrapper: profile.profile.passwordWrappedMasterKey,
  });
  assert.deepEqual(unwrapped, masterKey);
  crypto.clearSensitiveBytes(unwrapped);
  const principals = await request("/api/encryption/principals"),
    grants = await request(
      "/api/encryption/principals/" + ids.client + "/grants",
    );
  assert.equal(principals.find((p) => p.id === ids.client)?.state, "approved");
  const grant = grants.find((g) => g.component === "account-master-key");
  assert.ok(grant);
  const clientUnwrapped = await crypto.unwrapAccountMasterKeyForClient({
    ownerId: ids.owner,
    wrapper: grant.wrappedKey,
    clientKeyPair,
  });
  assert.deepEqual(clientUnwrapped, masterKey);
  crypto.clearSensitiveBytes(clientUnwrapped);
  const projects = await request("/api/projects"),
    project = projects.find((p) => p.id === ids.project);
  assert.ok(project);
  const chats = await request("/api/projects/" + ids.project + "/chats");
  const chat = chats.find((c) => c.id === ids.chat);
  assert.ok(chat);
  const task = await request("/api/tasks/" + ids.task),
    draft = await request("/api/chats/" + ids.chat + "/composer-draft"),
    documents = await request(
      "/api/projects/" + ids.project + "/file-documents",
    );
  const messages = await request("/api/chats/" + ids.chat + "/messages");
  assert.equal(messages.kind, "chat-encrypted");
  assert.equal(messages.messages.length, 3);
  for (const sourceMessage of [
    report.historical.user,
    report.historical.assistant,
    report.historical.pending,
  ]) {
    const actual = messages.messages.find((m) => m.id === sourceMessage.id);
    assert.ok(actual);
    assert.deepEqual(actual.protectedContent, sourceMessage.protectedContent);
    const decrypted = await crypto.decryptChatMessageProtectedContent({
      ownerId: ids.owner,
      messageId: actual.id,
      keyRevision: 1,
      componentKey: crypto.deriveComponentKey({
        ownerId: ids.owner,
        accountMasterKey: masterKey,
        component: "chat-content",
        keyRevision: 1,
      }),
      encrypted: actual.protectedContent,
      publicClassification: sourceMessage.classification,
    });
    assert.ok(decrypted.content[0].text.includes("Private historical:"));
  }
  const queue = await request("/api/chats/" + ids.chat + "/queue");
  assert.equal(queue.items.length, 1);
  const prompt = queue.items[0];
  assert.equal(prompt.id, ids.prompt);
  assert.equal(prompt.frozen, true);
  assert.deepEqual(
    prompt.protectedContent,
    report.historical.prompt.protectedContent,
  );
  const openedPrompt = await crypto.decryptQueuedPromptProtectedContent({
    ownerId: ids.owner,
    promptId: ids.prompt,
    keyRevision: 1,
    componentKey: crypto.deriveComponentKey({
      ownerId: ids.owner,
      accountMasterKey: masterKey,
      component: "chat-content",
      keyRevision: 1,
    }),
    encrypted: prompt.protectedContent,
    publicClassification: report.historical.prompt.classification,
  });
  assert.ok(openedPrompt.text.includes("Private historical:queue"));
  const observed = {
    project,
    chat,
    task,
    draft,
    documents,
    messages,
    queue,
    profile,
    principals,
    grants,
    credentials,
  };
  await verifyMaterial(material, observed, report.serverId);
  if (previous)
    assert.deepEqual(
      observed,
      previous,
      "the older/newer server reads the complete latest accepted product DTOs",
    );
  return observed;
}
async function writes(material) {
  const current = await request("/api/tasks/" + ids.task);
  const chat = await request("/api/chats/" + ids.chat, "PATCH", {
    titleProtection: material.chat,
  });
  const draft = await request(
    "/api/chats/" + ids.chat + "/composer-draft",
    "PUT",
    { state: material.draft },
  );
  const task = await request("/api/tasks/" + ids.task + "/draft", "PATCH", {
    rowVersion: current.rowVersion,
    task: material.task,
    priority: current.priority + 1,
  });
  assert.equal(task.rowVersion, current.rowVersion + 1);
  const document = await request(
    "/api/projects/" + ids.project + "/file-documents",
    "POST",
    material.document,
  );
  assert.equal(document.id, material.document.id);
  return { chat, draft, task, document };
}
async function legacySnapshot(data, name) {
  const db = await PGlite.create(path.join(data, "server-db"));
  try {
    const value = await snapshot(db);
    await save(name, value);
    return value;
  } finally {
    await db.close();
  }
}
async function nativeSnapshot(data, mode, env, name) {
  const directory =
    mode === "pglite"
      ? path.join(data, "server-db")
      : mode === "bundled-postgres"
        ? path.join(data, "postgres")
        : data;
  const result = await run(
    probe,
    ["--directory", directory, "--database", mode, "--no-migrate"],
    env,
  );
  const value = result.events.find((e) => e.tables && e.sequences);
  assert.ok(value);
  assert.equal(value.migrationsApplied, 0);
  const snapshot = {
    tables: value.tables,
    sequences: value.sequences,
    probe: value.probe,
  };
  for (const phase of [
    "historical",
    "rust-",
    "node-after-rust-",
    "rust-return-",
  ])
    assert.equal(
      JSON.stringify(snapshot.tables).includes("Private " + phase),
      false,
      "product plaintext is absent from server tables",
    );
  await save(name, snapshot);
  return snapshot;
}
async function verifyFiles(data) {
  for (const relative of ["secret-encryption-key.json", "archives/opaque.bin"])
    assert.deepEqual(
      await readFile(path.join(data, relative)),
      await readFile(path.join(report.populatedLegacy, relative)),
      relative + " survives logical conversion",
    );
  assert.equal(
    (await stat(path.join(data, "archives/opaque.bin"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(path.join(data, "archives/empty"))).isDirectory(),
    true,
  );
}
try {
  const data = path.join(root, "populated-legacy");
  report.populatedLegacy = data;
  await cp(source, data, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    force: false,
    errorOnExist: true,
  });
  assert.deepEqual(await files(data), original);
  clientKeyPair = await crypto.generateHpkeKeyPair(true);
  const publicKey = await crypto.exportHpkePublicKey(clientKeyPair.publicKey),
    passwordWrappedMasterKey = await crypto.wrapAccountMasterKeyWithPassword({
      password,
      ownerId: ids.owner,
      accountMasterKey: masterKey,
      masterKeyRevision: 1,
    }),
    wrappedMasterKey = await crypto.wrapAccountMasterKeyForClient({
      ownerId: ids.owner,
      clientId: ids.client,
      accountMasterKey: masterKey,
      masterKeyRevision: 1,
      clientPublicKey: publicKey,
    });
  await save("fixture-private-keys", {
    ids,
    accountMasterKey: Buffer.from(masterKey).toString("base64url"),
    clientPrivateKey: Buffer.from(
      await crypto.exportHpkePrivateKey(clientKeyPair.privateKey),
    ).toString("base64url"),
    publicKey,
  });
  server = await startPackagedNodeServer(legacy, environment(data));
  const session = await request("/api/auth/login", "POST", { password });
  report.originalCsrfToken = session.csrfToken;
  const bootstrap = await request("/api/bootstrap");
  report.serverId = bootstrap.server.id;
  report.versions.original = bootstrap.server.version.version;
  if (values["expected-legacy-version"])
    assert.equal(report.versions.original, values["expected-legacy-version"]);
  const code = await request(
    "/api/workers/enrollment-codes",
    "POST",
    { label: "Historical rollback worker" },
    201,
  );
  const enrollment = await request(
    "/api/internal/workers/enroll",
    "POST",
    {
      code: code.code,
      heartbeat: {
        ...heartbeat,
        workerId: ids.worker,
        name: "Historical rollback worker",
      },
    },
    201,
  );
  report.originalWorkerCredentialSummary = enrollment.credentialSummary;
  await save("fixture-worker-credential", enrollment);
  await request(
    "/api/encryption/profile/initialize",
    "POST",
    {
      profile: {
        formatVersion: 1,
        activeMasterKeyRevision: 1,
        passwordKdf: passwordWrappedMasterKey.kdf,
        passwordWrappedMasterKey,
        payloadMigrationStatus: "pending",
      },
      initialClient: {
        id: ids.client,
        label: "Historical rollback client",
        publicKey,
        wrappedMasterKey,
      },
    },
    201,
  );
  await stop("legacy-initialization");
  report.historical = await makeMaterial("historical", report.serverId);
  await save("historical-material", report.historical);
  database = await PGlite.create(path.join(data, "server-db"));
  await seed(database, report.historical);
  await database.close();
  database = undefined;
  await mkdir(path.join(data, "archives/empty"), { recursive: true });
  await writeFile(
    path.join(data, "archives/opaque.bin"),
    Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)),
    { mode: 0o600 },
  );
  server = await startPackagedNodeServer(legacy, environment(data));
  await writes(report.historical);
  const baseline = await observe(report.historical);
  await save("historical-http-baseline", baseline);
  await stop("legacy-populated");
  const sourceSnapshot = await legacySnapshot(data, "historical-database");
  report.nonemptyTables = Object.fromEntries(
    Object.entries(sourceSnapshot.tables)
      .filter(([, r]) => r.length)
      .map(([k, r]) => [k, r.length]),
  );
  record({
    stage: "actual-old-node-populated-baseline",
    version: report.versions.original,
    tables: Object.keys(sourceSnapshot.tables).length,
    nonemptyTables: Object.keys(report.nonemptyTables).length,
    messages: 3,
    queueItems: 1,
    decryption: true,
  });
  const bundle = path.join(root, "historical-bundle"),
    sourceBefore = await files(data);
  await run(process.execPath, [converter, data, bundle, executable]);
  assert.deepEqual(await files(data), sourceBefore);
  const bundleManifest = JSON.parse(
    await readFile(path.join(bundle, "manifest.json"), "utf8"),
  );
  const bundleFiles = await files(bundle);
  postgres = await postgresFixture(path.join(root, "external-postgres"));
  for (const mode of (values.modes ?? "pglite,bundled-postgres,postgres").split(
    ",",
  )) {
    report.activeMode = mode;
    const result = { mode, stages: [] };
    report.modes.push(result);
    const nativeData = path.join(root, "native-" + mode),
      env = {
        ...environment(nativeData),
        ...(mode === "postgres"
          ? { DATABASE_URL: await postgres.database() }
          : {}),
      };
    const before = Date.now(),
      imported = await native(
        nativeData,
        mode,
        ["--migrate-only", "--restore-profile", bundle],
        env,
      ),
      after = Date.now();
    const receipt = imported.events.find(
      (e) => e.event === "profile.restore.completed",
    )?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.databaseMode, mode);
    result.importReceipt = receipt;
    const observed = await nativeSnapshot(
      nativeData,
      mode,
      env,
      mode + "-after-import",
    );
    assertImportedProfile(
      sourceSnapshot,
      observed,
      receipt,
      bundleManifest,
      before,
      after,
    );
    await verifyFiles(nativeData);
    const launch = () =>
      startServer(
        executable,
        [
          ...base,
          "--data-dir",
          nativeData,
          "--database",
          mode,
          "--port",
          "0",
          "--shutdown-on-stdin-close",
        ],
        { env },
      );
    server = await launch();
    await observe(report.historical, baseline);
    const rustWrites = await makeMaterial("rust-" + mode, report.serverId);
    await save(mode + "-rust-material", rustWrites);
    result.rustWrites = await writes(rustWrites);
    const accepted = await observe(rustWrites);
    await save(mode + "-rust-accepted", accepted);
    await stop(mode + "-native-written");
    server = await launch();
    await observe(rustWrites, accepted);
    await stop(mode + "-native-restarted");
    const written = await nativeSnapshot(
      nativeData,
      mode,
      env,
      mode + "-before-reverse",
    );
    const nativeBundle = path.join(root, "written-bundle-" + mode);
    await native(
      nativeData,
      mode,
      ["--migrate-only", "--export-profile", nativeBundle],
      env,
    );
    const reverse = path.join(root, "reverse-legacy-" + mode);
    await run(
      process.execPath,
      [converter, "--restore", nativeBundle, reverse, executable],
      env,
    );
    assert.deepEqual(
      await legacySnapshot(reverse, mode + "-reverse-database"),
      written,
      "all tables, sequences, function result and SQL/JSON null kinds survive reverse migration after product writes",
    );
    await verifyFiles(reverse);
    server = await startPackagedNodeServer(legacy, environment(reverse));
    await observe(rustWrites, accepted);
    const nodeWrites = await makeMaterial(
      "node-after-rust-" + mode,
      report.serverId,
    );
    await save(mode + "-node-material", nodeWrites);
    result.nodeWrites = await writes(nodeWrites);
    const nodeAccepted = await observe(nodeWrites);
    await save(mode + "-node-accepted", nodeAccepted);
    await stop(mode + "-legacy-written");
    const reversedSnapshot = await legacySnapshot(
        reverse,
        mode + "-node-written-database",
      ),
      returnBundle = path.join(root, "return-bundle-" + mode);
    await run(process.execPath, [converter, reverse, returnBundle, executable]);
    const finalData = path.join(root, "return-rust-" + mode),
      finalEnv = {
        ...environment(finalData),
        ...(mode === "postgres"
          ? { DATABASE_URL: await postgres.database() }
          : {}),
      };
    const beforeReturn = Date.now(),
      returned = await native(
        finalData,
        mode,
        ["--migrate-only", "--restore-profile", returnBundle],
        finalEnv,
      ),
      afterReturn = Date.now();
    const returnReceipt = returned.events.find(
      (e) => e.event === "profile.restore.completed",
    )?.receipt;
    assert.ok(returnReceipt);
    const returnManifest = JSON.parse(
      await readFile(path.join(returnBundle, "manifest.json"), "utf8"),
    );
    assertImportedProfile(
      reversedSnapshot,
      await nativeSnapshot(
        finalData,
        mode,
        finalEnv,
        mode + "-returned-database",
      ),
      returnReceipt,
      returnManifest,
      beforeReturn,
      afterReturn,
    );
    await verifyFiles(finalData);
    const launchReturned = () =>
      startServer(
        executable,
        [
          ...base,
          "--data-dir",
          finalData,
          "--database",
          mode,
          "--port",
          "0",
          "--shutdown-on-stdin-close",
        ],
        { env: finalEnv },
      );
    server = await launchReturned();
    await observe(nodeWrites, nodeAccepted);
    const returnWrites = await makeMaterial(
      "rust-return-" + mode,
      report.serverId,
    );
    await save(mode + "-return-material", returnWrites);
    result.returnWrites = await writes(returnWrites);
    const returnAccepted = await observe(returnWrites);
    await save(mode + "-return-accepted", returnAccepted);
    await stop(mode + "-returned-native");
    server = await launchReturned();
    await observe(returnWrites, returnAccepted);
    await stop(mode + "-returned-native-restart");
    await nativeSnapshot(
      finalData,
      mode,
      finalEnv,
      mode + "-final-written-database",
    );
    assert.deepEqual(await files(bundle), bundleFiles);
    assert.deepEqual(await files(source), original);
    result.status = "passed";
    record({
      stage: "complete-product-roundtrip",
      mode,
      allTableAndSequenceEquality: true,
      originalSession: true,
      originalIdentity: true,
      masterKeyAndContentDecryption: true,
      rustThenLegacyWrites: true,
      originalFilesUnchanged: true,
    });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = {
    message: error.message,
    stack: error.stack,
    code: error.code,
    stdout: error.stdout,
    stderr: error.stderr,
  };
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  try {
    await stop("final-cleanup");
  } catch (error) {
    report.status = "failed";
    report.cleanupError = error.stack;
    process.exitCode = 1;
  }
  await database?.close();
  await postgres?.close();
  assert.deepEqual(await files(source), original);
  report.originalFilesUnchanged = true;
  await save("report", report);
}
console.log(
  JSON.stringify({
    status: report.status,
    root,
    stages: report.stages,
    failure: report.failure?.message,
  }),
);
