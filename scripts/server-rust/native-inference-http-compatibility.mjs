// Real worker-authenticated HTTP, controlled no-start journal evidence and
// canonical encrypted-input persistence. Full worker crash acceptance is separate.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { seedEventChats } from "./native-event-http-setup.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { nativeInferenceHttpCases } from "./native-inference-http-cases.mjs";

const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-inference-http-"),
);
const report = {
  suite: "native-inference-http-recovery",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
let active, pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        cryptoProofs: 0,
        sdkObservations: [],
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: (owner) => [
          ...seedEventChats(owner),
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('queue-model',${literal(owner)},'Controlled inference recovery')`,
          "INSERT INTO users(id,kind,display_name) VALUES('foreign-inference-owner','anonymous','Other inference owner')",
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,github_repository_blind_index,worktree_policy,git_capability,github_capability) VALUES('foreign-inference-project','foreign-inference-owner',${json(label("project"))},'github','foreign-inference-project','agent-managed',true,true)`,
          "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('foreign-inference-worker','foreign-inference-owner','Other inference worker','linux','x64',now(),now())",
          `INSERT INTO chats(id,owner_id,protected_label,context_kind,active_worker_id,active_scratch_root_id,worktree_mode) VALUES('foreign-inference-chat','foreign-inference-owner',${json(label("chat"))},'standalone','foreign-inference-worker','cccccccc-cccc-4ccc-8ccc-ccccccccc101',NULL)`,
          "INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES('cccccccc-cccc-4ccc-8ccc-ccccccccc101','foreign-inference-chat','foreign-inference-owner','foreign-inference-worker','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
        ],
      }));
      let proof;
      try {
        proof = await nativeInferenceHttpCases(h, result);
      } finally {
        await h.close();
        active = null;
      }
      const repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const data = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('commands',(SELECT jsonb_agg(jsonb_build_object('status',status,'code',rejection_code,'evidence',terminal_evidence,'logicalDone',logical_completed_at IS NOT NULL,'executionDone',execution_completed_at IS NOT NULL)) FROM native_commands WHERE operation_id='terminal-inference-recovery'),'prompts',(SELECT jsonb_agg(jsonb_build_object('state',state,'revision',revision,'content',opaque_content)) FROM queued_prompts WHERE id=${literal(proof.prompt.id)}),'claims',(SELECT jsonb_agg(jsonb_build_object('status',status,'nativeTurn',native_turn_id)) FROM managed_queue_claims WHERE operation_id='terminal-inference-recovery'),'turns',(SELECT count(*) FROM native_command_turns WHERE operation_id='terminal-inference-recovery')) result`,
        });
        assert.equal(data.rejected, false, data.diagnostic);
        const state = data.value;
        assert.equal(state.commands.length, 1);
        assert.deepEqual(state.commands[0], {
          status: "rejected",
          code: "worker-inference-deferred",
          evidence: {
            kind: "not-started",
            source: "worker-inference-journal",
            key: proof.record.key,
            workerGeneration: proof.record.workerGeneration,
            runtimeGeneration: proof.record.identity.runtimeGeneration,
            revision: 1,
          },
          logicalDone: true,
          executionDone: true,
        });
        assert.deepEqual(state.claims, [
          { status: "deferred", nativeTurn: null },
        ]);
        assert.equal(state.turns, 0);
        assert.equal(state.prompts.length, 1);
        assert.equal(state.prompts[0].state, "pending");
        assert.equal(state.prompts[0].revision, 0);
        assert.deepEqual(state.prompts[0].content, proof.prompt);
        await proof.content.prove(state.prompts[0].content);
        result.state = proof.content.canonical(h.fixture.normalize(state));
      } finally {
        await repository.close();
      }
      proof.content.finish();
    }
    for (const key of ["observations", "cryptoProofs", "state"])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
