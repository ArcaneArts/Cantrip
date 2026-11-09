// Real HTTP, App Live and the unchanged worker transport/protection functions.
// The SQL fixture only arranges durable states around the production router;
// actual full-worker/native-runtime acceptance remains a separate requirement.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  componentKey,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import {
  encryptProjectAutomationContent,
  decryptProjectAutomationContent,
  decryptQueuedPromptProtectedContent,
  decryptChatMessageProtectedContent,
} from "../../packages/crypto/dist/index.js";
import {
  projectAutomationProtectedNameSchema,
  projectAutomationProtectedPromptSchema,
  projectAutomationProtectedConditionSchema,
} from "../../packages/protocol/dist/automations.js";
import { workerCredentialScopes } from "../../packages/protocol/dist/index.js";
import { protectProjectAutomationDispatch } from "../../cantrip_worker/src/automation-encryption.ts";
import { ProjectAutomationScheduler } from "../../cantrip_worker/src/automation-scheduler.ts";
import { eventually } from "./full-worker.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-automation-http-"));
const report = {
  suite: "project-automation-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const id = (n) => `f2f2f2f2-2222-4222-8222-${String(n).padStart(12, "0")}`;
const future = "2050-01-01T00:00:00.123Z";
const marker = "private-automation-endpoint-proof";
const schemas = {
  name: projectAutomationProtectedNameSchema,
  prompt: projectAutomationProtectedPromptSchema,
  condition: projectAutomationProtectedConditionSchema,
};
let pg, h, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
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
        commands: [],
        cryptoProofs: 0,
        sdk: [],
        recovery: [],
      };
      outputs.push(result);
      const envelopes = new Map();
      let mode = "normal",
        held;
      const remember = (envelope, label) =>
        envelopes.set(JSON.stringify(envelope), label);
      function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object") {
          const known = envelopes.get(JSON.stringify(value));
          return (
            known ??
            Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, canonical(v)]),
            )
          );
        }
        return value;
      }
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        passwordHash,
        databaseMode,
        liveSqlFixture: true,
        result,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        configure: (owner) => [
          ...inventorySeed(owner, { kind: "openai-compatible", worker }),
          "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
          `UPDATE chats SET automation_paused=true,model_id='inventory-provider-model-1',reasoning_effort='medium' WHERE id=${literal(chat)}`,
          `UPDATE projects SET github_repository_full_name='Fixture/automation',github_repository_url='https://github.com/Fixture/automation' WHERE id=${literal(project)}`,
        ],
        onCommand: async (command, _emit, { encryption }) => {
          if (command.type !== "automation.dispatch.protect") return undefined;
          assert.equal(command.cwd, "/worker-owned/settings");
          assert.equal(command.repository, "Fixture/automation");
          assert.equal(command.modelId, "inventory-provider-model-1");
          assert.equal(command.reasoningEffort, "medium");
          result.commands.push(h.fixture.normalize(canonical(command)));
          if (mode === "hold") {
            held.requested = true;
            await held.promise;
          }
          if (mode === "worker-error")
            throw new Error(marker + " controlled private failure");
          if (mode === "invalid") return { allowed: true, protectedTurn: null };
          const response = await protectProjectAutomationDispatch({
            ...command,
            service: encryption,
            countOpenIssues: async () => 0,
          });
          if (response.protectedTurn) {
            const prompt = response.protectedTurn.queuedPrompt,
              pending = prompt.pendingMessage;
            const opened = await decryptQueuedPromptProtectedContent({
              ownerId: h.owner,
              promptId: prompt.id,
              keyRevision: prompt.protectedContent.keyRevision,
              componentKey: new Uint8Array(componentKey),
              encrypted: prompt.protectedContent,
              publicClassification: prompt.classification,
            });
            const message = await decryptChatMessageProtectedContent({
              ownerId: h.owner,
              messageId: pending.id,
              keyRevision: pending.protectedContent.keyRevision,
              componentKey: new Uint8Array(componentKey),
              encrypted: pending.protectedContent,
              publicClassification: pending.classification,
            });
            assert.equal(opened.text, marker + " prompt");
            assert.deepEqual(message.content, [
              { type: "text", text: marker + " prompt" },
            ]);
            result.cryptoProofs += 2;
            remember(
              prompt.protectedContent.envelope,
              "<verified queued prompt envelope>",
            );
            remember(
              pending.protectedContent.envelope,
              "<verified pending message envelope>",
            );
          }
          return response;
        },
      });
      try {
        // These are client-supplied schedule instants. The generic security
        // fixture assumes generated timestamps are in the past, which does not
        // apply to an automation's explicitly requested future schedule.
        const normalize = h.fixture.normalize.bind(h.fixture);
        h.fixture.normalize = (value, key) =>
          ["startsAt", "nextRunAt"].includes(key) && value === future
            ? value
            : normalize(value, key);
        await h.live.subscribed("automations-project", [
          { kind: "project", projectId: project },
        ]);
        const base = `/api/projects/${project}/automations`,
          item = (n) => `/api/automations/${id(n)}`,
          workerBase = "/api/internal/workers/automations",
          auth = {
            client: "worker",
            noOrigin: true,
            headers: { authorization: "Bearer " + h.credential },
          };
        async function content(n, condition = null) {
          const value = {};
          for (const [field, payload] of Object.entries({
            name: { version: 1, name: marker + " name" },
            prompt: { version: 1, prompt: marker + " prompt" },
            condition: { version: 1, condition },
          })) {
            const encrypted = await encryptProjectAutomationContent({
              ownerId: h.owner,
              context: {
                recordKind: "project-automation",
                recordId: id(n),
                field,
              },
              keyRevision: 1,
              componentKey: new Uint8Array(componentKey),
              content: payload,
              schema: schemas[field],
            });
            remember(
              encrypted.envelope,
              `<verified automation-${n}-${field} envelope>`,
            );
            value["protected" + field[0].toUpperCase() + field.slice(1)] =
              encrypted;
          }
          return value;
        }
        async function prove(automation, n) {
          for (const field of Object.keys(schemas)) {
            const encrypted =
              automation.content[
                "protected" + field[0].toUpperCase() + field.slice(1)
              ];
            const opened = await decryptProjectAutomationContent({
              ownerId: h.owner,
              context: {
                recordKind: "project-automation",
                recordId: id(n),
                field,
              },
              keyRevision: encrypted.keyRevision,
              componentKey: new Uint8Array(componentKey),
              encrypted,
              schema: schemas[field],
            });
            if (field !== "condition")
              assert.equal(opened[field], marker + " " + field);
            result.cryptoProofs++;
          }
        }
        const visit = h.visit;
        await visit(
          "missing project list stays empty",
          "GET",
          "/api/projects/missing/automations",
        );
        await visit("initial project list", "GET", base);
        for (const [name, body] of [
          ["missing", {}],
          [
            "invalid schedule",
            {
              id: id(1),
              chatId: chat,
              schedule: {
                kind: "cron",
                expression: "0 0 0 * * *",
                timeZone: "UTC",
              },
              content: await content(1),
            },
          ],
          [
            "invalid timezone",
            {
              id: id(1),
              chatId: chat,
              schedule: {
                kind: "cron",
                expression: "* * * * *",
                timeZone: "Mars/Olympus",
              },
              content: await content(1),
            },
          ],
        ])
          await visit(name, "POST", base, { json: body, status: 400 });
        const protectedContent = await content(1);
        let automation = await visit(
          "create protected automation",
          "POST",
          base,
          {
            json: {
              id: id(1),
              chatId: chat,
              schedule: {
                kind: "interval",
                every: 1,
                unit: "minute",
                startsAt: future,
              },
              content: protectedContent,
            },
            status: 201,
          },
        );
        assert.equal(automation.enabled, true);
        assert.equal(automation.nextRunAt, future);
        assert.deepEqual(automation.content, protectedContent);
        await prove(automation, 1);
        await visit("list newly created automation", "GET", base);
        if (profile === "accounts") {
          assert.deepEqual(
            await visit(
              "foreign owner cannot list project automations",
              "GET",
              base,
              { client: "other" },
            ),
            [],
          );
          await visit(
            "foreign owner cannot update automation",
            "PATCH",
            item(1),
            { client: "other", json: { enabled: false }, status: 404 },
          );
          await visit(
            "foreign owner cannot delete automation",
            "DELETE",
            item(1),
            { client: "other", status: 404 },
          );
          await visit(
            "foreign owner cannot create for target chat",
            "POST",
            base,
            {
              client: "other",
              json: {
                id: id(99),
                chatId: chat,
                schedule: {
                  kind: "interval",
                  every: 1,
                  unit: "minute",
                  startsAt: future,
                },
                content: protectedContent,
              },
              status: 404,
            },
          );
          const captured = await visit(
            "worker credential owner survives foreign session cookie",
            "GET",
            workerBase + "?workerId=" + worker,
            { ...auth, client: "other" },
          );
          assert.equal(captured.length, 1);
          assert.equal(captured[0].id, id(1));
        }
        await visit("empty encrypted update", "PATCH", item(1), {
          json: { content: {} },
          status: 400,
        });
        automation = await visit("disable automation", "PATCH", item(1), {
          json: { enabled: false },
        });
        assert.equal(automation.nextRunAt, null);
        await visit("missing automation update", "PATCH", item(99), {
          json: { enabled: false },
          status: 404,
        });
        for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0, 65])])
          for (const [method, route] of [
            ["POST", base],
            ["PATCH", item(1)],
          ])
            await visit(`binary ${method} ${bytes.length}`, method, route, {
              raw: bytes,
              headers: { "content-type": "application/octet-stream" },
              status: 400,
            });
        await visit("worker id before authentication", "GET", workerBase, {
          ...auth,
          headers: {},
          status: 400,
        });
        await visit(
          "empty worker id before authentication",
          "GET",
          workerBase + "?workerId=",
          { ...auth, headers: {}, status: 400 },
        );
        await visit(
          "worker credential is required",
          "GET",
          workerBase + "?workerId=" + worker,
          { ...auth, headers: {}, status: 401 },
        );
        await visit(
          "worker credential cannot select another worker",
          "GET",
          workerBase + "?workerId=another",
          { ...auth, status: 401 },
        );
        await visit(
          "worker automation poll",
          "GET",
          workerBase + "?workerId=" + worker,
          auth,
        );
        await visit(
          "malformed dispatch JSON parses before authentication",
          "POST",
          workerBase + `/${id(1)}/dispatch?workerId=` + worker,
          {
            ...auth,
            headers: { "content-type": "application/json" },
            raw: "{",
            status: 400,
          },
        );
        await h.fixture.sql([
          `UPDATE worker_credentials SET scopes='["worker:agent-tools"]' WHERE worker_id=${literal(worker)}`,
        ]);
        await visit(
          "agent-tools scope cannot poll automations",
          "GET",
          workerBase + "?workerId=" + worker,
          { ...auth, status: 401 },
        );
        await h.fixture.sql([
          `UPDATE worker_credentials SET scopes=${json(workerCredentialScopes)} WHERE worker_id=${literal(worker)}`,
        ]);
        await visit(
          "invalid dispatch schema after worker authentication",
          "POST",
          workerBase + `/${id(1)}/dispatch?workerId=` + worker,
          { ...auth, json: {}, status: 400 },
        );
        await visit(
          "missing occurrence is skipped",
          "POST",
          workerBase + `/${id(99)}/dispatch?workerId=` + worker,
          { ...auth, json: { revision: 1, scheduledFor: stamp } },
        );
        for (const [n, dispatchMode, condition, status] of [
          [2, "normal", { type: "open-issues", minimum: 2 }, 202],
          [3, "normal", null, 202],
          [4, "invalid", null, 409],
          [5, "worker-error", null, 409],
        ]) {
          const encrypted = await content(n, condition);
          automation = await visit(`create dispatch case ${n}`, "POST", base, {
            json: {
              id: id(n),
              chatId: chat,
              enabled: false,
              schedule: {
                kind: "cron",
                expression: "2020-01-01T00:00:00Z",
                timeZone: "UTC",
              },
              content: encrypted,
            },
            status: 201,
          });
          await prove(automation, n);
          await h.fixture.sql([
            `UPDATE project_automations SET enabled=true,next_run_at=${literal(stamp)} WHERE id=${literal(id(n))}`,
          ]);
          mode = dispatchMode;
          const dispatched = await visit(
            `protected dispatch ${n}`,
            "POST",
            workerBase + `/${id(n)}/dispatch?workerId=` + worker,
            { ...auth, json: { revision: 1, scheduledFor: stamp }, status },
          );
          if (status === 202) {
            assert.equal(dispatched.accepted, true);
            assert.equal(dispatched.status, n === 2 ? "skipped" : "queued");
            assert.equal(dispatched.nextRunAt, null);
          } else
            assert.deepEqual(dispatched, {
              error: "Protected automation dispatch failed.",
            });
          await visit(
            `repeated completed occurrence ${n}`,
            "POST",
            workerBase + `/${id(n)}/dispatch?workerId=` + worker,
            { ...auth, json: { revision: 1, scheduledFor: stamp } },
          );
          if (n === 3) {
            const queue = await visit(
              "read actual protected queued prompt",
              "GET",
              `/api/chats/${chat}/queue`,
            );
            const queued = queue.items ?? queue;
            assert.equal(queued.length, 1);
            const p = queued[0];
            const opened = await decryptQueuedPromptProtectedContent({
              ownerId: h.owner,
              promptId: p.id,
              keyRevision: p.protectedContent.keyRevision,
              componentKey: new Uint8Array(componentKey),
              encrypted: p.protectedContent,
              publicClassification: p.classification,
            });
            assert.equal(opened.text, marker + " prompt");
            result.cryptoProofs++;
          }
        }
        mode = "normal";
        const sdkContent = await content(6, {
          type: "open-issues",
          minimum: 2,
        });
        await visit("create actual scheduler occurrence", "POST", base, {
          json: {
            id: id(6),
            chatId: chat,
            enabled: false,
            schedule: {
              kind: "cron",
              expression: "2020-01-01T00:00:00Z",
              timeZone: "UTC",
            },
            content: sdkContent,
          },
          status: 201,
        });
        await h.fixture.sql([
          `UPDATE project_automations SET enabled=true,next_run_at=${literal(stamp)} WHERE id=${literal(id(6))}`,
        ]);
        const scheduler = new ProjectAutomationScheduler({
          serverUrl: h.fixture.server.origin,
          workerId: worker,
          token: h.credential,
          fetch: async (url, options) => {
            const response = await fetch(url, options);
            result.sdk.push({
              path: new URL(url).pathname + new URL(url).search,
              method: options.method ?? "GET",
              status: response.status,
              body: h.fixture.normalize(
                canonical(await response.clone().json()),
              ),
            });
            return response;
          },
        });
        const beforeCommands = result.commands.length;
        await scheduler.tick();
        scheduler.close();
        assert.equal(result.commands.length, beforeCommands + 1);
        assert.equal(result.sdk.length, 2);
        assert.equal(result.sdk[1].body.status, "skipped");
        const durable = async (n) =>
          (
            await h.fixture.sql(
              [],
              [
                `SELECT jsonb_build_object('automation',to_jsonb(a),'run',(SELECT to_jsonb(r) FROM project_automation_runs r WHERE automation_id=a.id))::text result FROM project_automations a WHERE id=${literal(id(n))}`,
              ],
            )
          )[0];
        const claimCase = async (n) => {
          await visit(`create held occurrence ${n}`, "POST", base, {
            json: {
              id: id(n),
              chatId: chat,
              enabled: false,
              schedule: {
                kind: "cron",
                expression: "2020-01-01T00:00:00Z",
                timeZone: "UTC",
              },
              content: await content(n),
            },
            status: 201,
          });
          await h.fixture.sql([
            `UPDATE project_automations SET enabled=true,next_run_at=${literal(stamp)} WHERE id=${literal(id(n))}`,
          ]);
          held = { requested: false };
          held.promise = new Promise((resolve) => (held.release = resolve));
          mode = "hold";
        };
        await claimCase(7);
        let pending = visit(
          "held dispatch survives concurrent edit",
          "POST",
          workerBase + `/${id(7)}/dispatch?workerId=` + worker,
          { ...auth, json: { revision: 1, scheduledFor: stamp }, status: 202 },
        );
        await eventually(
          () => held.requested,
          (value) => assert.equal(value, true),
          15000,
        );
        const duplicate = await visit(
          "concurrent occurrence sees active lease",
          "POST",
          workerBase + `/${id(7)}/dispatch?workerId=` + worker,
          { ...auth, json: { revision: 1, scheduledFor: stamp } },
        );
        assert.equal(duplicate.accepted, false);
        await visit(
          "edit automation while worker protects turn",
          "PATCH",
          item(7),
          { json: { enabled: false } },
        );
        held.release();
        await pending;
        mode = "normal";
        let state = await durable(7);
        assert.equal(state.automation.revision, 2);
        assert.equal(state.automation.enabled, false);
        assert.equal(state.automation.next_run_at, null);
        assert.equal(state.run.status, "queued");
        result.recovery.push({
          case: "edited-during-protection",
          automationRevision: 2,
          enabled: false,
          runStatus: "queued",
        });
        await claimCase(8);
        pending = visit(
          "lease expiry is reported after durable queue admission",
          "POST",
          workerBase + `/${id(8)}/dispatch?workerId=` + worker,
          { ...auth, json: { revision: 1, scheduledFor: stamp }, status: 409 },
        );
        await eventually(
          () => held.requested,
          (value) => assert.equal(value, true),
          15000,
        );
        await h.fixture.sql([
          `UPDATE project_automation_runs SET lease_expires_at=${literal(stamp)} WHERE automation_id=${literal(id(8))}`,
        ]);
        held.release();
        assert.deepEqual(await pending, {
          error: "Automation dispatch lease expired before completion.",
        });
        mode = "normal";
        state = await durable(8);
        assert.equal(state.run.status, "dispatching");
        assert.equal(state.automation.last_status, "dispatching");
        result.recovery.push({
          case: "lease-expired-after-admission",
          runStatus: state.run.status,
          automationStatus: state.automation.last_status,
        });
        const beforeRecovery = result.commands.length;
        await visit(
          "expired encrypted queue recovery preserves Source mapper failure",
          "POST",
          workerBase + `/${id(8)}/dispatch?workerId=` + worker,
          { ...auth, json: { revision: 1, scheduledFor: stamp }, status: 409 },
        );
        assert.equal(
          result.commands.length,
          beforeRecovery,
          "opaque legacy lookup fails before another protection command",
        );
        state = await durable(8);
        assert.equal(state.run.status, "failed");
        assert.equal(state.run.fencing_token, 2);
        assert.equal(state.run.attempt_count, 2);
        assert.equal(state.automation.next_run_at, null);
        result.recovery.push({
          case: "opaque-legacy-recovery",
          runStatus: "failed",
          fencingToken: 2,
          attempts: 2,
        });
        await claimCase(9);
        const controller = new AbortController();
        const abandoned = fetch(
          h.fixture.server.origin +
            workerBase +
            `/${id(9)}/dispatch?workerId=` +
            worker,
          {
            method: "POST",
            headers: { ...auth.headers, "content-type": "application/json" },
            body: JSON.stringify({ revision: 1, scheduledFor: stamp }),
            signal: controller.signal,
          },
        ).then(
          () => assert.fail("held request unexpectedly completed"),
          (error) => error,
        );
        await eventually(
          () => held.requested,
          (value) => assert.equal(value, true),
          15000,
        );
        controller.abort();
        assert.equal((await abandoned).name, "AbortError");
        held.release();
        mode = "normal";
        await eventually(
          () => durable(9),
          (value) => assert.equal(value.run.status, "queued"),
          15000,
        );
        result.recovery.push({
          case: "disconnected-client",
          runStatus: "queued",
        });
        for (const [n, kind] of [
          [10, "message"],
          [11, "prompt"],
        ]) {
          await claimCase(n);
          const key = `automation:${id(n)}:${stamp}`;
          if (kind === "message")
            await h.fixture.sql([
              `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,content,idempotency_key) SELECT ${literal(id(100))},id,active_worktree_id,'user','default','[]',${literal(key)} FROM chats WHERE id=${literal(chat)}`,
            ]);
          else
            await h.fixture.sql([
              `INSERT INTO queued_prompts(id,chat_id,text,mode,model_id,position,idempotency_key) VALUES(${literal(id(101))},${literal(chat)},'Legacy visible queued automation','default','inventory-provider-model-1',99,${literal(key)})`,
            ]);
          const before = result.commands.length;
          const recovered = await visit(
            `recover existing legacy ${kind}`,
            "POST",
            workerBase + `/${id(n)}/dispatch?workerId=` + worker,
            {
              ...auth,
              json: { revision: 1, scheduledFor: stamp },
              status: 202,
            },
          );
          assert.equal(
            recovered.status,
            kind === "message" ? "started" : "queued",
          );
          assert.equal(result.commands.length, before);
          state = await durable(n);
          assert.equal(state.run.status, recovered.status);
          result.recovery.push({
            case: `legacy-${kind}`,
            status: recovered.status,
          });
          mode = "normal";
        }
        await visit(
          "delete automation with registered binary parser",
          "DELETE",
          item(1),
          {
            raw: Buffer.from([0xff]),
            headers: { "content-type": "application/octet-stream" },
            status: 204,
          },
        );
        await visit("delete missing automation", "DELETE", item(1), {
          status: 404,
        });
        await h.live.subscribed("automation-publication-barrier", [
          { kind: "project", projectId: project },
        ]);
        const events = h.live.history.filter(
          (e) => e.type === "event" && e.resource === "project-automation",
        );
        assert.ok(events.length >= 15);
        for (const e of events) {
          assert.deepEqual(e.scope, { kind: "project", projectId: project });
          assert.equal(e.action, "invalidated");
          assert.equal(e.payload, null);
          assert.equal(e.revision, null);
        }
        result.events = events.map(
          ({ scope, resource, action, entityId, revision, payload }) =>
            h.fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
        );
        for (const value of [...h.fixture.records.values(), h.live.history])
          assert.equal(
            JSON.stringify(value).includes(marker),
            false,
            "plaintext remains endpoint-only",
          );
        result.observations = canonical(result.observations);
        result.diagnostics = h.diagnostics();
        assert.equal(
          result.diagnostics.includes(marker),
          false,
          "server diagnostics redact private worker failure",
        );
      } finally {
        held?.release?.();
        await h.close();
        h = null;
      }
    }
    for (const key of [
      "observations",
      "commands",
      "cryptoProofs",
      "events",
      "sdk",
      "recovery",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = h?.diagnostics();
} finally {
  await h?.close().catch(() => {});
  await pg?.close();
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/project-automations-http-${databaseMode}.json`,
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
