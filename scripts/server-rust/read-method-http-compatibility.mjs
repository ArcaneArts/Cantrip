// Compare automatic HEAD dispatch with real Source GET behavior and retained SQL.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { HttpFixture } from "./http-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  readMethodSeed,
  readCases,
  localOwner,
} from "./read-method-fixtures.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    "observe-differences": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-read-method-http-"));
process.stderr.write(
  JSON.stringify({ event: "read-method.http.created", root }) + "\n",
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Real production HTTP/router and isolated SQL; no guest executors or platform acceptance claim.",
};
const origin = "http://127.0.0.1:5173";
const headers = [
  "content-type",
  "content-length",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "vary",
  "x-content-type-options",
  "referrer-policy",
  "content-security-policy",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "x-frame-options",
];
function normalizeState(value, f, key = "") {
  if (Array.isArray(value)) return value.map((x) => normalizeState(x, f));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeState(v, f, k)]),
    );
  if (typeof value === "string" && key.endsWith("_at")) {
    assert.ok(Number.isFinite(Date.parse(value)), key);
    if (value.startsWith("2026-10-25")) {
      const fixed =
        /^2026-10-25[ T]00:00:00\.(\d{1,6})(?:Z|\+00(?::00)?)$/.exec(value);
      assert.ok(fixed, "Retain actual fixed fixture timestamp precision");
      return `2026-10-25T00:00:00.${fixed[1].padEnd(6, "0")}Z`;
    }
    return "<timestamp>";
  }
  return f.normalize(value, key);
}
function normalizeSnapshot(value, fixture) {
  const snapshot = normalizeState(value, fixture);
  // Sort table rows after owner-ID normalization; retain nested JSON array order.
  for (const rows of Object.values(snapshot)) {
    const identity = (row) =>
      String(
        row.id ??
          row.operation_id ??
          row.workspace_id ??
          row.instance_id ??
          row.chat_id ??
          JSON.stringify(row),
      );
    rows.sort((a, b) => identity(a).localeCompare(identity(b)));
  }
  return snapshot;
}
async function run(f, profile, result) {
  try {
    await f.start();
    await mkdir(path.join(root, profile, f.kind), { recursive: true });
    const auth = await f.observe(
      "authentication",
      profile === "accounts" ? "POST" : profile === "password" ? "POST" : "GET",
      profile === "accounts"
        ? "/api/auth/register"
        : profile === "password"
          ? "/api/auth/login"
          : "/api/auth/session",
      profile === "accounts"
        ? {
            status: 201,
            json: {
              email: "read-method@example.invalid",
              displayName: "Read methods",
              password,
            },
          }
        : profile === "password"
          ? { json: { password } }
          : {},
    );
    result.authentication = auth;
    const owner = f.records.get("authentication").currentUser?.id ?? localOwner;
    await f.sql(readMethodSeed(owner));
    const [names] = await f.sql(
      [],
      [
        "SELECT jsonb_agg(table_name ORDER BY table_name)::text AS result FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'cantrip_os_%' OR table_name IN ('workers','projects','project_sources','project_worktrees'))",
      ],
    );
    const snapshotSQL = `SELECT jsonb_build_object(${names.flatMap((name) => ["'" + name + "'", `(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${name} t)`]).join(",")})::text AS result`;
    const snapshot = async () => (await f.sql([], [snapshotSQL]))[0];
    for (const entry of readCases()) {
      const pair = [];
      for (const method of ["GET", "HEAD"]) {
        const before = await snapshot();
        const client = f.client();
        const response = await fetch(f.server.origin + entry.url, {
          method,
          headers: {
            origin,
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
          signal: AbortSignal.timeout(15000),
        });
        const text = await response.text();
        if (method === "HEAD") assert.equal(text, "");
        const body = text ? JSON.parse(text) : null;
        if (
          !values["observe-differences"] &&
          method === "GET" &&
          entry.expectedIds
        ) {
          assert.equal(
            response.status,
            200,
            `${f.kind}/${entry.name}: ${text}`,
          );
          assert.deepEqual(
            body.items.map((item) => item.operationId),
            entry.expectedIds,
            `${f.kind}/${entry.name}: no cursor precision loss`,
          );
          assert.equal(body.nextCursor, entry.expectedCursor);
        }
        const after = await snapshot();
        if (!entry.changes && !values["observe-differences"])
          assert.deepEqual(
            after,
            before,
            `${f.kind}/${entry.name}/${method} must not change any selected SQL state`,
          );
        const rawStatePath = path.join(
          root,
          profile,
          f.kind,
          `state-${result.http.length}.json`,
        );
        await writeFile(
          rawStatePath,
          JSON.stringify({ before, after }, null, 2) + "\n",
        );
        result.sql.push({
          name: entry.name,
          method,
          before: normalizeSnapshot(before, f),
          after: normalizeSnapshot(after, f),
          rawStatePath,
        });
        const observed = {
          name: entry.name,
          method,
          url: entry.url,
          status: response.status,
          headers: Object.fromEntries(
            headers.map((k) => [k, response.headers.get(k)]),
          ),
          body: f.normalize(body),
        };
        result.http.push(observed);
        pair.push(observed);
        if (
          !values["observe-differences"] &&
          method === "GET" &&
          entry.name.startsWith("owned") &&
          !entry.name.includes("invalid") &&
          !entry.name.includes("missing") &&
          !entry.name.includes("unknown cursor")
        )
          assert.equal(
            response.status,
            200,
            `${f.kind}/${entry.name}: ${text}`,
          );
      }
      if (!values["observe-differences"] && entry.headCapabilityDenied) {
        assert.equal(
          pair[0].status,
          200,
          "Source permits the folder GET catalog",
        );
        assert.equal(
          pair[1].status,
          409,
          "Source guards the folder HEAD catalog",
        );
      } else if (!values["observe-differences"]) {
        assert.equal(
          pair[1].status,
          pair[0].status,
          `${f.kind}/${entry.name} HEAD must retain GET status`,
        );
        assert.deepEqual(
          pair[1].headers,
          pair[0].headers,
          `${f.kind}/${entry.name} HEAD must retain GET headers`,
        );
      }
    }
    result.passed = true;
  } finally {
    result.diagnostics = f.server?.diagnostics();
    await f.close();
  }
}
let pg;
try {
  const built =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const executable = path.join(
    root,
    "server-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  await copyFile(built, executable);
  report.executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of values.profile
    ? [values.profile]
    : ["development", "password", "accounts", "standalone"]) {
    const cell = { profile, runtimes: [] };
    report.profiles.push(cell);
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: values.database,
        liveSqlFixture: true,
        environment: {
          CANTRIP_AUTH_MODE: ["development", "standalone"].includes(profile)
            ? "none"
            : profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          PGLITE_RUNTIME_DIR: path.join(root, profile, kind, "pglite-runtime"),
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(profile === "standalone"
            ? { CANTRIP_BOOTSTRAP_MODE: "standalone" }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      if (profile === "standalone") delete f.environment.CANTRIP_WORKER_TOKEN;
      const result = { kind, http: [], sql: [] };
      cell.runtimes.push(result);
      process.stderr.write(
        JSON.stringify({
          event: "read-method.http.started",
          database: values.database,
          profile,
          kind,
        }) + "\n",
      );
      await run(f, profile, result);
    }
    const [left, right] = cell.runtimes;
    if (values["observe-differences"])
      cell.differences = left.http.flatMap((x, i) =>
        JSON.stringify(x) === JSON.stringify(right.http[i])
          ? []
          : [{ node: x, rust: right.http[i] }],
      );
    else {
      assert.deepEqual(
        right.authentication,
        left.authentication,
        profile + " authentication",
      );
      assert.equal(right.http.length, left.http.length);
      assert.equal(right.sql.length, left.sql.length);
      for (let index = 0; index < left.http.length; index++) {
        assert.deepEqual(
          right.http[index],
          left.http[index],
          `${profile} HTTP ${index}`,
        );
        const { rawStatePath: leftPath, ...leftState } = left.sql[index];
        const { rawStatePath: rightPath, ...rightState } = right.sql[index];
        assert.deepEqual(
          rightState,
          leftState,
          `${profile} SQL ${index}: ${leftPath} / ${rightPath}`,
        );
      }
      cell.passed = true;
    }
  }
  report.passed = !values["observe-differences"];
  report.observationCompleted = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  try {
    await pg?.close();
  } finally {
    if (values.report) {
      await mkdir(path.dirname(path.resolve(values.report)), {
        recursive: true,
      });
      await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
    }
  }
}
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    profiles: report.profiles.length,
    differences: report.profiles.map((x) => x.differences?.length),
  }),
);
