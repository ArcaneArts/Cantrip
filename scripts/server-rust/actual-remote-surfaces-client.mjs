// Existing encryption/API modules and full Chromium worker over the legacy socket.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
export async function prepareActualRemoteSurface({
  page,
  projectId,
  workerId,
  origin,
  protocolUrl,
  result,
}) {
  const token = "private-legacy-surface-" + crypto.randomUUID();
  const url = new URL("/__actual_surface_fixture/" + token, origin).href;
  const value = await page.evaluate(
    async ({ projectId, workerId, url, token, protocolUrl }) => {
      const { post, request } = await import("/src/lib/api-client.ts");
      const { surfaceTitleEncryption: e } =
        await import("/src/lib/surface-title-encryption.ts");
      const { ensureSurfacePrivateStateWorkerEncryption } =
        await import("/src/lib/surface-private-state-worker-encryption.ts");
      const protocol = await import(protocolUrl);
      const worker = (await window.folderWorkers.getWorkers()).find(
        (w) => w.workerId === workerId,
      );
      await ensureSurfacePrivateStateWorkerEncryption({ worker });
      const id = crypto.randomUUID();
      const created = protocol.remoteSurfaceWireSummarySchema.parse(
        await post(`/api/projects/${projectId}/remote-surfaces`, {
          id,
          workerId,
          titleProtection: await e.protect(id, token, "remote-surface"),
          stateProtection: await e.protectBrowserRemoteSurfaceState(id, url, 1),
          configuration: { kind: "browser" },
        }),
      );
      const updated = protocol.remoteSurfaceWireSummarySchema.parse(
        await request(`/api/remote-surfaces/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            titleProtection: await e.protect(
              id,
              token + " renamed",
              "remote-surface",
            ),
            preferredTransport: "websocket",
          }),
        }),
      );
      return {
        created: await e.openRemoteSurface(created),
        updated: await e.openRemoteSurface(updated),
        saved: updated,
      };
    },
    { projectId, workerId, url, token, protocolUrl },
  );
  assert.equal(value.created.url, url);
  assert.equal(value.updated.title, token + " renamed");
  assert.equal(value.updated.preferredTransport, "websocket");
  result.steps.push(
    "existing encryption and API modules create and rename an opaque generic browser surface",
  );
  return {
    id: value.created.id,
    projectId,
    workerId,
    url,
    token,
    protocolUrl,
    saved: value.saved,
  };
}

export async function assertOfflineRemoteSurface(page, surface) {
  const observed = await page.evaluate(
    async ({ id, projectId, protocolUrl }) => {
      const { CantripApiError, post, request } =
        await import("/src/lib/api-client.ts");
      const { remoteSurfaceWireListSchema } = await import(protocolUrl);
      try {
        await post(`/api/remote-surfaces/${id}/resume`);
      } catch (error) {
        if (!(error instanceof CantripApiError)) throw error;
        const row = remoteSurfaceWireListSchema
          .parse(await request(`/api/projects/${projectId}/remote-surfaces`))
          .find((entry) => entry.id === id);
        return {
          httpStatus: error.status,
          message: error.message,
          savedStatus: row?.status,
          lastError: row?.lastError,
        };
      }
      throw new Error("Remote surface unexpectedly resumed without its worker");
    },
    surface,
  );
  assert.deepEqual(observed, {
    httpStatus: 503,
    message: "Worker is offline.",
    savedStatus: "offline",
    lastError: "Worker is offline.",
  });
  return observed;
}

export async function actualRemoteSurface({
  page,
  surface,
  result,
  diagnostics,
}) {
  const requests = [];
  const capture = (request) => {
    if (request.url().includes("/remote-surfaces"))
      requests.push({
        path: new URL(request.url()).pathname,
        body: request.postData(),
      });
  };
  page.on("request", capture);
  try {
    const retained = await page.evaluate(
      async ({ projectId, id, protocolUrl }) => {
        const { request } = await import("/src/lib/api-client.ts"),
          p = await import(protocolUrl);
        const { surfaceTitleEncryption: e } =
          await import("/src/lib/surface-title-encryption.ts");
        const found = p.remoteSurfaceWireListSchema
          .parse(await request(`/api/projects/${projectId}/remote-surfaces`))
          .find((v) => v.id === id);
        return { wire: found, opened: await e.openRemoteSurface(found) };
      },
      surface,
    );
    assert.equal(retained.opened.url, surface.url);
    assert.equal(retained.opened.title, surface.token + " renamed");
    assert.equal(retained.wire.stateRevision, 1);
    assert.deepEqual(
      retained.wire.titleProtection,
      surface.saved.titleProtection,
    );
    assert.deepEqual(
      retained.wire.stateProtection,
      surface.saved.stateProtection,
    );
    assert.equal(retained.wire.status, "idle");
    assert.equal(retained.wire.lastError, null);
    const fleet = await page.evaluate(async (project) => {
      const api = await import("/src/lib/api/surfaces.ts");
      return api.getRemoteDesktopFleet(project);
    }, surface.projectId);
    result.desktopFleet = {
      workers: fleet.workers.length,
      healthy: fleet.workers.filter((w) => w.status === "ok").length,
      partial: fleet.partial,
      truncated: fleet.truncated,
    };
    const start = async () =>
      page.evaluate(async ({ id, protocolUrl }) => {
        const p = await import(protocolUrl);
        const crypto =
          await import("/src/lib/remote-surface-stream-encryption.ts");
        const { surfaceTitleEncryption: e } =
          await import("/src/lib/surface-title-encryption.ts");
        const { getActiveServerUrl } =
          await import("/src/lib/server-connections.ts");
        const url = new URL(
          `/api/remote-surfaces/${id}/connect?width=1024&height=768&devicePixelRatio=1`,
          getActiveServerUrl(),
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const state = (window.actualLegacySurfaceState = {
          frames: 0,
          frameBytes: 0,
          urls: [],
          titles: [],
          revisions: [],
          ready: null,
          error: null,
          aadRejected: false,
        });
        const socket = (window.actualLegacySurface = new WebSocket(url));
        socket.binaryType = "arraybuffer";
        let sequence = 0,
          queue = Promise.resolve();
        window.actualLegacySend = async (message) => {
          if (!state.ready) throw new Error("Surface is not ready");
          const header = {
            protocolVersion: 1,
            surfaceId: id,
            attachmentId: state.ready.attachmentId,
            channel: "control",
            sequence: sequence++,
          };
          const payload = await crypto.protectRemoteSurfaceStreamPayload({
            context: {
              surfaceKind: "browser",
              surfaceId: id,
              attachmentId: header.attachmentId,
              direction: "client-to-worker",
              channel: header.channel,
              sequence: header.sequence,
            },
            payload: new TextEncoder().encode(JSON.stringify(message)),
          });
          socket.send(p.encodeRemoteSurfaceFrame(header, payload));
        };
        socket.onmessage = (event) => {
          queue = queue
            .then(async () => {
              if (typeof event.data === "string") {
                const message = p.remoteSurfaceConnectionMessageSchema.parse(
                  JSON.parse(event.data),
                );
                if (message.type === "error") throw new Error(message.message);
                state.ready = message;
                return;
              }
              const frame = p.decodeRemoteSurfaceFrame(
                new Uint8Array(event.data),
              );
              const context = {
                surfaceKind: "browser",
                surfaceId: frame.header.surfaceId,
                attachmentId: frame.header.attachmentId,
                direction: "worker-to-client",
                channel: frame.header.channel,
                sequence: frame.header.sequence,
              };
              const payload = await crypto.openRemoteSurfaceStreamPayload({
                context,
                protectedPayload: frame.payload,
              });
              if (!state.aadRejected) {
                let rejected = false;
                try {
                  await crypto.openRemoteSurfaceStreamPayload({
                    context: { ...context, attachmentId: "wrong-attachment" },
                    protectedPayload: frame.payload,
                  });
                } catch {
                  rejected = true;
                }
                if (!rejected)
                  throw new Error(
                    "Stream accepted a different attachment identity",
                  );
                state.aadRejected = true;
              }
              if (frame.header.channel === "frame") {
                if (payload[0] !== 255 || payload[1] !== 216)
                  throw new Error("Authenticated surface image is not JPEG");
                state.frames++;
                state.frameBytes += payload.length;
              } else if (frame.header.channel === "control") {
                const message = JSON.parse(new TextDecoder().decode(payload));
                if (message.type === "browser-state") {
                  const opened = await e.openBrowserOperation({
                    browserId: id,
                    operationId: message.operationId,
                    stateProtection: message.stateProtection,
                  });
                  state.urls.push(opened.url);
                  state.revisions.push(opened.revision);
                  state.titles.push(message.title);
                }
              }
            })
            .catch((error) => {
              state.error = error.message;
            });
        };
        socket.onerror = () => {
          state.error = "Legacy socket transport error";
        };
        window.actualLegacyDrain = () => queue;
      }, surface);
    const snapshot = () => page.evaluate(() => window.actualLegacySurfaceState);
    await start();
    const initial = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.ok(state.ready);
      assert.ok(state.frames > 0);
      assert.ok(state.aadRejected);
      assert.ok(state.urls.includes(surface.url));
      assert.ok(state.titles.some((t) => t?.startsWith(surface.token + ":")));
    });
    const initialTitle = initial.titles.findLast((t) =>
      t?.startsWith(surface.token + ":"),
    );
    const load = Number(initialTitle.slice(surface.token.length + 1));
    assert.ok(Number.isSafeInteger(load) && load > 0);
    await page.evaluate(async () =>
      window.actualLegacySend({ type: "reload" }),
    );
    const reload = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.ok(state.titles.includes(surface.token + ":" + (load + 1)));
      assert.ok(state.frames > initial.frames);
    });
    const lifecycle = [];
    let paused;
    for (const [action, status, event] of [
      ["suspend", "suspended", "surface.lifecycle.suspended"],
      ["resume", "active", "surface.lifecycle.resumed"],
    ]) {
      const { response, saved } = await page.evaluate(
        async ({ id, projectId, action, protocolUrl }) => {
          const { post, request } = await import("/src/lib/api-client.ts");
          const {
            remoteSurfaceWireListSchema,
            remoteSurfaceWireSummarySchema,
          } = await import(protocolUrl);
          const route = `/api/remote-surfaces/${id}`;
          const response = remoteSurfaceWireSummarySchema.parse(
            await post(`${route}/${action}`),
          );
          const saved = remoteSurfaceWireListSchema
            .parse(await request(`/api/projects/${projectId}/remote-surfaces`))
            .find((entry) => entry.id === id);
          return { response, saved };
        },
        { ...surface, action },
      );
      assert.equal(response.status, status);
      assert.equal(response.lastError, null);
      assert.deepEqual(saved, response);
      assert.deepEqual(saved.titleProtection, retained.wire.titleProtection);
      assert.deepEqual(saved.stateProtection, retained.wire.stateProtection);
      assert.equal(saved.stateRevision, retained.wire.stateRevision);
      const workerEvents = await eventually(
        () =>
          diagnostics()
            .split("\n")
            .filter(
              (line) =>
                line.includes(`event=${event} `) &&
                line.includes(`surfaceId=${surface.id} `),
            ),
        (events) => assert.equal(events.length, 1),
      );
      lifecycle.push({ action, status, workerEvent: workerEvents[0] });
      if (action === "suspend") paused = await snapshot();
    }
    const resumed = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.equal(state.ready.attachmentId, paused.ready.attachmentId);
      assert.ok(state.frames > paused.frames);
    });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.actualLegacySurface.addEventListener("close", resolve, {
            once: true,
          });
          window.actualLegacySurface.close(1000, "product fixture");
        }),
    );
    const updatedUrl = surface.url + "?protected-restart=2";
    await page.evaluate(
      async ({ id, updatedUrl, protocolUrl }) => {
        const { request } = await import("/src/lib/api-client.ts"),
          p = await import(protocolUrl);
        const { surfaceTitleEncryption: e } =
          await import("/src/lib/surface-title-encryption.ts");
        const row = p.remoteSurfaceWireSummarySchema.parse(
          await request(`/api/remote-surfaces/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              expectedStateRevision: 1,
              stateProtection: await e.protectBrowserRemoteSurfaceState(
                id,
                updatedUrl,
                2,
              ),
            }),
          }),
        );
        const opened = await e.openRemoteSurface(row);
        if (opened.url !== updatedUrl || opened.stateRevision !== 2)
          throw new Error("Protected surface state did not advance");
      },
      { ...surface, updatedUrl },
    );
    await start();
    const restored = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.ok(state.frames > 0);
      assert.ok(state.urls.includes(updatedUrl));
      assert.ok(state.revisions.includes(2));
    });
    const absent = await page.evaluate(
      async ({ id, projectId, protocolUrl }) => {
        const { request } = await import("/src/lib/api-client.ts"),
          p = await import(protocolUrl);
        await request(`/api/remote-surfaces/${id}`, { method: "DELETE" });
        return !p.remoteSurfaceWireListSchema
          .parse(await request(`/api/projects/${projectId}/remote-surfaces`))
          .some((v) => v.id === id);
      },
      surface,
    );
    assert.equal(absent, true);
    const encoded = JSON.stringify(requests);
    for (const secret of [surface.url, surface.token, updatedUrl])
      assert.equal(encoded.includes(secret), false);
    result.legacySurface = {
      completed: true,
      initialFrames: initial.frames,
      reloadFrames: reload.frames,
      pausedFrames: paused.frames,
      resumedFrames: resumed.frames,
      restoredFrames: restored.frames,
      authenticatedBytes: restored.frameBytes,
      aadRejected: restored.aadRejected,
      savedRevision: 2,
      retained: true,
      reopenedStatus: retained.wire.status,
      retainedExactEnvelopes: true,
      lifecycle,
      deleted: absent,
      requests,
    };
    result.steps.push(
      "real legacy socket carries authenticated Chromium images and controls, rejects altered AAD, applies suspend/resume and retained encrypted state, then deletes the surface",
    );
  } finally {
    page.off("request", capture);
    await page
      .evaluate(() => window.actualLegacySurface?.close())
      .catch(() => {});
  }
}
