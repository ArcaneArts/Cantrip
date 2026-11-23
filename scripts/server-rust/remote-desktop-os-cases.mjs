// Real SQL ownership/generation captures; guest command results are controlled.
import assert from "node:assert/strict";
import {
  desktopCreate,
  desktopGeneration,
} from "./remote-surface-contract-oracle.mjs";
import { literal, json } from "./project-target-state.mjs";
export const osIds = Object.fromEntries(
  [
    "instance",
    "workspace",
    "source",
    "tree",
    "binding",
    "runtime",
    "attachment",
    "desktop",
  ].map((name, index) => {
    const n = String(index + 2);
    return [
      name,
      `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
    ];
  }),
);
export async function remoteDesktopOsCases({ f, state, commands, owner }) {
  const id = (name) => literal(osIds[name]);
  const guest = "/home/fixture/checkouts/desktop";
  await f.sql([
    `INSERT INTO cantrip_os_instances(id,owner_id,worker_id,guest_instance_id,attachment_generation,transport,name,status,runtime_generation) VALUES(${id("instance")},${literal(owner)},'alpha',${id("instance")},${id("attachment")},${json({ kind: "docker", container: "controlled-desktop" })},'Desktop fixture','connected',${id("runtime")})`,
    `INSERT INTO cantrip_os_workspaces(id,instance_id,guest_workspace_id,uid,gid,home_guest_path) VALUES(${id("workspace")},${id("instance")},'fixture',20000,20000,'/home/fixture')`,
    `INSERT INTO project_source_identities(id,project_id,worker_id,location_kind) VALUES(${id("source")},'folder','alpha','cantrip-os')`,
    `INSERT INTO cantrip_os_project_sources(id,workspace_id,source_kind,guest_path,ownership_kind) VALUES(${id("source")},${id("workspace")},'folder',${literal(guest)},'cantrip')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,location_kind,guest_path,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${id("tree")},${id("source")},'alpha','cantrip-os',${literal(guest)},'main',NULL,${literal(guest)},true,'cantrip','ready')`,
    `INSERT INTO cantrip_os_source_bindings(id,owner_id,project_id,worker_id,project_source_id,worktree_id,workspace_id,mode,guest_path,binding_generation,state,provisioned_attachment_generation,provisioned_runtime_generation) VALUES(${id("binding")},${literal(owner)},'folder','alpha',${id("source")},${id("tree")},${id("workspace")},'linux-owned',${literal(guest)},${id("binding")},'ready',${id("attachment")},${id("runtime")})`,
  ]);
  const input = {
    ...desktopCreate,
    id: osIds.desktop,
    cantripOsBindingId: osIds.binding,
    cantripOsRuntimeGeneration: osIds.runtime,
  };
  const path = "/api/projects/folder/remote-desktops";
  await commands("OS stale runtime", "POST", path, {
    status: 409,
    json: { ...input, cantripOsRuntimeGeneration: osIds.source },
  });
  await commands(
    "OS wrong project",
    "POST",
    "/api/projects/github/remote-desktops",
    { status: 409, json: input },
  );
  await commands("OS missing binding", "POST", path, {
    status: 409,
    json: { ...input, cantripOsBindingId: osIds.desktop },
  });
  await f.sql([
    `UPDATE cantrip_os_source_bindings SET state='failed' WHERE id=${id("binding")}`,
  ]);
  await commands("OS unavailable binding", "POST", path, {
    status: 409,
    json: input,
  });
  await f.sql([
    `UPDATE cantrip_os_source_bindings SET state='ready' WHERE id=${id("binding")}`,
  ]);
  for (const reply of [
    {},
    { desktopGeneration: null },
    { desktopGeneration, extra: true },
  ]) {
    state.replies = { "surface.desktop.os-prepare": reply };
    await commands(
      "OS malformed preparation " + JSON.stringify(reply),
      "POST",
      path,
      { status: 502, json: input },
    );
  }
  delete state.replies;
  const value = await commands("OS captured desktop", "POST", path, {
    status: 201,
    json: input,
  });
  assert.deepEqual(value.osSource, {
    bindingId: osIds.binding,
    worktreeId: osIds.tree,
    bindingGeneration: osIds.binding,
    attachmentGeneration: osIds.attachment,
    runtimeGeneration: osIds.runtime,
    desktopGeneration,
  });
  const prepared = state.commands
    .filter((c) => c.type === "surface.desktop.os-prepare")
    .at(-1);
  assert.equal(prepared.osExecution.scope.bindingId, osIds.binding);
  assert.equal(prepared.osExecution.scope.runtimeGeneration, osIds.runtime);
  assert.equal(prepared.osExecution.scope.ownerId, owner);
  assert.equal(prepared.osExecution.transport.container, "controlled-desktop");
}
