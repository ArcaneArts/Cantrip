import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import {
  catalogProvider,
  catalogLargeCount,
  catalogPrivateMarker,
} from "./catalog-provider.mjs";

// Settings reads start real background catalog refreshes. A duplicate complete
// observation may finish after the explicit caller. Preserve every identity and
// data field, while requiring observation clocks to move only forwards.
function assertRetained(actual, expected, key = "") {
  if (
    typeof expected === "string" &&
    key.endsWith("At") &&
    key !== "createdAt"
  ) {
    assert.ok(
      typeof actual === "string" &&
        Number.isFinite(Date.parse(actual)) &&
        Date.parse(actual) >= Date.parse(expected),
      key,
    );
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++)
      assertRetained(actual[i], expected[i]);
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const field of Object.keys(expected))
      assertRetained(actual[field], expected[field], field);
  } else assert.deepEqual(actual, expected, key);
}

export async function actualProviderCatalogClient({
  page,
  fixture,
  root,
  dataDirectory,
  workerId,
  cliBinary,
  startWorker,
  stopWorker,
  requests,
  result,
}) {
  const provider = await catalogProvider();
  const report = (result.providerCatalog = {
    snapshots: [],
    providerRequests: provider.requests,
    trapRequests: provider.trapRequests,
    failures: provider.failures,
  });
  const roles = {},
    idMap = new Map();
  const secondaryId = "catalog-secondary-worker";
  let secondary;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const profiles = (role) =>
    page.evaluate(async (id) => {
      const settings = await (
        await import("/src/lib/api/settings.ts")
      ).getSettings();
      return settings.models.filter((model) =>
        model.routes.some((route) => route.providerId === id),
      );
    }, roles[role].id);
  const refresh = (role, worker = workerId) =>
    page.evaluate(
      async ({ id, worker }) =>
        (await import("/src/lib/api/models.ts")).refreshProviderModelCatalog(
          id,
          worker,
        ),
      { id: roles[role].id, worker },
    );
  const state = (catalog, worker = workerId) =>
    catalog.syncStates.find((s) => s.scopeKey === `worker:${worker}`);
  const available = (catalog, name, worker = workerId) => {
    const model = catalog.models.find((m) => m.nativeModelId === name);
    assert.ok(model, name);
    return catalog.availability.find(
      (a) => a.providerModelId === model.id && a.workerId === worker,
    );
  };
  const grant = (id) =>
    page.evaluate(async (workerId) => {
      const { clientEncryption } =
        await import("/src/lib/client-encryption.ts");
      const snapshot = clientEncryption.getSnapshot();
      await (
        await import("/src/lib/worker-encryption-grants.ts")
      ).authorizeWorkerEncryption({
        components: ["provider-credential"],
        identity: snapshot.identity,
        keyRevision: snapshot.masterKeyRevision,
        workerId,
      });
      await (
        await import("/src/lib/api/worker-wire.ts")
      ).refreshWorkerEncryption(workerId, {
        component: "provider-credential",
        keyRevision: snapshot.masterKeyRevision,
      });
    }, id);
  const create = async (role, kind) => {
    roles[role] = await page.evaluate(
      async ({ name, kind, baseUrl, apiKey }) =>
        (await import("/src/lib/api/models.ts")).createModelProvider({
          name,
          kind,
          baseUrl,
          apiKey,
        }),
      {
        name: `Owned ${role} catalog`,
        kind,
        baseUrl: provider.baseUrl(role),
        apiKey: provider.key,
      },
    );
    idMap.set(roles[role].id, `provider:${role}`);
    await grant(workerId);
  };
  const normalize = (value, key = "") => {
    if (typeof value === "string") {
      if (key.endsWith("At")) {
        assert.ok(Number.isFinite(Date.parse(value)), key);
        return "<checked timestamp>";
      }
      if (key === "description")
        return { sha256: digest(value), bytes: Buffer.byteLength(value) };
      return idMap.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
      );
    return value;
  };
  const record = async (role, label, catalog) => {
    const models = await profiles(role);
    for (const m of catalog.models)
      idMap.set(m.id, `catalog:${role}:${m.nativeModelId}`);
    for (const a of catalog.availability)
      idMap.set(
        a.id,
        `availability:${idMap.get(a.providerModelId)}:${a.scopeKey}`,
      );
    for (const s of catalog.syncStates)
      idMap.set(s.id, `sync:${role}:${s.scopeKey}`);
    for (const m of models) {
      const route = m.routes.find((r) => r.providerId === roles[role].id);
      const tag = `profile:${role}:${route.modelName}:${m.operation}:${m.discoveryManaged ? "managed" : "explicit"}`;
      idMap.set(m.id, tag);
      for (const r of m.routes) idMap.set(r.id, `route:${tag}:${r.modelName}`);
    }
    const compact = normalize({
      ...catalog,
      models: [...catalog.models].sort((a, b) =>
        a.nativeModelId.localeCompare(b.nativeModelId),
      ),
      availability: [...catalog.availability].sort((a, b) =>
        `${idMap.get(a.providerModelId)}:${a.scopeKey}`.localeCompare(
          `${idMap.get(b.providerModelId)}:${b.scopeKey}`,
        ),
      ),
      syncStates: [...catalog.syncStates].sort((a, b) =>
        a.scopeKey.localeCompare(b.scopeKey),
      ),
      profiles: [...models].sort((a, b) =>
        idMap.get(a.id).localeCompare(idMap.get(b.id)),
      ),
    });
    report.snapshots.push({ role, label, value: compact });
    console.error(
      "Actual provider catalog:",
      label,
      "models",
      catalog.models.length,
      "profiles",
      models.length,
    );
    return models;
  };
  const stopSecondary = async () => {
    if (!secondary) return;
    const current = secondary;
    secondary = undefined;
    try {
      result.workerStops.push(await current.close());
    } finally {
      result.workerDiagnostics.push(current.diagnostics());
    }
  };
  try {
    await create("paged", "openai-compatible");
    const seed = await refresh("paged");
    assert.equal(state(seed).status, "current");
    assert.equal(seed.models.length, 3);
    const initial = await record("paged", "seed", seed);
    assert.deepEqual(initial.map((m) => m.operation).sort(), [
      "decision",
      "embedding",
      "language",
    ]);

    const held = provider.select("paged", "large", { hold: true });
    const before = await profiles("paged");
    await page.evaluate(
      async ({ id, workerId }) => {
        window.catalogHeld = (await import("/src/lib/api/models.ts"))
          .refreshProviderModelCatalog(id, workerId)
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({
              ok: false,
              message: error.message,
              code: error.code,
            }),
          );
      },
      { id: roles.paged.id, workerId },
    );
    let large;
    try {
      await eventually(
        () => held.entered,
        (entered) => assert.equal(entered, true),
      );
      assert.deepEqual(
        await profiles("paged"),
        before,
        "a partial provider response cannot reconcile or delete catalog profiles",
      );
    } finally {
      held.release();
    }
    const completed = await page.evaluate(() => window.catalogHeld);
    assert.equal(completed.ok, true, completed.message);
    large = completed.value;
    assert.equal(large.models.length, catalogLargeCount);
    assert.equal(large.servedStale, false);
    assert.equal(state(large).status, "current");
    assert.ok(
      large.models.reduce(
        (bytes, model) => bytes + Buffer.byteLength(model.description ?? ""),
        0,
      ) >
        4 * 1024 * 1024,
    );
    assert.equal(
      provider.requests.filter(
        (r) => r.group === "paged" && r.phase === "large",
      ).length,
      5,
    );
    const largeProfiles = await record("paged", "large", large);
    assert.equal(largeProfiles.length, catalogLargeCount);
    for (const original of initial)
      assert.equal(
        largeProfiles.find((m) => m.id === original.id)?.operation,
        original.operation,
      );
    result.steps.push(
      "full worker follows five provider pages and transfers a snapshot above the legacy model/byte bounds without reconciling a partial catalog",
    );

    for (const mode of ["failure", "foreign", "loop"]) {
      provider.select("paged", mode);
      const failed = await refresh("paged");
      assert.equal(failed.servedStale, true);
      assert.equal(state(failed).status, "stale");
      assert.equal(state(failed).error, "endpoint-catalog-refresh-failed");
      assertRetained(
        state(failed).lastSuccessAt,
        state(large).lastSuccessAt,
        "lastSuccessAt",
      );
      assertRetained(failed.models, large.models);
      assertRetained(failed.availability, large.availability);
      assertRetained(await profiles("paged"), largeProfiles);
      await record("paged", mode, failed);
    }
    assert.deepEqual(provider.trapRequests, []);
    provider.select("paged", "small");
    const recovered = await refresh("paged");
    assert.equal(recovered.servedStale, false);
    assert.equal(state(recovered).status, "current");
    assert.equal(recovered.models.length, catalogLargeCount);
    assert.equal(
      recovered.availability.filter(
        (a) => a.workerId === workerId && a.state === "available",
      ).length,
      3,
    );
    assert.equal(available(recovered, "paged-0003").state, "unavailable");
    await record("paged", "recovered-small", recovered);
    result.steps.push(
      "failed, cross-origin and repeating provider continuations retain prior identities and data; a complete later catalog alone marks unseen models unavailable",
    );

    await create("studio", "lm-studio");
    const studio = await refresh("studio");
    assert.equal(studio.models.length, 3);
    assert.equal(state(studio).status, "current");
    assert.equal(
      studio.models.find((m) => m.nativeModelId === "studio-common")
        .contextWindow,
      4096,
    );
    await record("studio", "native-complete", studio);
    provider.select("studio", "partial");
    const partial = await refresh("studio");
    assert.equal(partial.servedStale, true);
    assert.equal(state(partial).status, "stale");
    assert.equal(state(partial).error, "endpoint-native-metadata-unavailable");
    assertRetained(
      state(partial).lastSuccessAt,
      state(studio).lastSuccessAt,
      "lastSuccessAt",
    );
    assert.equal(partial.models.length, 4);
    assert.equal(
      partial.models.find((m) => m.nativeModelId === "studio-common")
        .contextWindow,
      1024,
      "a valid prefix of a malformed native overlay must not commit",
    );
    for (const id of ["studio-embedding", "studio-decision"]) {
      assertRetained(
        partial.models.find((m) => m.nativeModelId === id),
        studio.models.find((m) => m.nativeModelId === id),
      );
      assertRetained(available(partial, id), available(studio, id));
    }
    await record("studio", "native-partial", partial);
    provider.select("studio", "complete");
    const studioComplete = await refresh("studio");
    assert.equal(state(studioComplete).status, "current");
    assert.equal(studioComplete.servedStale, false);
    assert.equal(
      available(studioComplete, "studio-embedding").state,
      "unavailable",
    );
    await record("studio", "native-recovered", studioComplete);
    result.steps.push(
      "LM Studio native overlay failure is atomic and preserves missing native models until an authoritative complete observation",
    );

    await create("gateway", "litellm");
    const gateway = await refresh("gateway");
    assert.equal(gateway.models.length, 3);
    const hybrid = gateway.models.find(
      (m) => m.nativeModelId === "public-hybrid",
    );
    assert.equal(hybrid.operationCapabilities.embedding.status, "supported");
    assert.equal(hybrid.operationCapabilities.embedding.maxInputTokens, 1024);
    assert.equal(hybrid.operationCapabilities.decision.status, "supported");
    assert.equal(hybrid.operationCapabilities.language.status, "unknown");
    const gatewayProfiles = await record(
      "gateway",
      "gateway-complete",
      gateway,
    );
    const operations = (models, name) =>
      models
        .filter((m) => m.routes.some((r) => r.modelName === name))
        .map((m) => m.operation)
        .sort();
    assert.deepEqual(operations(gatewayProfiles, "public-hybrid"), [
      "decision",
      "embedding",
    ]);
    assert.deepEqual(operations(gatewayProfiles, "public-image"), []);
    assert.deepEqual(operations(gatewayProfiles, "public-legacy"), [
      "language",
    ]);
    provider.select("gateway", "partial");
    const gatewayPartial = await refresh("gateway");
    assert.equal(gatewayPartial.servedStale, true);
    assert.equal(
      state(gatewayPartial).error,
      "endpoint-native-metadata-unavailable",
    );
    assertRetained(
      gatewayPartial.models.find((m) => m.nativeModelId === "public-hybrid")
        .operationCapabilities,
      hybrid.operationCapabilities,
    );
    const partialProfiles = await record(
      "gateway",
      "gateway-partial",
      gatewayPartial,
    );
    assert.deepEqual(operations(partialProfiles, "public-hybrid"), [
      "decision",
      "embedding",
    ]);
    provider.select("gateway", "complete");
    const gatewayComplete = await refresh("gateway");
    assert.equal(gatewayComplete.servedStale, false);
    await record("gateway", "gateway-recovered", gatewayComplete);
    result.steps.push(
      "LiteLLM exposes public aliases, conservative capabilities and operation-specific profiles without leaking private deployment metadata or regressing partial scopes",
    );

    await create("unsloth", "unsloth");
    const unsloth = await refresh("unsloth");
    const unslothProfiles = await record(
      "unsloth",
      "studio-all-operations",
      unsloth,
    );
    assert.deepEqual(operations(unslothProfiles, "studio-image-task"), []);
    assert.deepEqual(operations(unslothProfiles, "studio-native-decision"), [
      "decision",
    ]);
    assert.equal(
      unsloth.models.find((m) => m.nativeModelId === "studio-native-decision")
        .operationCapabilities.decision.adapter,
      "system-one",
    );
    result.steps.push(
      "Unsloth discovery requests all operations and does not turn unclassified non-language tasks into language models",
    );

    await create("scope", "openai-compatible");
    const scopeA = await refresh("scope");
    const autoLanguage = (await record("scope", "scope-language", scopeA)).find(
      (m) => m.discoveryManaged && m.operation === "language",
    );
    assert.ok(autoLanguage);
    const explicit = await page.evaluate(async (providerId) => {
      const model = await (
        await import("/src/lib/api/models.ts")
      ).createModelProfile({
        name: "Owned explicit language profile",
        operation: "language",
        routes: [{ providerId, modelName: "shared-scope", enabled: true }],
      });
      await (
        await import("/src/lib/api/settings.ts")
      ).updateSettings({ defaultModelId: model.id });
      return model;
    }, roles.scope.id);
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await import("/src/lib/api/settings.ts")).getSettings())
            .preferences.defaultModelId,
      ),
      explicit.id,
    );
    const enrollment = await page.evaluate(
      async (workerId) =>
        (await import("/src/lib/api/workers.ts")).createWorkerEnrollmentCode({
          label: workerId,
        }),
      secondaryId,
    );
    provider.select("scope", "embedding");
    secondary = launchActualWorker(
      fixture.workerFixture ?? fixture,
      path.join(root, fixture.kind, "catalog-secondary", "worker"),
      { workerId: secondaryId, cliBinary, enrollmentCode: enrollment.code },
    );
    await secondary.ready();
    if (fixture.workerFixture) await fixture.assertRemoteWorker(secondaryId);
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === secondaryId)?.online,
          true,
        ),
    );
    await grant(secondaryId);
    // Finish explicit observations on this worker before comparing scopes.
    // This also resolves its real reconnect-triggered catalog refreshes.
    for (const role of Object.keys(roles)) {
      if (role !== "scope")
        assert.equal(
          state(await refresh(role, secondaryId), secondaryId).status,
          "current",
        );
    }
    const scopeB = await refresh("scope", secondaryId);
    assert.deepEqual(
      available(scopeB, "shared-scope", workerId),
      available(scopeA, "shared-scope", workerId),
    );
    assert.equal(
      available(scopeB, "shared-scope", secondaryId).operationCapabilities
        .embedding.status,
      "supported",
    );
    assert.equal(
      available(scopeB, "shared-scope", secondaryId).operationCapabilities
        .language.status,
      "unsupported",
    );
    const crossProfiles = await record("scope", "scope-embedding", scopeB);
    assert.equal(
      crossProfiles.find((m) => m.id === autoLanguage.id)?.operation,
      "language",
    );
    assert.equal(
      crossProfiles.find((m) => m.id === explicit.id)?.operation,
      "language",
    );
    const embedding = crossProfiles.find(
      (m) => m.discoveryManaged && m.operation === "embedding",
    );
    assert.ok(embedding);
    assert.notEqual(embedding.id, autoLanguage.id);
    const inferred = await page.evaluate(
      async ({ workerId, modelId, routeId }) =>
        (await import("/src/lib/api/model-operations.ts")).embed({
          workerId,
          modelId,
          routeId,
          items: [
            {
              id: "catalog-item",
              content: [{ type: "text", text: "Owned catalog inference" }],
            },
          ],
        }),
      {
        workerId: secondaryId,
        modelId: embedding.id,
        routeId: embedding.routes[0].id,
      },
    );
    assert.equal(inferred.space.modelId, embedding.id);
    assert.deepEqual(inferred.items[0].values, [0.25, -0.5]);
    await eventually(
      () =>
        page.evaluate(
          async (id) =>
            (
              await (
                await import("/src/lib/api/telemetry.ts")
              ).getProviderTelemetryExport(id)
            ).tokenUsage,
          roles.scope.id,
        ),
      (rows) => {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].workerId, secondaryId);
        assert.equal(rows[0].attemptStatus, "completed");
        assert.equal(rows[0].reportedTotalTokens, 2);
      },
    );
    await stopSecondary();
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === secondaryId)?.online,
          false,
        ),
    );
    const requestCount = provider.requests.length;
    const offline = await refresh("scope", secondaryId);
    assert.equal(offline.servedStale, true);
    assert.equal(state(offline, secondaryId).error, "worker-offline");
    assert.equal(provider.requests.length, requestCount);
    await record("scope", "scope-offline", offline);
    for (const role of Object.keys(roles)) {
      if (role === "scope") continue;
      const cached = await refresh(role, secondaryId);
      assert.equal(cached.servedStale, true);
      assert.equal(state(cached, secondaryId).error, "worker-offline");
      await record(role, "secondary-offline", cached);
    }
    assert.equal(provider.requests.length, requestCount);
    provider.select("scope", "language");
    await record("scope", "scope-primary-restored", await refresh("scope"));
    result.steps.push(
      "contradictory worker-scoped observations preserve existing language and explicit profiles while a distinct discovered embedding route executes on its owning worker",
    );

    const retained = {};
    for (const role of Object.keys(roles))
      retained[role] = await page.evaluate(
        async (id) =>
          (await import("/src/lib/api/models.ts")).getProviderModelCatalog(id),
        roles[role].id,
      );
    const profileIds = {},
      retainedProfiles = {};
    for (const role of Object.keys(roles)) {
      retainedProfiles[role] = await profiles(role);
      profileIds[role] = retainedProfiles[role]
        .map((m) => [m.id, m.operation])
        .sort();
    }
    const identity = await page.evaluate(() => window.folderIdentity);
    await stopWorker();
    await fixture.restart();
    await startWorker();
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
    for (const role of Object.keys(roles)) {
      const catalog = await page.evaluate(
        async ({ id, workerId }) =>
          (await import("/src/lib/api/models.ts")).getProviderModelCatalog(
            id,
            workerId,
          ),
        { id: roles[role].id, workerId },
      );
      assert.deepEqual(
        catalog.models.map((m) => [m.id, m.nativeModelId]).sort(),
        retained[role].models.map((m) => [m.id, m.nativeModelId]).sort(),
      );
      assertRetained(catalog, retained[role]);
      assertRetained(await profiles(role), retainedProfiles[role]);
      assert.deepEqual(
        (await profiles(role)).map((m) => [m.id, m.operation]).sort(),
        profileIds[role],
      );
      await record(role, "retained-restart", catalog);
    }
    const afterIdentity = await page.evaluate(async () => ({
      serverId: (
        await (await import("/src/lib/api/account.ts")).getServerBootstrap()
      ).server.id,
      ownerId: (
        await (await import("/src/lib/api/account.ts")).getAuthSession()
      ).currentUser.id,
    }));
    assert.deepEqual(afterIdentity, identity);
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await import("/src/lib/api/settings.ts")).getSettings())
            .preferences.defaultModelId,
      ),
      explicit.id,
    );
    result.steps.push(
      "catalog row/profile identities, independent worker scopes, explicit defaults and usable metadata survive actual server and worker restart",
    );
    assert.deepEqual(provider.trapRequests, []);
    assert.deepEqual(provider.failures, []);
    for (const secret of [provider.key, catalogPrivateMarker]) {
      assert.equal(JSON.stringify(requests).includes(secret), false);
      assert.equal(JSON.stringify(report.snapshots).includes(secret), false);
      assert.ok(
        !fixture.generations.some((g) => g.diagnostics?.includes(secret)) &&
          !fixture.server.diagnostics().includes(secret),
      );
    }
    report.summary = report.snapshots;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await stopSecondary();
    await provider.close();
  }
}

// Report the first differing row, keeping diagnostics bounded for large catalogs.
// Every normalized field and every array entry still participates in equality.
export function assertProviderCatalogSummary(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    const a = actual[index],
      b = expected[index];
    assert.equal(a.role, b.role);
    assert.equal(a.label, b.label);
    assert.deepEqual(Object.keys(a.value).sort(), Object.keys(b.value).sort());
    for (const key of Object.keys(a.value)) {
      const left = a.value[key],
        right = b.value[key];
      if (Array.isArray(left)) {
        assert.ok(Array.isArray(right));
        assert.equal(
          left.length,
          right.length,
          `${a.role}/${a.label}/${key} length`,
        );
        for (let row = 0; row < left.length; row++)
          assert.deepEqual(
            left[row],
            right[row],
            `${a.role}/${a.label}/${key}/${row}`,
          );
      } else assert.deepEqual(left, right, `${a.role}/${a.label}/${key}`);
    }
  }
}
