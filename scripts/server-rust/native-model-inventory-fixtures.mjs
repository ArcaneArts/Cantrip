import { literal } from "./project-target-state.mjs";
export const inventoryModel = {
  id: "model",
  profileName: "Profile",
  routeId: "route",
  name: "Native",
  reasoningEffort: null,
  providerModelId: null,
  catalog: null,
};
export function nativeModelInventoryWireFixtures() {
  const request = {
      workerId: "worker",
      providerId: "provider",
      providerAccountId: null,
    },
    inventory = {
      ...request,
      providerKind: "ollama",
      models: [inventoryModel],
    };
  return {
    nativeModelInventoryRequestSchema: [
      request,
      { ...request, providerAccountId: "account" },
    ],
    nativeModelInventorySchema: [
      inventory,
      { ...inventory, providerKind: "chatgpt", models: [] },
    ],
    nativeChatModelInventoryQuerySchema: [{ bindingId: "binding" }],
    nativeChatModelInventorySchema: [{ ...inventory, bindingId: "binding" }],
  };
}
export function inventorySeed(
  owner,
  {
    id = "inventory-provider",
    kind = "ollama",
    base = "http://fixture.invalid",
    worker = "alpha",
  } = {},
) {
  const sql = [
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(owner)},${literal("Private provider label " + id)},${literal(kind)},${literal(base)}) ON CONFLICT DO NOTHING`,
  ];
  for (const [n, name, enabled, discovered] of [
    [0, "Anchor", false, false],
    [1, "éclair", true, true],
    [2, "Zebra", true, true],
    [3, "Custom", true, false],
    [4, "á", true, true],
    [5, "a", true, true],
    [6, "A", true, true],
    [7, "Å", true, true],
    [8, "A", true, false],
  ]) {
    const model = id + "-model-" + n,
      route = id + "-route-" + n,
      catalog = id + "-catalog-" + n;
    sql.push(
      `INSERT INTO model_profiles(id,owner_id,name) VALUES(${literal(model)},${literal(owner)},'Public profile')`,
    );
    if (discovered)
      sql.push(
        `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source) VALUES(${literal(catalog)},${literal(id)},${literal(name)},${literal(name)},'manual') ON CONFLICT DO NOTHING`,
      );
    sql.push(
      `INSERT INTO model_routes(id,model_id,provider_id,model_name,provider_model_id,position,enabled) VALUES(${literal(route)},${literal(model)},${literal(id)},${literal(name)},${literal(discovered ? catalog : null)},${n},${enabled})`,
    );
    if (discovered)
      sql.push(
        `INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,state) VALUES(${literal(id + "-availability-" + n)},${literal(catalog)},${literal("worker:" + worker)},${literal(worker)},${literal(n === 2 ? "unavailable" : "available")})`,
      );
  }
  return sql;
}
