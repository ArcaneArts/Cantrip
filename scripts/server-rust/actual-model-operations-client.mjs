import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { modelOperationProvider } from "./model-operation-provider.mjs";
import { repositoryRoot } from "./build.mjs";

export async function actualModelOperationsClient({
  page,
  fixture,
  workerId,
  startWorker,
  stopWorker,
  crashWorker,
  workerProcessForInterruption,
  postgresOutage,
  requests,
  result,
}) {
  const provider = await modelOperationProvider();
  const marker = "Private model operation input 🍄 " + randomUUID();
  const report = (result.modelOperations = {
    cases: [],
    providerRequests: provider.requests,
    failures: provider.failures,
  });
  let setup;
  const wires = new Map();
  const requestFor = (operation) =>
    requests.findLast(
      (r) => r.pathname === `/api/model-operations/${operation}`,
    );
  const begin = async (name, operation, options = {}) => {
    console.error("Actual model operation:", name);
    const before = provider.requests.length;
    await page.evaluate(
      async ({ name, operation, options }) => {
        const api = await import("/src/lib/api/model-operations.ts");
        const state = window.modelOperationFixture;
        const controller = new AbortController();
        const selected = options.defaults
          ? { workerId: state.workerId }
          : {
              workerId: state.workerId,
              modelId: state[operation].id,
              routeId: state[operation].routes[0].id,
            };
        const content =
          operation === "embedding"
            ? {
                items: Array.from(
                  { length: options.items ?? 1 },
                  (_, index) => ({
                    id: `item-${index}`,
                    content: [
                      { type: "text", text: state.marker + " " + index },
                    ],
                  }),
                ),
                options: options.timeout
                  ? { timeoutMs: options.timeout }
                  : undefined,
                expectedSpace: options.expectedSpace,
              }
            : {
                state: { privateText: state.marker },
                questions: [
                  {
                    id: "ready",
                    type: "predicate",
                    instructions: "Is it ready?",
                  },
                  {
                    id: "action",
                    type: "choice",
                    choices: [{ id: "continue" }, { id: "stop" }],
                  },
                  {
                    id: "risk",
                    type: "score",
                    levels: [{ id: "low" }, { id: "high" }],
                  },
                ],
              };
        const job = { controller, settled: false };
        state.jobs[name] = job;
        const invoke = async () => {
          if (!options.rawDisconnect)
            return api[operation === "embedding" ? "embed" : "decide"]({
              ...selected,
              ...content,
              signal: controller.signal,
            });
          // Same public encryption and HTTP SDK, with no explicit cancel request:
          // a disconnected HTTP client alone must retire its running inference.
          const protocol = await import(state.protocolUrl);
          const { getClientSession } =
            await import("/src/lib/client-session.ts");
          const { protectEndpointContent, openEndpointContent } =
            await import("/src/lib/endpoint-content-encryption.ts");
          const { request } = await import("/src/lib/api-client.ts");
          const scope = protocol.modelOperationScopeSchema.parse(selected);
          const operationId = crypto.randomUUID();
          const context = {
            serverId: getClientSession().serverId,
            operationId,
            scope,
            operation,
          };
          const protectedRequest = await protectEndpointContent({
            context: protocol.modelOperationContentContext({
              ...context,
              direction: "request",
            }),
            content,
            schema: protocol.embeddingInputSchema,
          });
          const response = await request(
            `/api/model-operations/${operation}`,
            {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({ operationId, scope, protectedRequest }),
            },
            { allowCsrfRecovery: false },
          );
          return openEndpointContent({
            context: protocol.modelOperationContentContext({
              ...context,
              direction: "response",
            }),
            opaque: response.protectedResponse,
            schema: protocol.embeddingOutcomeSchema,
          });
        };
        job.promise = invoke()
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({
              ok: false,
              name: error.name,
              code: error.code ?? null,
              status: error.status ?? null,
              message: error.message,
            }),
          )
          .then((value) => {
            job.settled = true;
            job.result = value;
            return value;
          });
      },
      { name, operation, options },
    );
    report.cases.push({ name, operation, before });
  };
  const finish = async (name, operation, expectedPosts) => {
    const outcome = await page.evaluate(
      (name) => window.modelOperationFixture.jobs[name].promise,
      name,
    );
    const entry = report.cases.find((c) => c.name === name);
    entry.outcome = outcome;
    entry.posts = provider.requests.length - entry.before;
    assert.equal(entry.posts, expectedPosts);
    const wire = JSON.parse(requestFor(operation).body);
    wires.set(name, wire);
    entry.operationId = wire.operationId;
    assert.equal(wire.protectedRequest.domain, "model-operation-content");
    return outcome;
  };
  const rows = () =>
    page.evaluate(
      async (id) =>
        (
          await (
            await import("/src/lib/api/telemetry.ts")
          ).getProviderTelemetryExport(id)
        ).tokenUsage,
      setup.provider.id,
    );
  const receipt = async (name, expected) => {
    const wire = wires.get(name);
    const row = await eventually(rows, (rows) => {
      const matching = rows.filter(
        (row) => row.executionAttemptId === wire.operationId,
      );
      report.cases.find((c) => c.name === name).lastObservedUsage = matching;
      assert.equal(matching.length, 1);
      assert.equal(matching[0].attemptStatus, expected.status);
      assert.equal(
        matching[0].modelOperationUsage.transportStatus,
        expected.transport ?? "replied",
      );
      const value = matching[0].modelOperationUsage.receipt;
      if (expected.status === "unknown") assert.equal(value, null);
      else {
        assert.equal(value.status, expected.status);
        assert.equal(value.requests, expected.requests ?? 1);
        assert.equal(
          value.succeededRequests,
          expected.succeeded ??
            (expected.status === "completed" ? (expected.requests ?? 1) : 0),
        );
        assert.equal(value.failedRequests, expected.failed ?? 0);
        assert.equal(value.cancelledRequests, expected.cancelled ?? 0);
      }
    }).then((rows) =>
      rows.find((row) => row.executionAttemptId === wire.operationId),
    );
    assert.equal(row.turnId, null);
    assert.equal(
      row.modelId,
      setup[report.cases.find((c) => c.name === name).operation].id,
    );
    const identity = row.modelOperationUsage.identity;
    const operation = report.cases.find((c) => c.name === name).operation;
    assert.equal(identity.workerId, workerId);
    assert.equal(identity.operation, operation);
    assert.equal(identity.modelId, setup[operation].id);
    assert.equal(identity.routeId, setup[operation].routes[0].id);
    assert.equal(row.modelRouteId, setup[operation].routes[0].id);
    assert.equal(
      identity.serverId,
      await page.evaluate(() => window.folderIdentity.serverId),
    );
    assert.equal(identity.providerId, setup.provider.id);
    assert.equal(
      row.sourceKey,
      `model-operation:${JSON.stringify([identity.serverId, workerId, wire.operationId])}`,
    );
    report.cases.find((c) => c.name === name).usage = row;
    return row;
  };
  const replay = async (name, operation, code) => {
    const before = provider.requests.length;
    const value = await page.evaluate(
      async ({ operation, wire }) => {
        const { request } = await import("/src/lib/api-client.ts");
        const protocol = await import(window.modelOperationFixture.protocolUrl);
        const { getClientSession } = await import("/src/lib/client-session.ts");
        const { openEndpointContent } =
          await import("/src/lib/endpoint-content-encryption.ts");
        const result = await request(
          `/api/model-operations/${operation}`,
          { method: "POST", body: JSON.stringify(wire) },
          { allowCsrfRecovery: false },
        );
        return openEndpointContent({
          context: protocol.modelOperationContentContext({
            serverId: getClientSession().serverId,
            operationId: wire.operationId,
            scope: wire.scope,
            operation,
            direction: "response",
          }),
          opaque: result.protectedResponse,
          schema:
            operation === "embedding"
              ? protocol.embeddingOutcomeSchema
              : protocol.decisionOutcomeSchema,
        });
      },
      { operation, wire: wires.get(name) },
    );
    assert.equal(value.status, "failed");
    assert.equal(value.error.code, code);
    assert.equal(
      provider.requests.length,
      before,
      "redelivery must never submit another inference",
    );
    const retained = report.cases.find((c) => c.name === name).usage;
    assert.deepEqual(
      (await rows()).find(
        (row) => row.executionAttemptId === wires.get(name).operationId,
      ),
      retained,
    );
  };
  const exercisePostgresOutage = async () => {
    const name = "active-postgres-outage";
    const plan = provider.reply("embedding", { hold: true });
    await begin(name, "embedding", { timeout: 120_000 });
    await eventually(
      () => plan.entered,
      (entered) => assert.equal(entered, true),
    );
    const wire = JSON.parse(requestFor("embedding").body);
    const before = await eventually(rows, (current) => {
      const attempts = current.filter(
        (row) => row.executionAttemptId === wire.operationId,
      );
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attemptStatus, "running");
      assert.equal(attempts[0].modelOperationUsage.receipt, null);
    });
    const servers = (fixture.peers ?? [fixture]).map(({ server }) => server);
    const child = workerProcessForInterruption();
    assert.ok(child?.pid);
    const workerStillRunning = () => {
      assert.equal(workerProcessForInterruption(), child);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    };
    const probe = (pathname, timeout) =>
      Promise.all(
        servers.map(async ({ origin }) => {
          try {
            const response = await fetch(origin + pathname, {
              signal: AbortSignal.timeout(timeout),
            });
            return { status: response.status, body: await response.json() };
          } catch (error) {
            if (error.name !== "TimeoutError") throw error;
            return { timeoutMs: timeout };
          }
        }),
      );
    const assertDatabaseReadiness = (peer, status, code) => {
      assert.equal(peer.status, code);
      assert.equal(peer.body.database.engine, "postgres");
      assert.equal(peer.body.database.status, status);
    };
    const outage = (report.postgresOutage = {
      serverPids: servers.map(({ child }) => child.pid),
      workerPid: child.pid,
      operationId: wire.operationId,
      before,
    });
    assert.equal(plan.entry.closed, false);
    outage.stop = await postgresOutage.stop({ immediate: true });
    assert.equal(outage.stop.requestedSignal, "SIGQUIT");
    const stoppedAt = performance.now();
    try {
      outage.offline = await eventually(
        () => probe("/readyz", 5_000),
        (peers) =>
          peers.forEach((peer) =>
            assertDatabaseReadiness(peer, "unavailable", 503),
          ),
      );
      await delay(Math.max(0, 40_000 - (performance.now() - stoppedAt)));
      [outage.prolongedOffline, outage.liveness] = await Promise.all([
        probe("/readyz", 5_000),
        probe("/healthz", 5_000),
      ]);
      for (const peer of outage.liveness) {
        assert.equal(peer.status, 200);
        assert.equal(peer.body.status, "alive");
      }
      // The reference's PostgreSQL pool can still be backing off. Record that
      // timeout explicitly and keep the Rust readiness contract mandatory.
      outage.prolongedOffline.forEach((peer, index) => {
        if (
          (fixture.peers ?? [fixture])[index].kind === "node" &&
          peer.timeoutMs
        )
          return;
        assertDatabaseReadiness(peer, "unavailable", 503);
      });
      await delay(Math.max(0, 45_000 - (performance.now() - stoppedAt)));
      assert.equal(plan.entry.closed, false);
      assert.equal(plan.entry.completed, false);
      assert.equal(provider.requests.length, report.cases.at(-1).before + 1);
      workerStillRunning();
    } finally {
      outage.offlineMs = Math.round(performance.now() - stoppedAt);
      outage.restart = await postgresOutage.start();
    }
    assert.notEqual(outage.stop.pid, outage.restart.pid);
    assert.equal(outage.stop.port, outage.restart.port);
    outage.recovered = await eventually(
      () => probe("/readyz", 10_000),
      (peers) =>
        peers.forEach((peer) => assertDatabaseReadiness(peer, "ready", 200)),
      45_000,
    );
    assert.equal(plan.entry.closed, false);
    plan.release();
    assert.equal((await finish(name, "embedding", 1)).ok, true);
    await receipt(name, { status: "completed" });
    assert.deepEqual(
      (await rows()).filter(
        (row) => row.executionAttemptId !== wire.operationId,
      ),
      before.filter((row) => row.executionAttemptId !== wire.operationId),
    );
    await replay(name, "embedding", "invalid-request");
    provider.reply("decision");
    await begin("after-postgres-outage", "decision");
    assert.equal(
      (await finish("after-postgres-outage", "decision", 1)).ok,
      true,
    );
    await receipt("after-postgres-outage", { status: "completed" });
    assert.equal((await rows()).length, report.cases.length);
    for (const server of servers) {
      assert.equal(server.child.exitCode, null);
      assert.equal(server.child.signalCode, null);
    }
    workerStillRunning();
    result.steps.push(
      "the original inference survives prolonged external PostgreSQL loss, records one receipt and rejects replay after recovery",
    );
  };
  try {
    setup = await page.evaluate(
      async ({ baseUrl, apiKey, workerId, marker, protocolUrl }) => {
        const api = await import("/src/lib/api/models.ts");
        const provider = await api.createModelProvider({
          name: "Owned operation provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey,
        });
        const models = {};
        for (const operation of ["embedding", "decision"])
          models[operation] = await api.createModelProfile({
            name: `Owned ${operation}`,
            operation,
            routes: [
              {
                providerId: provider.id,
                modelName: `owned-${operation}-model`,
                enabled: true,
                operationAdapter:
                  operation === "embedding"
                    ? "openai-embeddings"
                    : "openai-decisions",
                operationOptions:
                  operation === "embedding" ? { maxBatchSize: 2 } : {},
              },
            ],
          });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultEmbeddingModelId: models.embedding.id,
          defaultDecisionModelId: models.decision.id,
        });
        window.modelOperationFixture = {
          ...models,
          provider,
          workerId,
          marker,
          protocolUrl,
          jobs: {},
        };
        return { ...models, provider };
      },
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        workerId,
        marker,
        protocolUrl: `/@fs${pathToFileURL(path.join(repositoryRoot, "packages/protocol/src/index.ts")).pathname}`,
      },
    );
    provider.reply("embedding");
    provider.reply("embedding");
    await begin("batch", "embedding", { items: 3, defaults: true });
    const batch = await finish("batch", "embedding", 2);
    assert.equal(batch.ok, true, JSON.stringify(batch));
    assert.equal(batch.value.batches, 2);
    assert.deepEqual(
      batch.value.items.map((v) => [v.id, v.index, v.values]),
      [
        ["item-0", 0, [1, 0.5, -0.25]],
        ["item-1", 1, [2, 0.5, -0.25]],
        ["item-2", 2, [1, 0.5, -0.25]],
      ],
    );
    assert.deepEqual(batch.value.usage, { inputTokens: 10, totalTokens: 10 });
    assert.equal(batch.value.space.modelId, setup.embedding.id);
    assert.equal(batch.value.space.routeId, setup.embedding.routes[0].id);
    assert.equal(batch.value.space.providerId, setup.provider.id);
    const batchRow = await receipt("batch", {
      status: "completed",
      requests: 2,
    });
    assert.equal(batchRow.reportedTotalTokens, 10);
    await replay("batch", "embedding", "invalid-request");
    result.steps.push(
      "full worker batches opaque embedding input once, returns ordered vectors and preserves its immutable terminal usage on exact replay",
    );

    provider.reply("embedding");
    await begin("pinned", "embedding", { expectedSpace: batch.value.space });
    const pinned = await finish("pinned", "embedding", 1);
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    assert.deepEqual(pinned.value.space, batch.value.space);
    await receipt("pinned", { status: "completed" });

    provider.reply("decision");
    await begin("decision", "decision", { defaults: true });
    const decision = await finish("decision", "decision", 1);
    assert.equal(decision.ok, true, JSON.stringify(decision));
    assert.deepEqual(
      decision.value.answers.map((a) => a.id),
      ["ready", "action", "risk"],
    );
    assert.equal(decision.value.answers[0].probability, 0.75);
    assert.equal(decision.value.answers[1].choice, "continue");
    assert.equal(decision.value.answers[2].score, 0.75);
    const decisionRow = await receipt("decision", { status: "completed" });
    assert.equal(decision.value.modelId, setup.decision.id);
    assert.equal(decision.value.routeId, setup.decision.routes[0].id);
    assert.equal(decision.value.providerId, setup.provider.id);
    assert.equal(decision.value.adapter, "openai-decisions");
    assert.equal(decision.value.status, "complete");
    assert.deepEqual(
      [
        decisionRow.inputTokens,
        decisionRow.outputTokens,
        decisionRow.cachedInputTokens,
        decisionRow.cacheWriteInputTokens,
        decisionRow.reasoningOutputTokens,
        decisionRow.reportedTotalTokens,
      ],
      [7, 3, 2, 1, 1, 10],
    );
    result.steps.push(
      "existing encrypted SDK preserves pinned embedding space and native typed decision answers with reported token counters",
    );

    provider.reply("embedding", { unknownUsage: true });
    await begin("unknown-counters", "embedding");
    const unknown = await finish("unknown-counters", "embedding", 1);
    assert.equal(unknown.ok, true);
    assert.deepEqual(unknown.value.usage, {
      inputTokens: null,
      totalTokens: null,
    });
    const unknownRow = await receipt("unknown-counters", {
      status: "completed",
    });
    assert.equal(unknownRow.reportedTotalTokens, null);
    assert.equal(
      unknownRow.modelOperationUsage.receipt.observedTotalTokens,
      null,
    );

    for (const [name, operation, plan, error, status] of [
      ["malformed", "decision", { malformed: true }, "invalid-response", 409],
      [
        "provider-rejection",
        "embedding",
        { status: 401 },
        "provider-error",
        401,
      ],
    ]) {
      provider.reply(operation, plan);
      await begin(name, operation);
      const value = await finish(name, operation, 1);
      assert.equal(value.ok, false);
      assert.equal(value.code, error);
      assert.equal(value.status, status);
      await receipt(name, { status: "failed", failed: 1 });
    }
    result.steps.push(
      "missing counters remain unknown and malformed/provider failures produce protected errors without automatic retries",
    );

    for (const mode of ["explicit-cancel", "sdk-abort", "http-disconnect"]) {
      const plan = provider.reply("embedding", { hold: true });
      await begin(mode, "embedding", {
        rawDisconnect: mode === "http-disconnect",
        timeout: 5000,
      });
      await eventually(
        () => plan.entered,
        (value) => assert.equal(value, true),
      );
      const wire = JSON.parse(requestFor("embedding").body);
      if (mode === "explicit-cancel") {
        const cancel = await page.evaluate(
          async (wire) =>
            (await import("/src/lib/api-client.ts")).request(
              "/api/model-operations/embedding/cancel",
              {
                method: "POST",
                body: JSON.stringify({
                  operationId: wire.operationId,
                  scope: wire.scope,
                }),
              },
            ),
          wire,
        );
        assert.deepEqual(cancel, {
          operationId: wire.operationId,
          cancelled: true,
        });
      } else
        await page.evaluate(
          (name) => window.modelOperationFixture.jobs[name].controller.abort(),
          mode,
        );
      await eventually(
        () => plan.entry.closed,
        (value) => assert.equal(value, true),
        2000,
      );
      assert.equal(
        plan.entry.completed,
        false,
        "cancellation must close the held provider response",
      );
      const value = await finish(mode, "embedding", 1);
      assert.equal(value.ok, false);
      if (mode === "explicit-cancel") assert.equal(value.code, "cancelled");
      else assert.equal(value.name, "AbortError");
      await receipt(mode, { status: "cancelled", cancelled: 1 });
      await replay(mode, "embedding", "cancelled");
      result.steps.push(
        `running ${mode} closes the original provider connection and retains one cancelled usage receipt without replay`,
      );
    }

    const timed = provider.reply("embedding", { hold: true });
    await begin("provider-timeout", "embedding", { timeout: 1000 });
    const timeout = await finish("provider-timeout", "embedding", 1);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.code, "provider-error");
    await eventually(
      () => timed.entry.closed,
      (value) => assert.equal(value, true),
    );
    assert.equal(timed.entry.completed, false);
    // The production usage collector explicitly distinguishes a provider
    // TimeoutError from user cancellation and records a failed request.
    await receipt("provider-timeout", { status: "failed", failed: 1 });
    result.steps.push(
      "provider deadline closes the original HTTP request and records failed operation usage without fabricating counters or retrying",
    );

    const interrupted = provider.reply("embedding", { hold: true });
    await begin("worker-crash", "embedding", { timeout: 5000 });
    await eventually(
      () => interrupted.entered,
      (value) => assert.equal(value, true),
    );
    await crashWorker();
    await eventually(
      () => interrupted.entry.closed,
      (value) => assert.equal(value, true),
      2000,
    );
    assert.equal(interrupted.entry.completed, false);
    const interruptedResult = await finish("worker-crash", "embedding", 1);
    assert.equal(interruptedResult.ok, false);
    assert.equal(interruptedResult.status, 502);
    assert.equal(interruptedResult.code, "model-operation-unavailable");
    await receipt("worker-crash", {
      status: "unknown",
      transport: "unavailable",
    });
    const beforeReconnect = provider.requests.length;
    await startWorker();
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
    assert.equal(provider.requests.length, beforeReconnect);
    result.steps.push(
      "actual worker SIGKILL closes its provider request, retains unknown usage and never automatically resubmits the operation after reconnect",
    );

    const beforeRestart = await rows();
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
    assert.deepEqual(await rows(), beforeRestart);
    provider.reply("decision");
    await begin("after-restart", "decision");
    assert.equal((await finish("after-restart", "decision", 1)).ok, true);
    await receipt("after-restart", { status: "completed" });
    assert.equal((await rows()).length, report.cases.length);
    assert.equal(
      new Set(report.cases.map((c) => c.operationId)).size,
      report.cases.length,
    );
    const analytics = await page.evaluate(async () => {
      const state = window.modelOperationFixture;
      return (
        await import("/src/lib/api/telemetry.ts")
      ).getProviderTelemetryAnalytics({
        provider: state.provider,
        models: [state.embedding, state.decision],
        days: 1,
      });
    });
    report.aggregate = {
      totals: analytics.tokens.total,
      coverage: analytics.tokens.directOperations,
    };
    assert.deepEqual(report.aggregate.totals, {
      inputTokens: 36,
      outputTokens: 9,
      totalTokens: 45,
      cachedInputTokens: 6,
      cacheWriteInputTokens: 3,
      reasoningOutputTokens: 3,
    });
    assert.deepEqual(report.aggregate.coverage, {
      attemptCount: 12,
      reportedAttemptCount: 11,
      observedRequestCount: 12,
      incompleteUsageCount: 7,
    });
    result.steps.push(
      "public provider telemetry totals and completeness distinguish observed usage from missing worker receipts and unknown counters",
    );
    result.steps.push(
      "direct operation usage survives server and worker restart exactly, and the retained provider and model route execute again",
    );
    if (postgresOutage) {
      await exercisePostgresOutage();
    } else if (workerProcessForInterruption) {
      const name = "server-crash";
      const plan = provider.reply("embedding", { hold: true });
      await begin(name, "embedding", { timeout: 8_000 });
      await eventually(
        () => plan.entered,
        (entered) => assert.equal(entered, true),
      );
      const { operationId } = JSON.parse(requestFor("embedding").body);
      const retainedIdentity = await page.evaluate(
        () => window.folderIdentity.serverId,
      );
      const priorRows = await eventually(rows, (current) => {
        const active = current.filter(
          (row) => row.executionAttemptId === operationId,
        );
        assert.equal(active.length, 1);
        assert.equal(active[0].attemptStatus, "running");
        assert.equal(active[0].modelOperationUsage.transportStatus, "running");
        assert.equal(active[0].reportedTotalTokens, null);
        assert.equal(active[0].modelOperationUsage.receipt, null);
      });
      const workerProcess = workerProcessForInterruption();
      assert.ok(workerProcess?.pid);
      assert.equal(
        plan.entry.closed,
        false,
        "provider must still be active at server interruption",
      );
      const interruptedAt = performance.now();
      report.serverInterruption = {
        ...(await fixture.restart({ crash: true })),
        workerPid: workerProcess.pid,
      };
      const original = await finish(name, "embedding", 1);
      assert.equal(original.ok, false);
      await eventually(
        () => plan.entry.closed,
        (closed) => assert.equal(closed, true),
        12_000,
      );
      assert.equal(plan.entry.completed, false);
      report.serverInterruption.providerClosedObservedAfterMs = Math.round(
        performance.now() - interruptedAt,
      );
      await eventually(
        () => page.evaluate(() => window.folderWorkers.getWorkers()),
        (workers) =>
          assert.equal(
            workers.find((w) => w.workerId === workerId)?.online,
            true,
          ),
      );
      assert.equal(
        await page.evaluate(async () => {
          const { getClientSession } =
            await import("/src/lib/client-session.ts");
          return getClientSession().serverId;
        }),
        retainedIdentity,
      );
      const restored = await rows();
      assert.deepEqual(restored, priorRows);
      report.cases.find((c) => c.name === name).usage = restored.find(
        (row) => row.executionAttemptId === operationId,
      );
      provider.reply("decision");
      await begin("after-server-crash", "decision");
      assert.equal(
        (await finish("after-server-crash", "decision", 1)).ok,
        true,
      );
      await receipt("after-server-crash", { status: "completed" });
      assert.equal(workerProcessForInterruption(), workerProcess);
      assert.equal(workerProcess.exitCode, null);
      assert.equal(workerProcess.signalCode, null);
      assert.equal((await rows()).length, report.cases.length);
      result.steps.push(
        "server SIGKILL interrupts an active operation, preserves one unreported usage record and reconnects the same worker without replay",
      );
    }
    assert.deepEqual(provider.failures, []);
    for (const request of provider.requests) {
      assert.equal(request.authenticated, true);
      if (request.path.endsWith("embeddings")) {
        assert.equal(request.body.model, "owned-embedding-model");
        assert.ok(Array.isArray(request.body.input));
        assert.ok(
          request.body.input.every(
            (text) => typeof text === "string" && text.startsWith(marker),
          ),
        );
      } else {
        assert.equal(request.body.model, "owned-decision-model");
        assert.equal(request.body.input[0].content[0].data.privateText, marker);
      }
    }
    for (const secret of [
      marker,
      provider.apiKey,
      "Private provider diagnostic",
    ])
      assert.ok(
        !JSON.stringify(requests).includes(secret) &&
          !fixture.generations.some((g) => g.diagnostics?.includes(secret)) &&
          !fixture.server.diagnostics().includes(secret),
        "server transport and logs must retain only opaque operation content",
      );
    report.summary = report.cases.map((c) => ({
      name: c.name,
      operation: c.operation,
      posts: c.posts,
      ok: c.outcome.ok,
      code: c.outcome.code ?? null,
      attemptStatus: c.usage.attemptStatus,
      transport: c.usage.modelOperationUsage.transportStatus,
      receipt: c.usage.modelOperationUsage.receipt && {
        status: c.usage.modelOperationUsage.receipt.status,
        requests: c.usage.modelOperationUsage.receipt.requests,
        succeeded: c.usage.modelOperationUsage.receipt.succeededRequests,
        failed: c.usage.modelOperationUsage.receipt.failedRequests,
        cancelled: c.usage.modelOperationUsage.receipt.cancelledRequests,
        metrics: c.usage.modelOperationUsage.receipt.metrics,
        observedTotalTokens:
          c.usage.modelOperationUsage.receipt.observedTotalTokens,
      },
    }));
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    report.browserJobs = await page
      .evaluate(() =>
        Object.fromEntries(
          Object.entries(window.modelOperationFixture?.jobs ?? {}).map(
            ([key, job]) => [key, { settled: job.settled, result: job.result }],
          ),
        ),
      )
      .catch(() => null);
    throw error;
  } finally {
    await provider.close();
  }
}
