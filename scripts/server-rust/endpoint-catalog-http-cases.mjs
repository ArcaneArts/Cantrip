import assert from "node:assert/strict";
import {
  endpointProviderKinds,
  providerDefinitions,
} from "../../packages/protocol/dist/index.js";

export async function seedEndpointCatalogProviders(repository, literal, owner) {
  for (const kind of endpointProviderKinds)
    for (const suffix of ["a", "b"])
      await repository.seed(
        "INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(" +
          [
            "catalog-endpoint-" + kind + "-" + suffix,
            owner,
            "Private endpoint label " + kind + " " + suffix,
            kind,
            "http://" + kind + "-" + suffix + ".invalid/v1",
          ]
            .map(literal)
            .join(",") +
          ")",
      );
}

export async function endpointCatalogHttpCases({
  visit,
  result,
  state,
  pendingCatalog,
  refresh,
  mode,
}) {
  result.endpointCatalogCases = [];
  // Worker readiness can refresh providers in the background. Observe every
  // initial current catalog before changing one provider's controlled reply.
  for (const kind of endpointProviderKinds)
    for (const suffix of ["a", "b"])
      await visit(
        "endpoint initial catalog " + kind + " " + suffix,
        "GET",
        pendingCatalog("catalog-endpoint-" + kind + "-" + suffix),
      );
  for (const kind of endpointProviderKinds) {
    const first = "catalog-endpoint-" + kind + "-a";
    const second = "catalog-endpoint-" + kind + "-b";
    const controlled = { loaded: false, contextWindow: 4096, fail: false };
    state.providers.set(first, controlled);
    const a = await visit(
      "endpoint first instance " + kind,
      "POST",
      refresh(first),
      { json: {} },
    );
    assert.equal(a.models.length, 1);
    assert.equal(a.models[0].nativeModelId, "shared-model");
    assert.equal(a.models[0].contextWindow, 4096);
    assert.equal(a.models[0].loaded, false);
    assert.equal(a.models[0].metadataSource, "compatible-api");
    const command = result.commands.findLast(
      (command) => command.provider.id === first,
    );
    assert.equal(command.type, "model.endpoint.catalog");
    assert.equal(command.provider.id, first);
    assert.equal(command.provider.kind, kind);
    assert.equal(command.provider.name, providerDefinitions[kind].label);
    assert.equal(command.provider.baseUrl, "http://" + kind + "-a.invalid/v1");
    assert.equal(command.provider.protectedApiKey, null);

    const b = await visit(
      "endpoint second instance " + kind,
      "GET",
      pendingCatalog(second),
    );
    assert.equal(b.models[0].contextWindow, 8192);
    assert.equal(b.models[0].loaded, true);
    assert.notEqual(a.models[0].id, b.models[0].id);
    controlled.fail = true;
    const stale = await visit(
      "endpoint failed refresh retains first instance " + kind,
      "POST",
      refresh(first),
      { json: {} },
    );
    assert.equal(stale.servedStale, true);
    assert.equal(stale.models[0].id, a.models[0].id);
    assert.equal(stale.models[0].contextWindow, 4096);
    assert.equal(stale.models[0].loaded, false);
    assert.equal(stale.syncStates[0].error, "endpoint-catalog-refresh-failed");
    const count = result.commands.length;
    const cached = await visit(
      "endpoint failure leaves second instance current " + kind,
      "GET",
      pendingCatalog(second),
    );
    assert.equal(cached.models[0].contextWindow, 8192);
    assert.equal(result.commands.length, count);
    controlled.fail = false;
    controlled.loaded = null;
    controlled.contextWindow = 8192;
    const recovered = await visit(
      "endpoint retry accepts unknown loaded state " + kind,
      "POST",
      refresh(first),
      { json: {} },
    );
    assert.equal(recovered.servedStale, false);
    assert.equal(recovered.models[0].id, a.models[0].id);
    assert.equal(recovered.models[0].contextWindow, 8192);
    assert.equal(Object.hasOwn(recovered.models[0], "loaded"), false);
    // Exercise the production transaction fence, including a late failure,
    // through real HTTP routes and worker socket replies on both servers.
    for (const oldFails of [false, true]) {
      const received = Promise.withResolvers();
      const pause = { received: received.resolve, release: undefined };
      controlled.fail = oldFails;
      controlled.contextWindow = 2048;
      controlled.pause = pause;
      const old = visit(
        `endpoint held old connection ${kind} ${oldFails}`,
        "POST",
        refresh(first),
        { json: {} },
      );
      try {
        await Promise.race([
          received.promise,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error("Old catalog request did not reach the worker"),
                ),
              5000,
            );
            timer.unref();
          }),
        ]);
        controlled.fail = false;
        controlled.contextWindow = 65536;
        const saved = await visit(
          `endpoint changes connection ${kind} ${oldFails}`,
          "PATCH",
          `/api/settings/providers/${first}`,
          {
            csrf: true,
            json: {
              name: `Updated ${kind} instance`,
              kind,
              baseUrl: `http://${kind}-new.invalid/proxy-${oldFails}/v1`,
            },
          },
        );
        assert.ok(saved.connectionRevision > 1);
        const current = await visit(
          `endpoint current connection ${kind} ${oldFails}`,
          "POST",
          refresh(first),
          { json: {} },
        );
        assert.equal(current.models[0].contextWindow, 65536);
        assert.equal(current.syncStates[0].status, "current");
        pause.release();
        const superseded = await old;
        assert.equal(superseded.models[0].contextWindow, 65536);
        assert.equal(superseded.syncStates[0].status, "current");
        assert.equal(superseded.servedStale, false);
        const sibling = await visit(
          `endpoint connection change leaves sibling ${kind} ${oldFails}`,
          "GET",
          pendingCatalog(second),
        );
        assert.equal(sibling.models[0].contextWindow, 8192);
      } finally {
        pause.release?.();
        await old.catch(() => {});
      }
    }
    if (mode === "accounts")
      await visit(
        "foreign endpoint catalog stays hidden " + kind,
        "GET",
        pendingCatalog(first),
        { client: "other", status: 404 },
      );
    result.endpointCatalogCases.push({
      kind,
      isolatedInstances: true,
      loadedStates: [false, true, null],
      staleRecovery: true,
      connectionRevisionIsolation: true,
    });
  }
}
