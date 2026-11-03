// Real provider probes retain endpoint labels and redact worker error details.
import assert from "node:assert/strict";
import {
  isAccountProviderKind,
  providerDefinitions,
} from "../../packages/protocol/dist/index.js";
import { literal } from "./project-target-state.mjs";
import { settingsWorker } from "./native-settings-http-fixture.mjs";

export async function runSettingsEndpointProviderHttpCases(
  h,
  visit,
  result,
  controller,
) {
  const cases = [];
  for (const [kind, definition] of Object.entries(providerDefinitions)) {
    const id = "endpoint-probe-" + kind;
    const base =
      definition.defaultBaseUrl === "https://"
        ? "http://fixture.invalid/v1"
        : definition.defaultBaseUrl;
    await h.fixture.sql([
      "INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(" +
        [id, h.owner, definition.defaultName, kind, base]
          .map(literal)
          .join(",") +
        ")",
    ]);
    if (isAccountProviderKind(kind)) {
      const response = await visit(
        "account provider retains sign-in diagnostic " + kind,
        "POST",
        "/api/settings/providers/" + id + "/test",
        { json: {}, status: 409 },
      );
      assert.equal(
        response.error,
        "Use the account's sign-in status to check this provider.",
      );
      cases.push({ kind, accountStatus: 409 });
      continue;
    }
    const model = id + "-model",
      route = id + "-route";
    await h.fixture.sql([
      "INSERT INTO model_profiles(id,owner_id,name) VALUES(" +
        [model, h.owner, "Endpoint " + kind].map(literal).join(",") +
        ")",
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES(" +
        [route, model, id, "fixture-endpoint-model", 0].map(literal).join(",") +
        ")",
    ]);
    controller.reset();
    const success = await visit(
      "endpoint provider connection " + kind,
      "POST",
      "/api/settings/providers/" + id + "/test",
      { json: {} },
    );
    assert.equal(success.ok, true);
    assert.equal(success.stage, "completed");
    assert.equal(success.workerId, settingsWorker);
    assert.equal(success.modelName, "fixture-endpoint-model");
    assert.equal(
      success.message,
      "Connected to " +
        definition.label +
        " through bundled Codex using fixture-endpoint-model.",
    );
    controller.fail("HTTP 401 sensitive-probe-secret endpoint-response-body");
    const failure = await visit(
      "endpoint provider redacted failure " + kind,
      "POST",
      "/api/settings/providers/" + id + "/test",
      { json: {} },
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.stage, "key-authentication");
    assert.equal(
      failure.message,
      definition.label + " rejected authentication. HTTP 401.",
    );
    assert.equal(
      JSON.stringify(failure).includes("sensitive-probe-secret"),
      false,
    );
    cases.push({ kind, connected: true, failureRedacted: true });
    controller.reset();
  }
  result.endpointProviderCases = cases;
}
