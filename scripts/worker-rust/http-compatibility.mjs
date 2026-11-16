// Focused Node/native HTTP behavior and persistence; only disposable profiles.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { workerHeartbeatSchema } from "../../packages/protocol/dist/index.js";
import { enrollWorker } from "../../cantrip_worker/src/enrollment.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass built --binary http-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-http-"));
const credential = "ctwk_" + "a".repeat(43),
  code = "ctwl_" + "b".repeat(32);
const heartbeat = workerHeartbeatSchema.parse({
  workerId: "fixture-worker",
  name: "HTTP fixture",
  platform: "darwin",
  architecture: "arm64",
  codexVersion: null,
  startedAt: "2026-11-16T12:00:00.000Z",
});
const enrolled = {
  credential,
  worker: { ...heartbeat, online: true, lastSeenAt: heartbeat.startedAt },
  credentialSummary: {
    id: "11111111-1111-4111-8111-111111111111",
    workerId: heartbeat.workerId,
    label: null,
    scopes: [
      "worker:connect",
      "worker:heartbeat",
      "worker:automations",
      "worker:agent-tools",
    ],
    createdAt: heartbeat.startedAt,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    active: true,
  },
};
const preferences = {
  revision: 1,
  configuration: { effect: "off", parameters: {} },
};
const cases = [
  {
    operation: "enroll",
    status: 201,
    body: "\ufeff" + JSON.stringify(enrolled),
  },
  {
    operation: "enroll",
    status: 201,
    body: JSON.stringify(enrolled),
    replacement: { workerId: "old-worker", credential },
  },
  {
    operation: "enroll",
    status: 403,
    body: JSON.stringify({ error: "Enrollment denied." }),
  },
  { operation: "enroll", status: 500, body: "not JSON" },
  {
    operation: "enroll",
    status: 201,
    body: JSON.stringify({
      ...enrolled,
      worker: { ...enrolled.worker, workerId: "different-worker" },
    }),
  },
  { operation: "heartbeat", status: 200, body: "{}" },
  { operation: "heartbeat", status: 200, body: "null" },
  {
    operation: "heartbeat",
    status: 200,
    body: JSON.stringify({ computerUseEffects: preferences }),
  },
  {
    operation: "heartbeat",
    status: 200,
    body: JSON.stringify({
      computerUseEffects: { ...preferences, revision: 0 },
    }),
  },
  { operation: "heartbeat", status: 204, body: "" },
  { operation: "heartbeat", status: 200, body: "" },
  { operation: "heartbeat", status: 200, body: "{}", declaredLength: 300_000 },
  {
    operation: "heartbeat",
    status: 200,
    body: "x".repeat(300_000),
    chunked: true,
  },
  { operation: "heartbeat", status: 401, body: "not JSON" },
];
let active,
  requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({
    path: request.url,
    method: request.method,
    authorization: request.headers.authorization ?? null,
    body: JSON.parse(body),
  });
  response.writeHead(active.status, {
    "content-type": "application/json",
    ...(active.declaredLength
      ? { "content-length": String(active.declaredLength) }
      : {}),
  });
  if (active.chunked) {
    response.write(active.body);
    response.end();
  } else response.end(active.body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function native(input) {
  const child = spawn(path.resolve(values.binary), [], {
    env: { ...process.env, PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(JSON.stringify(input) + "\n");
  assert.equal(await completion, 0, stderr);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}
try {
  for (const [index, scenario] of cases.entries()) {
    active = scenario;
    requests = [];
    const configuration = {
      dataDirectory: path.join(root, "node-" + index),
      enrollmentCode: scenario.operation === "enroll" ? code : null,
      replacement: scenario.replacement ?? null,
      serverUrl: origin,
      token: credential,
      tokenSource: "environment",
      workerId: heartbeat.workerId,
    };
    let expected;
    try {
      let value;
      if (scenario.operation === "enroll") {
        await enrollWorker(configuration, heartbeat);
        value = {
          token: configuration.token,
          tokenSource: configuration.tokenSource,
          enrollmentCode: configuration.enrollmentCode,
          replacement: configuration.replacement,
        };
      } else value = await sendHeartbeat(configuration, heartbeat);
      expected = { ok: true, value };
    } catch (error) {
      expected = { ok: false, error: error.message };
    }
    const directory = path.join(root, "rust-" + index);
    const actual = await native({
      operation: scenario.operation,
      directory,
      code: scenario.operation === "enroll" ? code : null,
      replacement: scenario.replacement,
      serverUrl: origin,
      heartbeat,
    });
    assert.deepEqual(actual, expected, "HTTP scenario " + index);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests[1],
      requests[0],
      "request body/auth parity " + index,
    );
    if (actual.ok && scenario.operation === "enroll") {
      assert.equal(
        await readFile(path.join(directory, "worker-credential.json"), "utf8"),
        await readFile(
          path.join(configuration.dataDirectory, "worker-credential.json"),
          "utf8",
        ),
      );
    }
  }
  console.log(
    JSON.stringify({
      suite: "native-worker-http-compatibility",
      passed: true,
      comparisons: cases.length,
      requestBodiesAndAuthorization: true,
      credentialBytesIdentical: true,
      responseBoundsAndEffectsValidation: true,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
