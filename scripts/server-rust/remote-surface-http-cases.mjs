import assert from "node:assert/strict";
import {
  label,
  state as protectedState,
  literal,
} from "./project-target-state.mjs";
import {
  desktopCreate,
  surfaceCreate,
  desktopId,
  surfaceId,
} from "./remote-surface-contract-oracle.mjs";
import { eventually } from "./full-worker.mjs";
import {
  remoteSurfaceBoundaryCases,
  remoteSurfaceWorkerDisconnect,
} from "./remote-surface-boundary-cases.mjs";
import { remoteSurfaceStressCases } from "./remote-surface-stress-cases.mjs";
import { remoteSurfaceTimerCases } from "./remote-surface-timer-cases.mjs";
import { remoteDesktopOsCases } from "./remote-desktop-os-cases.mjs";
import { remoteSurfaceSocketCases } from "./remote-surface-socket-cases.mjs";

export async function remoteSurfaceHttpCases({
  f,
  state,
  worker,
  visit,
  result,
  owner,
  profile,
  timers,
  stress,
}) {
  const commands = async (name, method, url, options = {}) => {
    const before = state.commands.length;
    const body = await visit(name, method, url, options);
    result.cases.push({ name, commands: state.commands.slice(before) });
    return body;
  };
  const generic = "/api/projects/github/remote-surfaces";
  const desktops = "/api/projects/github/remote-desktops";
  const raw = "/api/remote-surfaces/raw-browser";
  const desktop = "/api/remote-desktops/desktop";
  for (const suffix of ["remote-surfaces", "remote-desktops"]) {
    const list = await visit(
      "owned " + suffix,
      "GET",
      "/api/projects/github/" + suffix,
    );
    assert.equal(list.length, suffix === "remote-surfaces" ? 4 : 1);
    for (const project of ["missing", "other"])
      assert.deepEqual(
        await visit(
          project + " " + suffix,
          "GET",
          `/api/projects/${project}/${suffix}`,
        ),
        [],
      );
  }
  await visit("desktop detail", "GET", desktop);
  await visit("desktop HEAD", "HEAD", desktop, { compareContentLength: true });
  await visit("surface list HEAD", "HEAD", generic, {
    compareContentLength: true,
  });
  await visit("desktop list HEAD", "HEAD", desktops, {
    compareContentLength: true,
  });
  await visit("unsupported surface method", "PUT", raw, {
    status: 404,
    json: { ignored: true },
  });
  await visit("unsupported desktop method", "DELETE", desktop, { status: 404 });
  await visit("plain connection GET", "GET", raw + "/connect", {
    status: 404,
    compareContentLength: true,
  });
  await visit("plain connection HEAD", "HEAD", raw + "/connect", {
    status: 500,
    compareContentLength: true,
  });
  await visit("browser is not desktop", "GET", "/api/remote-desktops/browser", {
    status: 404,
  });
  await visit("foreign desktop", "GET", "/api/remote-desktops/other-desktop", {
    status: 404,
  });
  for (const [name, url, input] of [
    ["surface create missing", generic, {}],
    [
      "surface create title",
      generic,
      { ...surfaceCreate, titleProtection: label("browser") },
    ],
    [
      "surface create mismatched state",
      generic,
      {
        ...surfaceCreate,
        stateProtection: protectedState("remote-desktop-state"),
      },
    ],
    ["desktop create missing", desktops, {}],
    [
      "desktop create OS half",
      desktops,
      { ...desktopCreate, cantripOsBindingId: desktopId },
    ],
    [
      "desktop create destinations",
      desktops,
      { ...desktopCreate, paneId: "pane", targetRegion: "main" },
    ],
  ])
    await visit(name, "POST", url, { status: 400, json: input });
  await commands("create generic browser", "POST", generic, {
    status: 201,
    json: surfaceCreate,
  });
  await commands("reject generic desktop", "POST", generic, {
    status: 400,
    json: {
      ...surfaceCreate,
      configuration: { kind: "desktop" },
      stateProtection: protectedState("remote-desktop-state"),
    },
  });
  await commands(
    "reject missing placement",
    "POST",
    "/api/projects/missing/remote-surfaces",
    { status: 404, json: surfaceCreate },
  );
  await commands(
    "reject foreign placement",
    "POST",
    "/api/projects/other/remote-surfaces",
    { status: 404, json: surfaceCreate },
  );
  for (const input of [
    {},
    { expectedStateRevision: 1 },
    { stateProtection: protectedState("browser-state") },
    { titleProtection: label("browser") },
  ])
    await visit(
      "surface invalid update " + JSON.stringify(input),
      "PATCH",
      raw,
      { status: 400, json: input },
    );
  await commands("generic target managed", "PATCH", raw, {
    status: 400,
    json: { configuration: { kind: "desktop" } },
  });
  await commands(
    "canonical title protected",
    "PATCH",
    "/api/remote-surfaces/browser",
    { status: 404, json: { titleProtection: label("remote-surface") } },
  );
  await commands("raw label update", "PATCH", raw, {
    json: {
      titleProtection: label("remote-surface"),
      preferredTransport: "websocket",
    },
  });
  const updated = await commands("raw state update", "PATCH", raw, {
    json: {
      stateProtection: protectedState("browser-state"),
      expectedStateRevision: 1,
    },
  });
  assert.equal(updated.stateRevision, 2);
  await commands("raw stale update", "PATCH", raw, {
    status: 409,
    json: {
      stateProtection: protectedState("browser-state"),
      expectedStateRevision: 1,
    },
  });
  await commands(
    "kind mismatch update",
    "PATCH",
    "/api/remote-surfaces/remote",
    { status: 404, json: { configuration: { kind: "browser" } } },
  );
  await commands("suspend", "POST", raw + "/suspend");
  await commands("resume", "POST", raw + "/resume");
  state.errors = { "surface.suspend": "Controlled surface failure" };
  await commands("suspend failure", "POST", raw + "/suspend", { status: 502 });
  delete state.errors;
  const created = await commands("create desktop", "POST", desktops, {
    status: 201,
    json: {
      ...desktopCreate,
      target: { kind: "worker", projectId: "github", workerId: "alpha" },
    },
  });
  assert.equal(created.id, desktopId);
  assert.equal(created.stateRevision, 1);
  await commands("desktop update", "PATCH", desktop, {
    json: {
      expectedStateRevision: 1,
      stateProtection: protectedState("remote-desktop-state"),
    },
  });
  await commands("desktop stale", "PATCH", desktop, {
    status: 409,
    json: {
      expectedStateRevision: 1,
      stateProtection: protectedState("remote-desktop-state"),
    },
  });
  state.errors = {
    "surface.configure": "Private worker error must be replaced",
  };
  const failed = await commands("desktop configure failure", "PATCH", desktop, {
    json: {
      expectedStateRevision: 2,
      stateProtection: protectedState("remote-desktop-state"),
    },
  });
  assert.equal(failed.status, "error");
  assert.equal(
    failed.lastError,
    "The worker could not apply the encrypted Remote Desktop target.",
  );
  delete state.errors;
  for (const message of [null, ""]) {
    state.replies = { "surface.desktop.probe": { available: false, message } };
    await commands(
      "desktop probe unavailable " + JSON.stringify(message),
      "POST",
      desktops,
      { status: 409, json: desktopCreate },
    );
  }
  state.replies = { "surface.desktop.probe": { available: true } };
  await commands("desktop probe malformed", "POST", desktops, {
    status: 502,
    json: desktopCreate,
  });
  delete state.replies;
  await visit(
    "missing fleet",
    "GET",
    "/api/projects/missing/remote-desktop-fleet",
    { status: 404 },
  );
  await visit(
    "foreign fleet",
    "GET",
    "/api/projects/other/remote-desktop-fleet",
    { status: 404 },
  );
  const fleet = await commands(
    "fleet",
    "GET",
    "/api/projects/github/remote-desktop-fleet",
  );
  assert.equal(fleet.workers.find((w) => w.workerId === "alpha").status, "ok");
  assert.equal(fleet.partial, true);
  state.errors = { "surface.desktop.targets": "Private inventory failure" };
  const failure = await commands(
    "fleet worker failure",
    "GET",
    "/api/projects/github/remote-desktop-fleet",
  );
  assert.equal(
    failure.workers.find((w) => w.workerId === "alpha").error.message,
    "Could not inspect alpha worker.",
  );
  delete state.errors;
  state.replies = {
    "surface.desktop.targets": {
      operationId: surfaceId,
      stateProtection: protectedState("remote-desktop-state"),
      monitorCount: 0,
      windowCount: 0,
    },
  };
  await commands(
    "fleet invalid protection",
    "GET",
    "/api/projects/github/remote-desktop-fleet",
  );
  delete state.replies;
  await remoteDesktopOsCases({ f, state, commands, owner });
  await remoteSurfaceSocketCases({ f, state, worker, result });
  if (stress)
    await remoteSurfaceStressCases({ f, state, worker, visit, result });
  if (timers) await remoteSurfaceTimerCases({ f, state, visit, result });
  await remoteSurfaceBoundaryCases({
    f,
    state,
    visit,
    result,
    profile,
    timers,
  });
  await commands(
    "delete generic browser",
    "DELETE",
    "/api/remote-surfaces/" + surfaceId,
    { status: 204 },
  );
  await eventually(
    () =>
      state.commands.filter(
        (c) => c.type === "surface.close" && c.surfaceId === surfaceId,
      ).length,
    (n) => assert.equal(n, 1),
  );
  await commands(
    "delete missing",
    "DELETE",
    "/api/remote-surfaces/" + surfaceId,
    { status: 404 },
  );
  await commands(
    "delete canonical desktop",
    "DELETE",
    "/api/remote-surfaces/" + desktopId,
    { status: 204 },
  );
  const [retained] = await f.sql(
    [],
    [
      `SELECT jsonb_build_object('view',EXISTS(SELECT 1 FROM project_views WHERE id=${literal(desktopId)}),'surface',EXISTS(SELECT 1 FROM remote_surfaces WHERE id=${literal(desktopId)}))::text AS result`,
    ],
  );
  assert.deepEqual(retained, { view: true, surface: false });
  result.cases.push({ name: "delete retains canonical view", retained });
  await remoteSurfaceWorkerDisconnect({ f, state, worker, result });
  await commands("offline suspend", "POST", raw + "/suspend", { status: 503 });
  const offline = await commands("offline desktop update", "PATCH", desktop, {
    json: {
      expectedStateRevision: 3,
      stateProtection: protectedState("remote-desktop-state"),
    },
  });
  assert.equal(offline.status, "offline");
  await commands("offline desktop create", "POST", desktops, {
    status: 409,
    json: desktopCreate,
  });
  // Direct persistence checks compare the exact protected envelope after writes.
  const [saved] = await f.sql(
    [],
    [
      "SELECT jsonb_build_object('state',protected_state,'revision',state_revision,'status',status)::text AS result FROM remote_surfaces WHERE id='desktop'",
    ],
  );
  assert.deepEqual(saved.state, protectedState("remote-desktop-state"));
  assert.equal(saved.revision, 4);
  assert.equal(saved.status, "offline");
  result.cases.push({ name: "retained encrypted desktop", saved });
}
