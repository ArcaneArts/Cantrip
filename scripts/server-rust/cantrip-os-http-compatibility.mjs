// Current public HTTP/worker transport and opaque durable state. Controlled OS
// replies do not establish real guest filesystem/archive execution acceptance.
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
import { literal, json, label } from "./project-target-state.mjs";
import {
  cantripOsHttpWorker,
  osHttpProject as project,
} from "./cantrip-os-http-worker.mjs";
import { cantripOsHttpCases } from "./cantrip-os-http-cases.mjs";
const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-os-http-"));
const report = {
  suite: "cantrip-os-public-http",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        cryptoProofs: 0,
        proofs: [],
        serverExits: [],
      };
      outputs.push(result);
      const control = cantripOsHttpWorker(result);
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
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES(${literal(project)},${literal(owner)},${json(label("project"))},'managed-folder','managed','direct',true,false)`,
        ],
        onCommand: control.handle,
      }));
      let proof;
      const serverProcess = h.fixture.server;
      try {
        proof = await cantripOsHttpCases(h, control, result, profile);
      } catch (error) {
        result.error = {
          message: error.message,
          diagnostics:
            h.fixture.server?.diagnostics() ?? serverProcess.diagnostics(),
        };
        throw error;
      } finally {
        await h.close();
        result.diagnostics = serverProcess.diagnostics();
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
          sql: `SELECT jsonb_build_object('bindings',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'runtime',provisioned_runtime_generation)) FROM cantrip_os_source_bindings WHERE project_id=${literal(project)}),'provisions',(SELECT jsonb_agg(to_jsonb(p)) FROM cantrip_os_provision_admissions p WHERE binding_id=${literal(proof.binding.id)}),'backups',(SELECT jsonb_agg(to_jsonb(b)) FROM cantrip_os_backup_operations b WHERE operation_id=${literal(proof.backupRequest.operationId)})) result`,
        });
        assert.equal(data.rejected, false, data.diagnostic);
        assert.equal(data.value.bindings.length, 1);
        assert.equal(data.value.bindings[0].state, "ready");
        assert.equal(data.value.provisions.length, 1);
        assert.equal(data.value.backups.length, 1);
        assert.deepEqual(
          data.value.provisions[0].protected_request,
          proof.provision.protectedRequest,
        );
        assert.deepEqual(data.value.backups[0].request, proof.backupRequest);
        await control.proveBackup(h, {
          operationId: proof.backupRequest.operationId,
          result: data.value.backups[0].result,
        });
        result.rawState = data.value;
        result.state = control.canonical(h.fixture.normalize(data.value));
      } finally {
        await repository.close();
      }
    }
    for (const key of ["observations", "commands", "cryptoProofs", "state"])
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
