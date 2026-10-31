// Real HTTP and Live with unchanged worker transport and production endpoint
// crypto. The native RPC runtime is controlled; full native admission is separate.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  encryptNativeSettingsPatch,
  encryptNativeAccountDefaults,
  decryptNativeAccountDefaults,
} from "../../packages/crypto/dist/index.js";
import { openNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.ts";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as workerId,
  otherChat,
  componentKey,
  privateMarker,
  until,
} from "./native-settings-http-fixture.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-native-settings-http-"));
const report = {
  suite: "actual-native-settings-http-live-worker-crypto",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  nativeRuntime:
    "controlled RPC; production worker transport and encryption helpers",
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
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        defaultsProofs: 0,
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
      }));
      const { visit, fixture } = h,
        base = "/api/chats/" + chat + "/native-settings",
        internal = "/api/internal/native-commands/";
      const auth = {
        client: "worker",
        headers: { authorization: "Bearer " + h.credential },
      };
      const key = {
        ownerId: h.owner,
        serverId: h.serverId,
        componentKey: new Uint8Array(componentKey),
        keyRevision: 1,
      };
      const refresh = (name, options = {}) =>
        visit(name, "POST", base + "/refresh", options);
      try {
        if (profile !== "none")
          await refresh("settings refresh requires CSRF", {
            csrf: false,
            status: 403,
          });
        if (profile === "accounts") {
          await visit("foreign settings are hidden", "GET", base, {
            client: "other",
            status: 404,
          });
          await refresh("foreign owner cannot refresh", {
            client: "other",
            status: 404,
          });
        }
        await visit(
          "missing settings state",
          "GET",
          "/api/chats/" + otherChat + "/native-settings",
          { status: 404 },
        );
        const empty = await visit("initial settings state", "GET", base);
        assert.equal(empty.binding, null);
        await visit("invalid settings update", "POST", base + "/update", {
          json: {},
          status: 400,
        });
        await visit(
          "invalid account defaults",
          "POST",
          "/api/chats/" + chat + "/native-account-defaults",
          { json: {}, status: 400 },
        );
        await visit(
          "internal validation before authentication",
          "POST",
          internal + "settings-refresh",
          { client: "worker", json: {}, status: 400 },
        );
        await visit(
          "internal settings requires worker credential",
          "POST",
          internal + "settings-refresh",
          { client: "worker", json: { workerId, chatId: chat }, status: 401 },
        );
        await visit(
          "internal mismatched worker credential",
          "POST",
          internal + "settings-refresh",
          {
            ...auth,
            json: { workerId: "different-worker", chatId: chat },
            status: 401,
          },
        );
        const first = await refresh("fresh encrypted native read"),
          binding = first.binding;
        assert.equal(binding.workerId, workerId);
        assert.equal(binding.runtimeGeneration, "runtime");
        await assert.rejects(() =>
          openNativeSettingsSnapshot({
            service: h.encryption,
            context: { ...first.effective.context, threadId: "different" },
            snapshot: first.effective,
          }),
        );
        const repeated = await refresh("same source retains binding");
        assert.equal(repeated.binding.bindingId, binding.bindingId);
        const internalRead = await visit(
          "authenticated native settings read",
          "POST",
          internal + "settings-refresh",
          { ...auth, json: { workerId, chatId: chat } },
        );
        assert.equal(internalRead.binding.bindingId, binding.bindingId);
        await visit("stale settings binding", "POST", base + "/update", {
          status: 409,
          json: {
            operationId: "stale",
            bindingId: "stale",
            protectedPatch: first.effective.protectedContent,
          },
        });
        h.setVersion("epoch", "2");
        const snapshot = await h.snapshot();
        await visit(
          "stale observation binding",
          "POST",
          internal + "settings-observation",
          {
            ...auth,
            status: 409,
            json: { workerId, bindingId: "stale", snapshot },
          },
        );
        const observation = await visit(
          "publish native settings observation",
          "POST",
          internal + "settings-observation",
          {
            ...auth,
            json: { workerId, bindingId: binding.bindingId, snapshot },
          },
        );
        assert.equal(observation.settingsVersion.revision, "2");
        const observed = await visit("read observed settings", "GET", base);
        assert.equal(observed.effective.context.settingsVersion.revision, "2");
        const patch = { model: privateMarker + "-updated" },
          operationId = "settings-update";
        const protectedPatch = await encryptNativeSettingsPatch({
          ...key,
          context: { chatId: chat, bindingId: binding.bindingId, operationId },
          patch,
        });
        const receipt = await visit(
          "forward encrypted settings patch",
          "POST",
          base + "/update",
          {
            json: { operationId, bindingId: binding.bindingId, protectedPatch },
          },
        );
        assert.equal(receipt.status, "applied");
        assert.deepEqual(h.updates.at(-1).patch, patch);
        h.setMode("wrong-operation");
        await visit(
          "worker receipt must match operation",
          "POST",
          base + "/update",
          {
            status: 500,
            json: { operationId, bindingId: binding.bindingId, protectedPatch },
          },
        );
        h.setMode("normal");
        const defaultsPath = "/api/chats/" + chat + "/native-account-defaults";
        async function defaults(name, request, expected) {
          const response = await visit(name, "POST", defaultsPath, {
            json: request,
          });
          const context = {
            chatId: chat,
            bindingId: request.bindingId,
            operationId: request.operationId,
            direction: "response",
          };
          const opened = await decryptNativeAccountDefaults({
            ...key,
            context,
            envelope: response.protectedResult,
          });
          assert.equal(opened.verification, expected);
          await assert.rejects(() =>
            decryptNativeAccountDefaults({
              ...key,
              context: { ...context, operationId: "wrong" },
              envelope: response.protectedResult,
            }),
          );
          result.defaultsProofs++;
          return opened;
        }
        const read = await defaults(
          "read encrypted account defaults",
          {
            action: "read",
            bindingId: binding.bindingId,
            operationId: "defaults-read",
          },
          "read",
        );
        assert.equal(read.snapshot.stored.model, privateMarker);
        const write = {
            expectedVersion: "defaults-v1",
            values: { model: privateMarker + "-default" },
          },
          defaultsOperation = "defaults-write";
        const protectedWrite = await encryptNativeAccountDefaults({
          ...key,
          context: {
            chatId: chat,
            bindingId: binding.bindingId,
            operationId: defaultsOperation,
            direction: "request",
          },
          value: write,
        });
        const written = await defaults(
          "write encrypted account defaults",
          {
            action: "write",
            bindingId: binding.bindingId,
            operationId: defaultsOperation,
            protectedWrite,
          },
          "confirmed",
        );
        assert.deepEqual(h.defaultsCalls.at(-1).write, write);
        assert.deepEqual(written.snapshot.stored, write.values);
        const held = h.hold();
        const pending = visit(
          "account defaults rechecks binding after native IO",
          "POST",
          defaultsPath,
          {
            status: 409,
            json: {
              action: "read",
              bindingId: binding.bindingId,
              operationId: "defaults-retired",
            },
          },
        );
        pending.catch(() => {});
        await until(() => held().requested, Boolean);
        h.setVersion("new-epoch", "1");
        const replaced = await refresh(
          "replace settings source while defaults await native IO",
        );
        assert.notEqual(replaced.binding.bindingId, binding.bindingId);
        h.release();
        await pending;
        await visit("retired binding cannot write", "POST", base + "/update", {
          status: 409,
          json: { operationId, bindingId: binding.bindingId, protectedPatch },
        });
        await h.live.ping("native settings publications committed");
        result.events = h.live.history
          .filter((e) => e.type === "event" && e.resource === "chat")
          .map(({ scope, resource, action, entityId, revision, payload }) =>
            fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
          );
        assert.equal(result.events.length, 6);
        assert.equal(
          h.diagnostics().includes(privateMarker),
          false,
          "server diagnostics contain no decrypted native settings",
        );
        result.nativeUpdates = h.updates.map((u) =>
          fixture.normalize({ ...u, patch: "<verified endpoint plaintext>" }),
        );
        result.accountCalls = h.defaultsCalls.map((u) =>
          fixture.normalize({
            ...u,
            ...(u.write ? { write: "<verified endpoint plaintext>" } : {}),
          }),
        );
      } finally {
        await h.close();
        active = null;
      }
    }
    for (const field of [
      "observations",
      "snapshotProofs",
      "defaultsProofs",
      "events",
      "nativeUpdates",
      "accountCalls",
    ])
      assert.deepEqual(
        outputs[1][field],
        outputs[0][field],
        profile + " native settings " + field,
      );
  }
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
      runtimes: p.outputs.map((r) => ({
        kind: r.kind,
        http: r.observations.length,
        snapshots: r.snapshotProofs,
        defaults: r.defaultsProofs,
        live: r.events.length,
      })),
    })),
    passed: true,
  }),
);
