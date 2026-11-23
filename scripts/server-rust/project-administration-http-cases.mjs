import assert from "node:assert/strict";
import {
  projects,
  projectSql,
  literal,
  json,
  stamp,
} from "./project-administration-state.mjs";

export async function preferenceCases({ f, settle, snapshot, result }) {
  const preferred = (label, id, workerId, status = 200) =>
    settle(
      label,
      "PATCH",
      `/api/projects/${id}/preferred-worker`,
      { json: { workerId }, status },
      status === 200 ? "preference" : undefined,
    );
  const policy = (label, id, value, status = 200) =>
    settle(
      label,
      "PATCH",
      `/api/projects/${id}/worktree-policy`,
      { json: { policy: value }, status },
      status === 200 ? "preference" : undefined,
    );
  for (const value of ["direct", "agent-managed", "required-for-writes"])
    await policy("policy " + value, projects.github, value);
  await policy("invalid policy", projects.github, "invalid", 400);
  for (const id of [projects.folder, projects["local-git"]]) {
    await policy("capability precedes schema " + id, id, null, 409);
  }
  await preferred("folder relocation capability", projects.folder, "beta", 409);
  await preferred("GitHub owned offline worker", projects.github, "beta");
  await preferred("clear preferred worker", projects.github, null);
  await preferred("missing worker", projects.github, "missing", 404);
  await preferred("foreign worker", projects.github, "foreign", 404);
  await preferred("foreign project", projects.other, "alpha", 404);
  await preferred("foreign project malformed input", projects.other, 9, 400);
  await preferred("local Git ready source", projects["local-git"], "beta");
  await f.sql([
    "UPDATE project_worktrees SET lifecycle_state='preparing' WHERE id='local-git-beta-main'",
  ]);
  await preferred(
    "local Git source not ready",
    projects["local-git"],
    "beta",
    409,
  );
  await f.sql([
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='local-git-beta-main'",
  ]);
  await preferred("local Git missing source", projects["local-git"], "�", 409);
  await f.sql([
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,created_at,updated_at) VALUES('local-git-replacement',${literal(projects["local-git"])},'�','git','/fixture/replacement','/fixture/replacement',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES('local-git-replacement-main','local-git-replacement','�','main','/fixture/replacement','/fixture/replacement',true,'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
  ]);
  await preferred(
    "GitHub lone surrogate SQL boundary",
    projects.github,
    "\ud800",
  );
  await preferred(
    "local Git lone surrogate is distinct",
    projects["local-git"],
    "\ud800",
    409,
  );
  await preferred(
    "local Git replacement character source",
    projects["local-git"],
    "�",
  );
  await preferred("clear local Git preference", projects["local-git"], null);
  await f.sql(projectSql(f.owner, "�", { sources: [] }));
  const ids = (await snapshot()).projects
    .filter((p) => p.owner_id === f.owner)
    .map((p) => p.id)
    .reverse();
  const order = (label, ids, status = 204) =>
    settle(
      label,
      "PATCH",
      "/api/projects/order",
      { json: { ids }, status },
      status === 204 ? "order" : undefined,
    );
  await order("reorder all owned projects", ids);
  await order("idempotent ordering", ids);
  await order("missing order member", ids.slice(1), 400);
  await order(
    "duplicate order member",
    ids.map((v, i) => (i === 1 ? ids[0] : v)),
    400,
  );
  await order("foreign order member", [...ids.slice(1), projects.other], 400);
  await order(
    "surrogate order identity",
    ids.map((id) => (id === "�" ? "\ud800" : id)),
    400,
  );
  await f.sql([
    `CREATE FUNCTION project_order_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(ids[1])} AND NEW.position<>OLD.position THEN RAISE EXCEPTION 'controlled project order failure'; END IF; RETURN NEW; END $$`,
    "CREATE TRIGGER project_order_fault BEFORE UPDATE OF position ON projects FOR EACH ROW EXECUTE FUNCTION project_order_fault()",
  ]);
  try {
    await order("ordering transaction rolls back", [...ids].reverse(), 500);
  } finally {
    await f.sql([
      "DROP TRIGGER project_order_fault ON projects",
      "DROP FUNCTION project_order_fault()",
    ]);
  }
  result.preferenceCasesCompleted = true;
}

export async function removalCases({ f, settle, snapshot, state, result }) {
  let counter = 0;
  const make = async (options) => {
    const id = `22222222-2222-4222-8222-${String(++counter).padStart(12, "0")}`;
    await f.sql(projectSql(f.owner, id, options));
    return id;
  };
  const remove = (
    label,
    id,
    deleteLocalFiles,
    status = 204,
    mutation = status === 204 ? "remove" : undefined,
  ) =>
    settle(
      label,
      "DELETE",
      `/api/projects/${encodeURIComponent(id)}`,
      {
        ...(deleteLocalFiles === undefined
          ? {}
          : { json: { deleteLocalFiles } }),
        status,
      },
      mutation,
    );
  await settle(
    "invalid removal input",
    "DELETE",
    `/api/projects/${projects.github}`,
    { json: { deleteLocalFiles: "true" }, status: 400 },
  );
  await remove("missing removal default body", "missing", undefined, 404);
  await settle(
    "null removal body defaults",
    "DELETE",
    "/api/projects/missing",
    { json: null, status: 404 },
  );
  await remove("foreign removal", projects.other, false, 404);
  const noMembership = await make({ membership: false });
  await remove(
    "missing workspace storage is a real failure",
    noMembership,
    false,
    500,
  );
  for (const status of ["cloning", "preparing"]) {
    const id = await make();
    await f.sql([
      `UPDATE projects SET setup_status=${literal(status)} WHERE id=${literal(id)}`,
    ]);
    await remove("active setup " + status, id, true, 409);
  }
  for (const jobState of ["queued", "running", "blocked"]) {
    const id = await make();
    await f.sql([
      `INSERT INTO project_replica_jobs(id,owner_id,project_id,worker_id,kind,state,idempotency_key,payload_fingerprint,progress,available_at,lease_expires_at,created_at,updated_at) VALUES(${literal(id.replace(/^22222222/, "33333333"))},${literal(f.owner)},${literal(id)},'beta','provision',${literal(jobState)},${literal(id)},'opaque-fingerprint',${json({ stage: jobState === "running" ? "dispatching" : jobState, percent: 0, updatedAt: stamp })},'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z',${literal(stamp)},${literal(stamp)})`,
    ]);
    await remove(
      "replica job " + jobState,
      id,
      false,
      jobState === "blocked" ? 204 : 409,
    );
  }
  const conversion = (id, jobState, worker = "alpha", deleted = false) =>
    `INSERT INTO project_github_conversion_jobs(id,owner_id,project_id,project_source_id,worker_id,repository_blind_index,repository_id,repository_full_name,repository_url,confirmation_token,state,available_at,lease_expires_at,completed_at,local_files_deleted_at,created_at,updated_at) VALUES(${literal(id.replace(/^22222222/, "44444444"))},${literal(f.owner)},${literal(id)},${literal(id + "-" + worker)},${literal(worker)},${literal(id + "-conversion-blind")},'123','fixture/repository','https://github.com/fixture/repository','opaque-confirmation',${literal(jobState)},'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z',${literal(jobState === "succeeded" ? stamp : null)},${literal(deleted ? stamp : null)},${literal(stamp)},${literal(stamp)})`;
  for (const jobState of ["queued", "running", "blocked"]) {
    const id = await make();
    await f.sql([conversion(id, jobState)]);
    await remove("conversion job " + jobState, id, false, 409);
  }
  const external = await make({
    origin: "managed-folder",
    management: "external",
  });
  await remove("attached folder refuses file deletion", external, true, 409);
  await remove("attached folder preserves files", external, false);
  const missingWorker = await make({
    origin: "managed-folder",
    management: "managed",
    sources: [],
  });
  await f.sql([
    `UPDATE projects SET preferred_worker_id=NULL WHERE id=${literal(missingWorker)}`,
  ]);
  await remove("folder missing owning worker", missingWorker, true, 409);
  const folder = await make({
    origin: "managed-folder",
    management: "managed",
  });
  await f.sql([
    "UPDATE workers SET managed_folder_capabilities=jsonb_set(managed_folder_capabilities,'{remove}','false') WHERE id='alpha'",
  ]);
  await remove("folder worker lacks capability", folder, true, 409);
  await f.sql([
    "UPDATE workers SET managed_folder_capabilities=jsonb_set(managed_folder_capabilities,'{remove}','true') WHERE id IN ('alpha','beta')",
  ]);
  const offlineFolder = await make({
    origin: "managed-folder",
    management: "managed",
    sources: ["beta"],
  });
  await remove("folder owning worker offline", offlineFolder, true, 503);
  const offlineReplica = await make({ sources: ["alpha", "beta"] });
  await remove("owned replica must be online", offlineReplica, true, 503);
  const preserve = await make({ sources: ["alpha", "beta"], resources: true });
  state.fail = "terminal.close";
  await remove("preserve files ignores terminal failures", preserve, false);
  delete state.fail;
  await remove("repeated deletion is missing", preserve, false, 404);
  const surface = await make({ resources: true });
  state.fail = "surface.close";
  await remove("surface close failure is ignored", surface, false);
  delete state.fail;
  const terminal = await make({ resources: true });
  state.fail = "terminal.close";
  await remove(
    "terminal close failure prevents file deletion",
    terminal,
    true,
    502,
  );
  delete state.fail;
  await remove("terminal close retry completes cleanup", terminal, true);
  state.fail = "project.folder.delete";
  await remove("folder deletion worker failure", folder, true, 502);
  delete state.fail;
  state.folderResult = { deleted: "invalid" };
  await remove("folder acknowledgment is validated", folder, true, 502);
  delete state.folderResult;
  await remove("managed folder deletes through worker", folder, true);
  const owned = await make({ sources: ["alpha", "beta"], resources: true });
  await f.sql([
    `UPDATE project_sources SET ownership_kind='user' WHERE id=${literal(owned + "-beta")}`,
  ]);
  await remove("user-owned offline replica is preserved", owned, true);
  const converted = await make({ sources: ["alpha", "beta"] });
  await f.sql([
    conversion(converted, "succeeded"),
    `UPDATE project_sources SET ownership_kind='user' WHERE id=${literal(converted + "-beta")}`,
  ]);
  await remove(
    "converted managed source uses folder deletion",
    converted,
    true,
  );
  const convertedDeleted = await make();
  await f.sql([conversion(convertedDeleted, "succeeded", "alpha", true)]);
  await remove(
    "already deleted converted source uses normal source cleanup",
    convertedDeleted,
    true,
  );
  const convertedOffline = await make({ sources: ["beta"] });
  await f.sql([conversion(convertedOffline, "succeeded", "beta")]);
  await remove(
    "converted folder owning worker offline",
    convertedOffline,
    true,
    503,
  );
  const tab = await make();
  await f.sql([
    `UPDATE user_settings SET mobile_project_tab_configurations=mobile_project_tab_configurations||${json({ [tab]: [null, "chat"] })} WHERE user_id=${literal(f.owner)}`,
  ]);
  await remove("mobile project configuration cleanup", tab, false);
  for (const id of ["order", "from-folder", "from-github"]) {
    await f.sql(projectSql(f.owner, id, { sources: [] }));
    await remove(
      "static path retains DELETE project identity " + id,
      id,
      false,
    );
  }
  for (const [method, url] of [
    ["POST", `/api/projects/${projects.github}`],
    ["PUT", `/api/projects/${projects.github}/preferred-worker`],
    ["DELETE", `/api/projects/${projects.github}/worktree-policy`],
  ])
    await settle("unsupported " + method + url, method, url, {
      json: {},
      status: 404,
    });
  result.removalCasesCompleted = true;
}
