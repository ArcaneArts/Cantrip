// Production browser observation consumer -> real relay -> full worker adapter.
// Terminal lifecycle events come from the real PTY, without injected frames.
import assert from "node:assert/strict";
import { decodeWorkerLinkFrame } from "../../packages/protocol/dist/worker-link.js";
import { eventually } from "./full-worker.mjs";

export async function actualWorkerObservations({
  page,
  workerId,
  result,
  route = "relay",
}) {
  const requests = [],
    sockets = [];
  const response = (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.startsWith("/api/worker-links/") ||
      url.pathname.endsWith("/worker-link/sessions")
    ) {
      const record = {
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      };
      if (url.pathname.endsWith("/signals")) {
        const body = response.request().postDataJSON();
        record.signals = body.signals.map(({ signal }) => ({
          type: signal.type,
          ...(signal.type === "candidate"
            ? { mdns: /\s[^\s]+\.local\s/u.test(signal.candidate.candidate) }
            : {}),
        }));
      }
      requests.push(record);
    }
  };
  const websocket = (socket) => {
    if (!new URL(socket.url()).pathname.startsWith("/api/worker-links/"))
      return;
    const value = { frames: [], closed: false };
    sockets.push(value);
    for (const direction of ["sent", "received"])
      socket.on("frame" + direction, ({ payload }) =>
        (() => {
          try {
            assert.ok(Buffer.isBuffer(payload));
            const frame = decodeWorkerLinkFrame(payload);
            value.frames.push({
              direction,
              binary: true,
              bytes: payload.length,
              kind: frame.header.kind,
              lane: frame.header.lane,
              sequence: frame.header.sequence,
              payloadBytes: frame.payload.length,
            });
          } catch (cause) {
            value.frames.push({ direction, error: cause.message });
          }
        })(),
      );
    socket.on("close", () => {
      value.closed = true;
    });
  };
  page.on("response", response);
  page.on("websocket", websocket);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      const before = await page.evaluate(
        () => window.actualObservationRecoveries ?? [],
      );
      await page.evaluate(() => {
        window.actualObservationClient?.stop();
        window.actualObservationRelease?.();
        window.actualObservationWarmReference?.release();
      });
      assert.deepEqual(before, []);
      await eventually(
        () => page.evaluate(() => window.actualLinkManager.getStatusSnapshot()),
        (snapshots) => {
          assert.ok(
            snapshots.every(
              (s) => s.activeLinkCount === 0 && s.activeChannelCount === 0,
            ),
          );
        },
      );
      await eventually(
        () => ({ requests, sockets }),
        ({ requests, sockets }) => {
          if (
            requests.some(
              (r) => /\/observations\/grant$/.test(r.path) && r.status === 201,
            )
          )
            assert.ok(
              requests.some(
                (r) =>
                  r.method === "DELETE" &&
                  /\/grants\/[^/]+$/.test(r.path) &&
                  r.status === 204,
              ),
            );
          assert.ok(
            requests.some(
              (r) =>
                r.method === "DELETE" &&
                /^\/api\/worker-links\/[^/]+$/.test(r.path) &&
                r.status === 204,
            ),
          );
          assert.ok(sockets.length > 0 && sockets.every((s) => s.closed));
        },
      );
      const state = await page.evaluate(() => ({
        events: window.actualObservations,
        recoveries: window.actualObservationRecoveries,
      }));
      assert.deepEqual(
        state.recoveries ?? [],
        state.events?.length ? [{ workerId, mode: "affected" }] : [],
      );
      result.workerObservations = { route, ...state, requests, sockets };
    } finally {
      page.off("response", response);
      page.off("websocket", websocket);
    }
  };
  try {
    assert.ok(
      ["relay", "lan"].includes(route),
      "Unknown actual WorkerLink test route",
    );
    await page.evaluate(async (workerId) => {
      window.actualLinkManager = (
        await import("/src/lib/worker-link.ts")
      ).workerLinkManager;
      window.actualObservationWarmReference =
        await window.actualLinkManager.acquire(workerId);
    }, workerId);
    await eventually(
      () => {
        const failed = requests.find(
          (r) => r.path.endsWith("/signals") && r.status >= 400,
        );
        if (route !== "relay" && failed)
          throw new Error(
            "Actual WorkerLink signaling failed: " + JSON.stringify(failed),
          );
        return page.evaluate(() =>
          window.actualLinkManager.getStatusSnapshot(),
        );
      },
      (snapshots) => {
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].state, "active");
        assert.equal(snapshots[0].preferredRoute, route);
      },
      60000,
    );
    const identity = await page.evaluate(
      () => window.actualObservationWarmReference.link.session.identity,
    );
    await page.evaluate(async (workerId) => {
      const { WorkerObservationClient } =
        await import("/src/lib/worker-observation-client.ts");
      window.actualLinkManager = (
        await import("/src/lib/worker-link.ts")
      ).workerLinkManager;
      window.actualObservations = [];
      window.actualObservationRecoveries = [];
      window.actualObservationClient = new WorkerObservationClient({
        handleWorkerObservation: (workerId, envelope) =>
          window.actualObservations.push({ workerId, envelope }),
        recoverWorkerObservations: (workerId, mode) =>
          window.actualObservationRecoveries.push({ workerId, mode }),
      });
      window.actualObservationClient.updateAvailableWorkers([workerId]);
      window.actualObservationRelease =
        window.actualObservationClient.retainDemands([
          { workerId, topics: ["runtime"] },
        ]);
      window.actualObservationClient.start();
    }, workerId);
    await eventually(
      () => page.evaluate(() => window.actualLinkManager.getStatusSnapshot()),
      (snapshots) => {
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].workerId, workerId);
        assert.equal(snapshots[0].state, "active");
        assert.equal(snapshots[0].activeChannelCount, 1);
        assert.deepEqual(snapshots[0].effectiveRoutes, [route]);
      },
    );
    result.steps.push(
      `unchanged browser observation consumer opens a real events channel through ${route} and full worker`,
    );
    return {
      async expectTerminalExit(terminalId) {
        const events = await eventually(
          () => page.evaluate(() => window.actualObservations),
          (events) => {
            assert.ok(
              events.some(
                ({ workerId: source, envelope }) =>
                  source === workerId &&
                  envelope.payload.topic === "runtime" &&
                  envelope.payload.notification.type ===
                    "terminal.runtime.observed" &&
                  envelope.payload.notification.terminalId === terminalId,
              ),
            );
          },
        );
        events.forEach(({ envelope }, index) =>
          assert.equal(envelope.continuitySequence, index),
        );
        const terminal = events.find(
          ({ envelope }) =>
            envelope.payload.notification.terminalId === terminalId,
        );
        assert.equal(
          terminal.envelope.payload.notification.workerProcessGeneration,
          identity.workerProcessGeneration,
        );
        if (route === "relay")
          await eventually(
            () => sockets,
            (sockets) => {
              assert.ok(
                sockets.some((s) =>
                  s.frames.some(
                    (f) =>
                      f.direction === "received" &&
                      f.kind === "data" &&
                      f.payloadBytes > 0 &&
                      f.lane === "events",
                  ),
                ),
              );
              assert.ok(
                sockets.some((s) =>
                  s.frames.some(
                    (f) =>
                      f.direction === "sent" &&
                      f.kind === "credit" &&
                      f.lane === "events",
                  ),
                ),
              );
              for (const socket of sockets)
                assert.ok(socket.frames.every((f) => f.binary && !f.error));
            },
          );
        else {
          const status = await page.evaluate(() =>
            window.actualLinkManager.getStatusSnapshot(),
          );
          assert.deepEqual(status[0].effectiveRoutes, ["lan"]);
          assert.ok(
            requests.some((r) => /\/peers$/.test(r.path) && r.status === 201),
          );
          assert.ok(
            requests.some((r) => /\/signals$/.test(r.path) && r.status === 204),
          );
          assert.ok(
            requests.some((r) => /\/mailbox$/.test(r.path) && r.status === 200),
          );
          assert.ok(
            sockets.every((s) => s.frames.every((f) => f.kind !== "data")),
            "LAN observations must not arrive through relay",
          );
        }
        result.steps.push(
          `real PTY exit reaches the production browser observation decoder with continuous sequence over ${route}`,
        );
      },
      close,
    };
  } catch (cause) {
    result.workerObservationFailure = {
      requests,
      sockets,
      state: await page
        .evaluate(() => ({
          events: window.actualObservations,
          recoveries: window.actualObservationRecoveries,
          status: window.actualLinkManager?.getStatusSnapshot(),
        }))
        .catch(() => null),
    };
    await close().catch(() => {});
    throw cause;
  }
}
