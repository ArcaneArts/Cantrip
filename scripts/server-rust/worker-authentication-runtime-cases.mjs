// Actual production HTTP/WS attempts. Database fault rows are confined to the
// disposable external PostgreSQL fixture; command effects are controlled.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { heartbeat } from "./security-fixtures.mjs";
import { localOwner } from "./project-target-state.mjs";
import { cantripVersion } from "../../packages/version/dist/index.js";
import { workerInferenceStatusSchema } from "../../packages/protocol/dist/index.js";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const WebSocket = require("ws"),
  postgres = require("postgres");
const workerId = "auth-alpha",
  wrongCredential = `ctwk_${"X".repeat(43)}`;
function within(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, no) => {
      timer = setTimeout(() => no(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function workerAuthenticationRuntimeCases(
  origin,
  cookie,
  parent,
  databaseUrl,
  coordination,
) {
  const evidence = (parent.workerAuthentication = { attempts: [], http: [] });
  const session = await fetch(origin + "/api/auth/session", {
    headers: { cookie },
  }).then((r) => r.json());
  const owner = session.currentUser?.id ?? localOwner;
  async function visit(method, route, body, expected = 200) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        cookie,
        origin: "http://127.0.0.1:5173",
        ...(session.csrfToken ? { "x-cantrip-csrf": session.csrfToken } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text(),
      value = text ? JSON.parse(text) : null;
    evidence.http.push({ method, route, status: response.status, body: value });
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  const bootstrap = await visit("GET", "/api/bootstrap");
  const code = await visit(
    "POST",
    "/api/workers/enrollment-codes",
    { label: "Authentication diagnostics" },
    201,
  );
  const enrollment = await visit(
    "POST",
    "/api/internal/workers/enroll",
    {
      code: code.code,
      heartbeat: { ...heartbeat, workerId, name: "Authentication diagnostics" },
    },
    201,
  );
  async function attempt(
    name,
    {
      id = workerId,
      generation = randomUUID(),
      credential = wrongCredential,
      success = false,
    } = {},
  ) {
    const query = new URLSearchParams();
    if (id !== null) query.set("workerId", id);
    if (generation !== null) query.set("connectionGeneration", generation);
    const row = { name, workerId: id, generation, messages: [] };
    evidence.attempts.push(row);
    const startedAt = performance.now();
    const socket = new WebSocket(
      origin.replace(/^http/, "ws") + "/api/internal/workers/connect?" + query,
      ["cantrip-worker-auth-ready-v2"],
      { headers: { authorization: `Bearer ${credential}` } },
    );
    let physicalClosed = false;
    const closed = new Promise((yes) =>
      socket.once("close", (code, reason) => {
        physicalClosed = true;
        row.closedAfterMs = performance.now() - startedAt;
        yes({ code, reason: reason.toString() });
      }),
    );
    let acknowledgeClose;
    const closeFrame = evidence.coordinationLateFailure
      ? new Promise((yes) => {
          const actualClose = socket.close.bind(socket);
          socket.close = (code, reason) => {
            row.serverCloseFrame = { code, reason: reason.toString() };
            row.closeFrameAfterMs = performance.now() - startedAt;
            acknowledgeClose = () => actualClose(code, reason);
            yes();
          };
        })
      : null;
    let configured;
    const configurationResponse = new Promise((yes) => {
      configured = yes;
    });
    const ready = new Promise((yes) =>
      socket.on("message", (bytes) => {
        const envelope = JSON.parse(bytes.toString());
        if (envelope.kind === "connection") {
          row.messages.push(envelope.state);
          assert.equal(envelope.connectionGeneration, generation);
          if (envelope.state === "ready") yes();
        }
        if (envelope.kind !== "request") return;
        let result;
        const command = envelope.command;
        if (command.type === "inference.configure")
          result = workerInferenceStatusSchema.parse({
            serverId: bootstrap.server.id,
            ownerId: owner,
            workerId,
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
        else if (command.type === "model.ollama.catalog")
          result = { models: [], observedAt: new Date().toISOString() };
        else if (command.type === "worker.version") result = cantripVersion;
        else if (command.type === "worktree.observation.configure")
          result = { accepted: true, paths: [] };
        socket.send(
          JSON.stringify({
            kind: "response",
            requestId: envelope.requestId,
            ...(result === undefined
              ? {
                  ok: false,
                  error: {
                    code: "controlled-background",
                    message: "Controlled authentication endpoint",
                  },
                }
              : { ok: true, result }),
          }),
        );
        if (command.type === "inference.configure") configured();
      }),
    );
    socket.once("upgrade", (response) => {
      row.upgradeRequestId = response.headers["x-request-id"] ?? null;
    });
    socket.on("error", (error) => {
      row.error = error.message;
    });
    try {
      if (closeFrame) {
        try {
          await within(closeFrame, "paused claim timeout close frame");
          assert.deepEqual(row.serverCloseFrame, {
            code: 1013,
            reason: "Worker authentication timed out",
          });
          assert.ok(
            row.closeFrameAfterMs >= 9000,
            "actual authentication deadline precedes close",
          );
          await coordination.client.sendCommand([
            "ACL",
            "SETUSER",
            "default",
            "-set",
          ]);
          await coordination.client.sendCommand(["CLIENT", "UNPAUSE"]);
          const failedBy = Date.now() + 5000;
          while (!parent.stderr.includes("Could not claim worker connection")) {
            assert.ok(
              Date.now() < failedBy,
              "late claim error is captured before the close ACK",
            );
            await new Promise((yes) => setTimeout(yes, 10));
          }
          assert.equal(
            physicalClosed,
            false,
            "claim diagnostics do not depend on physical socket closure",
          );
          evidence.lateClaimFailedBeforeCloseAck = true;
        } finally {
          acknowledgeClose?.();
        }
      }
      if (success) {
        await within(
          Promise.race([
            ready,
            closed.then((v) => {
              throw new Error("closed before ready: " + JSON.stringify(v));
            }),
          ]),
          name + " ready",
        );
        await visit("GET", `/api/workers/${workerId}/version`);
        await within(
          configurationResponse,
          "actual initial inference configuration response",
        );
        await visit("GET", `/api/workers/${workerId}/version`);
        socket.close(1000, "authentication case complete");
      }
      row.closed = await within(closed, name + " close");
      if (name === "claim paused")
        assert.ok(
          row.closedAfterMs >= 9000,
          "claim waits through the real authentication deadline",
        );
      assert.deepEqual(row.closed, {
        code: success
          ? 1000
          : ["claim unavailable", "claim paused"].includes(name)
            ? 1013
            : name === "missing generation"
              ? 1002
              : 1008,
        reason: success
          ? "authentication case complete"
          : name === "claim paused"
            ? "Worker authentication timed out"
            : name === "claim unavailable"
              ? "Worker relay coordination is unavailable"
              : name === "missing generation"
                ? "Worker connection generation is required"
                : name === "owner mismatch"
                  ? "Worker identity mismatch"
                  : name === "memory revoked"
                    ? "Worker credential was revoked"
                    : "Unauthorized",
      });
      assert.deepEqual(
        row.messages,
        success
          ? ["pending", "ready"]
          : [
                "invalid credential",
                "invalid credential repeated",
                "other credential",
                "owner mismatch",
                "memory revoked",
                "claim unavailable",
                "claim paused",
              ].includes(name)
            ? ["pending"]
            : [],
      );
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }
  if (coordination) {
    evidence.coordinationPaused = coordination.faultKind.startsWith("pause");
    evidence.coordinationLateFailure =
      coordination.faultKind === "pause-denied";
    evidence.coordinationUnavailable = !evidence.coordinationPaused;
    evidence.privateValues = [
      wrongCredential,
      enrollment.credential,
      "private-generation-marker",
    ];
    await coordination.client.sendCommand(
      evidence.coordinationPaused
        ? ["CLIENT", "PAUSE", "20000", "WRITE"]
        : ["ACL", "SETUSER", "default", "-set"],
    );
    try {
      await attempt(
        evidence.coordinationPaused ? "claim paused" : "claim unavailable",
        { credential: enrollment.credential },
      );
    } finally {
      if (evidence.coordinationLateFailure)
        await coordination.client.sendCommand([
          "ACL",
          "SETUSER",
          "default",
          "-set",
        ]);
      await coordination.client.sendCommand(
        evidence.coordinationPaused
          ? ["CLIENT", "UNPAUSE"]
          : ["ACL", "SETUSER", "default", "+set"],
      );
    }
    if (evidence.coordinationLateFailure) {
      try {
        const failedBy = Date.now() + 5000;
        while (!parent.stderr.includes("Could not claim worker connection")) {
          assert.ok(
            Date.now() < failedBy,
            "late claim error is captured after socket closure",
          );
          await new Promise((yes) => setTimeout(yes, 10));
        }
        assert.deepEqual(
          await coordination.client.keys("*:worker:auth-alpha"),
          [],
        );
        evidence.lateClaimFailedAfterClose = true;
      } finally {
        await coordination.client.sendCommand([
          "ACL",
          "SETUSER",
          "default",
          "+set",
        ]);
      }
    } else if (evidence.coordinationPaused) {
      const claimedBy = Date.now() + 5000;
      while (!parent.stdout.includes("Worker relay ownership claimed")) {
        assert.ok(
          Date.now() < claimedBy,
          "actual queued claim executes after Redis resumes",
        );
        await new Promise((yes) => setTimeout(yes, 10));
      }
      const releasedBy = Date.now() + 5000;
      while ((await coordination.client.keys("*:worker:auth-alpha")).length) {
        assert.ok(
          Date.now() < releasedBy,
          "closed socket releases its real late claim before the sixty-second TTL",
        );
        await new Promise((yes) => setTimeout(yes, 10));
      }
      evidence.lateClaimExecutedAndReleased = true;
    }
    const until = Date.now() + 15000;
    while ((await fetch(origin + "/readyz")).status !== 200) {
      assert.ok(Date.now() < until, "actual coordination recovery readiness");
      await new Promise((yes) => setTimeout(yes, 20));
    }
    return;
  }
  await attempt("missing worker", { id: null });
  await attempt("missing worker repeated", { id: null });
  await attempt("invalid generation", {
    generation: "private-generation-marker",
  });
  await attempt("invalid generation repeated", {
    generation: "private-generation-marker",
  });
  await attempt("other generation", {
    id: "auth-beta",
    generation: "private-generation-marker",
  });
  await attempt("invalid credential");
  await attempt("invalid credential repeated");
  await attempt("other credential", { id: "auth-beta" });
  await attempt("missing generation", { generation: null });
  await attempt("authenticated", {
    credential: enrollment.credential,
    success: true,
  });
  if (databaseUrl) {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`INSERT INTO users(id,kind,display_name) VALUES('auth-foreign-owner','anonymous','Isolated foreign owner')`;
      await sql`UPDATE workers SET owner_id='auth-foreign-owner' WHERE id=${workerId}`;
      try {
        await attempt("owner mismatch", { credential: enrollment.credential });
      } finally {
        await sql`UPDATE workers SET owner_id=${owner} WHERE id=${workerId}`;
      }
      const [{ id }] =
        await sql`SELECT id FROM worker_credentials WHERE worker_id=${workerId} AND revoked_at IS NULL`;
      // Exercise the actual in-memory revocation guard even if durable state is
      // inconsistent. The real API succeeds, while a disposable trigger retains
      // the old timestamp. No service/repository method is replaced.
      await sql.unsafe(`CREATE FUNCTION auth_test_keep_credential_active() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.revoked_at := OLD.revoked_at; RETURN NEW; END $$;
        CREATE TRIGGER auth_test_keep_credential_active BEFORE UPDATE OF revoked_at ON worker_credentials FOR EACH ROW EXECUTE FUNCTION auth_test_keep_credential_active();`);
      try {
        await visit(
          "DELETE",
          `/api/workers/${workerId}/credentials/${id}`,
          undefined,
          204,
        );
        assert.equal(
          (
            await sql`SELECT revoked_at FROM worker_credentials WHERE id=${id}`
          )[0].revoked_at,
          null,
        );
        await attempt("memory revoked", { credential: enrollment.credential });
      } finally {
        await sql.unsafe(
          "DROP TRIGGER auth_test_keep_credential_active ON worker_credentials; DROP FUNCTION auth_test_keep_credential_active();",
        );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  evidence.noisyAttempts = 3;
  evidence.privateValues = [
    wrongCredential,
    enrollment.credential,
    "private-generation-marker",
  ];
}

export function verifyWorkerAuthenticationRuntime(records, evidence, stdout) {
  const expectedNames = [
    "missing worker",
    "invalid generation",
    "other generation",
    "invalid credential",
    "other credential",
    "authenticated",
  ];
  if (evidence.attempts.some((a) => a.name === "owner mismatch"))
    expectedNames.push("owner mismatch", "memory revoked");
  if (evidence.coordinationUnavailable)
    expectedNames.splice(0, expectedNames.length, "claim unavailable");
  if (evidence.coordinationPaused)
    expectedNames.splice(
      0,
      expectedNames.length,
      ...(evidence.coordinationLateFailure ? ["claim paused"] : []),
    );
  const decisions = records.filter(
    (r) =>
      r.context?.event?.startsWith("worker.authentication.") ||
      r.context?.event === "worker.connection.claim-failed",
  );
  assert.equal(
    decisions.length,
    expectedNames.length,
    "one decision per unsuppressed authentication attempt",
  );
  const rows = [],
    ids = new Set();
  for (const [index, raw] of decisions.entries()) {
    assert.equal(new Date(raw.timestamp).toISOString(), raw.timestamp);
    const row = structuredClone(raw);
    delete row.cursor;
    delete row.timestamp;
    const name = expectedNames[index],
      attempt = evidence.attempts.find((a) => a.name === name);
    const id = row.context.requestId;
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.ok(!ids.has(id));
    ids.add(id);
    // Node does not expose its assigned request ID on a successful upgrade.
    // Causally sequential attempts correlate by decision order, reason and ID;
    // preserve actual header presence and correlate it whenever exposed.
    if (attempt.upgradeRequestId !== null)
      assert.equal(id, attempt.upgradeRequestId);
    if (attempt.workerId === null)
      assert.equal(row.context.workerId, undefined);
    else assert.equal(row.context.workerId, attempt.workerId);
    if (row.context.event === "worker.authentication.completed") {
      assert.equal(name, "authenticated");
      assert.ok(
        stdout.includes(`workerProcessGeneration=${attempt.generation}`),
        "full console retains the actual generation",
      );
    }
    row.context.requestId = name;
    rows.push(row);
  }
  for (const secret of evidence.privateValues)
    assert.ok(
      !JSON.stringify(records).includes(secret),
      "authentication input stays out of persisted records",
    );
  return {
    attempts: evidence.attempts.map(
      ({ name, messages, closed, upgradeRequestId }) => ({
        name,
        messages,
        closed,
        upgradeRequestIdPresent: upgradeRequestId !== null,
      }),
    ),
    rows,
  };
}
