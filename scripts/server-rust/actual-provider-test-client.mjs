// Existing encrypted browser SDK -> server -> unchanged full worker -> native
// Codex -> strict owned CONNECT proxy and trusted local HTTPS model boundary.
import assert from "node:assert/strict";

export async function actualProviderTestClient({
  page,
  fixture,
  workerId,
  startWorker,
  stopWorker,
  result,
  requests,
  boundary,
}) {
  // Install the controlled outbound TLS route only for this feature's worker
  // lifetime, after the original MCP HTTP/discovery assertions have completed.
  await stopWorker();
  await startWorker(undefined, { providerTest: true });
  const providerId = await page.evaluate(
    async ({ baseUrl, apiKey, workerId }) => {
      const models = await import("/src/lib/api/models.ts");
      const provider = await models.createModelProvider({
        name: "Disposable native Z.ai connection check",
        kind: "openai-compatible",
        baseUrl,
        apiKey,
      });
      await models.createModelProfile({
        name: "Disposable native Z.ai model",
        routes: [
          { providerId: provider.id, modelName: "glm-5.3", enabled: true },
        ],
      });
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
      return provider.id;
    },
    { baseUrl: boundary.baseUrl, apiKey: boundary.apiKey, workerId },
  );
  const credentialSummary = () =>
    page.evaluate(async (providerId) => {
      const provider = (
        await (await import("/src/lib/api-client.ts")).request("/api/settings")
      ).providers.find((p) => p.id === providerId);
      return {
        id: provider.id,
        hasApiKey: provider.hasApiKey,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
      };
    }, providerId);
  const originalCredential = await credentialSummary();
  assert.equal(
    originalCredential.hasApiKey,
    true,
    "public summaries report credential availability without exposing the envelope",
  );
  for (const restart of [false, true]) {
    if (restart) {
      const port = Number(new URL(fixture.server.origin).port);
      await stopWorker();
      await fixture.close();
      await fixture.start({ port });
      await startWorker(undefined, { providerTest: true });
    }
    boundary.reply({});
    const started = Date.now();
    const probe = await page.evaluate(
      async ({ providerId, workerId }) =>
        (await import("/src/lib/api/models.ts")).testModelProviderConnection(
          providerId,
          workerId,
        ),
      { providerId, workerId },
    );
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.stage, "completed");
    assert.equal(probe.workerId, workerId);
    assert.equal(probe.modelName, "glm-5.3");
    assert.ok(
      Number.isInteger(probe.durationMs) &&
        probe.durationMs >= 0 &&
        probe.durationMs <= Date.now() - started + 100,
    );
    const summary = await page.evaluate(async () =>
      (await import("/src/lib/api-client.ts")).request(
        "/api/desktop-update/active-work",
      ),
    );
    assert.deepEqual(Object.keys(summary).sort(), [
      "activeChats",
      "backgroundJobs",
      "queuedPrompts",
      "terminalServices",
    ]);
    for (const value of Object.values(summary))
      assert.ok(
        Number.isSafeInteger(value) && value >= 0 && value <= 4294967295,
      );
    assert.deepEqual(
      await credentialSummary(),
      originalCredential,
      "provider identity and credential availability survive probes and actual restart",
    );
  }
  for (const rejected of [true, false]) {
    const started = Date.now();
    boundary.reply(
      rejected
        ? {
            status: 401,
            message: "401 Unauthorized controlled provider key",
            repeat: true,
          }
        : {},
    );
    const probe = await page.evaluate(
      async ({ providerId, workerId }) =>
        (await import("/src/lib/api/models.ts")).testModelProviderConnection(
          providerId,
          workerId,
        ),
      { providerId, workerId },
    );
    assert.ok(
      Number.isSafeInteger(probe.durationMs) &&
        probe.durationMs >= 0 &&
        probe.durationMs <= Date.now() - started + 100,
    );
    (result.nativeProviderProbeResults ??= []).push({
      ...probe,
      durationMs: "<checked production duration>",
    });
    if (rejected) boundary.clearReply();
    assert.equal(probe.ok, !rejected, JSON.stringify(probe));
    assert.equal(probe.stage, rejected ? "key-authentication" : "completed");
    assert.equal(probe.modelName, "glm-5.3");
    assert.equal(probe.workerId, workerId);
    assert.deepEqual(await credentialSummary(), originalCredential);
  }
  const posts = boundary.requests.filter((r) => r.method === "POST");
  const rejectedPosts = posts.filter((p) => p.responseStatus === 401);
  assert.equal(
    rejectedPosts.length,
    6,
    "actual bundled Codex authentication retry count from the Source probe",
  );
  assert.equal(posts.filter((p) => p.responseStatus === 200).length, 3);
  assert.equal(posts.length, 9);
  assert.equal(boundary.tunnels.length, 9);
  assert.deepEqual(boundary.failures, []);
  for (const request of posts) {
    assert.equal(request.authenticated, true);
    assert.equal(request.completed, true);
    assert.ok(JSON.stringify(request.input).includes("Reply with exactly OK."));
  }
  assert.equal(
    JSON.stringify(requests).includes(boundary.apiKey),
    false,
    "provider key remains opaque in browser/server HTTP",
  );
  assert.equal(
    fixture.server.diagnostics().includes(boundary.apiKey),
    false,
    "provider key stays out of server diagnostics",
  );
  result.providerConnectionSummary = {
    nativeProviderRequests: posts.length,
    nativeAuthenticationFailureAndRecovery: true,
    trustedLocalTls: true,
    opaqueProviderCredential: true,
    retainedAfterServerWorkerRestart: true,
    actualDesktopSummary: true,
  };
  result.steps.push(
    "existing browser provider-test SDK uses opaque credentials through the full worker and real Codex over verified local TLS, retains success after server/worker restart and reads actual desktop update state",
  );
}
