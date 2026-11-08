import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { isDeepStrictEqual } from "node:util";

const specs = [
  ["GET", "/readyz"],
  ["HEAD", "/readyz"],
  ["GET", "/healthz"],
  ["GET", "/metrics"],
  ["GET", "/api/workers"],
  ["HEAD", "/api/workers"],
  ["GET", "/api/workers/missing/version"],
  ["POST", "/api/workers/enrollment-codes", '{"expiresInSeconds":0}'],
  ["POST", "/api/workers/enrollment-codes", "{"],
  ["POST", "/api/workers/missing/restart", "{}"],
  ["PUT", "/api/workers", "{}"],
  ["POST", "/readyz", "{}"],
  ["GET", "/api/settings"],
  ["POST", "/api/log-policy-missing", "{"],
  ["GET", "/api/agent-requests/"],
  ["GET", "/api/workers//version"],
  ...[100, 101].map((n) => [
    "GET",
    "/api/workers/" + "w".repeat(n) + "/version",
  ]),
  ["GET", "/api/workers/" + "%77".repeat(50) + "/version"],
  ["GET", "/api/workers/%GG/version"],
  ["GET", "/api/workers/%FF/version"],
  ["GET", "/%61pi/workers"],
  ["GET", "/%68ealthz"],
  ["GET", "/api/workers/missing/%76ersion"],
  ["GET", "/api/workers/%252F/version"],
  ["GET", "/api/workers/a%2Fb/version"],
  ["GET", "/api/workers/" + "%F0%9F%98%80".repeat(50) + "/version"],
  ["GET", "/api/workers/" + "%F0%9F%98%80".repeat(51) + "/version"],
  ["GET", "/api/workers/" + "w".repeat(101) + "/missing?private=value"],
  ["GET", "/api/workers/%GG/version?private=value"],
  ["GET", "/api/workers/" + "%77".repeat(101) + "/version"],
  ["GET", "/api/workers/missing/version?invalid=%GG"],
  ["GET", "/api/log-policy-missing?invalid=%FF"],
  ["GET", "/api/%GG/missing"],
  ["OPTIONS", "*"],
  ["GET", "http://127.0.0.1/api/workers/%GG/version"],
  ["GET", "http://127.0.0.1/%61pi/workers"],
  ["GET", "/api/workers/%C0%AF/version"],
  ["GET", "/api/workers/%/version"],
  ...["GET", "HEAD", "POST", "OPTIONS", "QUERY"].flatMap((method) => [
    [method, "/api/workers/%GG/version", ...(method === "POST" ? ["{"] : [])],
    [method, "/api/workers/%FF/version"],
    [method, "/api/log-policy-missing/%GG"],
    [method, "/api/workers/" + "w".repeat(101) + "/version"],
  ]),
  [
    "GET",
    "/api/workers/%GG/version",
    undefined,
    { origin: "http://untrusted.invalid", forwarded: "for=untrusted" },
  ],
  ["GET", "/metrics?after=target-probes"],
];
const normalized = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof parsed.requestId === "string"
  ) {
    assert.match(parsed.requestId, /^[0-9a-f-]{36}$/);
    parsed.requestId = "<request>";
  }
  return parsed;
};
function comparison(row) {
  const body = structuredClone(row.body);
  if (
    body &&
    typeof body === "object" &&
    body.service === "cantrip_server" &&
    ["ready", "not-ready", "alive"].includes(body.status)
  ) {
    assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
    body.timestamp = "<timestamp>";
    if (body.database) {
      assert.ok(
        Number.isFinite(body.database.latencyMs) &&
          body.database.latencyMs >= 0,
      );
      body.database.latencyMs = "<latency>";
    }
  }
  if (row.target.startsWith("/metrics")) {
    const lines = body.trim().split("\n");
    const descriptors = [],
      series = [];
    for (const line of lines) {
      if (line.startsWith("#")) descriptors.push(line);
      else {
        const at = line.lastIndexOf(" ");
        assert.ok(at > 0 && Number.isFinite(Number(line.slice(at + 1))), line);
        series.push(line.slice(0, at));
      }
    }
    const httpCounters = Object.fromEntries(
      lines
        .filter((line) => line.startsWith("cantrip_http_requests_total{"))
        .map((line) => {
          const at = line.lastIndexOf(" ");
          return [line.slice(0, at), Number(line.slice(at + 1))];
        }),
    );
    return {
      descriptors: descriptors.sort(),
      series: series.sort(),
      httpCounters,
    };
  }
  return body;
}
async function request(origin, method, target, body, headers) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path: target,
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const bytes = Buffer.concat(chunks);
            if (
              method !== "HEAD" &&
              response.headers["content-length"] !== undefined
            )
              assert.equal(
                bytes.length,
                Number(response.headers["content-length"]),
              );
            resolve({
              status: response.statusCode,
              headers: response.headers,
              rawBody: bytes.toString("utf8"),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("HTTP probe timeout")));
    req.end(body);
  });
}
function headersForComparison(row) {
  const headers = { ...row.headers };
  for (const name of [
    "date",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
  ])
    delete headers[name];
  if (headers["x-request-id"]) {
    assert.match(headers["x-request-id"], /^[0-9a-f-]{36}$/);
    headers["x-request-id"] = "<request>";
  }
  return headers;
}
export const targetPolicyNormalization = {
  timestampsAndLatencies:
    "Validated ISO timestamps and finite nonnegative durations",
  metrics:
    "Exact descriptor and series keys; all sample values must be finite. This logging suite does not compare changing metric values.",
  transportHeaders:
    "Date, connection, transfer encoding and keepalive excluded; content lengths validated against actual bytes for non-HEAD replies.",
};
export async function targetPolicyCases(
  origin,
  cookie,
  { metrics = true } = {},
) {
  const responses = [];
  for (const [method, target, body, headers] of specs) {
    if (!metrics && target.startsWith("/metrics")) continue;
    const response = await request(origin, method, target, body, {
      ...(cookie ? { cookie } : {}),
      ...headers,
    });
    responses.push({
      method,
      target,
      ...response,
      body: normalized(response.rawBody),
      requestId: response.headers["x-request-id"] ?? null,
    });
  }
  return responses;
}
export function verifyTargetPolicy(peers) {
  for (const peer of peers)
    for (const row of peer.responses)
      row.completionRecords = peer.records.filter(
        (r) =>
          r.context?.event === "http.request.completed" &&
          r.context.requestId === row.requestId,
      );
  const [node, rust] = peers;
  assert.equal(node.responses.length, rust.responses.length);
  const wireDifferences = [],
    loggingDifferences = [];
  for (let i = 0; i < node.responses.length; i++) {
    const a = node.responses[i],
      b = rust.responses[i];
    assert.equal(a.method, b.method);
    assert.equal(a.target, b.target);
    if (
      a.status !== b.status ||
      !isDeepStrictEqual(comparison(a), comparison(b)) ||
      !isDeepStrictEqual(headersForComparison(a), headersForComparison(b))
    )
      wireDifferences.push({
        method: a.method,
        target: a.target,
        node: {
          status: a.status,
          body: a.body,
          headers: headersForComparison(a),
        },
        rust: {
          status: b.status,
          body: b.body,
          headers: headersForComparison(b),
        },
      });
    if (a.completionRecords.length !== b.completionRecords.length)
      loggingDifferences.push({
        method: a.method,
        target: a.target,
        node: a.completionRecords.length,
        rust: b.completionRecords.length,
      });
  }
  return { wireDifferences, loggingDifferences };
}
