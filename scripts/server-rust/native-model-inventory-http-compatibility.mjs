// Read-only public picker follows a real protected native settings binding.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as workerId,
  otherChat,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { nativeModelInventoryHttpRaces } from "./native-model-inventory-http-races.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(
    path.join(tmpdir(), "cantrip-native-model-inventory-http-"),
  );
const report = {
  suite: "actual-native-model-inventory-http",
  databaseMode,
  completeReplacement: false,
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
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], snapshotProofs: 0 };
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
        configure: (owner, scope) => {
          scope.modelRouteId = "inventory-provider-route-0";
          return [
            ...inventorySeed(owner, {
              kind: "openai-compatible",
              worker: workerId,
            }),
            "UPDATE chat_runtime_sessions SET model_route_id='inventory-provider-route-0' WHERE id='settings-runtime'",
          ];
        },
      }));
      try {
        const { visit } = h,
          base = "/api/chats/" + chat + "/native-settings/models";
        await visit("missing picker binding", "GET", base, { status: 400 });
        await visit("stale picker binding", "GET", base + "?bindingId=stale", {
          status: 409,
        });
        const state = await visit(
          "read protected picker source",
          "POST",
          "/api/chats/" + chat + "/native-settings/refresh",
        );
        assert.equal(state.binding.modelRouteId, "inventory-provider-route-0");
        const query =
          "?bindingId=" + encodeURIComponent(state.binding.bindingId);
        await visit(
          "unknown picker query",
          "GET",
          base + query + "&unknown=true",
          { status: 400 },
        );
        await visit(
          "duplicate picker query",
          "GET",
          base + query + "&bindingId=second",
          { status: 400 },
        );
        await visit(
          "missing picker chat",
          "GET",
          "/api/chats/" + otherChat + "/native-settings/models" + query,
          { status: 404 },
        );
        if (profile === "accounts")
          await visit("foreign owner cannot read picker", "GET", base + query, {
            client: "other",
            status: 404,
          });
        const inventory = await visit(
          "public inventory from disabled bound anchor",
          "GET",
          base + query,
        );
        assert.equal(inventory.bindingId, state.binding.bindingId);
        assert.equal(inventory.providerId, "inventory-provider");
        assert.equal(inventory.workerId, workerId);
        assert.equal(inventory.providerKind, "openai-compatible");
        assert.equal(inventory.providerAccountId, null);
        assert.equal(inventory.models.length, 8);
        assert.equal(
          inventory.models.some(
            (m) => m.routeId === "inventory-provider-route-0",
          ),
          false,
        );
        assert.ok(inventory.models.some((m) => m.name === "Custom"));
        assert.equal(
          JSON.stringify(inventory).includes("Private provider label"),
          false,
        );
        await visit("head model inventory", "HEAD", base + query);
        await visit(
          "model picker does not mutate native binding",
          "GET",
          "/api/chats/" + chat + "/native-settings",
        );
        await h.live.ping("picker read complete");
        result.live = h.live.history.filter(
          (e) => e.type === "event" && e.resource === "chat",
        ).length;
        assert.equal(result.live, 1, "only the explicit refresh publishes");
        assert.equal(h.updates.length, 0);
        assert.equal(h.defaultsCalls.length, 0);
      } finally {
        await h.close();
        active = null;
      }
    }
    for (const key of ["observations", "snapshotProofs", "live"])
      assert.deepEqual(
        outputs[1][key],
        outputs[0][key],
        profile + " picker " + key,
      );
  }
  if (databaseMode === "postgres")
    await nativeModelInventoryHttpRaces({
      pg,
      root,
      executable,
      repositoryExecutable,
      passwordHash,
      report,
    });
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  try {
    await active?.close();
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailure = String(error);
  }
  if (failure) report.passed = false;
  if (option("--report")) {
    const p = path.resolve(option("--report"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      http: p.outputs.map((r) => r.observations.length),
    })),
    passed: true,
  }),
);
