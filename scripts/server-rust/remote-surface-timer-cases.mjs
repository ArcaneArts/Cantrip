// Actual production 20/30-second deadlines; no accelerated clocks or timeouts.
import assert from "node:assert/strict";
import { SurfaceProbe } from "./remote-surface-socket-cases.mjs";
import { gate, bounded } from "./worker-log-stream-probe.mjs";
import { desktopCreate } from "./remote-surface-contract-oracle.mjs";
import { osIds } from "./remote-desktop-os-cases.mjs";
import { state as protectedState } from "./project-target-state.mjs";

export async function remoteSurfaceTimerCases({ f, state, visit, result }) {
  const release = gate(),
    offset = state.commands.length;
  const types = [
    "surface.desktop.probe",
    "surface.desktop.targets",
    "surface.configure",
    "surface.desktop.os-prepare",
    "surface.attach",
  ];
  state.holds = Object.fromEntries(
    types.map((type) => [type, release.promise]),
  );
  const promises = [];
  const timed = (name, deadline, operation) => {
    const index = result.cases.length;
    result.cases.push({ name, pending: true });
    const promise = (async () => {
      const started = performance.now();
      const value = await operation();
      const elapsedMs = performance.now() - started;
      assert.ok(
        elapsedMs >= deadline && elapsedMs < deadline + 20000,
        `${name}: ${elapsedMs}ms`,
      );
      (result.deadlines ??= []).push({ name, deadlineMs: deadline, elapsedMs });
      result.cases[index] = { name, deadlineMs: deadline };
      return value;
    })();
    promises.push(promise);
    return promise;
  };
  let socket;
  try {
    timed("actual probe deadline", 20000, async () => {
      const value = await visit(
        "probe deadline",
        "POST",
        "/api/projects/github/remote-desktops",
        { status: 502, json: desktopCreate, timeoutMs: 60000 },
      );
      assert.match(value.error, /timed out/iu);
    });
    timed("actual fleet deadline", 20000, async () => {
      const value = await visit(
        "fleet deadline",
        "GET",
        "/api/projects/github/remote-desktop-fleet",
        { timeoutMs: 60000 },
      );
      assert.equal(
        value.workers.find((w) => w.workerId === "alpha").status,
        "timed-out",
      );
    });
    timed("actual desktop configuration deadline", 20000, async () => {
      const value = await visit(
        "configuration deadline",
        "PATCH",
        "/api/remote-desktops/" + osIds.desktop,
        {
          json: {
            expectedStateRevision: 2,
            stateProtection: protectedState("remote-desktop-state"),
          },
          timeoutMs: 60000,
        },
      );
      assert.equal(value.status, "error");
      assert.equal(
        value.lastError,
        "The worker could not apply the encrypted Remote Desktop target.",
      );
    });
    timed("actual OS preparation deadline", 30000, async () => {
      const value = await visit(
        "OS preparation deadline",
        "POST",
        "/api/projects/folder/remote-desktops",
        {
          status: 502,
          json: {
            ...desktopCreate,
            cantripOsBindingId: osIds.binding,
            cantripOsRuntimeGeneration: osIds.runtime,
          },
          timeoutMs: 60000,
        },
      );
      assert.match(value.error, /timed out/iu);
    });
    timed("actual attachment deadline", 30000, async () => {
      socket = new SurfaceProbe(f);
      await socket.open();
      assert.deepEqual(await socket.message(50000), {
        type: "error",
        message: "Remote Surface could not be opened.",
        recoverable: true,
      });
      assert.deepEqual(
        await bounded(socket.closed, "attachment deadline close"),
        { code: 1013, reason: "Remote Surface unavailable" },
      );
    });
    await Promise.all(promises);
    const commands = state.commands
      .slice(offset)
      .filter((c) => types.includes(c.type))
      .sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(
      commands.map((c) => c.type),
      [...types].sort(),
    );
    result.cases.push({ name: "deadline command bindings", commands });
  } finally {
    release.resolve();
    delete state.holds;
    await Promise.allSettled(promises);
    if (socket) await socket.close();
  }
}
