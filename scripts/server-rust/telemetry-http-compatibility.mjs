// Production HTTP/Live routes and migrated storage, with the existing Node
// service as the independent reference. No server methods are replaced.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { telemetryDeleteShutdown } from "./telemetry-delete-shutdown.mjs";
import {
  startOperationClock,
  assertGeneratedAtInOperation,
} from "./operation-clock.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-telemetry-http-"));
const report = {
  suite: "actual-provider-telemetry-http-live",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
  httpParityPassed: false,
  timestampBoundsPassed: false,
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const anchor = Math.floor(Date.now() / 86400000) * 86400000;
const times = Array.from({ length: 41 }, (_, i) =>
  new Date(anchor - (40 - i) * 86400000).toISOString(),
);
const stamp = times[40],
  reset = new Date(anchor + 7 * 86400000).toISOString();
const seedTimes = new Set([...times, reset]);
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-clock-fixture"));
  const repositoryExecutable = await buildRustExample(
    "settings-repository-fixture",
  );
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const mode of ["accounts", "none"]) {
    const profile = { mode, runtimes: [] };
    report.profiles.push(profile);
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: mode,
        databaseMode,
        observeHttpClocks: true,
        environment: {
          CANTRIP_AUTH_MODE: mode,
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
      const originalNormalize = fixture.normalize.bind(fixture);
      fixture.normalize = (value, key = "") =>
        typeof value === "string" && seedTimes.has(value)
          ? value
          : originalNormalize(value, key);
      const result = { kind, observations: [], generatedTimes: [], events: [] };
      const pendingClocks = [];
      profile.runtimes.push(result);
      const base = "/api/analytics/provider-telemetry";
      const visit = async (label, method, target, options = {}) => {
        const finishParentClock = startOperationClock();
        const response = await fixture.observe(label, method, target, {
          csrf: !["GET", "HEAD"].includes(method),
          ...options,
        });
        const parentClock = finishParentClock();
        const actual = fixture.records.get(label);
        if (actual?.generatedAt || actual?.range) {
          const requestId = [...fixture.requests].findLast(
            ([, value]) => value === label,
          )?.[0];
          const timing = {
            label,
            requestId,
            generatedAt: actual.generatedAt ?? null,
            rangeTo: actual.range?.to ?? null,
            parentClock,
            parentBoundsPassed: Object.fromEntries(
              [
                ["generatedAt", actual.generatedAt],
                ["rangeTo", actual.range?.to],
              ]
                .filter(([, value]) => value != null)
                .map(([field, value]) => [
                  field,
                  Date.parse(value) >= parentClock.before &&
                    Date.parse(value) <= parentClock.after,
                ]),
            ),
          };
          result.generatedTimes.push(timing);
          pendingClocks.push({ timing, events: fixture.server.events });
        }
        if (actual?.range) {
          const values = new URL(target, "http://fixture").searchParams.getAll(
            "days",
          );
          const parsed = Number.parseInt(
            values.length ? values.join(",") : "90",
            10,
          );
          const days = Number.isFinite(parsed)
            ? Math.min(365, Math.max(1, parsed))
            : 90;
          assert.equal(
            Date.parse(actual.range.to) - Date.parse(actual.range.from),
            days * 86400000,
            "exact Source days interval",
          );
          response.body.range = {
            from: "<range-from:" + days + ">",
            to: "<range-to>",
          };
        }
        result.observations.push({ label, ...response });
        return actual;
      };
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
      let repository, live, owner, other;
      try {
        await fixture.start();
        if (mode === "accounts") {
          await visit("anonymous analytics", "GET", base, {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous export", "GET", base + "/provider/export", {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous delete", "DELETE", base + "/provider", {
            client: "anonymous",
            status: 401,
          });
          for (const client of ["main", "other"])
            await fixture.observe(
              "register " + client,
              "POST",
              "/api/auth/register",
              {
                client,
                status: 201,
                json: {
                  displayName: "Telemetry " + client,
                  email: `telemetry-${client}@example.invalid`,
                  password: "isolated telemetry fixture password",
                },
              },
            );
        }
        await fixture.observe("session", "GET", "/api/auth/session");
        owner =
          mode === "accounts"
            ? fixture.records.get("session").currentUser.id
            : "00000000-0000-0000-0000-000000000001";
        other =
          mode === "accounts"
            ? (await fixture.observe(
                "other session",
                "GET",
                "/api/auth/session",
                { client: "other" },
              ),
              fixture.records.get("other session").currentUser.id)
            : "22222222-2222-4222-8222-222222222222";
        await fixture.close();
        repository = await openRepository();
        if (mode === "none")
          await repository.seed(
            `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(other)},'account','Other','telemetry-other@example.invalid','telemetry-other@example.invalid')`,
          );
        for (const [provider, who] of [
          ["telemetry-provider", owner],
          ["telemetry-failing", owner],
          ["telemetry-invalid", owner],
          ["telemetry-deep", owner],
          ["telemetry-foreign", other],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider)},${literal(who)},${literal("DO_NOT_EXPORT_PROVIDER_NAME_" + provider)},'openai-compatible','https://example.invalid')`,
          );
        await repository.seed(
          `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,weekly_usage_used_basis_points,created_at,updated_at) VALUES('telemetry-account','telemetry-provider',${literal(JSON.stringify(policyEnvelope))},'DO_NOT_EXPORT_CREDENTIAL_HOME',4567,${literal(stamp)},${literal(stamp)})`,
        );
        await repository.seed(
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES('project',${literal(owner)},${literal(JSON.stringify({ classification: { recordKind: "project" }, protectedLabel: policyEnvelope }))},'managed-folder','external','direct')`,
        );
        await repository.seed(
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('model',${literal(owner)},'DO_NOT_EXPORT_MODEL_NAME')`,
        );
        for (const [suffix, provider, who, offset] of [
          ["own", "telemetry-provider", owner, 0],
          ["foreign-owner", "telemetry-provider", other, 1000],
          ["foreign-provider", "telemetry-foreign", other, 2000],
          ["failure", "telemetry-failing", owner, 3000],
        ]) {
          for (let i = 0; i < 40; i++) {
            // Source SQL orders only by time. Distinct seeded times let the
            // exact response comparison assert that order without inventing
            // an ordering contract for equal timestamps.
            const at = new Date(
              Date.parse(times[i + 1]) + offset,
            ).toISOString();
            seedTimes.add(at);
            await repository.seed(
              `INSERT INTO provider_quota_observations(id,owner_id,event_key,observation_batch_key,provider_id,provider_kind,provider_account_id,observed_at,received_at,used_percent_micros,resets_at,window_duration_minutes,window_kind,observation_trigger,worker_version) VALUES(${literal(suffix + "-q" + i)},${literal(who)},${literal(suffix + "-e" + i)},'batch',${literal(provider)},'openai-compatible','telemetry-account',${literal(at)},${literal(at)},${i * 1000000},${literal(reset)},10080,'weekly','fixture','worker-fixture')`,
            );
            await repository.seed(
              `INSERT INTO token_usage_records(id,owner_id,source_key,source_aliases,provider_id,provider_account_id,model_id,reasoning_effort,project_id,input_tokens,output_tokens,cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,started_at,completed_at,created_at,updated_at) VALUES(${literal(suffix + "-t" + i)},${literal(who)},${literal(suffix + "-s" + i)},'["DO_NOT_EXPORT_SOURCE_ALIAS"]',${literal(provider)},'telemetry-account','model','high','project',${i < 20 ? 100 : 1000},20,5,3,7,${literal(at)},${literal(at)},${literal(stamp)},${literal(stamp)})`,
            );
            await repository.seed(
              `INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,provider_account_id,model_id,reasoning_effort,project_id,started_at,completed_at,created_at,updated_at,attempt_status,tool_call_count,invalid_tool_call_count,duration_ms,compaction_count,output_tokens,reasoning_output_tokens,signal_availability,native_attribution) VALUES(${literal(suffix + "-b" + i)},${literal(who)},${literal(suffix + "-bs" + i)},${literal(suffix + "-a" + i)},${literal(provider)},'telemetry-account','model','high','project',${literal(at)},${literal(at)},${literal(stamp)},${literal(stamp)},${literal(i < 20 ? "completed" : "failed")},10,${i < 20 ? 0 : 7},${i < 20 ? 1000 : 10000},${i < 20 ? 0 : 2},100,${i < 20 ? 10 : 90},'{"nativeReasoningKnown":false}','{"version":1,"turnIds":[],"captures":[],"conflictingTurnKeys":[]}')`,
            );
          }
          await repository.seed(
            `INSERT INTO provider_model_catalog_snapshots(id,owner_id,provider_id,provider_account_id,availability_scope,metadata_source,metadata_hash,observed_at,created_at) VALUES(${literal(suffix + "-catalog")},${literal(who)},${literal(provider)},'telemetry-account','worker','catalog','hash',${literal(stamp)},${literal(stamp)})`,
          );
        }
        const deepAvailability = new Map();
        for (const depth of [100, 150, 300]) {
          const started = new Date(Date.parse(stamp) + depth).toISOString();
          seedTimes.add(started);
          const availability =
            '{"nativeReasoningKnown":true,"structured":' +
            "[".repeat(depth) +
            "true" +
            "]".repeat(depth) +
            "}";
          deepAvailability.set(depth, JSON.parse(availability));
          await repository.seed(
            `INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,started_at,created_at,updated_at,signal_availability) VALUES(${literal("deep-" + depth)},${literal(owner)},${literal("deep-" + depth)},'deep-attempt','telemetry-deep',${literal(started)},${literal(stamp)},${literal(stamp)},${literal(availability)})`,
          );
        }
        await repository.seed(
          `INSERT INTO token_usage_records(id,owner_id,source_key,provider_id,input_tokens,output_tokens,native_usage,created_at,updated_at) VALUES('invalid-export',${literal(owner)},'invalid','telemetry-invalid',1,0,'{"rawPayload":"DO_NOT_EXPORT_RAW_PAYLOAD"}',${literal(stamp)},${literal(stamp)})`,
        );
        await repository.seed(
          "CREATE FUNCTION telemetry_http_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.provider_id='telemetry-failing' THEN RAISE EXCEPTION 'telemetry delete failure'; END IF; RETURN OLD; END $$",
        );
        await repository.seed(
          "CREATE TRIGGER telemetry_http_failure BEFORE DELETE ON model_behavior_observations FOR EACH ROW EXECUTE FUNCTION telemetry_http_failure()",
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        const query = (values) => base + "?" + new URLSearchParams(values);
        const analytics = await visit("analytics default", "GET", base);
        assert.ok(
          analytics.changePoints.length > 0,
          "actual integrated change points",
        );
        assert.ok(!JSON.stringify(analytics).includes("DO_NOT_EXPORT"));
        assert.equal(analytics.quotaHistory.length, 80);
        for (const [label, values] of [
          ["provider", { providerId: "telemetry-provider" }],
          ["account", { providerAccountId: "telemetry-account" }],
          ["model", { modelId: "model" }],
          ["reasoning", { reasoningEffort: "high" }],
          ["project", { projectId: "project" }],
          ["missing", { providerId: "missing" }],
          ["foreign", { providerId: "telemetry-foreign" }],
          [
            "empty filters",
            {
              providerId: "",
              providerAccountId: "",
              modelId: "",
              reasoningEffort: "",
              projectId: "",
            },
          ],
          [
            "all filters",
            {
              providerId: "telemetry-provider",
              providerAccountId: "telemetry-account",
              modelId: "model",
              reasoningEffort: "high",
              projectId: "project",
            },
          ],
        ])
          await visit("analytics " + label, "GET", query(values));
        for (const days of [
          "",
          "0",
          "-4",
          "1",
          "2",
          "365",
          "366",
          "900",
          "2.9",
          " +7rest",
          "0x10",
          "garbage",
          "Infinity",
          "9".repeat(310),
          "\ufeff3",
        ])
          await visit(
            "days " + days,
            "GET",
            query({ days, providerId: "telemetry-provider" }),
          );
        for (const key of [
          "providerId",
          "providerAccountId",
          "modelId",
          "reasoningEffort",
          "projectId",
          "days",
        ])
          await visit(
            "repeated " + key,
            "GET",
            base + "?" + key + "=2&" + key + "=3",
          );
        await visit("analytics head", "HEAD", base);
        await visit("export head", "HEAD", base + "/telemetry-provider/export");
        for (const provider of ["missing", "telemetry-foreign"]) {
          await visit(
            "unavailable export " + provider,
            "GET",
            base + "/" + provider + "/export",
            { status: 404 },
          );
          await visit(
            "unavailable delete " + provider,
            "DELETE",
            base + "/" + provider,
            { status: 404 },
          );
        }
        await visit(
          "invalid stored native export",
          "GET",
          base + "/telemetry-invalid/export",
          { status: 500 },
        );
        const deepExport = await visit(
          "deep structured export",
          "GET",
          base + "/telemetry-deep/export",
        );
        assert.equal(deepExport.modelBehavior.length, deepAvailability.size);
        for (const [depth, availability] of deepAvailability)
          assert.deepEqual(
            deepExport.modelBehavior.find((row) => row.id === "deep-" + depth)
              .signalAvailability,
            availability,
          );
        const deepAnalytics = await visit(
          "deep structured analytics",
          "GET",
          query({ providerId: "telemetry-deep" }),
        );
        assert.equal(
          deepAnalytics.behavior.total.attemptCount,
          deepAvailability.size,
        );
        if (mode === "accounts") {
          await visit(
            "foreign session export",
            "GET",
            base + "/telemetry-provider/export",
            { client: "other", status: 404 },
          );
          await visit(
            "foreign session delete",
            "DELETE",
            base + "/telemetry-provider",
            { client: "other", status: 404 },
          );
          await visit(
            "delete missing csrf",
            "DELETE",
            base + "/telemetry-provider",
            { csrf: false, status: 403 },
          );
        }
        const failedBefore = await visit(
          "before failed delete",
          "GET",
          base + "/telemetry-failing/export",
        );
        await visit(
          "real transaction rollback",
          "DELETE",
          base + "/telemetry-failing",
          { status: 500 },
        );
        const failedAfter = await visit(
          "after failed delete",
          "GET",
          base + "/telemetry-failing/export",
        );
        const withoutGenerated = (value) => {
          const copy = structuredClone(value);
          delete copy.generatedAt;
          return copy;
        };
        assert.deepEqual(
          withoutGenerated(failedAfter),
          withoutGenerated(failedBefore),
          "all four tables survive failed later delete",
        );
        const exported = await visit(
          "owned export",
          "GET",
          base + "/telemetry-provider/export",
        );
        assert.equal(exported.quotaObservations.length, 40);
        assert.equal(exported.tokenUsage.length, 40);
        assert.equal(exported.modelBehavior.length, 40);
        assert.equal(exported.modelCatalogSnapshots.length, 1);
        assert.ok(!JSON.stringify(exported).includes("DO_NOT_EXPORT"));
        const deleted = await visit(
          "delete owned history",
          "DELETE",
          base + "/telemetry-provider",
        );
        assert.deepEqual(deleted, {
          providerId: "telemetry-provider",
          deleted: {
            quotaObservations: 40,
            tokenUsage: 40,
            modelBehavior: 40,
            modelCatalogSnapshots: 1,
          },
        });
        const empty = await visit(
          "retained account projection",
          "GET",
          query({ providerId: "telemetry-provider" }),
        );
        assert.deepEqual(empty.accounts, [
          { id: "telemetry-account", providerId: "telemetry-provider" },
        ]);
        assert.deepEqual(empty.quotaHistory, []);
        assert.equal(empty.tokens.total.totalTokens, 0);
        await visit("repeat delete", "DELETE", base + "/telemetry-provider");
        await live.ping("post telemetry operations");
        result.events = live.history
          .filter(
            (frame) =>
              frame.type === "event" &&
              frame.resource !== "account-resource-usage",
          )
          .map((frame) => ({
            resource: frame.resource,
            action: frame.action,
            entityId: frame.entityId,
            payload: frame.payload,
          }));
        assert.deepEqual(
          result.events,
          [],
          "telemetry reads/deletes publish no unrelated Live mutations",
        );
        await live.close();
        live = undefined;
        await fixture.close();
        repository = await openRepository();
        const retained = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('weekly',(SELECT weekly_usage_used_basis_points FROM model_provider_accounts WHERE id='telemetry-account'),'foreignQuota',(SELECT count(*) FROM provider_quota_observations WHERE owner_id=${literal(other)} AND provider_id='telemetry-provider')) AS result`,
        });
        assert.equal(retained.rejected, false);
        assert.deepEqual(retained.value, { weekly: 4567, foreignQuota: 40 });
        await repository.close();
        repository = undefined;
        await fixture.start();
        const reopened = await visit(
          "reopened export",
          "GET",
          base + "/telemetry-provider/export",
        );
        for (const field of [
          "quotaObservations",
          "tokenUsage",
          "modelBehavior",
          "modelCatalogSnapshots",
        ])
          assert.deepEqual(reopened[field], []);
        if (databaseMode === "postgres") {
          result.shutdown = {};
          await telemetryDeleteShutdown(
            fixture,
            owner,
            "telemetry-provider",
            result.shutdown,
          );
          await fixture.start();
          const drained = await visit(
            "post-shutdown retained deletion",
            "GET",
            base + "/telemetry-provider/export",
          );
          for (const field of [
            "quotaObservations",
            "tokenUsage",
            "modelBehavior",
            "modelCatalogSnapshots",
          ])
            assert.deepEqual(drained[field], []);
        }
      } finally {
        await live?.close();
        await fixture.close();
        await repository?.close();
        // Child close drains its diagnostic stream. Resolve receipts without
        // asserting here so both actual runtimes execute before clock checks.
        for (const { timing, events } of pendingClocks) {
          timing.operationClock =
            events.find(
              (event) =>
                event.event === "fixture.http.clock" &&
                event.requestId === timing.requestId,
            )?.operationClock ?? null;
        }
      }
    }
    assert.deepEqual(
      profile.runtimes[1].observations,
      profile.runtimes[0].observations,
      mode + " actual HTTP/Live telemetry parity",
    );
    if (databaseMode === "postgres")
      assert.deepEqual(
        profile.runtimes[1].shutdown,
        profile.runtimes[0].shutdown,
        "actual blocked deletion and shutdown parity",
      );
  }
  report.httpParityPassed = true;
  for (const profile of report.profiles)
    for (const runtime of profile.runtimes) {
      assert.ok(
        runtime.generatedTimes.length > 0,
        "Each actual runtime must exercise generated timestamps",
      );
      for (const timing of runtime.generatedTimes)
        for (const [field, value] of [
          ["generatedAt", timing.generatedAt],
          ["range.to", timing.rangeTo],
        ])
          if (value !== null)
            assertGeneratedAtInOperation({
              ...timing,
              profile: profile.mode,
              runtime: runtime.kind,
              field,
              actualGeneratedAt: value,
            });
    }
  report.timestampBoundsPassed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    if (!failure) failure = error;
    report.cleanupError = String(error);
  }
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.profiles.reduce(
      (n, p) => n + p.runtimes[0].observations.length,
      0,
    ),
    completeReplacement: false,
  }),
);
