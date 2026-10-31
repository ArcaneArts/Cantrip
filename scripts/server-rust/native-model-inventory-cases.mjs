import assert from "node:assert/strict";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { literal, json, label, otherOwner } from "./project-target-state.mjs";
export async function runNativeModelInventoryCases(h) {
  const { owner, seed, observe, snapshot } = h;
  const call = async (name, request, options = {}) => {
    const result = await observe(
      name,
      { chat: "chat", input: request },
      {
        op: "native-command-settings-model-inventory",
        shape: "raw",
        ...options,
      },
    );
    for (const value of result)
      assert.equal(
        JSON.stringify(value).includes("Private provider label"),
        false,
        "inventory excludes provider/account objects",
      );
    return result;
  };
  const request = (
    providerId = "inventory-provider",
    workerId = "alpha",
    providerAccountId = null,
  ) => ({ workerId, providerId, providerAccountId });
  await seed(inventorySeed(owner));
  for (const worker of ["alpha", "beta", "�", "\ud800"]) {
    const result = await call(
      "worker scoped Ollama inventory " + JSON.stringify(worker),
      request(undefined, worker),
    );
    for (const r of result) {
      assert.ok(r.models.some((m) => m.name === "Custom"));
      assert.equal(
        r.models.some((m) => m.name === "Zebra"),
        false,
      );
    }
  }
  await seed(
    "INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,state) VALUES('inventory-utf16','inventory-provider-catalog-1','replacement-worker','�','available')",
  );
  const replacement = await call(
    "actual replacement worker inventory",
    request(undefined, "�"),
  );
  for (const r of replacement)
    assert.ok(r.models.some((m) => m.name === "éclair"));
  const surrogate = await call(
    "original UTF16 worker identity is not its SQL encoding",
    request(undefined, "\ud800"),
  );
  for (const r of surrogate)
    assert.equal(
      r.models.some((m) => m.name === "éclair"),
      false,
    );
  for (const [name, input, options] of [
    ["missing provider", request("missing"), {}],
    ["another owner", request(), { requestOwner: otherOwner }],
    [
      "unexpected non-account scope",
      request(undefined, "alpha", "account"),
      {},
    ],
  ]) {
    const result = await call(name, input, options);
    for (const r of result) assert.equal(r, null);
  }
  await seed(
    inventorySeed(owner, {
      id: "inventory-router",
      kind: "openai-compatible",
      base: "https://OPENROUTER.AI/path",
    }),
  );
  let router = await call(
    "OpenRouter without global availability",
    request("inventory-router"),
  );
  for (const r of router)
    assert.deepEqual(
      r.models.map((m) => m.name),
      ["Custom"],
    );
  await seed(
    "INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,state) VALUES('inventory-router-global','inventory-router-catalog-1','openrouter:global',NULL,'available')",
  );
  router = await call(
    "exact OpenRouter global scope",
    request("inventory-router"),
  );
  for (const r of router) assert.ok(r.models.some((m) => m.name === "éclair"));
  await seed(
    inventorySeed(owner, {
      id: "inventory-subdomain",
      kind: "openai-compatible",
      base: "https://sub.openrouter.ai/",
    }),
  );
  const sub = await call(
    "compatible subdomain keeps source discovery behavior",
    request("inventory-subdomain"),
  );
  for (const r of sub) assert.ok(r.models.some((m) => m.name === "Zebra"));
  for (const kind of ["chatgpt", "grok"]) {
    const provider = "inventory-" + kind,
      account = provider + "-account",
      other = provider + "-other";
    await seed(inventorySeed(owner, { id: provider, kind }));
    await seed(
      `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,enabled,position) VALUES(${literal(account)},${literal(provider)},${json(label("chat").protectedLabel)},${literal(account)},true,0),(${literal(other)},${literal(provider)},${json(label("chat").protectedLabel)},${literal(other)},false,1)`,
    );
    for (const id of [null, "absent", other]) {
      const r = await call(
        kind + " rejects unavailable account " + id,
        request(provider, "alpha", id),
      );
      for (const value of r) assert.equal(value, null);
    }
    const custom = await call(
      kind + " inventory is not an execution or sign-in grant",
      request(provider, "alpha", account),
    );
    for (const r of custom)
      assert.deepEqual(
        r.models.map((m) => m.name),
        ["Custom"],
      );
    await seed(
      `UPDATE provider_model_availability SET provider_account_id=${literal(account)} WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_id=${literal(provider)})`,
    );
    const scoped = await call(
      kind + " worker/account scoped model availability",
      request(provider, "alpha", account),
    );
    for (const r of scoped)
      assert.ok(r.models.some((m) => m.name === "éclair"));
    await seed(
      `INSERT INTO provider_model_availability(id,provider_model_id,scope_key,provider_account_id,worker_id,state) VALUES(${literal(provider + "-global")},${literal(provider + "-catalog-1")},'server-account',${literal(account)},NULL,'unavailable')`,
    );
    const global = await call(
      kind + " server-wide account observation takes priority",
      request(provider, "alpha", account),
    );
    for (const r of global)
      assert.equal(
        r.models.some((m) => m.name === "éclair"),
        false,
      );
    const otherWorker = await call(
      kind + " account availability does not leak across workers",
      request(provider, "beta", account),
    );
    for (const r of otherWorker)
      assert.deepEqual(
        r.models.map((m) => m.name),
        ["Custom"],
      );
  }
  await snapshot(
    "native model inventory leaves durable execution state untouched",
  );
}
