// Real competing writes, caller destruction, and authenticated socket revocation.
import assert from "node:assert/strict";
import { request } from "node:http";
import { SurfaceProbe } from "./remote-surface-socket-cases.mjs";
import { bounded, gate } from "./worker-log-stream-probe.mjs";
import { osIds } from "./remote-desktop-os-cases.mjs";
import { state as protectedState, literal } from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
const headers = (f) => ({
  origin: "http://127.0.0.1:5173",
  "content-type": "application/json",
  cookie: [...f.client().cookies].map(([k, v]) => `${k}=${v}`).join("; "),
  ...(f.client().csrf ? { "x-cantrip-csrf": f.client().csrf } : {}),
});
export async function remoteSurfaceBoundaryCases({
  f,
  state,
  visit,
  result,
  profile,
  timers,
}) {
  const states = ["A", "B"].map((last) => {
    const value = protectedState("browser-state");
    value.protectedState.envelope.nonce = "A".repeat(15) + last;
    return value;
  });
  const replies = await Promise.all(
    states.map(async (value, index) => {
      const response = await fetch(
        f.server.origin + "/api/remote-surfaces/raw-browser",
        {
          method: "PATCH",
          headers: headers(f),
          body: JSON.stringify({
            expectedStateRevision: 2,
            stateProtection: value,
          }),
        },
      );
      const body = await response.json();
      assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
      return { index, status: response.status, body };
    }),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  const won = replies.find((r) => r.status === 200),
    lost = replies.find((r) => r.status === 409);
  assert.equal(won.body.stateRevision, 3);
  assert.deepEqual(won.body.stateProtection, states[won.index]);
  assert.deepEqual(lost.body, {
    code: "stale-state",
    error: "Remote Surface state changed before this update.",
  });
  const [saved] = await f.sql(
    [],
    [
      "SELECT jsonb_build_object('state',protected_state,'revision',state_revision)::text result FROM remote_surfaces WHERE id='raw-browser'",
    ],
  );
  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.state, states[won.index]);
  result.boundaries = { competingWrites: { replies, saved } };
  result.cases.push({
    name: "competing state writes commit exactly one matching protected envelope",
    statuses: [200, 409],
    revision: 3,
    passed: true,
  });

  const id = osIds.desktop,
    expected = timers ? 3 : 2,
    release = gate();
  const offset = state.commands.length;
  state.holds = { "surface.configure": release.promise };
  state.errors = {
    "surface.configure": "Private worker failure after caller destruction",
  };
  await f.sql([
    `UPDATE remote_surfaces SET status='idle',last_error=NULL WHERE id=${literal(id)}`,
  ]);
  const raw = JSON.stringify({
    expectedStateRevision: expected,
    stateProtection: protectedState("remote-desktop-state"),
  });
  const closed = gate();
  const caller = request(f.server.origin + "/api/remote-desktops/" + id, {
    method: "PATCH",
    headers: {
      ...headers(f),
      "content-length": Buffer.byteLength(raw),
      connection: "close",
    },
    agent: false,
  });
  const errors = [];
  caller.on("error", (error) => errors.push(error.code));
  caller.on("close", closed.resolve);
  try {
    caller.end(raw);
    await eventually(
      () =>
        state.commands
          .slice(offset)
          .find((c) => c.type === "surface.configure" && c.surfaceId === id),
      (command) => {
        assert.ok(command);
        assert.equal(command.stateRevision, expected + 1);
      },
    );
    caller.destroy();
    await bounded(closed.promise, "destroyed surface HTTP caller");
    assert.equal(caller.destroyed, true);
    release.resolve();
    await eventually(
      async () => {
        const [row] = await f.sql(
          [],
          [
            `SELECT jsonb_build_object('revision',state_revision,'state',protected_state,'status',status,'error',last_error)::text result FROM remote_surfaces WHERE id=${literal(id)}`,
          ],
        );
        return row;
      },
      (row) => {
        assert.equal(row.revision, expected + 1);
        assert.deepEqual(row.state, protectedState("remote-desktop-state"));
        assert.equal(row.status, "error");
        assert.equal(
          row.error,
          "The worker could not apply the encrypted Remote Desktop target.",
        );
      },
    );
    result.boundaries.callerLoss = { destroyed: caller.destroyed, errors };
    result.cases.push({
      name: "configuration failure completes its durable status write after the HTTP caller is destroyed",
      revision: expected + 1,
      passed: true,
    });
  } finally {
    release.resolve();
    delete state.holds;
    delete state.errors;
    caller.destroy();
  }

  if (profile !== "none") {
    const socket = new SurfaceProbe(f);
    await socket.open();
    const ready = await socket.message();
    assert.equal(ready.type, "ready");
    try {
      await visit("logout revokes surface socket", "POST", "/api/auth/logout", {
        status: 204,
        json: {},
      });
      assert.deepEqual(
        await bounded(socket.closed, "surface session revocation"),
        { code: 1008, reason: "Session was revoked" },
      );
      await eventually(
        () =>
          state.commands.filter(
            (c) =>
              c.type === "surface.detach" &&
              c.attachmentId === ready.attachmentId,
          ).length,
        (n) => assert.equal(n, 1),
      );
      await visit("restore surface test session", "POST", "/api/auth/login", {
        json:
          profile === "accounts"
            ? { email: "insights@example.invalid", password }
            : { password },
      });
      result.cases.push({
        name: "session revocation closes only the bound application attachment",
        close: socket.closeResult,
        passed: true,
      });
    } finally {
      await socket.close();
    }
  }
}
export async function remoteSurfaceWorkerDisconnect({
  f,
  state,
  worker,
  result,
}) {
  const socket = new SurfaceProbe(f);
  await socket.open();
  assert.equal((await socket.message()).type, "ready");
  worker.close();
  try {
    assert.deepEqual(
      await bounded(socket.closed, "surface worker disconnect"),
      { code: 1013, reason: "Remote Surface worker disconnected" },
    );
    await eventually(
      () => state.disconnects,
      (n) => assert.ok(n >= 1),
    );
    result.cases.push({
      name: "worker disconnection closes the active legacy surface",
      close: socket.closeResult,
      passed: true,
    });
  } finally {
    await socket.close();
  }
}
