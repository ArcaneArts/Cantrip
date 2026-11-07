import assert from "node:assert/strict";

export async function attachmentReopen({
  f,
  workers,
  attachmentId,
  snapshot,
  result,
  settle,
  upload,
  input,
}) {
  const before = await snapshot(),
    port = +new URL(f.server.origin).port;
  result.beforeReopenDiagnostics = f.server.diagnostics();
  for (const worker of workers) await worker.close();
  await f.close();
  // Use supported configuration bounds. Actual reads below exhaust the new
  // server's real command window; no injected counter or identity gate is used.
  f.environment.CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE = "60";
  f.environment.CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE = "60";
  await f.start({ port });
  await workers[0].start();
  const after = await snapshot();
  assert.deepEqual(
    after,
    before,
    "Server/database reopen preserves every attachment and replica row after writes",
  );
  result.serverReopenedAfterWrites = true;
  const client = f.client();
  result.commandQuotaWarmup = [];
  for (let i = 0; i < 61; i++) {
    const response = await fetch(
      f.server.origin +
        `/api/attachments/${attachmentId}/content?operationId=33333333-3333-4333-8333-abcdefabcdef`,
      {
        headers: {
          origin: "http://127.0.0.1:5173",
          cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = await response.json();
    assert.ok([200, 429].includes(response.status), JSON.stringify(body));
    result.commandQuotaWarmup.push({
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers),
    });
    if (response.status === 429) break;
  }
  assert.equal(
    result.commandQuotaWarmup.at(-1).status,
    429,
    "Real command admission must eventually reject the read",
  );
  await settle(
    "uncaught delete command quota",
    "DELETE",
    "/api/attachments/" + attachmentId,
    {
      status: 429,
      fetcher: async (...args) => {
        const response = await fetch(...args);
        const retry = response.headers.get("retry-after");
        assert.match(retry, /^[1-9]\d*$/);
        assert.ok(+retry <= 60);
        result.deleteCommandQuotaRetryAfterSeconds = +retry;
        return response;
      },
    },
  );
  await upload("caught upload command quota", input(), {
    status: 429,
    fetcher: async (...args) => {
      const response = await fetch(...args);
      assert.equal(
        response.headers.get("retry-after"),
        null,
        "Caught worker quota retains Source's absent Retry-After",
      );
      return response;
    },
  });
}
