// Actual production routes, compared without replacing either implementation.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { providerManagementShutdown } from "./provider-management-shutdown.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-provider-management-"));
const report = {
  suite: "actual-provider-management-http-live",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
const provider = {
  id: "11111111-1111-4111-8111-111111111111",
  name: " Fixture Provider ",
  kind: "openai-compatible",
  baseUrl: "https://example.invalid/api/v1/responses?unused=yes#fragment",
  initialAccount: null,
  protectedApiKey: policyEnvelope,
};
const account = {
  id: "22222222-2222-4222-8222-222222222222",
  protectedLabel: policyEnvelope,
};
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
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
      fixture.normalize = (value, key = "") => {
        if (typeof value === "string") {
          const discovered =
            /^(discovered:(?:model|route):)([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
              value,
            );
          if (discovered)
            return discovered[1] + originalNormalize(discovered[2]);
        }
        return originalNormalize(value, key);
      };
      const result = { kind, observations: [], queryErrors: [], events: [] };
      profile.runtimes.push(result);
      const visit = async (label, method, target, options = {}) => {
        const before = Date.now();
        const observed = await fixture.observe(label, method, target, {
          csrf: !["GET", "HEAD"].includes(method),
          ...options,
        });
        if (observed.body?.error?.startsWith("Failed query: ")) {
          result.queryErrors.push({ label, raw: observed.body.error });
          observed.body.error = observed.body.error
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
              (id) => fixture.normalize(id),
            )
            .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
              assert.ok(
                Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now(),
                "actual query timestamp",
              );
              return "<query-timestamp>";
            });
        }
        result.observations.push({ label, ...observed });
        return fixture.records.get(label);
      };
      const base = "/api/settings/providers";
      let live, repository;
      try {
        await fixture.start();
        if (mode === "accounts") {
          await visit("anonymous settings", "GET", "/api/settings", {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous create", "POST", base, {
            client: "anonymous",
            json: provider,
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
                  displayName: "Provider " + client,
                  email: `provider-${client}@example.invalid`,
                  password: "isolated provider fixture password",
                },
              },
            );
        }
        await fixture.observe("session", "GET", "/api/auth/session");
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        await visit("initial settings", "GET", "/api/settings");
        await visit("settings HEAD", "HEAD", "/api/settings");
        for (const [label, input] of [
          ["missing body fields", {}],
          ["null", null],
          ["array", []],
          [
            "unknown key",
            { ...provider, apiKey: "plaintext must be rejected" },
          ],
          ["invalid identifier", { ...provider, id: "provider" }],
          [
            "nonaccount initial account",
            { ...provider, initialAccount: account },
          ],
          ["account missing initial account", { ...provider, kind: "chatgpt" }],
          [
            "account absent initial account",
            { ...provider, kind: "grok", initialAccount: undefined },
          ],
          [
            "invalid envelope",
            {
              ...provider,
              protectedApiKey: { ...policyEnvelope, keyRevision: 0 },
            },
          ],
        ])
          await visit("invalid create " + label, "POST", base, {
            json: input,
            status: 400,
          });
        await visit("malformed JSON", "POST", base, {
          raw: "{",
          headers: { "content-type": "application/json" },
          status: 400,
        });
        const created = await visit("create protected provider", "POST", base, {
          json: provider,
          status: 201,
        });
        assert.equal(created.name, "Fixture Provider");
        assert.equal(created.baseUrl, "https://example.invalid/api/v1");
        assert.equal(created.hasApiKey, true);
        assert.equal(Object.hasOwn(created, "protectedApiKey"), false);
        const update = {
          name: "Updated Provider",
          kind: provider.kind,
          baseUrl: "https://example.invalid/CHAT/COMPLETIONS/",
          weeklyUsageReservePercent: 17,
        };
        await visit(
          "update retains opaque key",
          "PATCH",
          base + "/" + provider.id,
          { json: update },
        );
        await visit(
          "provider type cannot change",
          "PATCH",
          base + "/" + provider.id,
          { json: { ...update, kind: "ollama" }, status: 409 },
        );
        await visit("update clears key", "PATCH", base + "/" + provider.id, {
          json: { ...update, protectedApiKey: null },
        });
        await visit("missing update", "PATCH", base + "/missing", {
          json: update,
          status: 404,
        });
        if (mode === "accounts") {
          await visit("foreign update", "PATCH", base + "/" + provider.id, {
            client: "other",
            json: update,
            status: 404,
          });
          await visit("foreign delete", "DELETE", base + "/" + provider.id, {
            client: "other",
            status: 404,
          });
          await visit("CSRF required", "PATCH", base + "/" + provider.id, {
            json: update,
            csrf: false,
            status: 403,
          });
        }
        await visit("retained settings", "GET", "/api/settings");
        await visit("delete provider", "DELETE", base + "/" + provider.id, {
          status: 204,
        });
        await visit("repeat delete", "DELETE", base + "/" + provider.id, {
          status: 404,
        });
        const ollama = {
          ...provider,
          id: "88888888-8888-4888-8888-888888888888",
          name: "Ollama fixture",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          protectedApiKey: null,
        };
        await visit("Ollama create ignores discovery failure", "POST", base, {
          json: ollama,
          status: 201,
        });
        await visit(
          "Ollama update ignores forced discovery failure",
          "PATCH",
          base + "/" + ollama.id,
          {
            json: {
              name: "Updated Ollama",
              kind: ollama.kind,
              baseUrl: ollama.baseUrl,
            },
          },
        );
        const ollamaSettings = await visit(
          "settings survives background discovery failure",
          "GET",
          "/api/settings",
        );
        assert.equal(
          ollamaSettings.providers.find((value) => value.id === ollama.id).name,
          "Updated Ollama",
        );
        await visit("delete Ollama", "DELETE", base + "/" + ollama.id, {
          status: 204,
        });
        for (const [index, kind] of ["chatgpt", "grok"].entries()) {
          const id = index
            ? "44444444-4444-4444-8444-444444444444"
            : "33333333-3333-4333-8333-333333333333";
          await visit("create " + kind, "POST", base, {
            json: {
              ...provider,
              id,
              name: kind,
              kind,
              initialAccount: { ...account, id },
              protectedApiKey: null,
            },
            status: 201,
          });
          await visit("duplicate " + kind, "POST", base, {
            json: {
              ...provider,
              name: "duplicate",
              kind,
              initialAccount: account,
            },
            status: 409,
          });
          await visit("delete signed-out " + kind, "DELETE", base + "/" + id, {
            status: 204,
          });
        }
        // Actual constraint failure: retain the complete query context rather
        // than treating all conflict responses as interchangeable.
        const retainedAccountProvider = {
          ...provider,
          id: "33333333-3333-4333-8333-333333333333",
          kind: "chatgpt",
          initialAccount: account,
          protectedApiKey: null,
        };
        await visit("create account before collision", "POST", base, {
          json: retainedAccountProvider,
          status: 201,
        });
        const accountFailure = await visit(
          "initial account collision rolls back provider",
          "POST",
          base,
          {
            json: {
              ...retainedAccountProvider,
              id: "44444444-4444-4444-8444-444444444444",
              kind: "grok",
              name: "Account rollback target",
            },
            status: 409,
          },
        );
        if (kind === "node")
          assert.ok(
            accountFailure.error.startsWith(
              'Failed query: insert into "model_provider_accounts" ',
            ),
            "reference failure must reach the account insert",
          );
        const collision = await visit(
          "account collision retained state",
          "GET",
          "/api/settings",
        );
        assert.equal(
          collision.providers.some(
            (value) => value.id === "44444444-4444-4444-8444-444444444444",
          ),
          false,
          "provider insert rolls back when its account insert fails",
        );
        assert.equal(
          collision.providers.find(
            (value) => value.id === retainedAccountProvider.id,
          ).accounts[0].id,
          account.id,
        );
        await visit(
          "delete retained account provider",
          "DELETE",
          base + "/" + retainedAccountProvider.id,
          { status: 204 },
        );
        await visit("create before duplicate ID", "POST", base, {
          json: provider,
          status: 201,
        });
        await visit("duplicate identifier", "POST", base, {
          json: provider,
          status: 409,
        });
        await visit("retained duplicate transaction", "GET", "/api/settings");
        const zai = {
          ...provider,
          id: "66666666-6666-4666-8666-666666666666",
          name: "Built-in Zai",
          baseUrl: "https://api.z.ai/api/v1",
        };
        await visit("create built-in provider", "POST", base, {
          json: zai,
          status: 201,
        });
        const hydrated = await visit(
          "settings hydrates built-in catalog",
          "GET",
          "/api/settings",
        );
        assert.ok(
          hydrated.models.length > 0,
          "real built-in catalog creates usable models",
        );
        for (const model of hydrated.models.filter(
          (model) => model.discoveryManaged,
        )) {
          assert.match(
            model.id,
            /^discovered:model:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          assert.equal(
            model.routes[0].id,
            model.id.replace("discovered:model:", "discovered:route:"),
            "discovered route retains its model UUID",
          );
        }
        assert.equal(
          hydrated.preferences.defaultModelId,
          hydrated.models.find((model) => model.name === "glm-5.3").id,
          "default model refers to the bundled preferred model",
        );
        await visit(
          "built-in models prevent deletion",
          "DELETE",
          base + "/" + zai.id,
          { status: 409 },
        );
        await visit("create linked model", "POST", "/api/settings/models", {
          json: {
            name: "Provider mutation fixture",
            routes: [{ providerId: provider.id, modelName: "fixture-native" }],
          },
          status: 201,
        });
        result.events.push(
          ...live.history
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
            })),
        );
        await live.close();
        live = undefined;
        await fixture.close();
        repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
        await repository.seed(
          "CREATE FUNCTION provider_management_update_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='forced update failure' THEN RAISE EXCEPTION 'intentional provider update failure'; END IF; RETURN NEW; END $$",
        );
        await repository.seed(
          "CREATE TRIGGER provider_management_update_failure BEFORE UPDATE ON model_providers FOR EACH ROW EXECUTE FUNCTION provider_management_update_failure()",
        );
        await repository.seed(
          "CREATE FUNCTION provider_management_detach_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional runtime detach failure'; END $$",
        );
        await repository.seed(
          // Target provider detachment's actual thread-ID write. Startup's
          // independent status-only recovery must still execute normally.
          "CREATE TRIGGER provider_management_detach_failure BEFORE UPDATE OF codex_thread_id ON chat_runtime_sessions FOR EACH STATEMENT EXECUTE FUNCTION provider_management_detach_failure()",
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        await visit(
          "actual failed provider update",
          "PATCH",
          base + "/" + provider.id,
          {
            json: {
              ...update,
              name: "forced update failure",
              protectedApiKey: policyEnvelope,
            },
            status: 409,
          },
        );
        const rolledBack = await visit(
          "failed update retained state",
          "GET",
          "/api/settings",
        );
        assert.equal(
          rolledBack.providers.find((value) => value.id === provider.id).name,
          "Fixture Provider",
        );
        await visit(
          "actual failed runtime detach",
          "PATCH",
          base + "/" + provider.id,
          {
            json: { ...update, name: "committed before detach failure" },
            status: 409,
          },
        );
        const committed = await visit(
          "provider write precedes detach failure",
          "GET",
          "/api/settings",
        );
        assert.equal(
          committed.providers.find((value) => value.id === provider.id).name,
          "committed before detach failure",
        );
        await visit(
          "linked models prevent deletion",
          "DELETE",
          base + "/" + provider.id,
          { status: 409 },
        );
        await live.ping("provider management completed");
        result.events.push(
          ...live.history
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
            })),
        );
        await live.close();
        live = undefined;
        await fixture.close();
        await fixture.start();
        await visit("reopened settings", "GET", "/api/settings");
        if (databaseMode === "postgres") {
          const shutdownId = "77777777-7777-4777-8777-777777777777";
          await visit("create shutdown provider", "POST", base, {
            json: {
              ...provider,
              id: shutdownId,
              name: "Shutdown fixture",
              protectedApiKey: null,
            },
            status: 201,
          });
          result.shutdown = {};
          await providerManagementShutdown(
            fixture,
            mode === "accounts"
              ? fixture.records.get("session").currentUser.id
              : "00000000-0000-0000-0000-000000000001",
            shutdownId,
            result.shutdown,
          );
          await fixture.start();
          const retained = await visit(
            "post-shutdown retained provider",
            "GET",
            "/api/settings",
          );
          assert.equal(
            retained.providers.find((value) => value.id === shutdownId).name,
            "shutdown retained write",
          );
        }
      } finally {
        await live?.close();
        await fixture.close();
        await repository?.close();
      }
    }
    assert.deepEqual(
      profile.runtimes[1].observations,
      profile.runtimes[0].observations,
      mode + " provider management HTTP parity",
    );
    assert.deepEqual(
      profile.runtimes[1].events,
      profile.runtimes[0].events,
      mode + " provider management Live parity",
    );
    if (databaseMode === "postgres")
      assert.deepEqual(
        profile.runtimes[1].shutdown,
        profile.runtimes[0].shutdown,
        mode + " actual provider mutation shutdown parity",
      );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await postgresOwner?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
