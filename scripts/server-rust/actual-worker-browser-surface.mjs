// Production browser WorkerLink/crypto modules and an unchanged full worker
// rendering a real Chromium page. Database seeding supplies an existing surface;
// browser CRUD is a separate, still-unported domain.
import assert from "node:assert/strict";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";

export async function prepareBrowserSurface(page, origin, projectId) {
  const id = "actual-browser-" + crypto.randomUUID(),
    token = "private-browser-" + crypto.randomUUID();
  const url = new URL("/__actual_surface_fixture/" + token, origin).href;
  const protectedState = await page.evaluate(
    async ({ id, url }) => {
      const identity = window.folderIdentity;
      const label = await import("/src/lib/private-label-encryption.ts");
      const state =
        await import("/src/lib/surface-private-state-encryption.ts");
      return {
        titleProtection: await label.encodePrivateDisplayLabelForClient({
          identity,
          recordKind: "browser",
          rowId: id,
          label: "Private WorkerLink browser",
        }),
        stateProtection: await state.encodeSurfacePrivateStateForClient({
          identity,
          context: {
            serverId: identity.serverId,
            resource: "browser-row",
            resourceId: id,
            operationId: null,
            recordKind: "browser-state",
          },
          content: {
            version: 1,
            classification: { recordKind: "browser-state" },
            revision: 1,
            url,
          },
        }),
      };
    },
    { id, url },
  );
  return { id, projectId, token, url, ...protectedState };
}

export async function seedBrowserSurface(
  fixture,
  root,
  executable,
  surface,
  workerId,
) {
  const repo = await repositoryFixture({
    kind: fixture.kind,
    root: path.join(root, fixture.name),
    executable,
    databaseMode: fixture.databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    await repo.seed(
      `INSERT INTO browsers(id,project_id,protected_label,protected_state,state_revision) VALUES(${literal(surface.id)},${literal(surface.projectId)},${json(surface.titleProtection)},${json(surface.stateProtection)},1)`,
    );
    await repo.seed(
      `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration) VALUES(${literal(surface.id)},${literal(surface.projectId)},${literal(workerId)},'browser','{"kind":"browser","profileId":null}')`,
    );
  } finally {
    await repo.close();
  }
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
    await page.evaluate(
      async ({ id, workerId }) => {
        const { RemoteSurfaceWorkerLinkClient } =
          await import("/src/lib/remote-surface-worker-link.ts");
        window.actualBrowserSurfaceState = {
          state: "connecting",
          error: null,
          routes: null,
          frames: 0,
          frameBytes: 0,
          titles: [],
          controls: [],
        };
        const state = window.actualBrowserSurfaceState;
        const viewport = { width: 1024, height: 768, devicePixelRatio: 1 };
        window.actualBrowserSurface = new RemoteSurfaceWorkerLinkClient({
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
          onFrame: ({ header, payload }) => {
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
              if (message.type === "browser-state")
                state.titles.push(message.title);
            }
          },
        });
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
      initialLoad,
      reloadLoad: initialLoad + 1,
      released: true,
      responses,
    };
    result.steps.push(
      "existing RemoteSurfaceWorkerLinkClient receives authenticated JPEG and private state from a real worker Chromium, sends encrypted reload and releases its grant",
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
