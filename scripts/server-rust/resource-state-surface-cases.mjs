import assert from "node:assert/strict";
import { encryptedRemoteSurfaceCreateSchema } from "../../packages/protocol/dist/index.js";
import {
  surfaceCreate,
  surfaceId,
  desktopCreate,
  desktopId,
} from "./remote-surface-contract-oracle.mjs";
import { label, state } from "./project-target-state.mjs";

export async function resourceSurfaceCases({ observe, seed, reopen, other }) {
  for (const project of ["missing", "other"])
    for (const op of ["surfaces", "desktops"])
      await observe(
        "hidden resource catalog " + op + ":" + project,
        op,
        { project },
        { expected: [] },
      );
  for (const surface of ["missing", "other-desktop", "browser"])
    await observe(
      "hidden or non-desktop detail " + surface,
      "desktop",
      { surface },
      { expected: null },
    );
  await observe(
    "canonical surfaces retain labels and opaque state",
    "surfaces",
  );
  await observe("canonical desktop list", "desktops");
  await observe("canonical desktop detail", "desktop", { surface: "desktop" });
  const input = encryptedRemoteSurfaceCreateSchema.parse(surfaceCreate);
  for (const extra of [
    { project: "other" },
    { project: "missing" },
    { input: { ...input, workerId: "foreign" } },
  ])
    await observe(
      "surface creation verifies both owned resources " + JSON.stringify(extra),
      "surface-create",
      { input, ...extra },
      { expected: null },
    );
  await observe(
    "create opaque browser surface",
    "surface-create",
    { input },
    {
      unchanged: false,
      check: ({ response }) => {
        assert.equal(response.value.id, surfaceId);
        assert.deepEqual(response.value.stateProtection, input.stateProtection);
        assert.equal(response.value.stateRevision, 1);
      },
    },
  );
  await observe(
    "duplicate surface rejects without a new row",
    "surface-create",
    { input },
    { rejected: true },
  );
  for (const extra of [
    { surface: "missing" },
    { surface: "other-remote" },
    { owner: other, surface: surfaceId },
  ])
    await observe(
      "surface update hides unavailable target " + JSON.stringify(extra),
      "surface-update",
      {
        surface: surfaceId,
        input: { titleProtection: label("remote-surface") },
        ...extra,
      },
      { expected: null },
    );
  await observe(
    "surface state CAS increments the protected revision",
    "surface-update",
    {
      surface: surfaceId,
      input: {
        expectedStateRevision: 1,
        stateProtection: state("browser-state"),
        titleProtection: label("remote-surface"),
        preferredTransport: "websocket",
      },
    },
    {
      unchanged: false,
      check: ({ response }) => {
        assert.equal(response.value.stateRevision, 2);
        assert.equal(response.value.preferredTransport, "websocket");
      },
    },
  );
  await observe(
    "stale surface state retains the accepted row and clock",
    "surface-update",
    {
      surface: surfaceId,
      input: {
        expectedStateRevision: 1,
        stateProtection: state("browser-state"),
      },
    },
    { rejected: true },
  );
  await seed(
    "ALTER TABLE remote_surfaces ADD CONSTRAINT fixture_surface_revision CHECK(state_revision <> 3) NOT VALID",
  );
  await observe(
    "actual surface write failure retains the accepted row",
    "surface-update",
    {
      surface: surfaceId,
      input: {
        expectedStateRevision: 2,
        stateProtection: state("browser-state"),
      },
    },
    { rejected: true },
  );
  await seed(
    "ALTER TABLE remote_surfaces DROP CONSTRAINT fixture_surface_revision",
  );
  await reopen("created browser surface and accepted CAS state");
  await observe("surface catalog after retained restart", "surfaces");

  for (const extra of [
    { project: "other" },
    { project: "missing" },
    { worker: "foreign" },
  ])
    await observe(
      "desktop creation verifies both owned resources " + JSON.stringify(extra),
      "desktop-create",
      { worker: "alpha", input: desktopCreate, ...extra },
      { expected: null },
    );
  await seed(
    `ALTER TABLE remote_surfaces ADD CONSTRAINT fixture_desktop_insert CHECK(id <> '${desktopId}') NOT VALID`,
  );
  await observe(
    "desktop surface failure rolls back the earlier view insert",
    "desktop-create",
    { worker: "alpha", input: desktopCreate },
    { rejected: true },
  );
  await seed(
    "ALTER TABLE remote_surfaces DROP CONSTRAINT fixture_desktop_insert",
  );
  await observe(
    "desktop pane failure rolls back both inserted rows",
    "desktop-create",
    {
      worker: "alpha",
      input: { ...desktopCreate, paneId: "missing-pane" },
    },
    { rejected: true },
  );
  await observe(
    "create canonical opaque desktop and pane",
    "desktop-create",
    { worker: "alpha", input: desktopCreate },
    {
      unchanged: false,
      check: ({ response, after }) => {
        assert.equal(response.value.id, desktopId);
        assert.equal(response.value.workerId, "alpha");
        assert.deepEqual(
          response.value.stateProtection,
          desktopCreate.stateProtection,
        );
        assert.ok(after.project_views.some((row) => row.id === desktopId));
        assert.ok(after.remote_surfaces.some((row) => row.id === desktopId));
        assert.ok(
          after.tab_group_members.some((row) => row.tab_id === desktopId),
        );
      },
    },
  );
  await observe("new canonical desktop detail", "desktop", {
    surface: desktopId,
  });
  await observe("new canonical desktop list", "desktops");
  await reopen("created desktop, private state and pane layout");
  await observe("desktop detail after retained restart", "desktop", {
    surface: desktopId,
  });

  for (const extra of [
    { surface: "missing" },
    { surface: "other-remote" },
    { owner: other, surface: surfaceId },
  ])
    await observe(
      "surface deletion hides unavailable target " + JSON.stringify(extra),
      "surface-delete",
      { surface: surfaceId, ...extra },
      { expected: null },
    );
  await observe(
    "surface deletion returns the actual prior execution context",
    "surface-delete",
    { surface: surfaceId },
    {
      unchanged: false,
      check: ({ response, after }) => {
        assert.equal(response.value.surface.id, surfaceId);
        assert.ok(!after.remote_surfaces.some((row) => row.id === surfaceId));
      },
    },
  );
  await observe(
    "repeated surface deletion has no effect",
    "surface-delete",
    { surface: surfaceId },
    { expected: null },
  );
  await observe(
    "desktop surface deletion preserves its canonical view and pane",
    "surface-delete",
    { surface: desktopId },
    {
      unchanged: false,
      check: ({ before, after }) => {
        assert.deepEqual(after.project_views, before.project_views);
        assert.deepEqual(after.tab_group_members, before.tab_group_members);
        assert.ok(!after.remote_surfaces.some((row) => row.id === desktopId));
      },
    },
  );
  await reopen("surface deletion retains the canonical desktop view");
}
