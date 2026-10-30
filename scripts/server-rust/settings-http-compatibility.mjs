// Real production HTTP entrypoints with isolated stores and controlled workers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { SocketProbe } from "./worker-sockets.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-settings-http-"));
const report = {
  suite: "actual-settings-model-http-live",
  databaseMode,
  root,
  completeReplacement: false,
  runtimes: [],
};
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
// These are permitted JSONB rows, including older or malformed catalog data.
// Exercise the real operation rather than rejecting the whole catalog early.
const malformedReasoning = [
  ["null", null, 200, 500],
  ["object", {}, 500, 500],
  ["string", "high", 500, 500],
  ["empty-string", "", 200, 500],
  ["false", false, 500, 500],
  ["null-item", [null], 500, 500],
  ["null-after-match", [{ effort: "high", description: null }, null], 500, 200],
  [
    "null-before-match",
    [null, { effort: "high", description: null }],
    500,
    500,
  ],
  ["primitive-items", [{}, 0, false, "x", [], { effort: null }], 500, 409],
  [
    "object-efforts",
    [
      { effort: {}, description: null },
      { effort: {}, description: null },
    ],
    500,
    409,
  ],
];
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
    "settings-repository-fixture",
  );
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      postgresOwner && (kind === "node" || databaseMode === "postgres")
        ? await postgresOwner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "settings",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_SESSION_TTL_SECONDS: "3600",
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
    const result = { kind, observations: [], live: {}, queryErrors: [] };
    report.runtimes.push(result);
    let repository, live, otherLive, worker;
    const visit = async (label, method, url, options = {}) => {
      const started = Date.now();
      const observation = await fixture.observe(label, method, url, {
        csrf: !["GET", "HEAD"].includes(method),
        ...options,
      });
      if (observation.body?.error?.startsWith("Failed query: ")) {
        const raw = observation.body.error;
        result.queryErrors.push({ label, raw });
        observation.body.error = raw
          .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
            (id) => fixture.normalize(id),
          )
          .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
            assert.ok(
              Date.parse(stamp) >= started && Date.parse(stamp) <= Date.now(),
              label + ": actual query timestamp",
            );
            return "<query-timestamp>";
          });
      }
      result.observations.push({ label, ...observation });
      return fixture.records.get(label);
    };
    const openRepository = () =>
      repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, "settings"),
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
      });
    try {
      await fixture.start();
      await visit("anonymous update", "PATCH", "/api/settings", {
        json: { theme: "dark" },
        status: 401,
      });
      await visit(
        "anonymous reasoning",
        "GET",
        "/api/settings/models/root/reasoning",
        { status: 401 },
      );
      for (const client of ["main", "other"])
        await fixture.observe(
          "register " + client,
          "POST",
          "/api/auth/register",
          {
            client,
            status: 201,
            json: {
              displayName: "Settings " + client,
              email: `settings-${client}@example.invalid`,
              password: "isolated settings fixture password",
            },
          },
        );
      const owner = fixture.records.get("register main").currentUser.id,
        other = fixture.records.get("register other").currentUser.id;
      await fixture.close();
      repository = await openRepository();
      for (const [id, principal] of [
        ["provider-a", owner],
        ["provider-b", owner],
        ["provider-foreign", other],
        ["replacement-provider-\ufffd", owner],
      ])
        await repository.seed(
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(principal)},${literal(id)},'openai-compatible','https://fixture.invalid/v1');`,
        );
      for (const [id, principal] of [
        ["root", owner],
        ["sub", owner],
        ["foreign", other],
      ])
        await repository.seed(
          `INSERT INTO model_profiles(id,owner_id,name,default_reasoning_effort) VALUES(${literal(id)},${literal(principal)},${literal(id)},'high');`,
        );
      for (const [id, provider, native, efforts] of [
        ["cat-a", "provider-a", "native-a", ["low", "high"]],
        ["cat-b", "provider-b", "native-b", ["max"]],
        ["cat-sub", "provider-a", "native-sub", ["medium", "high"]],
      ])
        await repository.seed(
          `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source,supports_reasoning,supported_reasoning_efforts,reasoning_mandatory) VALUES(${literal(id)},${literal(provider)},${literal(native)},${literal(native)},'manual',true,${literal(JSON.stringify(efforts.map((effort) => ({ effort, description: "Fixture " + effort }))))},true);`,
        );
      await repository.seed(
        "INSERT INTO model_routes(id,model_id,provider_id,provider_model_id,model_name,position) VALUES('root-a','root','provider-a','cat-a','native-a',0),('root-b','root','provider-b','cat-b','native-b',1),('sub-a','sub','provider-a','cat-sub','native-sub',0),('foreign-a','foreign','provider-foreign',NULL,'foreign-native',0);",
      );
      for (const [name, options] of malformedReasoning) {
        const id = "malformed-reasoning-" + name;
        await repository.seed(
          `INSERT INTO model_profiles(id,owner_id,name,default_reasoning_effort) VALUES(${literal(id)},${literal(owner)},${literal(id)},'high');`,
        );
        await repository.seed(
          `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source,supports_reasoning,supported_reasoning_efforts) VALUES(${literal(id)},'provider-a',${literal(id)},${literal(id)},'manual',true,${literal(JSON.stringify(options))}::jsonb);`,
        );
        await repository.seed(
          `INSERT INTO model_routes(id,model_id,provider_id,provider_model_id,model_name,position) VALUES(${literal(id)},${literal(id)},'provider-a',${literal(id)},${literal(id)},0);`,
        );
      }
      await repository.seed(
        "ALTER TABLE model_profiles ADD CONSTRAINT settings_http_model_failure CHECK (name NOT IN ('reject-profile', 'reject-profile�'));",
      );
      await repository.seed(
        "ALTER TABLE model_routes ADD CONSTRAINT settings_http_route_failure CHECK (model_name <> 'reject-route');",
      );
      await repository.seed(
        "CREATE FUNCTION settings_http_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='projection-invalid' THEN NEW.name=' '; END IF; RETURN NEW; END $$;",
      );
      await repository.seed(
        "CREATE TRIGGER settings_http_projection_failure BEFORE INSERT OR UPDATE ON model_profiles FOR EACH ROW EXECUTE FUNCTION settings_http_projection_failure();",
      );
      await repository.seed(
        `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,position) VALUES('task-reference',${literal(owner)},'Reference','sub','fixture',100000);`,
      );
      const protectedLabel = {
        classification: { recordKind: "project" },
        protectedLabel: policyEnvelope,
      };
      for (const [id, principal] of [
        ["project", owner],
        ["foreign-project", other],
      ])
        await repository.seed(
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES(${literal(id)},${literal(principal)},${literal(JSON.stringify(protectedLabel))},'managed-folder','external','direct');`,
        );
      await repository.close();
      repository = undefined;
      await fixture.start();
      live = new LiveProbe(fixture);
      await live.open();
      await live.initialized();
      await live.subscribed();
      otherLive = new LiveProbe(fixture, { client: "other" });
      await otherLive.open();
      await otherLive.initialized();
      await otherLive.subscribed();
      await visit("invalid settings", "PATCH", "/api/settings", {
        json: { theme: "unknown", sidebarWidth: 0 },
        status: 400,
      });
      await visit("missing CSRF", "PATCH", "/api/settings", {
        csrf: false,
        json: { theme: "dark" },
        status: 403,
      });
      await visit("malformed JSON", "PATCH", "/api/settings", {
        raw: "{",
        headers: { "content-type": "application/json" },
        status: 400,
      });
      await visit("invalid model", "POST", "/api/settings/models", {
        json: { name: " ", routes: [] },
        status: 400,
      });
      await visit("disabled routes", "POST", "/api/settings/models", {
        json: {
          name: "Model",
          routes: [
            { providerId: "provider-a", modelName: "native-a", enabled: false },
          ],
        },
        status: 400,
      });
      await visit("unknown provider", "POST", "/api/settings/models", {
        json: {
          name: "Model",
          routes: [{ providerId: "missing", modelName: "native-a" }],
        },
        status: 404,
      });
      await visit("foreign provider", "POST", "/api/settings/models", {
        json: {
          name: "Model",
          routes: [{ providerId: "provider-foreign", modelName: "native-a" }],
        },
        status: 404,
      });
      const beforeInsertFailures = await visit(
        "before failed model transactions",
        "PATCH",
        "/api/settings",
        { json: {} },
      );
      await visit("model insert failure", "POST", "/api/settings/models", {
        json: {
          name: "reject-profile",
          routes: [{ providerId: "provider-a", modelName: "native-a" }],
        },
        status: 409,
      });
      await visit(
        "model query error preserves original UTF16",
        "POST",
        "/api/settings/models",
        {
          json: {
            name: "reject-profile\ud800",
            routes: [{ providerId: "provider-a", modelName: "native-a" }],
          },
          status: 409,
        },
      );
      await visit(
        "provider ownership compares original UTF16",
        "POST",
        "/api/settings/models",
        {
          json: {
            name: "Unpaired provider",
            routes: [
              {
                providerId: "replacement-provider-\ud800",
                modelName: "native-a",
              },
            ],
          },
          status: 404,
        },
      );
      await visit("route insert failure", "POST", "/api/settings/models", {
        json: {
          name: "Rejected routes",
          routes: [
            { providerId: "provider-a", modelName: "native-a" },
            { providerId: "provider-b", modelName: "reject-route" },
          ],
        },
        status: 409,
      });
      const afterInsertFailures = await visit(
        "after failed model transactions",
        "PATCH",
        "/api/settings",
        { json: {} },
      );
      assert.deepEqual(
        afterInsertFailures.models,
        beforeInsertFailures.models,
        "Model and route inserts roll back together",
      );
      await visit(
        "root reasoning",
        "GET",
        "/api/settings/models/root/reasoning",
      );
      await visit(
        "trim reasoning ID",
        "GET",
        "/api/settings/models/%EF%BB%BF%20root%20/reasoning",
      );
      await visit(
        "foreign reasoning",
        "GET",
        "/api/settings/models/foreign/reasoning",
        { status: 404 },
      );
      await visit(
        "missing reasoning",
        "GET",
        "/api/settings/models/missing/reasoning",
        { status: 404 },
      );
      await visit(
        "reasoning HEAD",
        "HEAD",
        "/api/settings/models/root/reasoning",
      );
      for (const [name, , stateStatus, requestedStatus] of malformedReasoning) {
        const id = "malformed-reasoning-" + name;
        await visit(
          "stored " + name + " reasoning",
          "GET",
          `/api/settings/models/${id}/reasoning`,
          { status: stateStatus },
        );
        await visit(
          "stored " + name + " requested effort",
          "PATCH",
          "/api/settings",
          {
            json: { defaultModelId: id, defaultReasoningEffort: "high" },
            status: requestedStatus,
          },
        );
        // A null request delegates to the provider and never evaluates .some.
        await visit(
          "stored " + name + " provider default",
          "PATCH",
          "/api/settings",
          { json: { defaultModelId: id, defaultReasoningEffort: null } },
        );
      }
      await visit("default missing root", "PATCH", "/api/settings", {
        json: { defaultModelId: "missing" },
        status: 409,
      });
      await visit("default root", "PATCH", "/api/settings", {
        json: { defaultModelId: "root", defaultReasoningEffort: "high" },
      });
      await visit("unsupported root reasoning", "PATCH", "/api/settings", {
        json: { defaultReasoningEffort: "minimal" },
        status: 409,
      });
      await visit("custom needs model", "PATCH", "/api/settings", {
        json: { defaultCustomSubagentModel: true },
        status: 400,
      });
      await visit("custom subagent", "PATCH", "/api/settings", {
        json: {
          defaultCustomSubagentModel: true,
          defaultSubagentModelId: "sub",
          defaultSubagentReasoningEffort: "medium",
        },
      });
      await visit(
        "reasoning rejects incompatible root pair",
        "PATCH",
        "/api/settings",
        { json: { defaultReasoningEffort: "max" }, status: 409 },
      );
      await visit("unsupported subagent reasoning", "PATCH", "/api/settings", {
        json: { defaultSubagentReasoningEffort: "max" },
        status: 409,
      });
      await visit("chat default reasoning", "PATCH", "/api/settings", {
        json: { defaultChatModelId: "root", defaultChatReasoningEffort: "max" },
      });
      await visit("chat default invalid", "PATCH", "/api/settings", {
        json: { defaultChatReasoningEffort: "minimal" },
        status: 409,
      });
      await visit("unknown labeling model", "PATCH", "/api/settings", {
        json: { labelingModelId: "missing" },
        status: 400,
      });
      await visit("unknown worker default", "PATCH", "/api/settings", {
        json: { defaultWorkerId: "missing" },
        status: 400,
      });
      await visit("preferences", "PATCH", "/api/settings", {
        json: {
          theme: "dark",
          mobileProjectTabConfigurations: { project: ["chat-a", null] },
          ignored: true,
        },
      });
      await visit("merge mobile tab preferences", "PATCH", "/api/settings", {
        json: { mobileProjectTabConfigurations: { second: ["chat-b"] } },
      });
      await visit(
        "destination requires update",
        "PATCH",
        "/api/settings/destination",
        { json: { expectedRevision: 1 }, status: 400 },
      );
      await visit(
        "destination strict fields",
        "PATCH",
        "/api/settings/destination",
        {
          json: { expectedRevision: 1, lastAppMode: "ide", unknown: true },
          status: 400,
        },
      );
      await visit(
        "destination foreign project",
        "PATCH",
        "/api/settings/destination",
        {
          json: { expectedRevision: 1, lastIdeProjectId: "foreign-project" },
          status: 409,
        },
      );
      await visit("destination", "PATCH", "/api/settings/destination", {
        json: {
          expectedRevision: 1,
          lastAppMode: "ide",
          lastIdeProjectId: "project",
        },
      });
      await visit("stale destination", "PATCH", "/api/settings/destination", {
        json: { expectedRevision: 1, lastAppMode: "chat" },
        status: 409,
      });
      await visit("destination null", "PATCH", "/api/settings/destination", {
        json: {
          expectedRevision: 2,
          lastIdeProjectId: null,
          lastAppMode: null,
        },
      });
      const created = await visit(
        "create model",
        "POST",
        "/api/settings/models",
        {
          json: {
            name: " \uFEFF Created 🦀 ",
            routes: [
              { providerId: "provider-a", modelName: " native-a " },
              {
                providerId: "provider-b",
                modelName: "native-b",
                enabled: false,
              },
            ],
            unknown: true,
          },
          status: 201,
        },
      );
      await visit(
        "model update failure",
        "PATCH",
        `/api/settings/models/${created.id}`,
        {
          json: { name: "reject-profile", routes: created.routes },
          status: 409,
        },
      );
      await visit(
        "route update failure",
        "PATCH",
        `/api/settings/models/${created.id}`,
        {
          json: {
            name: "Rejected update",
            routes: [{ ...created.routes[0], modelName: "reject-route" }],
          },
          status: 409,
        },
      );
      const afterUpdateFailures = await visit(
        "after failed route replacement",
        "PATCH",
        "/api/settings",
        { json: {} },
      );
      assert.deepEqual(
        afterUpdateFailures.models.find((model) => model.id === created.id),
        created,
        "Failed route replacement preserves profile and every route",
      );
      await visit(
        "created reasoning",
        "GET",
        `/api/settings/models/${created.id}/reasoning`,
      );
      await visit(
        "duplicate route IDs",
        "PATCH",
        `/api/settings/models/${created.id}`,
        {
          json: {
            name: "Updated",
            routes: [{ ...created.routes[0] }, { ...created.routes[0] }],
          },
          status: 404,
        },
      );
      await visit(
        "foreign route ID",
        "PATCH",
        `/api/settings/models/${created.id}`,
        {
          json: {
            name: "Updated",
            routes: [
              {
                id: "foreign-a",
                providerId: "provider-a",
                modelName: "native-a",
              },
            ],
          },
          status: 404,
        },
      );
      await visit(
        "update model",
        "PATCH",
        `/api/settings/models/${created.id}`,
        {
          json: {
            name: "Updated",
            routes: [
              {
                id: created.routes[0].id,
                providerId: "provider-a",
                modelName: "native-sub",
              },
              { providerId: "provider-b", modelName: "native-b" },
            ],
          },
        },
      );
      await visit("foreign update", "PATCH", "/api/settings/models/foreign", {
        json: {
          name: "Foreign",
          routes: [{ providerId: "provider-a", modelName: "native-a" }],
        },
        status: 404,
      });
      await visit(
        "delete referenced model",
        "DELETE",
        "/api/settings/models/sub",
        { status: 409 },
      );
      await visit(
        "delete malformed JSON preserves model",
        "DELETE",
        `/api/settings/models/${created.id}`,
        {
          raw: "{",
          headers: { "content-type": "application/json" },
          status: 400,
        },
      );
      await visit(
        "delete unsupported content preserves model",
        "DELETE",
        `/api/settings/models/${created.id}`,
        {
          raw: "<ignored/>",
          headers: { "content-type": "application/xml" },
          status: 415,
        },
      );
      await visit(
        "delete default model",
        "DELETE",
        "/api/settings/models/root",
        { status: 204 },
      );
      const cleared = await visit(
        "deleted default references cleared",
        "PATCH",
        "/api/settings",
        { json: {} },
      );
      assert.equal(cleared.preferences.defaultModelId, null);
      assert.equal(cleared.preferences.defaultChatModelId, null);
      await visit(
        "delete model",
        "DELETE",
        `/api/settings/models/${created.id}`,
        { status: 204, json: { ignored: true } },
      );
      await visit(
        "delete missing model",
        "DELETE",
        `/api/settings/models/${created.id}`,
        { status: 404 },
      );
      await visit(
        "delete foreign model",
        "DELETE",
        "/api/settings/models/foreign",
        { status: 404 },
      );
      await visit(
        "missing worker effects",
        "GET",
        "/api/settings/computer-use/workers/missing/effects",
        { status: 404 },
      );
      await visit("effects preferences", "PATCH", "/api/settings", {
        json: {
          computerUseEnabled: true,
          computerUseEffects: {
            effect: "cursor-warp",
            parameters: { strength: 0.5, radius: 64 },
          },
        },
      });
      await visit(
        "effects worker code",
        "POST",
        "/api/workers/enrollment-codes",
        { json: { label: "Settings worker" }, status: 201 },
      );
      await visit(
        "effects worker enrollment",
        "POST",
        "/api/internal/workers/enroll",
        {
          json: {
            code: fixture.records.get("effects worker code").code,
            heartbeat,
          },
          client: "worker",
          csrf: false,
          status: 201,
        },
      );
      await visit(
        "offline worker effects",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
        { status: 503 },
      );
      let effectReply = "success";
      const effectRequests = [];
      worker = new SocketProbe(fixture, {
        credential: fixture.records.get("effects worker enrollment").credential,
        onRequest(frame, socket) {
          if (frame.command.type !== "computer-use.effects.sync") return false;
          effectRequests.push(frame.command.preferences);
          if (effectReply === "disconnect") {
            socket.close(1000, "Controlled effects disconnect");
            return true;
          }
          const response = {
            kind: "response",
            requestId: frame.requestId,
            ok: effectReply !== "error",
          };
          if (effectReply === "error")
            response.error = {
              code: "fixture-effects",
              message: "Controlled effects failure 🦀\ud800",
            };
          else if (effectReply === "invalid")
            response.result = { revision: "invalid", configuration: null };
          else if (effectReply === "null") response.result = null;
          else if (effectReply !== "missing")
            response.result = {
              ...frame.command.preferences,
              state: "running",
              error: null,
              native: null,
            };
          socket.send(JSON.stringify(response));
          if (effectReply === "missing") {
            socket.once("pong", () =>
              socket.send(
                JSON.stringify({
                  ...response,
                  result: {
                    ...frame.command.preferences,
                    state: "running",
                    error: null,
                    native: null,
                  },
                }),
              ),
            );
            socket.ping("invalid-response-barrier");
          }
          return true;
        },
      });
      await worker.open();
      assert.equal((await worker.message()).state, "pending");
      assert.equal((await worker.message()).state, "ready");
      const firstEffects = await visit(
        "connected worker effects",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
      );
      assert.equal(firstEffects.configuration.effect, "cursor-warp");
      const effectUpdate = await visit(
        "effects synchronize after write",
        "PATCH",
        "/api/settings",
        {
          json: {
            computerUseEffects: {
              effect: "debug-gradient",
              parameters: { strength: 0.75 },
            },
          },
        },
      );
      assert.ok(
        effectRequests.some(
          (p) =>
            p.revision ===
              effectUpdate.preferences.computerUseEffectsRevision &&
            p.configuration.effect === "debug-gradient",
        ),
      );
      effectReply = "error";
      const renderingFailure = await visit(
        "rendering failure preserves write",
        "PATCH",
        "/api/settings",
        {
          json: {
            computerUseEffects: { effect: "pass-through", parameters: {} },
          },
        },
      );
      assert.equal(
        renderingFailure.preferences.computerUseEffects.effect,
        "pass-through",
      );
      await visit(
        "worker effects failure",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
        { status: 502 },
      );
      for (const reply of ["invalid", "null"]) {
        effectReply = reply;
        await visit(
          "worker effects " + reply + " result",
          "GET",
          "/api/settings/computer-use/workers/fixture-worker/effects",
          { status: 502 },
        );
      }
      effectReply = "success";
      const off = await visit(
        "disabled computer use synchronizes off",
        "PATCH",
        "/api/settings",
        { json: { computerUseEnabled: false } },
      );
      assert.ok(
        effectRequests.some(
          (p) =>
            p.revision === off.preferences.computerUseEffectsRevision &&
            p.configuration.effect === "off",
        ),
      );
      await visit(
        "disabled worker effects",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
      );
      effectReply = "missing";
      await visit(
        "invalid response ignored before valid response",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
      );
      effectReply = "disconnect";
      // An actual socket close follows reconnect grace before rejecting a
      // pending request. The default command deadline is ten minutes.
      await visit(
        "worker disconnect interrupts effects request",
        "GET",
        "/api/settings/computer-use/workers/fixture-worker/effects",
        { status: 503, timeoutMs: 45000 },
      );
      await worker.waitClosed();
      await worker.close();
      worker = undefined;
      await live.ping();
      await otherLive.ping();
      for (const [name, probe] of [
        ["owner", live],
        ["foreign", otherLive],
      ]) {
        const events = probe.history.filter(
          (frame) => frame.type === "event" && frame.resource === "settings",
        );
        assert.deepEqual(
          events,
          [],
          "Settings/model mutations do not publish source-absent invalidations",
        );
        result.live[name] = events;
      }
      await live.close();
      live = undefined;
      await otherLive.close();
      otherLive = undefined;
      await visit(
        "projection failure after committed model write",
        "POST",
        "/api/settings/models",
        {
          json: {
            name: "projection-invalid",
            routes: [{ providerId: "provider-a", modelName: "native-a" }],
          },
          status: 409,
        },
      );
      await fixture.close();
      repository = await openRepository();
      const committed = await repository.request({
        op: "query-json",
        sql: "SELECT jsonb_build_object('models',count(DISTINCT m.id),'routes',count(r.id),'name',min(m.name)) AS result FROM model_profiles m LEFT JOIN model_routes r ON r.model_id=m.id WHERE m.name=' '",
      });
      assert.equal(committed.rejected, false);
      assert.deepEqual(
        committed.value,
        { models: 1, routes: 1, name: " " },
        "Projection failure preserves the committed model and route",
      );
      result.committedProjectionFailure = committed.value;
      await repository.seed(
        "UPDATE model_profiles SET name='Recovered projection' WHERE name=' ';",
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      const retained = await visit(
        "retained preferences",
        "PATCH",
        "/api/settings",
        {
          json: {},
        },
      );
      assert.ok(
        retained.models.some((model) => model.name === "Recovered projection"),
      );
    } finally {
      for (const close of [
        () => worker?.close(),
        () => live?.close(),
        () => otherLive?.close(),
        () => fixture.close(),
        () => repository?.close(),
      ])
        try {
          await close();
        } catch (error) {
          (report.cleanupErrors ??= []).push(error.stack ?? String(error));
        }
    }
  }
  assert.deepEqual(
    report.runtimes[1].observations,
    report.runtimes[0].observations,
    "Actual settings HTTP compatibility",
  );
  assert.deepEqual(report.runtimes[1].live, report.runtimes[0].live);
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    (report.cleanupErrors ??= []).push(error.stack ?? String(error));
  }
}
if (reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    databaseMode,
    observations: report.runtimes.map((r) => ({
      kind: r.kind,
      count: r.observations.length,
    })),
    failure: report.failure,
    cleanupErrors: report.cleanupErrors,
  }),
);
if (failure) throw failure;
assert.deepEqual(report.cleanupErrors ?? [], []);
