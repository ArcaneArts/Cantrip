import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";

export async function verifyProviderConnection({
  call,
  newProvider,
  ownerId,
  workerId,
  keyRevision,
  componentKey,
  temp,
}) {
  const id = randomUUID();
  const apiKey = "disposable-local-provider-probe-key";
  const model = await newProvider({ expectedApiKey: apiKey });
  await call("POST", "/api/settings/providers", 201, {
    id,
    name: "Local provider probe fixture",
    kind: "openai-compatible",
    baseUrl: model.baseUrl,
    initialAccount: null,
    protectedApiKey: await c.encryptProtectedSecret({
      ownerId,
      component: "provider-credential",
      table: "model_providers",
      rowId: id,
      field: "protected_api_key",
      keyRevision,
      componentKey,
      content: { version: 1, apiKey },
      contentSchema: p.providerApiKeyProtectedContentSchema,
      maximumBytes: 16 * 1024,
    }),
  });
  await call("POST", "/api/settings/models", 201, {
    name: "Local probe model",
    routes: [{ providerId: id, modelName: model.model, enabled: true }],
  });
  const route = "/api/settings/providers/" + id + "/test?workerId=" + workerId;
  async function run(ok, stage) {
    const result = p.providerConnectionTestResultSchema.parse(
      await call("POST", route, 200, {}),
    );
    assert.equal(result.ok, ok, JSON.stringify(result));
    assert.equal(result.stage, stage, result.message);
    assert.equal(result.workerId, workerId);
    assert.equal(result.modelName, model.model);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  }
  model.reply({ text: "OK" });
  await run(true, "completed");

  const rejected = model.reply({
    status: 401,
    error: "Invalid API key " + apiKey,
    repeat: true,
  });
  try {
    await run(false, "key-authentication");
    assert.equal(rejected.request?.completed, true);
  } finally {
    rejected.discard();
  }

  model.reply({ text: "" });
  await run(false, "provider-response");

  model.reply({ text: "OK" });
  await run(true, "completed");

  const posts = model.requests.filter(({ method }) => method === "POST");
  assert.ok(posts.length >= 4);
  for (const post of posts) {
    assert.equal(post.completed, true);
    assert.ok(JSON.stringify(post.input).includes("Reply with exactly OK."));
    const tools = modelFunctions(post.input.tools).map(({ name }) => name);
    assert.ok(
      !tools.some((name) =>
        ["exec_command", "write_stdin", "shell", "apply_patch"].includes(name),
      ),
    );
  }
  assert.deepEqual(model.failures, []);
  assert.ok(
    !(await readdir(temp)).some((name) =>
      name.startsWith("cantrip-provider-test-"),
    ),
  );
  console.log(
    JSON.stringify({
      suite: "native-provider-connection-test",
      passed: true,
      inferenceRequests: posts.length,
    }),
  );
}
