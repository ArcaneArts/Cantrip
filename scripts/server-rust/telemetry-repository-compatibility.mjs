// Real migrated databases and production repository methods on both runtimes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-telemetry-repository-"),
);
const report = {
  suite: "actual-telemetry-repositories",
  databaseMode,
  root,
  completeReplacement: false,
  repositoryParityPassed: false,
  timestampBoundsPassed: false,
  runtimes: [],
};
const owners = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const fixed = "2026-10-27T00:00:00.123456Z";
const tables = [
  "provider_quota_observations",
  "token_usage_records",
  "model_behavior_observations",
  "provider_model_catalog_snapshots",
];
let postgresOwner, failure;
try {
  const executable = await buildRustExample("settings-repository-fixture");
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      postgresOwner && (kind === "node" || databaseMode === "postgres")
        ? await postgresOwner.database()
        : undefined;
    const result = { kind, observations: [], exports: [] };
    report.runtimes.push(result);
    const open = () =>
      repositoryFixture({
        kind,
        executable,
        root,
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
      });
    let repository = await open();
    const request = async (label, input) => {
      const monotonicBefore = process.hrtime.bigint();
      const before = Date.now(),
        response = await repository.request(input);
      if (
        response.value?.generatedAt &&
        !(input.op === "telemetry-quota" && input.query?.to != null)
      ) {
        // Preserve the actual observation before asserting it. In Windows CI
        // the unmodified Node reference failed here after reopen, but the old
        // report discarded both the failed timestamp and its request bounds.
        const timing = {
          label,
          kind,
          before,
          after: Date.now(),
          actualGeneratedAt: response.value.generatedAt,
          generatedMilliseconds: Date.parse(response.value.generatedAt),
          elapsedNanoseconds: (
            process.hrtime.bigint() - monotonicBefore
          ).toString(),
        };
        result.exports.push(timing);
        response.value.generatedAt = "<actual-generated-timestamp>";
      }
      const normalized = {
        label,
        rejected: response.rejected,
        ...(!response.rejected ? { value: response.value } : {}),
      };
      result.observations.push(normalized);
      return response;
    };
    const snapshot = async (label) =>
      request(label, {
        op: "query-json",
        sql: `SELECT jsonb_build_object(${tables.map((table) => `${literal(table)},(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM ${table} q)`).join(",")},'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM model_provider_accounts a WHERE id='telemetry-account')) AS result`,
      });
    try {
      for (const [index, owner] of owners.entries())
        await repository.seed(
          `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(owner)},'account','Telemetry owner',${literal(`telemetry-${index}@example.invalid`)},${literal(`telemetry-${index}@example.invalid`)}) ON CONFLICT(id) DO NOTHING`,
        );
      for (const [provider, owner] of [
        ["telemetry-provider", owners[0]],
        ["telemetry-foreign", owners[1]],
      ])
        await repository.seed(
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider)},${literal(owner)},'DO_NOT_EXPORT_PROVIDER_NAME','chatgpt','https://chatgpt.com')`,
        );
      await repository.seed(
        `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,weekly_usage_used_basis_points,credits,credits_observed_at,created_at,updated_at) VALUES('telemetry-account','telemetry-provider',${literal(JSON.stringify(policyEnvelope))},'account-home',4567,'{"hasCredits":true,"unlimited":false,"balance":"1.00"}',${literal(fixed)},${literal(fixed)},${literal(fixed)})`,
      );
      for (const [label, provider, owner] of [
        ["own", "telemetry-provider", owners[0]],
        ["foreign-owner", "telemetry-provider", owners[1]],
        ["other-provider", "telemetry-foreign", owners[1]],
      ]) {
        await repository.seed(
          `INSERT INTO provider_quota_observations(id,owner_id,event_key,observation_batch_key,provider_id,provider_kind,provider_account_id,observed_at,received_at,used_percent_micros,resets_at,window_duration_minutes,window_kind,observation_trigger,worker_version) VALUES(${literal(label + "-quota")},${literal(owner)},${literal(label + "-event")},'batch',${literal(provider)},'chatgpt','telemetry-account',${literal(fixed)},'2026-10-27T00:00:01.987654Z',13555555,'2026-11-02T00:00:00.123456Z',10080,'secondary','telemetry-fixture','worker-fixture')`,
        );
        await repository.seed(
          `INSERT INTO token_usage_records(id,owner_id,source_key,source_aliases,provider_id,provider_account_id,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens,started_at,completed_at,created_at,updated_at,native_usage,native_model_attribution) VALUES(${literal(label + "-token")},${literal(owner)},${literal(label + "-source")},'["DO_NOT_EXPORT_SOURCE_ALIAS"]',${literal(provider)},'telemetry-account',9007199254740993,17,5,7,NULL,${literal(fixed)},${literal(fixed)},${literal(fixed)},'{"structured":"preserved"}','{"private":"DO_NOT_EXPORT_NATIVE_MODEL_ATTRIBUTION"}')`,
        );
        await repository.seed(
          `INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,provider_account_id,started_at,completed_at,created_at,updated_at,attempt_status,tool_call_count,duration_ms,native_attribution) VALUES(${literal(label + "-behavior")},${literal(owner)},${literal(label + "-behavior-source")},${literal(label + "-attempt")},${literal(provider)},'telemetry-account',${literal(fixed)},'2026-10-27T00:00:01.123456Z',${literal(fixed)},${literal(fixed)},'completed',3,1000,'{"structured":"preserved"}')`,
        );
        await repository.seed(
          `INSERT INTO provider_model_catalog_snapshots(id,owner_id,provider_id,provider_account_id,availability_scope,metadata_source,metadata_hash,observed_at,created_at) VALUES(${literal(label + "-catalog")},${literal(owner)},${literal(provider)},'telemetry-account','worker-scope','public-catalog','hash',${literal(fixed)},${literal(fixed)})`,
        );
      }
      for (const provider of ["missing", "telemetry-foreign"]) {
        assert.equal(
          (
            await request("unavailable export " + provider, {
              op: "telemetry-export",
              owner: owners[0],
              provider,
            })
          ).value,
          null,
        );
        assert.equal(
          (
            await request("unavailable delete " + provider, {
              op: "telemetry-delete",
              owner: owners[0],
              provider,
            })
          ).value,
          null,
        );
      }
      const exported = await request("owned export", {
        op: "telemetry-export",
        owner: owners[0],
        provider: "telemetry-provider",
      });
      assert.equal(exported.rejected, false);
      assert.equal(exported.value.schemaVersion, 2);
      assert.deepEqual(exported.value.provider, { id: "telemetry-provider" });
      for (const field of [
        "quotaObservations",
        "tokenUsage",
        "modelBehavior",
        "modelCatalogSnapshots",
      ])
        assert.equal(exported.value[field].length, 1);
      assert.equal(
        exported.value.quotaObservations[0].observedAt,
        "2026-10-27T00:00:00.123Z",
      );
      assert.equal(
        exported.value.quotaObservations[0].receivedAt,
        "2026-10-27T00:00:01.987Z",
      );
      assert.equal(exported.value.tokenUsage[0].startedAt, null);
      assert.ok(!JSON.stringify(exported.value).includes("DO_NOT_EXPORT"));
      await repository.seed(
        "CREATE FUNCTION telemetry_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'telemetry fixture abort'; END $$",
      );
      await repository.seed(
        "CREATE TRIGGER telemetry_delete_failure BEFORE DELETE ON model_behavior_observations FOR EACH ROW EXECUTE FUNCTION telemetry_delete_failure()",
      );
      const before = (await snapshot("before failed deletion")).value;
      assert.equal(
        (
          await request("real failed deletion", {
            op: "telemetry-delete",
            owner: owners[0],
            provider: "telemetry-provider",
          })
        ).rejected,
        true,
      );
      assert.deepEqual(
        (await snapshot("after failed deletion")).value,
        before,
        "earlier quota/token deletes roll back with later behavior failure",
      );
      await repository.seed(
        "DROP TRIGGER telemetry_delete_failure ON model_behavior_observations",
      );
      await repository.seed("DROP FUNCTION telemetry_delete_failure()");
      const deleted = await request("delete owned telemetry", {
        op: "telemetry-delete",
        owner: owners[0],
        provider: "telemetry-provider",
      });
      assert.deepEqual(deleted.value, {
        providerId: "telemetry-provider",
        deleted: {
          quotaObservations: 1,
          tokenUsage: 1,
          modelBehavior: 1,
          modelCatalogSnapshots: 1,
        },
      });
      const after = (
        await snapshot("retained foreign rows and account projection")
      ).value;
      for (const table of tables) assert.equal(after[table].length, 2);
      assert.deepEqual(
        after.accounts,
        before.accounts,
        "deleting history does not clear the current account projection",
      );
      assert.deepEqual(
        (
          await request("repeat delete", {
            op: "telemetry-delete",
            owner: owners[0],
            provider: "telemetry-provider",
          })
        ).value,
        {
          providerId: "telemetry-provider",
          deleted: {
            quotaObservations: 0,
            tokenUsage: 0,
            modelBehavior: 0,
            modelCatalogSnapshots: 0,
          },
        },
      );
      await repository.close();
      repository = await open();
      const reopened = await request("retained empty owned export", {
        op: "telemetry-export",
        owner: owners[0],
        provider: "telemetry-provider",
      });
      for (const field of [
        "quotaObservations",
        "tokenUsage",
        "modelBehavior",
        "modelCatalogSnapshots",
      ])
        assert.deepEqual(reopened.value[field], []);
      await repository.seed(
        `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('telemetry-second',${literal(owners[0])},'second','openai-compatible','https://example.invalid')`,
      );
      await repository.seed(
        `INSERT INTO model_provider_accounts(id,provider_id,position,protected_label,credential_home_key,created_at,updated_at) VALUES('telemetry-unused-account','telemetry-provider',1,${literal(JSON.stringify(policyEnvelope))},'unused',${literal(fixed)},${literal(fixed)})`,
      );
      const start = Date.parse("2026-10-01T00:00:00Z");
      await repository.seed(
        `INSERT INTO model_profiles(id,owner_id,name) VALUES('model-0',${literal(owners[0])},'model zero'),('model-1',${literal(owners[0])},'model one')`,
      );
      await repository.seed(
        "INSERT INTO model_routes(id,model_id,provider_id,model_name) VALUES('route-fallback','model-0','telemetry-provider','native-model')",
      );
      await repository.seed(
        `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES('project',${literal(owners[0])},${literal(JSON.stringify({ classification: { recordKind: "project" }, protectedLabel: policyEnvelope }))},'managed-folder','external','direct')`,
      );
      for (let i = 0; i < 40; i++) {
        const observed = new Date(start + i * 86400000).toISOString(),
          started = new Date(start + i * 86400000 - 60000).toISOString();
        const provider = i === 1 ? "telemetry-second" : "telemetry-provider";
        const account =
          i % 7 === 0 ? "deleted-historical-account" : "telemetry-account";
        const model = i % 3 === 0 ? null : "model-" + (i % 2);
        const effort = i % 2 ? "high" : null;
        const project = i % 3 === 0 ? "project" : null;
        const sqlNull = (value) => (value === null ? "NULL" : literal(value));
        await repository.seed(
          `INSERT INTO provider_quota_observations(id,owner_id,event_key,observation_batch_key,provider_id,provider_kind,provider_account_id,observed_at,received_at,used_percent_micros,resets_at,window_duration_minutes,limit_id,window_kind,observation_trigger,worker_version) VALUES(${literal("analytics-q" + i)},${literal(owners[0])},${literal("analytics-e" + i)},'batch',${literal(provider)},'chatgpt',${literal(account)},${literal(observed)},${literal(observed)},${(i % 18) * 1000000},NULL,10080,NULL,'weekly','analytics-fixture','worker-fixture')`,
        );
        await repository.seed(
          `INSERT INTO token_usage_records(id,owner_id,source_key,provider_id,provider_account_id,model_id,model_route_id,reasoning_effort,project_id,input_tokens,output_tokens,cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,visible_output_tokens,reported_total_tokens,started_at,completed_at,finalized_at,attempt_status,created_at,updated_at) VALUES(${literal("analytics-t" + i)},${literal(owners[0])},${literal("analytics-s" + i)},${literal(provider)},${literal(account)},${sqlNull(model)},'route-fallback',${sqlNull(effort)},${sqlNull(project)},${i < 20 ? 100 : 1000},20,5,3,7,${i % 2 ? "NULL" : 13},${i % 2 ? "NULL" : 120},${literal(started)},${literal(observed)},${i % 2 ? literal(observed) : "NULL"},${literal(i % 5 === 0 ? "running" : i % 4 === 0 ? "failed" : "completed")},${literal(fixed)},${literal(fixed)})`,
        );
        await repository.seed(
          `INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,provider_account_id,model_id,model_route_id,reasoning_effort,project_id,started_at,completed_at,created_at,updated_at,attempt_status,tool_call_count,invalid_tool_call_count,duration_ms,compaction_count,input_tokens,output_tokens,reasoning_output_tokens,final_answer_appeared,signal_availability,native_attribution) VALUES(${literal("analytics-b" + i)},${literal(owners[0])},${literal("analytics-bs" + i)},${literal("analytics-a" + i)},${literal(provider)},${literal(account)},${sqlNull(model)},'route-fallback',${sqlNull(effort)},${sqlNull(project)},${literal(started)},${literal(observed)},${literal(fixed)},${literal(fixed)},${literal(i < 20 ? "completed" : "failed")},10,${i < 20 ? 0 : 7},${i < 20 ? 1000 : 10000},${i < 20 ? 0 : 2},100,100,${i < 20 ? 10 : 90},${i < 20},${literal(JSON.stringify({ nativeReasoningKnown: i % 2 === 0 }))},${i % 4 === 0 ? "'{}'" : "NULL"})`,
        );
      }
      const baseQuery = {
        from: "2026-10-10T00:00:00.000Z",
        to: "2026-11-11T00:00:00.000Z",
      };
      for (const [label, query] of [
        ["unfiltered", {}],
        ["owned provider", { providerId: "telemetry-provider" }],
        ["other owned provider", { providerId: "telemetry-second" }],
        ["foreign provider", { providerId: "telemetry-foreign" }],
        ["missing provider", { providerId: "missing" }],
        ["account", { providerAccountId: "telemetry-account" }],
        [
          "historical account",
          { providerAccountId: "deleted-historical-account" },
        ],
        ["model", { modelId: "model-1" }],
        ["reasoning effort", { reasoningEffort: "high" }],
        ["project", { projectId: "project" }],
        [
          "all filters",
          {
            providerId: "telemetry-provider",
            providerAccountId: "telemetry-account",
            modelId: "model-1",
            reasoningEffort: "high",
            projectId: "project",
          },
        ],
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
          "repeated provider",
          { providerId: ["telemetry-provider", "telemetry-second"] },
        ],
        [
          "repeated account",
          {
            providerAccountId: [
              "telemetry-account",
              "deleted-historical-account",
            ],
          },
        ],
        ["repeated model", { modelId: ["model-1", "model-0"] }],
        ["repeated effort", { reasoningEffort: ["high", ""] }],
        ["repeated project", { projectId: ["project", ""] }],
        [
          "empty range",
          { from: "2026-11-11T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" },
        ],
        [
          "exact lower upper bound",
          { from: "2026-10-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" },
        ],
      ]) {
        for (const op of ["telemetry-quota", "telemetry-analytics"]) {
          const response = await request(op + " " + label, {
            op,
            owner: owners[0],
            query: { ...baseQuery, ...query },
          });
          assert.equal(
            response.rejected,
            false,
            label + ": " + response.diagnostic,
          );
        }
      }
      await repository.seed(
        `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('telemetry-deep',${literal(owners[0])},'Deep structured telemetry','openai-compatible','https://example.invalid')`,
      );
      for (const [index, depth] of [100, 150, 300].entries()) {
        // The production query orders only by started_at. Give these new
        // parser fixtures distinct instants so their order is defined by SQL.
        const started = new Date(Date.parse(fixed) + index).toISOString();
        const availability =
          '{"nativeReasoningKnown":true,"structured":' +
          "[".repeat(depth) +
          "true" +
          "]".repeat(depth) +
          "}";
        await repository.seed(
          `INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,started_at,created_at,updated_at,signal_availability) VALUES(${literal("deep-" + depth)},${literal(owners[0])},${literal("deep-" + depth)},'deep-attempt','telemetry-deep',${literal(started)},${literal(fixed)},${literal(fixed)},${literal(availability)})`,
        );
        const exported = await request("deep structured export " + depth, {
          op: "telemetry-export",
          owner: owners[0],
          provider: "telemetry-deep",
        });
        assert.equal(exported.rejected, false, exported.diagnostic);
        assert.equal(exported.value.modelBehavior.length, index + 1);
        assert.deepEqual(
          exported.value.modelBehavior.find((row) => row.id === "deep-" + depth)
            .signalAvailability,
          JSON.parse(availability),
        );
        const analytics = await request("deep structured analytics " + depth, {
          op: "telemetry-analytics",
          owner: owners[0],
          query: { ...baseQuery, providerId: "telemetry-deep" },
        });
        assert.equal(analytics.rejected, false, analytics.diagnostic);
        assert.equal(analytics.value.behavior.total.attemptCount, index + 1);
      }
    } finally {
      await repository.close();
    }
  }
  assert.deepEqual(
    report.runtimes[1].observations,
    report.runtimes[0].observations,
    "actual repository exports and rollback state",
  );
  report.repositoryParityPassed = true;
  // A timing observation must not prevent the actual Rust operations and
  // source comparison from running. Keep the same inclusive bounds and fail
  // the suite after both implementations have exercised the complete sequence.
  for (const runtime of report.runtimes)
    for (const timing of runtime.exports)
      assert.ok(
        timing.generatedMilliseconds >= timing.before &&
          timing.generatedMilliseconds <= timing.after,
        JSON.stringify(timing),
      );
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
    cases: report.runtimes[0].observations.length,
    completeReplacement: false,
  }),
);
