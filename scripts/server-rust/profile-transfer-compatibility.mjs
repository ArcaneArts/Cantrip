// Actual legacy profile -> each Rust backend -> legacy profile, carrying the
// original session, opaque keys/files and real revision-fenced HTTP writes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  stat,
  appendFile,
  cp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { buildRustExample, buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  exportLegacyProfile,
  restoreLegacyProfile,
} from "../database-transfer/legacy-profile.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import {
  initialization,
  projectLabel,
  password,
} from "./security-fixtures.mjs";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { verifyNodeAfterNativeExport } from "./native-export-http-writes.mjs";
import {
  interruptedProfileImport,
  rejectedProfileImport,
} from "./profile-transfer-faults.mjs";
import { profileCommitProxy } from "./profile-commit-proxy.mjs";
import { snapshot, assertImportedProfile } from "./profile-snapshots.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const { PGlite } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("@electric-sql/pglite");

const { values } = parseArgs({
  options: { report: { type: "string" } },
  strict: true,
});
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-profile-transfer-"));
const report = { suite: "logical-profile-transfer", root, modes: [] };
const workspaceId = "77777777-7777-4777-8777-000000000091";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(root, relative = "", result = {}) {
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await files(root, name, result);
    else if (entry.isFile())
      result[name] = hash(await readFile(path.join(root, name)));
    else assert.fail("fixture has no special files");
  }
  return result;
}
async function visit(fixture, name, method, route, options = {}) {
  await fixture.observe(name, method, route, {
    csrf: method !== "GET",
    ...options,
  });
  return fixture.records.get(name);
}
async function run(executable, args, env) {
  const result = await execute(executable, args, {
    env,
    cwd: repositoryRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
let pg, failure;
try {
  const executable = await buildRustServer();
  const probe = await buildRustExample("database-transfer-fixture");
  const nativeSnapshot = async (data, mode, env) => {
    const directory =
      mode === "pglite"
        ? path.join(data, "server-db")
        : mode === "bundled-postgres"
          ? path.join(data, "postgres")
          : data;
    const records = await run(
      probe,
      ["--directory", directory, "--database", mode, "--no-migrate"],
      {
        ...env,
        CANTRIP_TEST_POSTGRES_BIN_DIR:
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      },
    );
    const result = records.find((value) => value.tables && value.sequences);
    assert.ok(
      result,
      "native snapshot probe returns the actual database state",
    );
    return {
      tables: result.tables,
      sequences: result.sequences,
      probe: result.probe,
    };
  };
  pg = await postgresFixture(path.join(root, "postgres-owner"));
  const sourceRoot = path.join(root, "source");
  const auth = {
    CANTRIP_AUTH_MODE: "password",
    CANTRIP_PASSWORD_HASH: await hashPassword(password),
  };
  const environment = (data) => {
    const value = { ...fixtureEnvironment(data), ...auth };
    delete value.CANTRIP_WORKER_TOKEN;
    return value;
  };
  const source = new HttpFixture({
    kind: "node",
    executable,
    root,
    name: "source",
    databaseMode: "pglite",
    environment: { ...fixtureEnvironment(sourceRoot), ...auth },
  });
  let session, bootstrap, created;
  try {
    await source.start();
    session = await visit(source, "original login", "POST", "/api/auth/login", {
      csrf: false,
      json: { password },
    });
    bootstrap = await visit(
      source,
      "original identity",
      "GET",
      "/api/bootstrap",
    );
    await visit(
      source,
      "initialize encryption",
      "POST",
      "/api/encryption/profile/initialize",
      { status: 201, json: initialization() },
    );
    created = await visit(
      source,
      "original encrypted workspace",
      "POST",
      "/api/workspaces",
      {
        status: 201,
        json: {
          id: workspaceId,
          nameProtection:
            discoveryWireFixtures(projectLabel)
              .encryptedProjectWorkspaceCreateSchema[0].nameProtection,
          storage: { kind: "managed" },
        },
      },
    );
    assert.equal(created.revision, 1);
  } finally {
    await source.close();
  }
  const legacy = await PGlite.create(path.join(sourceRoot, "server-db"));
  const literal = "profile LF\nCRLF\r\nbare CR\rUnicode 😺e\u0301\n";
  try {
    await legacy.exec(`CREATE TABLE public.migration_probe (
      id serial PRIMARY KEY, content text, metadata jsonb, raw bytea,
      large_number bigint, precise_number numeric, happened_at timestamptz,
      values_array text[], computed text GENERATED ALWAYS AS (content || '!') STORED);
      INSERT INTO public.migration_probe(content,metadata,raw,large_number,precise_number,happened_at,values_array)
      VALUES ('profile fixture', '{"null":null,"unicode":"é🦀","integer":9007199254740993}',
        decode('000102ff','hex'),9007199254740993,123456789012345678901234567890.12345,
        '2026-10-30T12:34:56.123456Z',ARRAY['NULL',NULL,'quoted"value']);
      INSERT INTO public.migration_probe(id,content,metadata) VALUES(3,'JSON null sentinel','null'::jsonb);
      SELECT setval('public.migration_probe_id_seq',101,false);`);
    await legacy.query(
      "INSERT INTO public.migration_probe(id,content) VALUES(2,$1)",
      [literal],
    );
    await legacy.exec(
      `CREATE FUNCTION public.migration_literal_probe() RETURNS text LANGUAGE sql AS $body$ SELECT $literal$${literal}$literal$::text $body$`,
    );
    report.expected = await snapshot(legacy);
  } finally {
    await legacy.close();
  }
  await mkdir(path.join(sourceRoot, "archives", "empty"), { recursive: true });
  const asset = Buffer.concat([
    Buffer.from("original\r\nlog\nbare\r😺\u0301\n"),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ]);
  await writeFile(path.join(sourceRoot, "archives", "opaque.bin"), asset, {
    mode: 0o600,
  });
  const key = await readFile(
    path.join(sourceRoot, "secret-encryption-key.json"),
  );
  const original = await files(sourceRoot);
  const bundle = path.join(root, "legacy-bundle");
  report.export = await exportLegacyProfile({
    source: sourceRoot,
    output: bundle,
    executable,
  });
  assert.deepEqual(
    await files(sourceRoot),
    original,
    "legacy conversion never opens or rewrites original files",
  );
  const manifest = JSON.parse(
    await readFile(path.join(bundle, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.databaseMode, "pglite");
  assert.ok(
    manifest.files.some((entry) => entry.path === "secret-encryption-key.json"),
  );
  const bundleFiles = await files(bundle);
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const data = path.join(root, "native-" + mode);
    const initial = {
      ...environment(data),
      CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      ...(mode === "bundled-postgres" ? { CANTRIP_DATABASE_MODE: mode } : {}),
      ...(mode === "postgres" ? { DATABASE_URL: await pg.database() } : {}),
    };
    const importStarted = Date.now();
    const records = await run(
      executable,
      ["--migrate-only", "--restore-profile", bundle],
      initial,
    );
    const importFinished = Date.now();
    const receipt = records.find(
      (value) => value.event === "profile.restore.completed",
    )?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.bundleId, report.export.bundleId);
    assert.equal(receipt.databaseMode, mode);
    const imported = await nativeSnapshot(data, mode, initial);
    assertImportedProfile(
      report.expected,
      imported,
      receipt,
      manifest,
      importStarted,
      importFinished,
    );
    assert.deepEqual(
      await readFile(path.join(data, "secret-encryption-key.json")),
      key,
    );
    assert.deepEqual(
      await readFile(path.join(data, "archives", "opaque.bin")),
      asset,
    );
    assert.ok((await stat(path.join(data, "archives", "empty"))).isDirectory());
    assert.equal(
      JSON.parse(
        await readFile(path.join(data, "server-database.json"), "utf8"),
      ).databaseMode,
      mode,
    );
    const native = new HttpFixture({
      kind: "rust",
      executable,
      root,
      name: "native-" + mode,
      databaseMode: mode,
      environment: environment(data),
    });
    native.clients = structuredClone(source.clients);
    native.tokens = new Map(source.tokens);
    let updated;
    try {
      // Start with the published root and its remembered backend, without an
      // explicit mode, PostgreSQL URL or binary directory.
      native.server = await startServer(
        executable,
        ["--port", "0", "--shutdown-on-stdin-close"],
        { cwd: repositoryRoot, env: native.environment },
      );
      const retained = await visit(
        native,
        "retained original session",
        "GET",
        "/api/auth/session",
      );
      assert.equal(retained.currentUser.id, session.currentUser.id);
      assert.equal(retained.csrfToken, session.csrfToken);
      assert.equal(
        (await visit(native, "same server identity", "GET", "/api/bootstrap"))
          .server.id,
        bootstrap.server.id,
      );
      const catalog = await visit(
        native,
        "original workspace",
        "GET",
        "/api/workspaces",
      );
      assert.deepEqual(
        catalog.workspaces.find((value) => value.id === workspaceId),
        created,
      );
      updated = await visit(
        native,
        "Rust revision write",
        "PATCH",
        "/api/workspaces/" + workspaceId,
        { json: { expectedRevision: 1, isDefault: true } },
      );
      assert.equal(updated.revision, 2);
    } finally {
      await native.close();
    }
    const writtenState = await nativeSnapshot(data, mode, initial);
    // Also prove that export includes the current file bytes rather than a
    // pre-migration snapshot. This is a fixture filesystem change, not a claim
    // that the unported production log archive has written this record.
    const extra = Buffer.from("after profile activation\r\n" + mode + "\n");
    await appendFile(path.join(data, "archives", "opaque.bin"), extra);
    const reverseBundle = path.join(root, "reverse-bundle-" + mode);
    const exported = await run(
      executable,
      [
        "--migrate-only",
        "--export-profile",
        reverseBundle,
        ...(process.env.CANTRIP_TEST_PG_DUMP_PATH
          ? ["--pg-dump-path", process.env.CANTRIP_TEST_PG_DUMP_PATH]
          : []),
      ],
      environment(data),
    );
    assert.ok(
      exported.some((value) => value.event === "profile.export.completed"),
    );
    const reverse = path.join(root, "legacy-after-" + mode);
    const reversed = await restoreLegacyProfile({
      source: reverseBundle,
      output: reverse,
      executable,
    });
    const reverseDatabase = await PGlite.create(
      path.join(reverse, "server-db"),
    );
    let reverseState;
    try {
      reverseState = await snapshot(reverseDatabase);
    } finally {
      await reverseDatabase.close();
    }
    assert.deepEqual(
      reverseState,
      writtenState,
      "reverse migration retains every table, sequence, function result and NULL kind after accepted Rust HTTP writes",
    );
    assert.deepEqual(
      await readFile(path.join(reverse, "secret-encryption-key.json")),
      key,
    );
    assert.deepEqual(
      await readFile(path.join(reverse, "archives", "opaque.bin")),
      Buffer.concat([asset, extra]),
    );
    const node = await verifyNodeAfterNativeExport({
      source: {
        fixture: native,
        result: { session, bootstrap, workspaceId, workspace: updated },
        auth,
      },
      reverseRoot: reverse,
      executable,
      root,
      mode,
    });
    report.modes.push({
      mode,
      receipt,
      reversed,
      node,
      filesRetained: true,
      importedSnapshot: imported,
      writtenSnapshot: writtenState,
      reverseSnapshot: reverseState,
      serverId: bootstrap.server.id,
    });
    assert.deepEqual(
      await files(bundle),
      bundleFiles,
      "every import preserves its source bundle",
    );
    // A completed target, even an empty one, is never replaced.
    const collision = path.join(root, "collision-" + mode);
    await mkdir(collision);
    let rejected;
    try {
      await run(
        executable,
        [
          "--data-dir",
          collision,
          "--migrate-only",
          "--restore-profile",
          bundle,
        ],
        {
          ...initial,
          ...(mode === "postgres" ? { DATABASE_URL: await pg.database() } : {}),
        },
      );
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected);
    assert.match(rejected.stderr, /AlreadyExists/);
    assert.deepEqual(await readdir(collision), []);
    report.modes.at(-1).interruption = await interruptedProfileImport({
      executable,
      bundle,
      root,
      mode,
      environment: {
        ...initial,
        ...(mode === "postgres" ? { DATABASE_URL: await pg.database() } : {}),
      },
      run,
    });
    const rejectedEnvironment = {
      ...initial,
      ...(mode === "postgres" ? { DATABASE_URL: await pg.database() } : {}),
    };
    report.modes.at(-1).rejection = await rejectedProfileImport({
      executable,
      bundle,
      root,
      mode,
      environment: rejectedEnvironment,
      run,
    });
    if (mode === "postgres") {
      const admin = postgres(rejectedEnvironment.DATABASE_URL, { max: 1 });
      try {
        assert.equal(
          (
            await admin`SELECT tablename FROM pg_tables WHERE schemaname IN ('public','drizzle')`
          ).length,
          0,
          "late SQL failure rolls back every imported table and its receipt in the external database",
        );
      } finally {
        await admin.end({ timeout: 5 });
      }
    }
  }
  // External PostgreSQL can commit while the server loses the acknowledgement.
  // Gate the actual backend COMMIT packet, then accept a real Rust HTTP write
  // before retrying the original profile snapshot into the same database.
  const direct = await pg.database(),
    proxy = await profileCommitProxy(direct);
  const committedRoot = path.join(root, "after-commit-profile");
  const before = new Set(await readdir(root));
  const child = spawn(
    executable,
    ["--migrate-only", "--restore-profile", bundle],
    {
      cwd: repositoryRoot,
      env: { ...environment(committedRoot), DATABASE_URL: proxy.url },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let childOut = "",
    childErr = "",
    childExit;
  child.stdout.on("data", (bytes) => (childOut += bytes));
  child.stderr.on("data", (bytes) => (childErr += bytes));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve((childExit = { code, signal })),
    );
  });
  completion.catch(() => {});
  let timer, admin;
  try {
    const committed = await Promise.race([
      proxy.committed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "real PostgreSQL COMMIT acknowledgement was not observed: " +
                  childErr,
              ),
            ),
          60000,
        );
      }),
      completion.then(() => {
        throw new Error(
          "profile server exited before held COMMIT: " + childErr,
        );
      }),
    ]);
    clearTimeout(timer);
    admin = postgres(direct, { max: 1 });
    assert.equal(
      (
        await admin`SELECT key FROM public.system_state WHERE key LIKE 'profile-import:%'`
      ).length,
      1,
      "the actual import receipt is committed before killing the client",
    );
    child.kill("SIGKILL");
    await completion;
    assert.notEqual(childExit.code, 0);
    assert.equal(childOut.includes('"profile.restore.completed"'), false);
    await assert.rejects(stat(committedRoot), { code: "ENOENT" });
    for (const name of await readdir(root))
      if (name.startsWith(".cantrip-profile-") && !before.has(name))
        await rm(path.join(root, name), { recursive: true, force: true });
    const writer = new HttpFixture({
      kind: "rust",
      executable,
      root,
      name: "post-commit-writer",
      databaseMode: "postgres",
      environment: {
        ...environment(path.join(root, "post-commit-writer")),
        DATABASE_URL: direct,
      },
    });
    writer.clients = structuredClone(source.clients);
    writer.tokens = new Map(source.tokens);
    let written;
    try {
      await writer.start();
      written = await visit(
        writer,
        "write after committed import",
        "PATCH",
        "/api/workspaces/" + workspaceId,
        { json: { expectedRevision: 1, isDefault: true } },
      );
      assert.equal(written.revision, 2);
    } finally {
      await writer.close();
    }
    const records = await run(
      executable,
      ["--migrate-only", "--restore-profile", bundle],
      { ...environment(committedRoot), DATABASE_URL: direct },
    );
    assert.ok(
      records.some((value) => value.event === "profile.restore.completed"),
    );
    const resumed = new HttpFixture({
      kind: "rust",
      executable,
      root,
      name: "post-commit-resumed",
      databaseMode: "postgres",
      environment: environment(committedRoot),
    });
    resumed.clients = structuredClone(source.clients);
    resumed.tokens = new Map(source.tokens);
    try {
      resumed.server = await startServer(
        executable,
        ["--port", "0", "--shutdown-on-stdin-close"],
        { cwd: repositoryRoot, env: resumed.environment },
      );
      const catalog = await visit(
        resumed,
        "retains post-commit HTTP write",
        "GET",
        "/api/workspaces",
      );
      assert.deepEqual(
        catalog.workspaces.find((value) => value.id === workspaceId),
        written,
      );
      assert.equal(
        (
          await visit(
            resumed,
            "retains identity after lost ack",
            "GET",
            "/api/bootstrap",
          )
        ).server.id,
        bootstrap.server.id,
      );
    } finally {
      await resumed.close();
    }
    report.lostCommitAcknowledgement = {
      ...committed,
      retainedRustWriteRevision: written.revision,
      profilePublishedOnRetry: true,
    };
  } finally {
    clearTimeout(timer);
    if (!childExit) {
      child.kill("SIGKILL");
      await completion.catch(() => {});
    }
    await admin?.end({ timeout: 5 });
    await proxy.close();
  }
  assert.deepEqual(await files(sourceRoot), original);
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  await pg?.close();
  if (values.report) {
    await mkdir(path.dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    modes: report.modes.map((value) => ({
      mode: value.mode,
      filesRetained: value.filesRetained,
      nodeWriteRevision: value.node.nodeWriteRevision,
    })),
  }),
);
