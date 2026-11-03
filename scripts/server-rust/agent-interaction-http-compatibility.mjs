// Production routers and real HTTP/Live/WorkerConnection sockets. SQL only
// arranges states and failures; full-worker acceptance is a separate suite.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
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
  encryptInteractionResponseContent,
  decryptInteractionRequestContent,
} from "../../packages/crypto/dist/index.js";
import {
  protectAgentInteractionRequest,
  openAgentInteractionResponse,
} from "../../cantrip_worker/src/interaction-encryption.ts";
import { eventually } from "./full-worker.mjs";
import { runInteractionHttpCases } from "./agent-interaction-http-cases.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-interaction-http-"));
const report = {
  suite: "agent-interaction-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
export const interactionId = (n) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
export const interactionMarker = "private-interaction-endpoint-proof";
export const interactionLane = "77777777-7777-4777-8777-777777777777";
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
        durable: [],
        recovery: [],
      };
      outputs.push(result);
      const envelopes = new Map(),
        payloads = new Map(),
        responses = new Map(),
        requestChats = new Map();
      // SQL JSONB reorders object properties; compare every envelope field.
      const envelopeKey = (v) =>
        JSON.stringify(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      let mode = "normal",
        held;
      function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object")
          return (
            envelopes.get(envelopeKey(value)) ??
            Object.fromEntries(
              Object.entries(value).map(([key, v]) => [key, canonical(v)]),
            )
          );
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
        environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "2" },
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        configure: (owner) => [
          ...inventorySeed(owner, { kind: "openai-compatible", worker }),
          "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
          `UPDATE chats SET automation_paused=true,model_id='inventory-provider-model-1',reasoning_effort='medium' WHERE id=${literal(chat)}`,
        ],
        onCommand: async (command, _emit, { encryption }) => {
          if (
            ![
              "agent.interaction.respond",
              "agent.interaction.respond.protected",
              "chat.native-control",
              "computer-use.approval.respond",
            ].includes(command.type)
          )
            return undefined;
          const reply = command.control ?? command,
            requestKey = reply.requestKey,
            protectedReply =
              reply.protectedResponse ??
              (command.type.endsWith(".protected") ||
              command.type.startsWith("computer-use.")
                ? command.response
                : null);
          if (protectedReply) {
            assert.deepEqual(
              await openAgentInteractionResponse({
                requestKey,
                response: protectedReply,
                service: encryption,
              }),
              responses.get(requestKey),
            );
            result.cryptoProofs++;
          } else assert.deepEqual(reply.response, responses.get(requestKey));
          result.commands.push(h.fixture.normalize(canonical(command)));
          if (mode === "hold") {
            held.requested = true;
            held.count++;
            await new Promise((resolve) => held.releases.push(resolve));
          }
          if (mode === "error")
            throw new Error("controlled worker rejection \ud800");
          if (mode === "invalid") return { accepted: false };
          return { accepted: true };
        },
      });
      try {
        const base = "/api/agent-requests",
          item = (n) => `${base}/${interactionId(n)}`,
          respond = (n) => item(n) + "/respond";
        async function response(
          n,
          protectedReply = false,
          responseKind = "fileChange",
          suffix = "",
        ) {
          const requestKey = interactionId(n),
            value =
              responseKind === "permissions"
                ? {
                    kind: "permissions",
                    permissions: {},
                    scope: "turn",
                    strictAutoReview: false,
                  }
                : { kind: "fileChange", decision: "accept" };
          responses.set(requestKey, value);
          if (!protectedReply)
            return { idempotencyKey: `reply:${n}${suffix}`, response: value };
          const classification = { kind: responseKind },
            encrypted = await encryptInteractionResponseContent({
              ownerId: h.owner,
              requestKey,
              keyRevision: 1,
              componentKey: new Uint8Array(componentKey),
              content: { version: 1, classification, response: value },
            });
          // The unchanged worker decrypts every transmitted response above.
          // Also decrypt seeded and replay-only ciphertext independently.
          assert.deepEqual(
            await openAgentInteractionResponse({
              requestKey,
              response: { classification, protectedResponse: encrypted },
              service: h.encryption,
            }),
            value,
          );
          result.cryptoProofs++;
          envelopes.set(
            envelopeKey(encrypted.envelope),
            `<verified response:${n}${suffix}>`,
          );
          return {
            idempotencyKey: `reply:${n}${suffix}`,
            classification,
            protectedResponse: encrypted,
          };
        }
        async function seed(n, options = {}) {
          const requestKey = interactionId(n),
            owningChat = options.noChat ? null : (options.chatId ?? chat),
            owningProject =
              options.projectId === undefined ? project : options.projectId,
            payload =
              options.kind === "permissions"
                ? {
                    kind: "permissions",
                    startedAtMs: 1,
                    reason: options.protected
                      ? interactionMarker
                      : "Visible permissions request",
                    environmentId: null,
                    cwd: null,
                    requestedPermissions: {},
                    source: "native-computer-use",
                  }
                : {
                    kind: "fileChange",
                    startedAtMs: 1,
                    reason: options.protected
                      ? interactionMarker
                      : "Visible request",
                    grantRoot: null,
                  },
            runtime = await protectAgentInteractionRequest({
              request: {
                requestKey,
                threadId: "thread",
                turnId: null,
                itemId: null,
                payload,
                expiresAt: "2050-01-01T00:00:00.000Z",
              },
              service: h.encryption,
            });
          payloads.set(requestKey, payload);
          requestChats.set(interactionId(n), owningChat);
          assert.deepEqual(
            (
              await decryptInteractionRequestContent({
                ownerId: h.owner,
                requestKey,
                keyRevision: 1,
                componentKey: new Uint8Array(componentKey),
                encrypted: runtime.protectedPayload,
                publicClassification: runtime.classification,
              })
            ).payload,
            payload,
          );
          result.cryptoProofs++;
          envelopes.set(
            envelopeKey(runtime.protectedPayload.envelope),
            `<verified request:${n}>`,
          );
          const status = options.status ?? "pending",
            resolved = status === "pending" ? null : stamp,
            sqlTime = new Date(Date.parse(stamp) + n).toISOString();
          await h.fixture.sql([
            `INSERT INTO agent_interaction_requests(id,request_key,interaction_owner,owner_id,project_id,chat_id,worker_id,execution_lane_id,thread_id,turn_id,item_id,kind,status,payload,protected_payload,expires_at,resolved_at,created_at,updated_at) VALUES(${literal(interactionId(n))},${literal(requestKey)},${literal(options.computer ? "computer-use" : "codex")},${literal(h.owner)},${literal(owningProject)},${literal(owningChat)},${literal(worker)},${literal(options.lane ?? null)},${literal(options.computer && !options.lane ? null : "thread")},NULL,NULL,${literal(payload.kind)},${literal(status)},${json(options.protected ? null : payload)},${json(options.protected ? runtime.protectedPayload : null)},${literal(options.expired ? stamp : null)},${literal(resolved)},${literal(sqlTime)},${literal(sqlTime)})`,
            ...(options.computer || status !== "pending"
              ? []
              : [
                  `UPDATE chats SET status='waiting-for-approval' WHERE id=${literal(owningChat)}`,
                ]),
          ]);
          return runtime;
        }
        async function durable(n, label) {
          const [row] = await h.fixture.sql(
            [],
            [
              `SELECT to_jsonb(r)::text result FROM agent_interaction_requests r WHERE id=${literal(interactionId(n))}`,
            ],
          );
          if (label) {
            (result.rawDurable ??= []).push({ label, row });
            const compared = structuredClone(row);
            for (const key of [
              "created_at",
              "updated_at",
              "resolved_at",
              "expires_at",
            ])
              if (compared[key] !== null) {
                const time = new Date(compared[key]);
                assert.ok(
                  Number.isFinite(time.valueOf()),
                  `valid SQL timestamp ${key}`,
                );
                if (key === "created_at")
                  assert.equal(
                    time.toISOString(),
                    new Date(Date.parse(stamp) + n).toISOString(),
                  );
                compared[key] = h.fixture.normalize(
                  time.toISOString(),
                  "updatedAt",
                );
              }
            result.durable.push({
              label,
              row: h.fixture.normalize(canonical(compared)),
            });
          }
          return row;
        }
        async function barrier(label) {
          await h.live.subscribed(label, [{ kind: "chat", chatId: chat }]);
        }
        function hold() {
          mode = "hold";
          held = { requested: false, count: 0, releases: [] };
          const gate = held;
          gate.release = () => {
            for (const release of gate.releases) release();
          };
          gate.releaseOne = (index) => gate.releases[index]();
          return held;
        }
        const context = {
          h,
          result,
          profile,
          base,
          item,
          respond,
          seed,
          response,
          durable,
          barrier,
          canonical,
          hold,
          setMode: (value) => {
            mode = value;
          },
          id: interactionId,
          lane: interactionLane,
          waitHeld: (count = 1) =>
            eventually(
              () => held.count,
              (v) => assert.equal(v, count),
              15000,
            ),
        };
        await runInteractionHttpCases(context);
        const events = h.live.history.filter(
          (e) => e.type === "event" && e.resource === "agent-interaction",
        );
        assert.ok(
          events.length >= 8,
          "resolutions and replays invalidate Live",
        );
        for (const event of events) {
          assert.deepEqual(event.scope, {
            kind: "chat",
            chatId: requestChats.get(event.entityId),
          });
          assert.equal(event.action, "invalidated");
          assert.equal(event.payload, null);
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
        result.observations = canonical(result.observations);
        for (const value of [...h.fixture.records.values(), h.live.history])
          assert.equal(
            JSON.stringify(value).includes(interactionMarker),
            false,
            "private interaction content remains endpoint-only",
          );
        result.diagnostics = h.diagnostics();
      } finally {
        result.diagnostics = h.diagnostics();
        held?.release?.();
        await h.close();
        h = null;
      }
    }
    for (const key of [
      "observations",
      "commands",
      "cryptoProofs",
      "durable",
      "recovery",
      "events",
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
      `.qa/rust-server/agent-interactions-http-${databaseMode}.json`,
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
