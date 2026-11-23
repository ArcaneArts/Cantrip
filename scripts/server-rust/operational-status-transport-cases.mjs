// Actual TCP disappearance, legacy HTTP requests and a real 101 handshake.
// A missing terminal exercises upgrade/close accounting, not a successful PTY.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { settingsChat, until } from "./native-settings-http-fixture.mjs";
import { TerminalRelayProbe } from "./terminal-relay-probe.mjs";

const origin = "http://127.0.0.1:5173";
const endpoints = [
  ["remote-surface-transport", "GET", "/api/remote-surfaces/missing/connect"],
  ["terminal-direct", "POST", "/api/terminals/missing/direct"],
  ["terminal-relay", "GET", "/api/terminals/missing/connect"],
  ["tunnel-direct", "POST", "/api/tunnel-attachments/missing/direct"],
  [
    "tunnel-direct-activate",
    "POST",
    "/api/tunnel-attachments/missing/direct-activate",
  ],
  ["tunnel-relay", "GET", "/api/tunnel-attachments/missing/connect"],
];
const deprecation = "@1787788800";
const link =
  '<https://github.com/ArcaneArts/Cantrip/blob/main/docs/NETWORK.md#legacy-feature-relay-compatibility>; rel="deprecation"; type="text/markdown"';
const counter = (parsed, endpoint) =>
  parsed.number(
    `cantrip_legacy_feature_transport_requests_total{endpoint="${endpoint}"}`,
  );
function operationalLogs(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("{")) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value.context?.event !== "network.compatibility-endpoint.requested")
        continue;
      assert.ok(Number.isFinite(Date.parse(value.timestamp)));
      records.push({
        level: value.level,
        message: value.message,
        context: value.context,
      });
    } else if (
      line.includes("event=network.compatibility-endpoint.requested")
    ) {
      const matched = /^\[server\] \d{2}:\d{2}: WARN (.*?) · (.*)$/.exec(line);
      assert.ok(matched, "actual Source operational log presentation");
      records.push({
        level: "warn",
        message: matched[1],
        context: Object.fromEntries(
          matched[2].split(" ").map((item) => {
            const at = item.indexOf("=");
            assert.ok(at > 0);
            return [item.slice(0, at), item.slice(at + 1)];
          }),
        ),
      });
    }
  }
  return records;
}
export async function operationalTransportCases({
  h,
  result,
  health,
  scrape,
  prometheus,
  bindingId,
}) {
  const f = h.fixture,
    client = f.client();
  const headers = {
    origin,
    cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
    "content-type": "application/json",
  };
  const before = await health("collector before actual caller disappearance");
  const postKey =
    'cantrip_http_requests_total{method="POST",status_class="2xx"}';
  const beforeMetrics = prometheus(
    await scrape("completed POST observations before caller disappearance"),
  );
  const succeeded = before.operations.workerCommands.succeededRequests;
  const calls = h.defaultsCalls.length;
  const held = h.hold();
  let responseReceived = false,
    clientError;
  const request = httpRequest(
    f.server.origin + `/api/chats/${settingsChat}/native-account-defaults`,
    { method: "POST", headers },
  );
  request.on("response", (response) => {
    responseReceived = true;
    response.resume();
  });
  request.on("error", (error) => {
    clientError = error.code;
  });
  const disconnected = new Promise((resolve) => request.once("close", resolve));
  request.end(
    JSON.stringify({
      action: "read",
      bindingId,
      operationId: "operational-disconnected-defaults",
    }),
  );
  let failure;
  try {
    await until(() => held().requested, Boolean);
    request.destroy();
    await disconnected;
    assert.equal(request.destroyed, true);
    assert.equal(responseReceived, false);
    assert.equal(clientError, "ECONNRESET");
    const abandoned = await health(
      "caller has left while the real worker command remains held",
    );
    assert.ok(abandoned.operations.workerCommands.activeRequests >= 1);
    assert.equal(
      abandoned.operations.http.activeRequests,
      before.operations.http.activeRequests + 1,
    );
  } catch (error) {
    failure = error;
  } finally {
    request.destroy();
    if (held().release) h.release();
  }
  if (failure) throw failure;
  const deadline = Date.now() + 15000;
  let settled;
  for (;;) {
    settled = await health("observe actual acknowledgment after caller loss", {
      compare: false,
    });
    const commands = settled.operations.workerCommands;
    if (
      commands.activeRequests === 0 &&
      commands.succeededRequests === succeeded + 1
    )
      break;
    assert.ok(
      Date.now() < deadline,
      "admitted worker command settles after TCP loss",
    );
    await delay(20);
  }
  assert.equal(h.defaultsCalls.length, calls + 1);
  assert.equal(
    settled.operations.http.activeRequests,
    before.operations.http.activeRequests + 1,
  );
  const afterMetrics = prometheus(
    await scrape("disconnected response does not fabricate a completion"),
  );
  assert.equal(afterMetrics.number(postKey), beforeMetrics.number(postKey));
  result.cases.push({
    name: "actual caller disappearance",
    clientError,
    responseReceived,
    calls: h.defaultsCalls.length - calls,
    succeeded: settled.operations.workerCommands.succeededRequests - succeeded,
    activeHttpDelta:
      settled.operations.http.activeRequests -
      before.operations.http.activeRequests,
    completedPostDelta:
      afterMetrics.number(postKey) - beforeMetrics.number(postKey),
  });

  const expected = Object.fromEntries(
    endpoints.map(([endpoint]) => [endpoint, counter(afterMetrics, endpoint)]),
  );
  result.legacyHttp = [];
  for (const [endpoint, method, route] of endpoints) {
    const response = await fetch(f.server.origin + route, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    const raw = {
      endpoint,
      method,
      route,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    };
    result.legacyHttp.push(raw);
    assert.ok([400, 404].includes(response.status), JSON.stringify(raw));
    assert.equal(response.headers.get("deprecation"), deprecation);
    assert.equal(response.headers.get("link"), link);
    expected[endpoint]++;
    const parsed = prometheus(
      await scrape("actual legacy HTTP collector " + endpoint),
    );
    for (const [name, value] of Object.entries(expected))
      assert.equal(counter(parsed, name), value, name);
    result.cases.push({
      name: "legacy HTTP " + endpoint,
      deprecation,
      link,
      counters: { ...expected },
      ...(endpoint === "remote-surface-transport"
        ? {
            scope:
              "telemetry only; remote-surface HTTP handler remains an explicit unported gap",
          }
        : { status: response.status, body }),
    });
  }
  const beforeUpgrade = await health(
    "collector before actual terminal WebSocket upgrade",
  );
  const probe = new TerminalRelayProbe(
    f,
    "/api/terminals/missing/connect?operationId=operational-upgrade",
  );
  let upgradeHeaders;
  probe.socket.once("upgrade", (response) => {
    upgradeHeaders = response.headers;
  });
  try {
    await probe.open();
    await until(() => probe.closeResult, Boolean);
    assert.equal(probe.upgrade.status, 101);
    assert.equal(upgradeHeaders.deprecation, undefined);
    assert.equal(upgradeHeaders.link, undefined);
    assert.deepEqual(probe.closeResult, {
      code: 1008,
      reason: "Terminal not found",
    });
    const afterUpgrade = await health(
      "closed upgraded socket retains Source HTTP observation",
    );
    assert.equal(
      afterUpgrade.operations.http.activeRequests,
      beforeUpgrade.operations.http.activeRequests + 1,
    );
    assert.equal(
      afterUpgrade.operations.http.requestCount,
      beforeUpgrade.operations.http.requestCount + 1,
    );
    assert.equal(afterUpgrade.live.connectionCount, 0);
    expected["terminal-relay"]++;
    const parsed = prometheus(
      await scrape(
        "actual upgraded legacy request increments only its counter",
      ),
    );
    for (const [name, value] of Object.entries(expected))
      assert.equal(counter(parsed, name), value, name);
    result.legacyUpgrade = {
      ...probe.record("actual 101 followed by missing-resource close"),
      headers: upgradeHeaders,
    };
    result.cases.push({
      name: "legacy 101 observation",
      upgrade: probe.upgrade,
      close: probe.closeResult,
      ordinaryDeprecationHeaders: false,
      activeHttpDelta:
        afterUpgrade.operations.http.activeRequests -
        beforeUpgrade.operations.http.activeRequests,
      completedHttpDelta:
        afterUpgrade.operations.http.requestCount -
        beforeUpgrade.operations.http.requestCount,
      counters: { ...expected },
    });
  } finally {
    await probe.close();
  }
  const logs = operationalLogs(h.diagnostics());
  const expectedLogs = endpoints.map(([endpoint]) => ({
    level: "warn",
    message: "Deprecated feature transport endpoint requested",
    context: {
      endpoint,
      event: "network.compatibility-endpoint.requested",
      operation: "connect",
      reasonCode: "legacy-feature-transport",
      status: "deprecated",
      subsystem: "worker-link",
    },
  }));
  assert.deepEqual(
    logs,
    expectedLogs,
    "six exact operational events; repeated legacy upgrade is rate limited",
  );
  result.cases.push({ name: "legacy operational logs", records: logs });
}
