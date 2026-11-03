// Real servers, SQL, sessions and WorkerConnection; only the remote probe is controlled.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { runSettingsActiveWorkHttpCases } from "./settings-active-work-http-cases.mjs";
import { runSettingsProviderHttpCases } from "./settings-provider-http-cases.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-settings-operations-"));
const report = {
  suite: "actual-settings-operations-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const endpoint = "/api/settings/providers/probe-zai/test";
let pg, h, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (v) => !option("--profile") || v === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        snapshotProofs: 0,
      };
      outputs.push(result);
      let reply = { accepted: true, durationMs: 7 },
        message,
        held;
      const controller = {
        hold() {
          const releases = [];
          held = {
            requests: 0,
            completed: 0,
            releases,
            release() {
              for (const resolve of releases) resolve();
            },
            releaseOne(n) {
              releases[n]();
            },
          };
          return held;
        },
        reset() {
          held = undefined;
          message = undefined;
          reply = { accepted: true, durationMs: 7 };
        },
      };
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "2" },
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        configure: (owner) => [
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('probe-zai',${literal(owner)},'Probe','openai-compatible','https://api.z.ai/api/v1'),('probe-plain',${literal(owner)},'Other','openai-compatible','http://fixture.invalid')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('probe-generic',${literal(owner)},'Generic'),('probe-preferred',${literal(owner)},'Preferred')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('probe-generic-route','probe-generic','probe-zai','glm-4.5',0),('probe-preferred-route','probe-preferred','probe-zai','glm-5.3',1)",
        ],
        onCommand: async (command) => {
          if (command.type !== "model.provider.test") return undefined;
          result.commands.push(h.fixture.normalize(command));
          const gate = held;
          if (gate) {
            gate.requests++;
            await new Promise((resolve) => gate.releases.push(resolve));
            gate.completed++;
          }
          if (message !== undefined) throw new Error(message);
          return reply;
        },
      });
      const visit = async (name, method, url, options = {}) => {
        const start = Date.now(),
          v = await h.visit(name, method, url, options);
        if (typeof v?.durationMs === "number") {
          assert.ok(
            Number.isInteger(v.durationMs) &&
              v.durationMs >= 0 &&
              v.durationMs <= Date.now() - start + 100,
            "actual probe wall-clock duration",
          );
          result.observations.at(-1).body.durationMs = "<bounded-duration>";
        }
        return v;
      };
      try {
        const empty = {
          activeChats: 0,
          queuedPrompts: 0,
          terminalServices: 0,
          backgroundJobs: 0,
        };
        assert.deepEqual(
          await visit(
            "empty active work",
            "GET",
            "/api/desktop-update/active-work",
          ),
          empty,
        );
        await visit(
          "active work HEAD",
          "HEAD",
          "/api/desktop-update/active-work",
        );
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        assert.deepEqual(
          await visit(
            "running chat counts",
            "GET",
            "/api/desktop-update/active-work",
          ),
          { ...empty, activeChats: 1 },
        );
        await h.fixture.sql([
          `UPDATE chats SET status='waiting-for-approval' WHERE id=${literal(chat)}`,
        ]);
        assert.deepEqual(
          await visit(
            "approval counts",
            "GET",
            "/api/desktop-update/active-work",
          ),
          { ...empty, activeChats: 1 },
        );
        await h.fixture.sql([
          `UPDATE chats SET archived_at=now() WHERE id=${literal(chat)}`,
        ]);
        assert.deepEqual(
          await visit(
            "archived chat excluded",
            "GET",
            "/api/desktop-update/active-work",
          ),
          empty,
        );
        await h.fixture.sql([
          `UPDATE chats SET status='idle',archived_at=NULL WHERE id=${literal(chat)}`,
        ]);
        await visit(
          "missing provider",
          "POST",
          "/api/settings/providers/missing/test",
          { json: {}, status: 404 },
        );
        await visit(
          "other provider kind",
          "POST",
          "/api/settings/providers/probe-plain/test",
          { json: {}, status: 409 },
        );
        for (const body of [undefined, null, {}, [], "ignored", false]) {
          const value = await visit(
            "probe ignores body " + JSON.stringify(body),
            "POST",
            endpoint,
            { ...(body === undefined ? {} : { json: body }) },
          );
          assert.equal(value.ok, true);
          assert.equal(value.stage, "completed");
          assert.equal(value.modelName, "glm-5.3");
          assert.equal(value.workerId, worker);
        }
        await visit(
          "malformed JSON before lookup",
          "POST",
          "/api/settings/providers/missing/test",
          {
            raw: "{",
            headers: { "content-type": "application/json" },
            status: 400,
          },
        );
        const requested = await visit(
          "unknown requested worker",
          "POST",
          endpoint + "?workerId=missing",
          { json: {} },
        );
        assert.equal(requested.stage, "worker-placement");
        assert.equal(requested.workerId, "missing");
        await visit(
          "duplicate worker query preserves output validation",
          "POST",
          endpoint + "?workerId=one&workerId=two",
          { json: {}, status: 500 },
        );
        const [saved] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('routes',(SELECT jsonb_agg(id) FROM model_routes WHERE provider_id='probe-zai' AND enabled))::text result",
          ],
        );
        await h.fixture.sql([
          "UPDATE model_routes SET enabled=false WHERE provider_id='probe-zai'",
        ]);
        const unavailable = await visit("no enabled model", "POST", endpoint, {
          json: {},
        });
        assert.equal(unavailable.stage, "model-availability");
        assert.equal(unavailable.modelName, null);
        await h.fixture.sql([
          `UPDATE model_routes SET enabled=true WHERE id IN (${saved.routes.map(literal).join(",")})`,
        ]);
        await h.fixture.sql([
          "UPDATE model_routes SET enabled=false WHERE id='probe-preferred-route'",
        ]);
        assert.equal(
          (
            await visit("first runtime fallback", "POST", endpoint, {
              json: {},
            })
          ).modelName,
          "glm-4.5",
        );
        await h.fixture.sql([
          "UPDATE model_routes SET enabled=true WHERE id='probe-preferred-route'",
        ]);
        for (const text of [
          "Worker is offline.",
          "Codex app-server exited before listening.",
          "401 Unauthorized API key",
          "unknown model 404",
          "responses endpoint 404",
          "429 Too Many Requests",
          "provider error \ud800",
          "\ufeff worKer not available \u2029",
        ]) {
          message = text;
          const value = await visit(
            "worker failure " + text,
            "POST",
            endpoint,
            { json: {} },
          );
          assert.equal(value.ok, false);
        }
        message = undefined;
        for (const value of [
          null,
          false,
          [],
          {},
          { accepted: false, durationMs: 1 },
          { accepted: true, durationMs: -1 },
          { accepted: true, durationMs: 0.5 },
          { accepted: true, durationMs: null },
          { accepted: true, durationMs: 0, future: true },
        ]) {
          reply = value;
          const outcome = await visit(
            "worker reply " + JSON.stringify(value),
            "POST",
            endpoint,
            { json: {} },
          );
          assert.equal(
            outcome.ok,
            value?.accepted === true && value.durationMs === 0,
          );
        }
        if (profile !== "none") {
          await visit(
            "anonymous active work",
            "GET",
            "/api/desktop-update/active-work",
            { client: "anonymous", status: 401 },
          );
          await visit("anonymous probe", "POST", endpoint, {
            client: "anonymous",
            json: {},
            status: 401,
          });
          await visit("probe requires CSRF", "POST", endpoint, {
            csrf: false,
            json: {},
            status: 403,
          });
        }
        if (profile === "accounts") {
          assert.deepEqual(
            await visit(
              "foreign owner sees no active work",
              "GET",
              "/api/desktop-update/active-work",
              { client: "other" },
            ),
            empty,
          );
          await visit("foreign provider hidden", "POST", endpoint, {
            client: "other",
            json: {},
            status: 404,
          });
        }
        controller.reset();
        await runSettingsProviderHttpCases({
          h,
          visit,
          result,
          controller,
          deadline: process.argv.includes("--deadline"),
        });
        await runSettingsActiveWorkHttpCases(h, visit);
      } finally {
        result.diagnostics = h.diagnostics();
        await h.close();
        h = null;
      }
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + " HTTP wire",
    );
    assert.deepEqual(
      outputs[1].commands,
      outputs[0].commands,
      profile + " worker command wire",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
} finally {
  await h?.close().catch(() => {});
  await pg?.close();
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/settings-operations-${databaseMode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure) await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      databaseMode,
      profiles: report.profiles.length,
      passed: report.passed ?? false,
      report: destination,
    }),
  );
}
if (failure) throw failure;
