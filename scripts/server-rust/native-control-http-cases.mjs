import assert from "node:assert/strict";
import {
  nativeControlContexts,
  seedNativeControl,
  nativeControlSnapshot,
  assertNativeCancelled,
} from "./native-control-http-state.mjs";
import { eventually } from "./full-worker.mjs";

export async function nativeControlHttpCases({ h, result, profile, controls }) {
  for (const p of nativeControlContexts) {
    const seed = (...args) => seedNativeControl(h, p, ...args);
    const snapshot = (label) => nativeControlSnapshot(h, p, result, label);
    const stop = (label, options = {}) =>
      h.visit(
        p.name + " " + label,
        "POST",
        `/api/chats/${p.chat}/interrupt`,
        options,
      );
    await seed();
    assert.deepEqual(await stop("idle stops autonomy"), { interrupted: true });
    const idle = await snapshot("idle stopped");
    assert.equal(idle.stopped, true);
    const before = result.commands.length;
    if (p.name === "project")
      await h.visit(
        "missing Chat stop",
        "POST",
        "/api/chats/missing/interrupt",
        { status: 404 },
      );
    if (profile !== "none") {
      await stop("unauthenticated stop", { client: "stranger", status: 401 });
      await stop("stop requires CSRF", { csrf: false, status: 403 });
    }
    if (profile === "accounts")
      await stop("foreign owner stop", { client: "other", status: 404 });
    assert.deepEqual(await snapshot("rejected requests unchanged"), idle);
    assert.equal(result.commands.length, before);
    for (const answer of [false, true]) {
      await seed("running");
      controls.interrupted = answer;
      assert.deepEqual(await stop("legacy interrupt " + answer), {
        interrupted: answer,
      });
      const state = await snapshot("legacy acknowledgement " + answer);
      assert.equal(state.stopped, true);
      assert.equal(state.chatStatus, "running");
      assert.equal(state.operation, null);
    }
    for (const answer of [false, true]) {
      await seed("running", "dispatched");
      controls.interrupted = answer;
      assert.deepEqual(await stop("dispatched native interrupt " + answer), {
        interrupted: answer,
      });
      const state = await snapshot("native authority retained " + answer);
      assert.equal(state.operation.status, "dispatched");
      assert.equal(state.activation.active, true);
      assert.equal(state.activation.logicalCancelled, true);
      assert.equal(state.operation.logicalCompleted, false);
      assert.equal(state.chatStatus, "running");
    }
    for (const logical of [false, true]) {
      await seed("running", "accepted", logical);
      const before = result.commands.length;
      assert.deepEqual(await stop("cancel accepted " + logical), {
        interrupted: true,
      });
      assertNativeCancelled(
        await snapshot("accepted cancellation " + logical),
        p,
        logical,
      );
      assert.equal(result.commands.length, before + Number(logical));
      assert.deepEqual(await stop("cancel replay " + logical), {
        interrupted: true,
      });
      assertNativeCancelled(
        await snapshot("cancellation replay " + logical),
        p,
        logical,
      );
      assert.equal(result.commands.length, before + Number(logical));
    }
    await seed("running", "accepted");
    controls.mode = "notification-error";
    assert.deepEqual(await stop("notification fails after commit"), {
      interrupted: true,
    });
    assertNativeCancelled(
      await snapshot("failed notification keeps cancellation committed"),
      p,
    );
    controls.mode = "normal";
    await seed("running", "accepted");
    await h.fixture.sql([
      "CREATE FUNCTION native_control_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='rejected' THEN RAISE EXCEPTION 'native-control-transaction-rejection'; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER native_control_reject BEFORE UPDATE ON native_commands FOR EACH ROW EXECUTE FUNCTION native_control_reject()",
    ]);
    const beforeFailure = result.commands.length;
    await stop("actual SQL cancellation failure", { status: 500 });
    const failed = await snapshot("cancellation transaction rolled back");
    assert.equal(failed.stopped, true);
    assert.equal(failed.chatStatus, "running");
    assert.equal(failed.operation.status, "accepted");
    assert.equal(failed.operation.logicalCompleted, false);
    assert.equal(failed.activation.active, true);
    assert.equal(result.commands.length, beforeFailure);
    await h.fixture.sql([
      "DROP TRIGGER native_control_reject ON native_commands",
      "DROP FUNCTION native_control_reject()",
    ]);
    assert.deepEqual(await stop("retry after real SQL failure"), {
      interrupted: true,
    });
    assertNativeCancelled(
      await snapshot("durable cancellation after retry"),
      p,
    );

    // The transaction has already committed while the actual worker response
    // remains held. Losing the HTTP caller must not undo accepted Stop.
    await seed("running", "accepted");
    const held = controls.hold();
    const abort = new AbortController();
    const request = stop("caller disconnects during notification", {
      fetcher: (url, init) => fetch(url, { ...init, signal: abort.signal }),
    }).then(
      () => assert.fail("held cancellation cannot reply before release"),
      (error) => error,
    );
    try {
      await eventually(
        () => held.requested,
        (value) => assert.equal(value, true),
        15000,
      );
      assertNativeCancelled(
        await snapshot("cancellation committed before caller disconnect"),
        p,
      );
      abort.abort();
      assert.equal((await request).name, "AbortError");
      held.release();
      await eventually(
        () => held.released,
        (value) => assert.equal(value, true),
        15000,
      );
      assertNativeCancelled(
        await snapshot("cancellation survives caller disconnect"),
        p,
      );
      result.disconnections.push({
        context: p.name,
        phase: "after-commit-before-notification-ack",
        error: "AbortError",
      });
    } finally {
      abort.abort();
      held.release();
      controls.mode = "normal";
    }

    await seed("running", "accepted");
    const replacing = controls.hold();
    const pending = stop("worker replacement after cancellation commit");
    try {
      await eventually(
        () => replacing.requested,
        (value) => assert.equal(value, true),
        15000,
      );
      assertNativeCancelled(
        await snapshot("cancellation committed before worker replacement"),
        p,
      );
      const previous = h.worker,
        oldGeneration = previous.connectionGeneration();
      await h.reconnectWorker();
      previous.close();
      const generation = h.worker.connectionGeneration();
      assert.equal(typeof oldGeneration, "string");
      assert.equal(typeof generation, "string");
      assert.notEqual(generation, oldGeneration);
      assert.deepEqual(await pending, { interrupted: true });
      result.rawReplacements.push({
        context: p.name,
        oldGeneration,
        generation,
      });
      result.replacements.push({ context: p.name, generationChanged: true });
      replacing.release();
      assertNativeCancelled(
        await snapshot("cancellation survives worker replacement"),
        p,
      );
    } finally {
      replacing.release();
      controls.mode = "normal";
    }

    await seed("running", "accepted");
    const expiring = controls.hold();
    const startedAt = Date.now();
    try {
      const response = await stop("actual cancellation notification deadline", {
        timeoutMs: 20000,
      });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(expiring.requested, true);
      assert.equal(
        expiring.released,
        false,
        "server deadline expires while the worker response remains held",
      );
      assert.deepEqual(response, { interrupted: true });
      assert.ok(
        elapsedMs >= 4750 && elapsedMs < 15000,
        "actual five-second notification deadline",
      );
      result.rawDeadlines.push({ context: p.name, elapsedMs });
      result.deadlines.push({
        context: p.name,
        notificationDeadlineMs: 5000,
        cancellationSurvived: true,
      });
      assertNativeCancelled(
        await snapshot("cancellation survives actual notification deadline"),
        p,
      );
    } finally {
      expiring.release();
      controls.mode = "normal";
    }
  }
}
