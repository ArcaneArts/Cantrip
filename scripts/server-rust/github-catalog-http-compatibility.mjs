// Preserve the removed plaintext catalog surface through real production HTTP.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "postgres", "bundled-postgres"].includes(databaseMode));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-github-catalog-"));
const report = { databaseMode, root, completeReplacement: false, profiles: [] };
let database, failure;
try {
  const executable = await buildRustServer();
  const password = "catalog-fixture-password";
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    database = await postgresFixture(path.join(root, "postgres"));
  for (const mode of ["none", "password", "accounts"]) {
    const profile = { mode, runtimes: [] };
    report.profiles.push(profile);
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        database && (kind === "node" || databaseMode === "postgres")
          ? await database.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: mode,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: mode,
          CANTRIP_PASSWORD_HASH: passwordHash,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const observations = [];
      const runtime = { kind, observations };
      profile.runtimes.push(runtime);
      let runtimeFailure;
      const visit = async (label, method, url, options = {}) => {
        const observation = await fixture.observe(label, method, url, options);
        observations.push({ label, ...observation });
        return observation;
      };
      try {
        await fixture.start();
        if (mode !== "none") {
          await visit("anonymous", "GET", "/api/github/status", {
            status: 401,
          });
          await visit(
            "anonymous malformed",
            "POST",
            "/api/github/repositories",
            {
              status: 401,
              raw: "{",
              headers: { "content-type": "application/json" },
            },
          );
          if (mode === "password")
            await visit("login", "POST", "/api/auth/login", {
              json: { password },
            });
          else
            await visit("register", "POST", "/api/auth/register", {
              status: 201,
              json: {
                email: "catalog@example.test",
                password,
                displayName: "Catalog",
              },
            });
          await visit(
            "csrf before removal",
            "POST",
            "/api/github/repositories",
            { status: 403, json: {} },
          );
        }
        for (const route of [
          "status",
          "repositories/cache",
          "repository-owners",
          "repositories",
          "unknown",
          "",
        ]) {
          for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
            const observation = await visit(
              `${method} ${route}`,
              method,
              `/api/github/${route}?workerId=foreign&workerId=missing&login=private`,
              { status: 410, csrf: true },
            );
            assert.deepEqual(
              observation.body,
              method === "HEAD"
                ? null
                : {
                    error:
                      "This plaintext repository route was removed. Use the protected repository operation endpoint.",
                  },
            );
          }
        }
        await visit("malformed payload", "POST", "/api/github/repositories", {
          status: 410,
          csrf: true,
          raw: "{",
          headers: { "content-type": "application/json" },
        });
        await visit("unsupported payload", "POST", "/api/github/repositories", {
          status: 410,
          csrf: true,
          raw: "private",
          headers: { "content-type": "application/x-catalog" },
        });
        await visit("origin before removal", "GET", "/api/github/status", {
          status: 403,
          headers: { origin: "https://foreign.invalid" },
        });
        await visit(
          "preflight before removal",
          "OPTIONS",
          "/api/github/status",
          { status: 204, headers: { "access-control-request-method": "GET" } },
        );
      } catch (error) {
        runtimeFailure = error;
        throw error;
      } finally {
        try {
          await fixture.close();
        } catch (error) {
          runtime.cleanupFailure = error.stack;
          if (!runtimeFailure) throw error;
        }
      }
    }
    assert.deepEqual(
      profile.runtimes[1].observations,
      profile.runtimes[0].observations,
      `${mode} exact HTTP compatibility`,
    );
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  try {
    await database?.close();
  } catch (error) {
    report.cleanupFailure = error.stack;
    failure ??= error;
  }
  const target = option("--report");
  if (target) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify(report));
