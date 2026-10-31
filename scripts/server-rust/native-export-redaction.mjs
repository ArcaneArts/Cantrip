import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment } from "./process.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-export-errors-"),
);
const report = { suite: "native-export-real-sql-redaction", root };
const at = process.argv.indexOf("--report"),
  reportPath = at < 0 ? undefined : process.argv[at + 1];
async function run(executable, args, env) {
  const child = spawn(executable, args, {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (v) => (stdout += v));
  child.stderr.on("data", (v) => (stderr += v));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
let owner, admin, failure;
try {
  const executable = await buildRustServer(),
    probe = await buildRustExample("database-export-diagnostics");
  owner = await postgresFixture(path.join(root, "postgres"));
  const url = await owner.database();
  admin = postgres(url, { max: 1 });
  const role = "cantrip_export_" + randomUUID().replaceAll("-", "");
  const password = randomUUID();
  const [{ statement }] =
    await admin`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',${role}::text,${password}::text) AS statement`;
  await admin.unsafe(statement);
  const needle = "private_export_diagnostic_value";
  await admin`CREATE TABLE private_export_diagnostic_value(value text)`;
  await admin`INSERT INTO private_export_diagnostic_value VALUES('fixture retained')`;
  const restricted = new URL(url);
  restricted.username = role;
  restricted.password = password;
  const env = {
    ...fixtureEnvironment(path.join(root, "profile")),
    DATABASE_URL: restricted.href,
  };
  const pgDump =
    process.env.CANTRIP_TEST_PG_DUMP_PATH ??
    path.join(
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      "pg_dump" + (process.platform === "win32" ? ".exe" : ""),
    );
  report.control = await run(
    pgDump,
    [
      "--host",
      restricted.hostname,
      "--port",
      restricted.port,
      "--username",
      role,
      "--dbname",
      restricted.pathname.slice(1),
      "--no-password",
      "--inserts",
      "--no-owner",
      "--no-privileges",
    ],
    {
      ...env,
      PGPASSWORD: password,
      PGSSLMODE: "disable",
      PGGSSENCMODE: "disable",
      PGCHANNELBINDING: "disable",
    },
  );
  assert.notEqual(report.control.code, 0);
  assert.ok(report.control.stderr.includes(needle), report.control.stderr);
  const output = path.join(root, "native-cli.sql");
  report.cli = await run(
    executable,
    [
      "--database",
      "postgres",
      "--migrate-only",
      "--export-sql",
      output,
      "--pg-dump-path",
      pgDump,
    ],
    env,
  );
  assert.notEqual(report.cli.code, 0);
  assert.equal(report.cli.stderr.includes(needle), false);
  assert.match(report.cli.stderr, /Logical database export failed/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  const diagnosticOutput = path.join(root, "explicit-diagnostics.sql");
  report.explicit = await run(probe, [pgDump, diagnosticOutput, needle], env);
  assert.equal(report.explicit.code, 0, report.explicit.stderr);
  report.private = JSON.parse(report.explicit.stdout.trim());
  assert.equal(report.private.privateDiagnosticRetained, true);
  await assert.rejects(readFile(diagnosticOutput), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(root)).filter((n) => n.startsWith(".cantrip-export-")),
    [],
  );
  assert.deepEqual(
    Array.from(await admin`SELECT value FROM private_export_diagnostic_value`),
    [{ value: "fixture retained" }],
  );
  const tables =
    await admin`SELECT tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY tablename`;
  assert.deepEqual(
    Array.from(tables),
    [{ tablename: needle }],
    "export never creates application schema or identities",
  );
  const selectedRole = "cantrip_selected_" + randomUUID().replaceAll("-", "");
  const [{ createRole }] =
    await admin`SELECT format('CREATE ROLE %I NOLOGIN',${selectedRole}::text) AS "createRole"`;
  await admin.unsafe(createRole);
  const [{ grantRole }] =
    await admin`SELECT format('GRANT %I TO %I',${selectedRole}::text,${role}::text) AS "grantRole"`;
  await admin.unsafe(grantRole);
  const [{ grantTable }] =
    await admin`SELECT format('GRANT SELECT ON private_export_diagnostic_value TO %I',${selectedRole}::text) AS "grantTable"`;
  await admin.unsafe(grantTable);
  const selectedUrl = new URL(restricted);
  selectedUrl.searchParams.set("options", "-c role=" + selectedRole);
  const applicationName = "native export + 🦀";
  selectedUrl.searchParams.set("application_name", applicationName);
  const reference = postgres(selectedUrl.href, { max: 1, connect_timeout: 2 });
  try {
    const [identity] =
      await reference`SELECT current_user::text AS active_role,session_user::text AS login_role,current_setting('application_name') AS application_name`;
    assert.equal(identity.active_role, selectedRole);
    assert.equal(identity.login_role, role);
    // PostgreSQL renders non-ASCII application-name bytes as escapes. Keep the
    // actual reference result as the exact Rust oracle, including those bytes.
    assert.ok(identity.application_name.startsWith("native export + "));
    report.nodeRoleIdentity = identity;
  } finally {
    await reference.end({ timeout: 5 });
  }
  const selectedOutput = path.join(root, "selected-role.sql");
  report.selectedRole = await run(
    executable,
    [
      "--database",
      "postgres",
      "--migrate-only",
      "--export-sql",
      selectedOutput,
      "--pg-dump-path",
      pgDump,
    ],
    { ...env, DATABASE_URL: selectedUrl.href },
  );
  assert.equal(report.selectedRole.code, 0, report.selectedRole.stderr);
  assert.ok(
    (await readFile(selectedOutput, "utf8")).includes("fixture retained"),
  );
  const roleProbeOutput = path.join(root, "role-probe.sql");
  report.roleProbe = await run(
    probe,
    [pgDump, roleProbeOutput, "--expect-success"],
    { ...env, DATABASE_URL: selectedUrl.href },
  );
  assert.equal(report.roleProbe.code, 0, report.roleProbe.stderr);
  assert.deepEqual(
    JSON.parse(report.roleProbe.stdout.trim()).identity,
    report.nodeRoleIdentity,
  );
  const authorizationUrl = new URL(url);
  authorizationUrl.searchParams.set(
    "options",
    "-c session_authorization=" + selectedRole,
  );
  authorizationUrl.searchParams.set("application_name", applicationName);
  const authorizationReference = postgres(authorizationUrl.href, {
    max: 1,
    connect_timeout: 2,
  });
  try {
    const [identity] =
      await authorizationReference`SELECT current_user::text AS active_role,session_user::text AS login_role,current_setting('application_name') AS application_name`;
    assert.equal(typeof identity.active_role, "string");
    assert.equal(typeof identity.login_role, "string");
    report.nodeSessionAuthorization = identity;
  } finally {
    await authorizationReference.end({ timeout: 5 });
  }
  const authorizationOutput = path.join(root, "session-authorization.sql");
  report.sessionAuthorization = await run(
    executable,
    [
      "--database",
      "postgres",
      "--migrate-only",
      "--export-sql",
      authorizationOutput,
      "--pg-dump-path",
      pgDump,
    ],
    { ...env, DATABASE_URL: authorizationUrl.href },
  );
  assert.equal(
    report.sessionAuthorization.code,
    0,
    report.sessionAuthorization.stderr,
  );
  assert.ok(
    (await readFile(authorizationOutput, "utf8")).includes("fixture retained"),
  );
  const authorizationProbeOutput = path.join(
    root,
    "session-authorization-probe.sql",
  );
  report.authorizationProbe = await run(
    probe,
    [pgDump, authorizationProbeOutput, "--expect-success"],
    { ...env, DATABASE_URL: authorizationUrl.href },
  );
  assert.equal(
    report.authorizationProbe.code,
    0,
    report.authorizationProbe.stderr,
  );
  assert.deepEqual(
    JSON.parse(report.authorizationProbe.stdout.trim()).identity,
    report.nodeSessionAuthorization,
  );
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  await admin?.end({ timeout: 5 });
  await owner?.close();
  if (reportPath)
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify({ suite: report.suite, passed: true, root }));
