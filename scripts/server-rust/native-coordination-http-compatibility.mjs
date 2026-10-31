// Actual native coordination HTTP/Live and worker endpoint cryptography.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password, heartbeat } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
} from "./native-event-http-setup.mjs";
import {
  coordinationCases,
  proveCoordinationStorage,
  normalizeCoordination,
  coordinationMarker,
} from "./native-coordination-http-cases.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(
    path.join(tmpdir(), "cantrip-native-coordination-http-"),
  );
const report = {
  suite: "actual-native-coordination-http-live-crypto",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  profiles: [],
};
let pg, failure, active;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        cryptoProofs: 0,
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
        configure: seedEventChats,
      }));
      const serverProcess = h.fixture.server;
      let proof;
      try {
        h.prepared = await prepareEventCommands(h);
        if (profile === "accounts") {
          const code = await h.visit(
            "foreign worker enrollment code",
            "POST",
            "/api/workers/enrollment-codes",
            {
              client: "other",
              status: 201,
              json: { label: "Foreign native coordination worker" },
            },
          );
          const id = "foreign-native-coordination-worker";
          const enrolled = await h.visit(
            "foreign worker enrollment",
            "POST",
            "/api/internal/workers/enroll",
            {
              client: "foreign-worker",
              status: 201,
              json: {
                code: code.code,
                heartbeat: { ...heartbeat, workerId: id },
              },
            },
          );
          h.foreignWorker = { id, credential: enrolled.credential };
        }
        await h.live.subscribed("coordination-scopes", [
          { kind: "chat", chatId: chat },
          { kind: "project", projectId: project },
        ]);
        proof = await coordinationCases(h, result);
        assert.equal(
          JSON.stringify([
            ...h.fixture.records.values(),
            h.live.history,
          ]).includes(coordinationMarker),
          false,
        );
      } finally {
        await h.close();
        active = null;
      }
      const repo = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const data = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('evidence',(SELECT jsonb_agg(to_jsonb(e)) FROM native_settings_evidence e),'commands',(SELECT jsonb_agg(to_jsonb(n)) FROM native_commands n),'pending',(SELECT jsonb_agg(to_jsonb(p)) FROM native_pending_requests p)) result",
        });
        assert.equal(data.rejected, false, data.diagnostic);
        await proveCoordinationStorage(h, data.value, proof, result);
      } finally {
        await repo.close();
      }
      result.observations = normalizeCoordination(
        result.observations,
        proof.digests,
      );
      result.live = normalizeCoordination(result.live, proof.digests);
      result.diagnostics = serverProcess.diagnostics();
      assert.equal(result.diagnostics.includes(coordinationMarker), false);
    }
    for (const key of [
      "observations",
      "snapshotProofs",
      "cryptoProofs",
      "live",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
