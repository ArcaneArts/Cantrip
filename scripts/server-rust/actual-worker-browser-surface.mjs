// Production browser WorkerLink/crypto modules and an unchanged full worker
// rendering a real Chromium page, created through the unchanged client API.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function prepareBrowserSurface(page, origin, projectId, workerId) {
  const token = "private-browser-" + crypto.randomUUID();
  const url = new URL("/__actual_surface_fixture/" + token, origin).href;
  const created = await page.evaluate(
    async ({ projectId, workerId, url }) => {
      const api = await import("/src/lib/api/surfaces.ts");
      return api.createBrowser(
        projectId,
        "Private WorkerLink browser",
        undefined,
        { kind: "worker", projectId, workerId },
        url,
      );
    },
    { projectId, workerId, url },
  );
  assert.equal(created.url, url);
  assert.equal(created.title, "Private WorkerLink browser");
  assert.equal(created.workerId, workerId);
  assert.equal(created.stateRevision, 1);
  return { id: created.id, projectId, token, url };
}

export async function actualWorkerBrowserSurface({
  page,
  surface,
  workerId,
  result,
  route = "relay",
}) {
  const responses = [];
  result.browserSurface = { responses, completed: false };
  const observe = (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.includes("/remote-surfaces/") || pathname.includes("/grants/"))
      responses.push({
        pathname,
        method: response.request().method(),
        status: response.status(),
      });
  };
  page.on("response", observe);
  try {
    const retained = await page.evaluate(async (projectId) => {
      const api = await import("/src/lib/api/surfaces.ts");
      return api.getBrowsers(projectId);
    }, surface.projectId);
    const browser = retained.find((value) => value.id === surface.id);
    assert.equal(browser?.url, surface.url);
    assert.equal(browser?.title, "Private WorkerLink browser");
    assert.equal(browser?.workerId, workerId);
    assert.equal(browser?.stateRevision, 1);
    await page.evaluate(
      async ({ id, workerId }) => {
        const { RemoteSurfaceWorkerLinkClient } =
          await import("/src/lib/remote-surface-worker-link.ts");
        const { surfaceTitleEncryption } =
          await import("/src/lib/surface-title-encryption.ts");
        window.actualBrowserSurfaceState = {
          state: "connecting",
          error: null,
          routes: null,
          frames: 0,
          frameBytes: 0,
          titles: [],
          urls: [],
          stateRevisions: [],
          controls: [],
        };
        const state = window.actualBrowserSurfaceState;
        const viewport = { width: 1024, height: 768, devicePixelRatio: 1 };
        window.actualBrowserSurfaceOptions = {
          surfaceId: id,
          workerId,
          streamKind: "browser",
          surfaceKind: "browser",
          viewport: () => viewport,
          messages: {
            connectionError: "Actual browser surface failed",
            invalidFrame: "Actual browser surface invalid encrypted frame",
          },
          onConnectionState: (value) => {
            state.state = value;
          },
          onError: (error) => {
            state.error = error;
          },
          onReady: (routes) => {
            state.routes = routes;
            if (
              !window.actualBrowserSurface.send(
                "control",
                new TextEncoder().encode(
                  JSON.stringify({ type: "viewport", viewport }),
                ),
              )
            )
              throw new Error("Actual ready viewport was not admitted");
          },
          onFrame: async ({ header, payload }) => {
            if (header.channel === "frame") {
              if (payload[0] !== 255 || payload[1] !== 216)
                throw new Error("Authenticated browser image is not JPEG");
              state.frames++;
              state.frameBytes += payload.length;
            } else if (header.channel === "control") {
              const message = JSON.parse(new TextDecoder().decode(payload));
              state.controls.push({
                type: message.type,
                title: message.title,
                loading: message.loading,
              });
              if (message.type === "browser-state") {
                const privateState =
                  await surfaceTitleEncryption.openBrowserOperation({
                    browserId: id,
                    operationId: message.operationId,
                    stateProtection: message.stateProtection,
                  });
                state.titles.push(message.title);
                state.urls.push(privateState.url);
                state.stateRevisions.push(privateState.revision);
              }
            }
          },
        };
        window.actualBrowserSurface = new RemoteSurfaceWorkerLinkClient(
          window.actualBrowserSurfaceOptions,
        );
        window.actualBrowserSurface.start();
      },
      { id: surface.id, workerId },
    );
    const snapshot = () =>
      page.evaluate(() => window.actualBrowserSurfaceState);
    const initial = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.equal(state.state, "ready");
      assert.deepEqual(state.routes, { interactive: route, realtime: route });
      assert.ok(state.frames > 0);
      assert.ok(state.frameBytes > 1000);
      assert.ok(state.titles.at(-1)?.startsWith(surface.token + ":"));
    });
    const initialLoad = Number(
      initial.titles.at(-1).slice(surface.token.length + 1),
    );
    result.browserSurface.initial = initial;
    assert.ok(Number.isSafeInteger(initialLoad) && initialLoad > 0);
    await page.evaluate(async () => {
      if (
        !window.actualBrowserSurface.send(
          "control",
          new TextEncoder().encode(JSON.stringify({ type: "reload" })),
        )
      )
        throw new Error("Actual browser control was not admitted");
      await window.actualBrowserSurface.drain();
    });
    const completed = await eventually(snapshot, (state) => {
      assert.equal(state.error, null);
      assert.ok(state.titles.includes(surface.token + ":" + (initialLoad + 1)));
    });
    const updatedUrl = surface.url + "?saved-state=updated";
    const updated = await page.evaluate(
      async ({ id, url }) => {
        const api = await import("/src/lib/api/surfaces.ts");
        return api.updateBrowser(id, { url });
      },
      { id: surface.id, url: updatedUrl },
    );
    assert.equal(updated.stateRevision, 2);
    assert.equal(updated.url, updatedUrl);
    const configured = await eventually(snapshot, (value) => {
      assert.equal(value.error, null);
      assert.ok(value.urls.includes(updatedUrl));
      assert.ok(value.stateRevisions.includes(2));
      assert.ok(value.frames > initial.frames);
    });
    await page.evaluate(() => window.actualBrowserSurface.close());
    await eventually(
      () => responses,
      (items) => {
        assert.ok(
          items.some(
            (r) => r.pathname.includes("/remote-surfaces/") && r.status === 201,
          ),
        );
        assert.ok(
          items.some(
            (r) =>
              r.pathname.includes("/grants/") &&
              r.method === "DELETE" &&
              r.status === 204,
          ),
        );
      },
    );
    result.browserSurface = {
      completed: true,
      initial,
      routes: completed.routes,
      frames: completed.frames,
      frameBytes: completed.frameBytes,
      authenticatedInitialState: true,
      authenticatedControlReload: true,
      authenticatedSavedStateUpdate: true,
      savedStateRevision: updated.stateRevision,
      configuredFrames: configured.frames,
      initialLoad,
      reloadLoad: initialLoad + 1,
      released: true,
      responses,
    };
    result.steps.push(
      "existing RemoteSurfaceWorkerLinkClient receives authenticated JPEG and private state from a real worker Chromium, sends encrypted reload and releases its grant",
    );
    // Open another live attachment so deletion must revoke an installed grant.
    await page.evaluate(async () => {
      const { RemoteSurfaceWorkerLinkClient } =
        await import("/src/lib/remote-surface-worker-link.ts");
      window.actualBrowserSurfaceState.error = null;
      window.actualBrowserSurfaceState.state = "connecting";
      window.actualBrowserSurface = new RemoteSurfaceWorkerLinkClient(
        window.actualBrowserSurfaceOptions,
      );
      window.actualBrowserSurface.start();
    });
    await eventually(snapshot, (value) => {
      assert.equal(value.error, null);
      assert.equal(value.state, "ready");
    });
    const deleted = await page.evaluate(
      async ({ id, project }) => {
        const api = await import("/src/lib/api/surfaces.ts");
        await api.deleteBrowser(id);
        return api.getBrowsers(project);
      },
      { id: surface.id, project: surface.projectId },
    );
    assert.equal(
      deleted.some((value) => value.id === surface.id),
      false,
    );
    await eventually(snapshot, (value) =>
      assert.notEqual(value.state, "ready"),
    );
    await page.evaluate(() => window.actualBrowserSurface.close());
    result.browserSurface.deletedWithActiveGrant = true;
    result.steps.push(
      "existing browser API applies an encrypted saved URL through the full worker and deletion removes the row and revokes its active grant",
    );
  } finally {
    result.browserSurface.lastState = await page
      .evaluate(() => window.actualBrowserSurfaceState)
      .catch(() => null);
    page.off("response", observe);
    await page
      .evaluate(() => window.actualBrowserSurface?.close())
      .catch(() => {});
  }
}
