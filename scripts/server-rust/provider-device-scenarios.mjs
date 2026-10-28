import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { LiveProbe, deadline } from "./live-sockets.mjs";

const provider = "status-chatgpt,",
  workerId = "fixture-worker,\uFFFD";
const login = {
  loginId: "fixture-device-login",
  verificationUrl: "https://auth.example.invalid/device",
  userCode: "ABCD-1234",
};
const safe = (state, extra = {}) => ({
  state,
  authMode: null,
  email: null,
  planType: null,
  weeklyUsage: null,
  failureCode: null,
  ...extra,
});

// Independent requests may finish in either order. Preserve raw wire order in
// the report and compare complete payloads as a pair only for explicitly
// concurrent, distinct-account phases. Revision checks still use wire order.
export function comparableDeviceEvents(events) {
  const result = [];
  for (let index = 0; index < events.length;) {
    const current = events[index];
    if (!current.comparisonGroup) {
      result.push(current.payload);
      index++;
      continue;
    }
    const group = [];
    while (
      index < events.length &&
      events[index].comparisonGroup === current.comparisonGroup
    )
      group.push(events[index++].payload);
    assert.equal(
      group.length,
      2,
      "independent account phase has exactly two publications",
    );
    assert.equal(
      new Set(group.map((payload) => payload.providerAccountId)).size,
      2,
    );
    group.sort((a, b) => (a.providerAccountId < b.providerAccountId ? -1 : 1));
    result.push(...group);
  }
  return result;
}

export function deviceScenarios({
  fixture,
  result,
  ids,
  captureModes,
  databaseMode,
}) {
  const starts = new Map(),
    modes = new Map(),
    heldStarts = new Map(),
    heldCaptures = new Map(),
    heldPurges = new Map(),
    pairedStarts = new Map();
  let live,
    foreignLive,
    worker,
    comparisonGroup = null;
  result.deviceEvents = [];
  const reply = (frame, socket, value, ok = true) =>
    socket.send(
      JSON.stringify({
        kind: "response",
        requestId: frame.requestId,
        ok,
        ...(ok
          ? { result: value }
          : { error: { code: "fixture-device", message: value } }),
      }),
    );
  const post = async (label, json, status = 200, options = {}) => {
    const started = Date.now();
    const observed = await fixture.observe(
      label,
      "POST",
      "/api/codex/auth/device-login",
      { csrf: true, json, status, ...options },
    );
    if (observed.body?.error?.startsWith("Failed query: ")) {
      (result.deviceQueryErrors ??= []).push({
        label,
        error: observed.body.error,
      });
      observed.body.error = observed.body.error
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
          (id) => fixture.normalize(id),
        )
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
          assert.ok(
            Date.parse(stamp) >= started && Date.parse(stamp) <= Date.now(),
            "actual account-status write timestamp",
          );
          return "<query-timestamp>";
        });
    }
    result.observations.push({ label, ...observed });
    return fixture.records.get(label);
  };
  const compareHttpPair = (start) => {
    const rows = result.observations.splice(start);
    assert.equal(
      rows.length,
      2,
      "concurrent phase has exactly two HTTP responses",
    );
    assert.equal(new Set(rows.map((row) => row.label)).size, 2);
    (result.concurrentHttpResponseOrder ??= []).push(
      rows.map((row) => row.label),
    );
    rows.sort((a, b) => (a.label < b.label ? -1 : 1));
    result.observations.push(...rows);
  };
  const start = async (name, label = name) => {
    assert.deepEqual(
      await post("device " + label, {
        providerId: provider,
        accountId: ids[name],
        workerId,
      }),
      login,
    );
    return starts.get(ids[name]);
  };
  const readStatus = async (name, label = name) => {
    const observed = await fixture.observe(
      "device status " + label,
      "GET",
      "/api/codex/auth/status?" +
        new URLSearchParams({ providerId: provider, accountId: ids[name] }),
    );
    result.observations.push({ label: "device status " + label, ...observed });
    return fixture.records.get("device status " + label);
  };
  const event = async (name, state, expected) => {
    const frame = await live.message(
      (frame) =>
        frame.type === "event" &&
        frame.resource === "provider-auth" &&
        (Array.isArray(name) ? name : [name]).some(
          (key) => frame.entityId === ids[key],
        ),
    );
    assert.equal(frame.action, "status");
    assert.equal(frame.payload.status.state, state);
    assert.equal(frame.revision, frame.payload.revision);
    assert.ok(Number.isSafeInteger(frame.revision));
    if (result.deviceEvents.length)
      assert.ok(frame.revision > result.deviceEvents.at(-1).actualRevision);
    if (typeof expected === "function") expected = expected(frame);
    if (expected) {
      assert.equal(frame.payload.observedAt, expected.observedAt);
      assert.equal(
        frame.payload.expiresAt,
        expected.expiresAt,
        "publish the original expiry, not its internal clamp",
      );
    } else {
      assert.equal(
        Date.parse(frame.payload.expiresAt) -
          Date.parse(frame.payload.observedAt),
        15 * 60_000,
      );
      assert.ok(
        Math.abs(Date.now() - Date.parse(frame.payload.observedAt)) < 15000,
      );
    }
    const payload = fixture.normalize({
      ...frame.payload,
      observedAt: "<observed-at>",
      expiresAt: frame.payload.expiresAt === null ? null : "<expires-at>",
      revision: "<monotonic>",
    });
    result.deviceEvents.push({
      actualRevision: frame.revision,
      payload,
      comparisonGroup,
    });
    return frame;
  };
  const observation = (
    command,
    sequence,
    status = safe("pending"),
    overrides = {},
  ) => ({
    type: "provider.auth.status.observed",
    observationId: command.observationId,
    providerId: command.providerId,
    providerAccountId: command.providerAccountId,
    providerKind: command.providerKind,
    sequence,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    status,
    ...overrides,
  });
  const send = (notification) =>
    worker.socket.send(JSON.stringify({ kind: "notification", notification }));
  return {
    onRequest(frame, socket) {
      const command = frame.command;
      if (
        command.type === "provider.auth.legacy.purge" &&
        heldPurges.has(command.providerAccountId)
      ) {
        heldPurges.get(command.providerAccountId)();
        return true;
      }
      if (command.type === "codex.auth.login.start") {
        assert.match(command.observationId, /^[0-9a-f-]{36}$/);
        assert.equal(command.providerId, provider);
        assert.equal(command.providerKind, "chatgpt");
        assert.equal(command.credentialHomeKey, command.providerAccountId);
        starts.set(command.providerAccountId, command);
        const mode = modes.get(command.providerAccountId);
        if (mode === "hold-pair") {
          const pair = pairedStarts.get(command.providerAccountId) ?? [];
          pair.push({ command, release: () => reply(frame, socket, login) });
          pairedStarts.set(command.providerAccountId, pair);
        } else if (mode === "hold")
          heldStarts.set(command.providerAccountId, () =>
            reply(frame, socket, login),
          );
        else if (mode === "failed")
          reply(frame, socket, "controlled device command failure", false);
        else if (mode === "invalid")
          reply(frame, socket, {
            loginId: "",
            verificationUrl: "not-a-url",
            userCode: "",
          });
        else reply(frame, socket, { ...login, ignored: true });
        return true;
      }
      if (
        command.type === "provider.auth.legacy.capture" &&
        heldCaptures.has(command.providerAccountId)
      ) {
        result.captureCalls.push(command);
        const holding = heldCaptures.get(command.providerAccountId);
        holding.release = () =>
          reply(frame, socket, {
            status: "available",
            credential: holding.credential,
            metadata: { expiresAt: null },
            portableAuth: true,
          });
        holding.resolve();
        return true;
      }
      return false;
    },
    async run(probe, credential) {
      worker = probe;
      if (fixture.environment.CANTRIP_AUTH_MODE === "accounts")
        await post(
          "device anonymous request",
          { providerId: provider, workerId },
          401,
          { client: "anonymous", csrf: false },
        );
      for (const input of [
        undefined,
        null,
        {},
        { providerId: provider },
        { workerId },
        { providerId: "", workerId },
        { providerId: provider, workerId: false },
      ])
        await post(
          "device missing fields " + JSON.stringify(input),
          input,
          400,
        );
      await post(
        "device csrf required",
        { providerId: provider, workerId },
        fixture.environment.CANTRIP_AUTH_MODE === "accounts" ? 403 : 200,
        { csrf: false },
      );
      for (const [label, body] of [
        ["missing worker", { providerId: provider, workerId: "missing" }],
        ["foreign provider", { providerId: "status-foreign", workerId }],
        ["wrong provider kind", { providerId: "status-wrong", workerId }],
        [
          "missing account",
          { providerId: provider, workerId, accountId: "missing" },
        ],
        [
          "truthy empty account array",
          { providerId: provider, workerId, accountId: [] },
        ],
      ])
        await post("device " + label, body, 404);
      await post(
        "device raw worker reference stays offline",
        { providerId: provider, workerId: ["fixture-worker", "\uFFFD"] },
        503,
      );
      await post(
        "device raw surrogate worker cannot alias its database replacement",
        { providerId: provider, workerId: "fixture-worker,\uD800" },
        503,
      );
      await post(
        "device actual NUL worker query failure",
        { providerId: provider, workerId: workerId + "\u0000" },
        502,
      );
      await post(
        "device worker primitive conversion failure",
        { providerId: provider, workerId: { toString: null } },
        502,
      );
      await post(
        "device raw boolean worker",
        { providerId: provider, workerId: true },
        databaseMode === "pglite" ? 404 : 502,
      );
      await post(
        "device raw provider array reaches command validation",
        { providerId: ["status-chatgpt", ""], workerId },
        502,
      );
      modes.set(ids.deviceError, "failed");
      await post(
        "device command failure",
        { providerId: provider, accountId: ids.deviceError, workerId },
        502,
      );
      assert.equal((await readStatus("deviceError")).loginPending, false);
      modes.set(ids.deviceInvalid, "invalid");
      await post(
        "device malformed login result",
        { providerId: provider, accountId: ids.deviceInvalid, workerId },
        502,
      );
      assert.equal((await readStatus("deviceInvalid")).loginPending, false);

      for (const name of ["deviceBadStatus", "deviceBadBinding"]) {
        const response = await post(
          "device actual SQL failure " + name,
          { providerId: provider, accountId: ids[name], workerId },
          502,
        );
        assert.ok(response.error.startsWith("Failed query: "));
        assert.equal(
          (
            await readStatus(
              name,
              name + " keeps its observation after SQL rollback",
            )
          ).loginPending,
          true,
        );
      }
      live = new LiveProbe(fixture);
      await live.open();
      await live.initialized();
      await live.subscribed();
      if (fixture.environment.CANTRIP_AUTH_MODE === "accounts") {
        foreignLive = new LiveProbe(fixture, { client: "other" });
        await foreignLive.open();
        await foreignLive.initialized();
        await foreignLive.subscribed();
      }
      const pending = await start("devicePending");
      await event("devicePending", "pending");
      assert.equal(
        (await readStatus("devicePending", "pending")).loginPending,
        true,
      );
      for (const override of [
        { observationId: "00000000-0000-4000-8000-000000000000" },
        { providerId: "status-foreign" },
        { providerAccountId: ids.deviceError },
        { providerKind: "grok" },
        { observedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
        { observedAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      ])
        send(observation(pending, 1, safe("pending"), override));
      const accepted = observation(pending, 1);
      send(accepted);
      await event("devicePending", "pending", accepted);
      send(observation(pending, 1));
      const next = observation(pending, 2);
      send(next);
      await event("devicePending", "pending", next);
      const expired = observation(pending, 3, safe("pending"), {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      send(expired);
      await event("devicePending", "pending", expired);
      const revived = observation(pending, 4);
      send(revived);
      await event("devicePending", "pending", revived);
      assert.equal(
        (
          await readStatus(
            "devicePending",
            "expired observation accepts a fresh sequence",
          )
        ).loginPending,
        true,
      );
      const expiredAgain = observation(pending, 5, safe("pending"), {
        expiresAt: expired.expiresAt,
      });
      send(expiredAgain);
      await event("devicePending", "pending", expiredAgain);
      const expiredStatus = await readStatus("devicePending", "expired");
      assert.equal(expiredStatus.loginPending, false);
      assert.equal(
        expiredStatus.loginError,
        "The provider sign-in code expired.",
      );
      send(observation(pending, 6));

      const failed = await start("deviceMissing");
      await event("deviceMissing", "pending");
      const authenticated = safe("authenticated", {
        authMode: "chatgpt",
        email: "fixture@example.invalid",
        planType: "pro",
        weeklyUsage: { usedPercent: 12.34, resetsAt: 1793577600 },
      });
      const missing = observation(failed, 1, authenticated);
      send(missing);
      const failedEvent = await event("deviceMissing", "failed", missing);
      assert.equal(
        failedEvent.payload.status.failureCode,
        "credential-capture-failed",
      );
      assert.equal((await readStatus("deviceMissing")).authenticated, false);
      captureModes.set(ids.deviceMissing, "failed");
      const failedCapture = await start(
        "deviceMissing",
        "worker capture failure stays safe",
      );
      await event("deviceMissing", "pending");
      const captureError = observation(failedCapture, 1, authenticated);
      send(captureError);
      const safeFailure = await event("deviceMissing", "failed", captureError);
      assert.equal(
        safeFailure.payload.status.failureCode,
        "credential-capture-failed",
      );
      assert.ok(!JSON.stringify(safeFailure.payload).includes("DO_NOT_LEAK"));
      captureModes.set(ids.deviceSuccess, "available");
      const success = await start("deviceSuccess");
      await event("deviceSuccess", "pending");
      const signedIn = observation(success, 1, authenticated);
      send(signedIn);
      await event("deviceSuccess", "authenticated", signedIn);
      assert.equal((await readStatus("deviceSuccess")).authenticated, true);

      // Hold both worker replies so both HTTP requests have completed their
      // observation replacement. There must be exactly one pending publication
      // and one terminal publication, regardless of command arrival order.
      modes.set(ids.deviceConcurrent, "hold-pair");
      for (let iteration = 0; iteration < 8; iteration++) {
        pairedStarts.set(ids.deviceConcurrent, []);
        const responseStart = result.observations.length;
        const replies = Promise.all(
          [0, 1].map((index) =>
            post(`device concurrent ${iteration}/${index}`, {
              providerId: provider,
              accountId: ids.deviceConcurrent,
              workerId,
            }),
          ),
        );
        await deadline(
          (async () => {
            while (pairedStarts.get(ids.deviceConcurrent).length !== 2)
              await new Promise((resolve) => setTimeout(resolve, 5));
          })(),
          "both concurrent login commands",
        );
        const pair = pairedStarts.get(ids.deviceConcurrent);
        assert.notEqual(
          pair[0].command.observationId,
          pair[1].command.observationId,
        );
        for (const pending of pair) pending.release();
        for (const value of await replies) assert.deepEqual(value, login);
        compareHttpPair(responseStart);
        await event("deviceConcurrent", "pending");
        const time = Date.now();
        const candidates = pair.map(({ command }, index) =>
          observation(command, 1, safe("signed-out"), {
            observedAt: new Date(time + index).toISOString(),
          }),
        );
        for (const note of candidates) send(note);
        await event("deviceConcurrent", "signed-out", (frame) => {
          const expected = candidates.find(
            (note) => note.observedAt === frame.payload.observedAt,
          );
          assert.ok(
            expected,
            "terminal publication belongs to one admitted login",
          );
          return expected;
        });
      }

      // Distinct accounts can both publish after concurrent database work.
      // Read those frames in wire order and require increasing auth revisions.
      const parallelNames = ["deviceParallelOne", "deviceParallelTwo"];
      for (const name of parallelNames) modes.set(ids[name], "hold-pair");
      for (let iteration = 0; iteration < 4; iteration++) {
        for (const name of parallelNames) pairedStarts.set(ids[name], []);
        const responseStart = result.observations.length;
        const replies = Promise.all(
          parallelNames.map((name) =>
            post(`device parallel ${iteration}/${name}`, {
              providerId: provider,
              accountId: ids[name],
              workerId,
            }),
          ),
        );
        await deadline(
          (async () => {
            while (
              !parallelNames.every(
                (name) => pairedStarts.get(ids[name]).length === 1,
              )
            )
              await new Promise((resolve) => setTimeout(resolve, 5));
          })(),
          "both independent account commands",
        );
        const pair = parallelNames.map(
          (name) => pairedStarts.get(ids[name])[0],
        );
        for (const pending of pair) pending.release();
        for (const value of await replies) assert.deepEqual(value, login);
        compareHttpPair(responseStart);
        comparisonGroup = `parallel-${iteration}-pending`;
        const pendingEvents = [
          await event(parallelNames, "pending"),
          await event(parallelNames, "pending"),
        ];
        assert.equal(
          new Set(pendingEvents.map((frame) => frame.entityId)).size,
          2,
        );
        const candidates = pair.map(({ command }) =>
          observation(command, 1, safe("signed-out")),
        );
        for (const note of candidates) send(note);
        const expected = (frame) => {
          const note = candidates.find(
            (note) =>
              note.providerAccountId === frame.payload.providerAccountId,
          );
          assert.ok(
            note,
            "terminal publication belongs to one independent account",
          );
          return note;
        };
        comparisonGroup = `parallel-${iteration}-terminal`;
        const terminalEvents = [
          await event(parallelNames, "signed-out", expected),
          await event(parallelNames, "signed-out", expected),
        ];
        assert.equal(
          new Set(terminalEvents.map((frame) => frame.entityId)).size,
          2,
        );
        comparisonGroup = null;
      }

      // A terminal observation can finish while login.start still awaits its
      // response. The late successful reply must not restore pending state.
      modes.set(ids.deviceEarly, "hold");
      const earlyRequest = start("deviceEarly");
      await deadline(
        (async () => {
          while (!heldStarts.has(ids.deviceEarly))
            await new Promise((r) => setTimeout(r, 5));
        })(),
        "early terminal login start",
      );
      const early = observation(
        starts.get(ids.deviceEarly),
        1,
        safe("signed-out"),
      );
      send(early);
      await event("deviceEarly", "signed-out", early);
      heldStarts.get(ids.deviceEarly)();
      await earlyRequest;
      assert.equal((await readStatus("deviceEarly")).loginPending, false);

      // Retain the original active object while capture awaits a worker. A
      // new login removes its map entry but must not cancel the old capture.
      const old = await start("deviceRace");
      await event("deviceRace", "pending");
      let captured;
      const capturing = new Promise((resolve) => {
        captured = resolve;
      });
      const hold = { resolve: captured, credential };
      heldCaptures.set(ids.deviceRace, hold);
      const oldAuth = observation(old, 1, authenticated);
      send(oldAuth);
      await deadline(capturing, "owned observation capture");
      const replacement = await start(
        "deviceRace",
        "replacement retains old admitted observation",
      );
      await event("deviceRace", "pending");
      hold.release();
      heldCaptures.delete(ids.deviceRace);
      await event("deviceRace", "authenticated", oldAuth);
      assert.equal(
        (await readStatus("deviceRace", "replacement remains pending"))
          .loginPending,
        true,
      );
      const stopReplacement = observation(replacement, 1, safe("signed-out"));
      send(stopReplacement);
      await event("deviceRace", "signed-out", stopReplacement);

      // Exercise an actual disconnected HTTP client, then observe pending and
      // completion through Live without issuing another worker command.
      modes.set(ids.deviceCancelled, "hold");
      const client = fixture.client();
      const csrf = client.csrf;
      const caller = httpRequest(
        fixture.server.origin + "/api/codex/auth/device-login",
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            "content-type": "application/json",
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
            connection: "close",
          },
        },
      );
      const failure = new Promise((resolve) => caller.once("error", resolve));
      const closed = new Promise((resolve) => caller.once("close", resolve));
      caller.end(
        JSON.stringify({
          providerId: provider,
          accountId: ids.deviceCancelled,
          workerId,
        }),
      );
      await deadline(
        (async () => {
          while (!heldStarts.has(ids.deviceCancelled))
            await new Promise((r) => setTimeout(r, 5));
        })(),
        "disconnected device command",
      );
      const disconnect = new Error("controlled device caller disconnect");
      caller.destroy(disconnect);
      assert.equal(await failure, disconnect);
      await closed;
      heldStarts.get(ids.deviceCancelled)();
      await event("deviceCancelled", "pending");
      captureModes.set(ids.deviceCancelled, "available");
      const completed = observation(
        starts.get(ids.deviceCancelled),
        1,
        authenticated,
      );
      send(completed);
      await event("deviceCancelled", "authenticated", completed);
      assert.equal((await readStatus("deviceCancelled")).authenticated, true);
      result.deviceCallerDisconnected = true;
      await live.ping();
      const actualEvents = live.history.filter(
        (frame) => frame.type === "event" && frame.resource === "provider-auth",
      );
      assert.equal(
        actualEvents.length,
        result.deviceEvents.length,
        "ignored, duplicate and terminal notifications cannot add Live events",
      );
      if (foreignLive) {
        await foreignLive.ping();
        assert.equal(
          foreignLive.history.filter(
            (frame) =>
              frame.type === "event" &&
              ["settings", "provider-auth"].includes(frame.resource),
          ).length,
          0,
        );
      }
    },
    async shutdown() {
      captureModes.set(ids.deviceShutdown, "available");
      const command = await start("deviceShutdown", "shutdown capture");
      let ready;
      const purging = new Promise((resolve) => {
        ready = resolve;
      });
      heldPurges.set(ids.deviceShutdown, ready);
      const signedIn = observation(
        command,
        1,
        safe("authenticated", {
          authMode: "chatgpt",
          email: null,
          planType: "pro",
          weeklyUsage: { usedPercent: 45.67, resetsAt: 1793577600 },
        }),
      );
      send(signedIn);
      await deadline(purging, "credential committed before held purge");
      await fixture.close();
      await worker.waitClosed();
      heldPurges.delete(ids.deviceShutdown);
      result.deviceNotificationShutdownCompleted = true;
    },
    async retainedShutdown() {
      const status = await readStatus(
        "deviceShutdown",
        "notification finishes its write during shutdown",
      );
      assert.equal(status.authenticated, true);
      assert.deepEqual(status.weeklyUsage, {
        usedPercent: 45.67,
        resetsAt: 1793577600,
      });
    },
    async close() {
      await foreignLive?.close();
      foreignLive = undefined;
      await live?.close();
      live = undefined;
    },
  };
}
