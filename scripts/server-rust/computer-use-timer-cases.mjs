// Actual worker deadlines; input.perform's lifetime is explicitly unbounded.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { input, id } from "./computer-use-http-fixtures.mjs";
import { gate } from "./worker-log-stream-probe.mjs";
import { eventually } from "./full-worker.mjs";

export async function computerUseTimerCases({ state, visit, result }) {
  const release = gate(),
    offset = state.commands.length;
  state.hold = release.promise;
  const root = "/api/chats/chat/computer-use";
  const pending = [];
  const timed = (name, path, status, json) => {
    const index = result.cases.length;
    result.cases.push({ name, pending: true });
    const promise = (async () => {
      const started = performance.now();
      await visit(name, "POST", root + path, {
        status,
        json,
        timeoutMs: 60000,
      });
      const elapsedMs = performance.now() - started;
      assert.ok(
        elapsedMs >= 30000 && elapsedMs < 50000,
        `${name}: ${elapsedMs}ms`,
      );
      (result.deadlines ??= []).push({ name, elapsedMs, deadlineMs: 30000 });
      result.cases[index] = { name, deadlineMs: 30000 };
    })();
    pending.push(promise);
  };
  let perform,
    finished = false;
  try {
    timed("actual preview deadline", "/preview", 502, {});
    timed("actual Stop deadline", "/preview/stop", 409, {
      leaseId: id(3),
      workerId: "alpha",
    });
    timed("actual operation deadline", "/operation", 502, input(70));
    const started = performance.now();
    perform = visit(
      "long input outlives default operation deadline",
      "POST",
      root + "/operation",
      { json: input(71, "input.perform"), timeoutMs: 60000 },
    ).then((value) => {
      finished = true;
      return value;
    });
    await eventually(
      () => state.commands.length - offset,
      (count) => assert.equal(count, 4),
    );
    await delay(31000);
    assert.equal(
      finished,
      false,
      "input.perform must remain active beyond 30 seconds",
    );
    await Promise.all(pending);
    release.resolve();
    assert.equal((await perform).response.operationId, id(71));
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs >= 31000);
    (result.deadlines ??= []).push({
      name: "input.perform has no default deadline",
      elapsedMs,
      deadlineMs: null,
    });
    result.cases.push({
      name: "input.perform completes only after the held native action is released beyond 30 seconds",
      passed: true,
    });
  } finally {
    release.resolve();
    delete state.hold;
    await Promise.allSettled([...pending, ...(perform ? [perform] : [])]);
  }
}
