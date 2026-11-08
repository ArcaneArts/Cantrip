// Disposable SQL state for real production HTTP/worker cleanup comparisons.
import assert from "node:assert/strict";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
export { localOwner, otherOwner, literal, json, stamp };
export const projects = {
  github: "11111111-1111-4111-8111-000000000001",
  folder: "11111111-1111-4111-8111-000000000002",
  "local-git": "11111111-1111-4111-8111-000000000003",
  other: "11111111-1111-4111-8111-000000000004",
};
const tables = [
  "projects",
  "project_sources",
  "project_worktrees",
  "project_workspace_memberships",
  "chats",
  "terminals",
  "remote_surfaces",
  "explorers",
  "code_tabs",
  "browsers",
  "project_views",
  "project_replica_jobs",
  "project_github_conversion_jobs",
];
export const snapshotQuery = `SELECT jsonb_build_object(${tables.map((t) => `${literal(t)},(SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]') FROM (SELECT to_jsonb(t) AS row FROM ${t} t) s)`).join(",")},'settings',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'default_worker_id',default_worker_id,'mobile_project_tab_configurations',mobile_project_tab_configurations) ORDER BY user_id) FROM user_settings))::text AS result`;
export function seed(owner) {
  return [
    ...targetStateSql(owner, otherOwner, projects).filter(
      (sql) => !/^INSERT INTO workers.*VALUES\('alpha'/.test(sql),
    ),
    `INSERT INTO project_workspaces(id,owner_id,position,is_default,created_at,updated_at) VALUES(${literal("workspace:default:" + otherOwner)},${literal(otherOwner)},0,true,${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
    `INSERT INTO project_workspace_storage_profiles(workspace_id,kind,created_at,updated_at) SELECT id,'system',${literal(stamp)},${literal(stamp)} FROM project_workspaces ON CONFLICT DO NOTHING`,
    `INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) SELECT 'workspace:default:'||owner_id,id,${literal(stamp)} FROM projects`,
    `UPDATE user_settings SET mobile_project_tab_configurations=${json({ [projects.github]: [null, "chat"], [projects.folder]: [null, "chat"] })} WHERE user_id=${literal(owner)}`,
  ];
}
export function projectSql(
  owner,
  id,
  {
    origin = "github",
    management = null,
    git = origin === "github",
    sources = ["alpha"],
    resources = false,
    membership = true,
  } = {},
) {
  const statements = [
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index,created_at,updated_at) VALUES(${literal(id)},${literal(owner)},${json(label("project"))},${literal(origin)},${literal(management)},${git},${origin === "github"},${literal(origin === "github" ? "agent-managed" : "direct")},'alpha',${literal(origin === "github" ? id + "-blind" : null)},${literal(stamp)},${literal(stamp)})`,
  ];
  if (membership)
    statements.push(
      `INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) VALUES(${literal("workspace:default:" + owner)},${literal(id)},${literal(stamp)})`,
    );
  for (const worker of sources) {
    const source = id + "-" + worker,
      tree = source + "-main",
      cwd = "/fixture/" + source;
    statements.push(
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,created_at,updated_at) VALUES(${literal(source)},${literal(id)},${literal(worker)},${literal(git ? "git" : "folder")},${literal(cwd)},${literal(cwd)},${literal(stamp)},${literal(stamp)})`,
    );
    statements.push(
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES(${literal(tree)},${literal(source)},${literal(worker)},'main',${literal(cwd)},${literal(cwd)},true,'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
    );
  }
  if (resources) {
    statements.push(
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,created_at,updated_at) SELECT ${literal(id + "-chat")},owner_id,${literal(id)},${literal(id + "-alpha-main")},'alpha',protected_label,created_at,updated_at FROM chats WHERE id='chat'`,
    );
    for (const suffix of ["a", "b"])
      statements.push(
        `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state,created_at,updated_at) SELECT ${literal(id + "-terminal-" + suffix)},${literal(id)},'alpha',${literal(id + "-alpha-main")},protected_label,protected_state,created_at,updated_at FROM terminals WHERE id='terminal'`,
      );
    for (const suffix of ["a", "b"])
      statements.push(
        `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision,created_at,updated_at) SELECT ${literal(id + "-surface-" + suffix)},${literal(id)},'alpha',kind,configuration,protected_label,protected_state,state_revision,created_at,updated_at FROM remote_surfaces WHERE id='remote'`,
      );
  }
  return statements;
}
export function comparable(raw, fixture) {
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.map((v) => visit(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, visit(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (/_at$/.test(key)) {
      assert.ok(Number.isFinite(Date.parse(value)), key);
      const iso = new Date(value).toISOString();
      if ([stamp, "2099-01-01T00:00:00.000Z"].includes(iso)) return iso;
      assert.ok(Date.parse(value) <= Date.now() + 1000, key);
      return "<database-timestamp>";
    }
    if (value === "workspace:default:" + fixture.owner)
      return "<owner-default-workspace>";
    return fixture.normalize(value, key);
  };
  const result = visit(raw);
  for (const rows of Object.values(result))
    if (Array.isArray(rows))
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}
