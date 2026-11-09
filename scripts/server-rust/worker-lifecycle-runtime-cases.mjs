// Production HTTP and unchanged worker transport. Credential endpoint effects
// are controlled; this does not execute the complete worker resource runtime.
import assert from "node:assert/strict";
import path from "node:path";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { eventually } from "./full-worker.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { localOwner } from "./project-target-state.mjs";
import { cantripVersion } from "../../packages/version/dist/index.js";
import {
  workerInferenceStatusSchema,
  workerEnrollmentCodeCreateSchema,
} from "../../packages/protocol/dist/index.js";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";

export async function workerLifecycleRuntimeCases(
  origin,
  cookie,
  directory,
  parent,
) {
  const evidence = (parent.workerLifecycle = {
    http: [],
    background: [],
    commands: [],
    disconnects: 0,
    privateValues: [],
    credentialIds: {},
    enrollmentCodeIds: {},
  });
  const session = await fetch(origin + "/api/auth/session", {
    headers: { cookie },
  }).then((r) => r.json());
  const owner = session.currentUser?.id ?? localOwner;
  async function visit(name, method, route, options = {}) {
    const authentication = options.authentication ?? {
      cookie,
      csrf: session.csrfToken,
    };
    const response = await fetch(origin + route, {
      method,
      headers: {
        origin: "http://127.0.0.1:5173",
        ...(options.client === "worker"
          ? {}
          : { cookie: authentication.cookie }),
        ...(authentication.csrf && options.client !== "worker"
          ? { "x-cantrip-csrf": authentication.csrf }
          : {}),
        ...(options.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.json === undefined
        ? {}
        : { body: JSON.stringify(options.json) }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text(),
      body = text ? JSON.parse(text) : null;
    options.onResponse?.(response);
    const row = {
      name,
      method,
      route,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      input: options.json,
      body,
    };
    evidence.http.push(row);
    assert.match(
      row.requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(response.status, options.status ?? 200, name + ": " + text);
    if (body?.code) {
      evidence.privateValues.push(body.code);
      evidence.enrollmentCodeIds[body.id] = name;
    }
    if (body?.credential) {
      evidence.privateValues.push(body.credential);
      evidence.credentialIds[body.credentialSummary.id] = name;
    }
    return body;
  }
  let worker,
    configurations = 0,
    failDelivery = false;
  const label = "private-worker-credential-label";
  evidence.privateValues.push(label);
  const bootstrap = await visit("bootstrap", "GET", "/api/bootstrap");
  function save(credential) {
    saveWorkerCredential({
      credential,
      dataDirectory: worker.config.dataDirectory,
      serverUrl: origin,
      workerId: "alpha",
    });
    worker.config.token = credential;
    worker.config.tokenSource = "persisted";
  }
  async function ready(previous = 0) {
    await visit(
      "version before configuration " + previous,
      "GET",
      "/api/workers/alpha/version",
    );
    await eventually(
      () => configurations,
      (n) => assert.ok(n > previous, "actual configuration callback"),
    );
    // A second RPC crosses the same worker socket FIFO after its configuration
    // response, so process shutdown cannot race an unacknowledged setup command.
    await visit(
      "version after configuration " + previous,
      "GET",
      "/api/workers/alpha/version",
    );
  }
  async function offline() {
    worker.close();
    await eventually(
      () =>
        fetch(origin + "/api/workers", { headers: { cookie } }).then((r) =>
          r.json(),
        ),
      (rows) =>
        assert.equal(rows.find((w) => w.workerId === "alpha")?.online, false),
    );
  }
  try {
    await visit(
      "invalid enrollment-code body",
      "POST",
      "/api/workers/enrollment-codes",
      { status: 400, json: { expiresInSeconds: 0 } },
    );
    worker = await managementWorker({
      f: { server: { origin } },
      visit,
      root: path.join(directory, "controlled-worker"),
      state: evidence,
      handlers: {
        "inference.configure": async (command) => {
          const result = workerInferenceStatusSchema.parse({
            serverId: bootstrap.server.id,
            ownerId: owner,
            workerId: "alpha",
            workerGeneration: "controlled-generation",
            revision: 0,
            providerCatalogRevision: command.catalogRevision ?? 0,
            pools: command.configurations.map((c) => ({
              ...c,
              activeCount: 0,
              queuedCount: 0,
              operations: [],
            })),
          });
          configurations++;
          return result;
        },
        "worker.version": async () => cantripVersion,
        "model.ollama.catalog": async () => ({
          models: [],
          observedAt: new Date().toISOString(),
        }),
        "worker.credential.rotate": async (command) => {
          evidence.commands.push({ type: command.type, failed: failDelivery });
          evidence.privateValues.push(command.credential);
          if (failDelivery)
            throw new Error("Controlled credential delivery failure");
          save(command.credential);
          return { accepted: true };
        },
      },
    });
    await ready();
    const online = await visit(
      "online rotation",
      "POST",
      "/api/workers/alpha/credentials/rotate",
      { json: { label } },
    );
    assert.equal(online.delivered, true);
    assert.equal(
      worker.config.token,
      online.credential,
      "actual controlled endpoint persisted the delivered secret",
    );
    await offline();
    const disconnected = await visit(
      "offline rotation",
      "POST",
      "/api/workers/alpha/credentials/rotate",
      { json: { label } },
    );
    assert.equal(disconnected.delivered, false);
    save(disconnected.credential);
    const previous = configurations;
    await worker.start();
    await ready(previous);
    failDelivery = true;
    const failed = await visit(
      "failed online rotation",
      "POST",
      "/api/workers/alpha/credentials/rotate",
      { json: { label } },
    );
    assert.equal(failed.delivered, false);
    await offline();
    await visit(
      "revoke current credential",
      "DELETE",
      `/api/workers/alpha/credentials/${failed.credentialSummary.id}`,
      { status: 204 },
    );
    await visit(
      "missing credential",
      "DELETE",
      "/api/workers/alpha/credentials/00000000-0000-4000-8000-000000000000",
      { status: 404 },
    );
    await visit(
      "missing worker",
      "POST",
      "/api/workers/lifecycle-missing/credentials/rotate",
      { status: 404, json: {} },
    );
    await visit(
      "invalid rotation body",
      "POST",
      "/api/workers/alpha/credentials/rotate",
      { status: 400, json: { label: 123 } },
    );
    await visit(
      "reusable worker code",
      "POST",
      "/api/workers/enrollment-codes",
      {
        status: 201,
        json: {
          label,
          candidateWorkerIds: ["alpha", "lifecycle-candidate"],
          expiresInSeconds: 60,
        },
      },
    );
    const initial = evidence.http.find(
      (r) => r.name === "alpha enrollment code",
    ).body.code;
    for (let i = 0; i < 7; i++)
      await visit(
        "consumed enrollment " + i,
        "POST",
        "/api/internal/workers/enroll",
        {
          client: "worker",
          status: 409,
          json: {
            code: initial,
            heartbeat: { ...heartbeat, workerId: "alpha" },
          },
        },
      );
    await visit(
      "other worker rejection",
      "POST",
      "/api/internal/workers/enroll",
      {
        client: "worker",
        status: 409,
        json: {
          code: initial,
          heartbeat: { ...heartbeat, workerId: "lifecycle-beta" },
        },
      },
    );
    await visit(
      "invalid enrollment body",
      "POST",
      "/api/internal/workers/enroll",
      { client: "worker", status: 400, json: { code: initial, heartbeat: {} } },
    );
    await visit(
      "rotation after final revocation",
      "POST",
      "/api/workers/alpha/credentials/rotate",
      { status: 409, json: {} },
    );
    if (parent.authentication.profile === "accounts") {
      const transferWorker = "lifecycle-transfer";
      const newWorker = "lifecycle-transferred";
      const initialCode = await visit(
        "transfer worker code",
        "POST",
        "/api/workers/enrollment-codes",
        { status: 201, json: { label } },
      );
      const transferable = await visit(
        "transfer worker enrollment",
        "POST",
        "/api/internal/workers/enroll",
        {
          client: "worker",
          status: 201,
          json: {
            code: initialCode.code,
            heartbeat: { ...heartbeat, workerId: transferWorker },
          },
        },
      );
      const alternate = { cookie: "", csrf: null };
      await visit("register transfer owner", "POST", "/api/auth/register", {
        authentication: alternate,
        status: 201,
        json: {
          email: "worker-transfer@example.invalid",
          displayName: "Worker transfer",
          password,
        },
        onResponse(response) {
          alternate.cookie = response.headers
            .getSetCookie()
            .map((v) => v.split(";")[0])
            .join("; ");
        },
      });
      const otherSession = await visit(
        "transfer owner session",
        "GET",
        "/api/auth/session",
        { authentication: alternate },
      );
      assert.notEqual(otherSession.currentUser.id, owner);
      alternate.csrf = otherSession.csrfToken;
      const code = await visit(
        "transfer enrollment code",
        "POST",
        "/api/workers/enrollment-codes",
        { authentication: alternate, status: 201, json: { label } },
      );
      await visit(
        "self replacement denied",
        "POST",
        "/api/internal/workers/enroll",
        {
          client: "worker",
          status: 409,
          json: {
            code: code.code,
            heartbeat: { ...heartbeat, workerId: transferWorker },
            replacement: {
              workerId: transferWorker,
              credential: transferable.credential,
            },
          },
        },
      );
      const unconsumed = await visit(
        "rejected replacement preserves code",
        "GET",
        `/api/workers/enrollment-codes/${code.id}`,
        { authentication: alternate },
      );
      assert.equal(unconsumed.status, "pending");
      const reassigned = await visit(
        "account reassignment",
        "POST",
        "/api/internal/workers/enroll",
        {
          client: "worker",
          status: 201,
          json: {
            code: code.code,
            heartbeat: { ...heartbeat, workerId: newWorker },
            replacement: {
              workerId: transferWorker,
              credential: transferable.credential,
            },
          },
        },
      );
      await visit(
        "previous owner denied",
        "GET",
        `/api/workers/${newWorker}/credentials`,
        { status: 404 },
      );
      await visit(
        "previous credential denied",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          client: "worker",
          status: 401,
          headers: { authorization: "Bearer " + transferable.credential },
          json: { ...heartbeat, workerId: transferWorker },
        },
      );
      await visit(
        "new credential accepted",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          client: "worker",
          status: 202,
          headers: { authorization: "Bearer " + reassigned.credential },
          json: { ...heartbeat, workerId: newWorker },
        },
      );
      await visit(
        "new owner revokes credential",
        "DELETE",
        `/api/workers/${newWorker}/credentials/${reassigned.credentialSummary.id}`,
        { authentication: alternate, status: 204 },
      );
    }
  } finally {
    worker?.close();
  }
}

export function verifyWorkerLifecycleRuntime(
  records,
  evidence,
  stdout,
  stderr,
) {
  const requests = new Map(evidence.http.map((r) => [r.requestId, r]));
  const decisions = records.filter(
    (r) =>
      r.context?.event?.startsWith("worker.enrollment.") ||
      r.context?.event?.startsWith("worker.credential."),
  );
  assert.ok(
    decisions.length >= 10,
    "actual enrollment, rotations, revocation and repeated rejection records",
  );
  const rows = decisions.map((raw) => {
    assert.equal(new Date(raw.timestamp).toISOString(), raw.timestamp);
    const row = structuredClone(raw);
    delete row.timestamp;
    delete row.cursor;
    const context = row.context,
      request = requests.get(context.requestId);
    assert.ok(request, "record identifies its real HTTP request");
    const fullLine = (stdout + stderr)
      .split("\n")
      .find(
        (line) =>
          line.includes("requestId=" + raw.context.requestId) &&
          line.includes("event=" + context.event),
      );
    assert.ok(
      fullLine,
      "actual full-console decision retains request correlation",
    );
    context.requestId = request.name;
    if (context.enrollmentCodeId !== undefined) {
      assert.ok(
        Object.hasOwn(evidence.enrollmentCodeIds, context.enrollmentCodeId),
      );
      context.enrollmentCodeId =
        evidence.enrollmentCodeIds[context.enrollmentCodeId];
    }
    if (context.credentialId !== undefined) {
      assert.ok(Object.hasOwn(evidence.credentialIds, context.credentialId));
      context.credentialId = evidence.credentialIds[context.credentialId];
    }
    if (context.event === "worker.enrollment.completed") {
      assert.ok(stdout.includes("platform=" + request.body.worker.platform));
      assert.ok(
        stdout.includes("architecture=" + request.body.worker.architecture),
      );
      assert.equal(
        context.replacedWorkerId,
        request.name === "account reassignment"
          ? "lifecycle-transfer"
          : undefined,
      );
      assert.ok(
        fullLine.includes(
          "replacedWorkerId=" +
            (request.name === "account reassignment"
              ? "lifecycle-transfer"
              : "undefined"),
        ),
        "full enrollment context retains its explicit optional identity",
      );
    }
    if (context.event === "worker.credential.rotated") {
      assert.ok(
        fullLine.includes(
          "reasonCode=" +
            (request.body.delivered ? "undefined" : "worker_delivery_failed"),
        ),
      );
      const previous = {
        "online rotation": 1,
        "offline rotation": 2,
        "failed online rotation": 3,
      }[request.name];
      assert.ok(
        fullLine.includes("counts.previousCredentials=" + previous),
        "full rotation context counts revoked and active history",
      );
    }
    if (context.event === "worker.enrollment.code_created") {
      const expected = workerEnrollmentCodeCreateSchema.parse(
        request.input ?? {},
      );
      assert.ok(
        fullLine.includes("expiresInSeconds=" + expected.expiresInSeconds),
        "full code-creation record retains actual expiration policy",
      );
      assert.ok(fullLine.includes("enrollmentCodeId=" + request.body.id));
    }
    return row;
  });
  for (const secret of new Set(evidence.privateValues))
    assert.ok(
      !JSON.stringify(records).includes(secret) &&
        !(stdout + stderr).includes(secret),
      "code, credential and label remain private",
    );
  return {
    rows,
    http: evidence.http
      .filter((r) => r.name !== "bootstrap")
      .map((r) => ({
        name: r.name,
        status: r.status,
        ...(r.body?.error ? { error: r.body } : {}),
        ...(r.body?.delivered !== undefined
          ? { delivered: r.body.delivered }
          : {}),
        ...(r.body?.workerId !== undefined
          ? { workerId: r.body.workerId }
          : {}),
      })),
    commands: evidence.commands,
  };
}
