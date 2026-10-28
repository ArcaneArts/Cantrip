// Disposable, schema-valid resource records shared by repository/socket tests.
import { projectLabel } from "./security-fixtures.mjs";
import { surfacePrivateStateOpaqueSchema } from "../../packages/protocol/dist/surface-private-state.js";
import { remoteSurfaceConfigurationSchema } from "../../packages/protocol/dist/remote-surfaces.js";
export const localOwner = "00000000-0000-0000-0000-000000000001";
export const otherOwner = "11111111-1111-4111-8111-111111111111";
export const literal = (v) =>
  v === null
    ? "NULL"
    : typeof v === "boolean" || typeof v === "number"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
export const json = (v) => literal(JSON.stringify(v)) + "::jsonb";
export const label = (recordKind) => ({
  ...projectLabel,
  classification: { recordKind },
});
export const state = (recordKind) =>
  surfacePrivateStateOpaqueSchema.parse({
    classification: { recordKind },
    protectedState: projectLabel.protectedLabel,
  });
export const stamp = "2026-10-25T00:00:00.123Z";
export function targetStateSql(owner = localOwner, other = otherOwner) {
  const sql = [
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES(${literal(other)},'account','Other owner','member','active','other-target@example.invalid','other-target@example.invalid') ON CONFLICT(id) DO NOTHING`,
  ];
  for (const [id, user] of [
    ["alpha", owner],
    ["beta", owner],
    ["�", owner],
    ["foreign", other],
  ])
    sql.push(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,remote_surface_capabilities,started_at,last_seen_at,created_at,updated_at) VALUES(${literal(id)},${literal(user)},${literal(id + " worker")},'linux','x64','{"browser":true,"desktop":true}',${literal(stamp)},'2099-01-01',${literal(stamp)},${literal(stamp)})`,
    );
  sql.push(
    `INSERT INTO user_settings(user_id,default_worker_id) VALUES(${literal(owner)},'beta') ON CONFLICT(user_id) DO UPDATE SET default_worker_id='beta'`,
  );
  for (const [project, origin, git, folder, user] of [
    ["github", "github", true, null, owner],
    ["folder", "managed-folder", false, "external", owner],
    ["local-git", "managed-folder", true, "managed", owner],
    ["other", "github", true, null, other],
  ]) {
    sql.push(
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index,created_at,updated_at) VALUES(${literal(project)},${literal(user)},${json(label("project"))},${literal(origin)},${literal(folder)},${git},${origin === "github"},${literal(origin === "github" ? "agent-managed" : "direct")},${literal(user === owner ? "alpha" : "foreign")},${literal(origin === "github" ? project + "-blind-index" : null)},${literal(stamp)},${literal(stamp)})`,
    );
    for (const worker of user === owner ? ["alpha", "beta"] : ["foreign"]) {
      const source = project + "-" + worker,
        tree = source + "-main",
        root = "/fixture/" + source;
      sql.push(
        `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,created_at,updated_at) VALUES(${literal(source)},${literal(project)},${literal(worker)},${literal(project === "folder" ? "folder" : "git")},${literal(root)},${literal(root)},${literal(stamp)},${literal(stamp)})`,
      );
      sql.push(
        `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES(${literal(tree)},${literal(source)},${literal(worker)},'main',${literal(root)},${literal(root)},true,'cantrip','ready',${literal(stamp)},${literal(stamp)})`,
      );
    }
  }
  for (const project of ["github", "other"]) {
    const user = project === "github" ? owner : other,
      worker = project === "github" ? "alpha" : "foreign",
      tree = project + "-" + worker + "-main",
      prefix = project === "github" ? "" : "other-";
    sql.push(
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,created_at,updated_at) VALUES(${literal(prefix + "chat")},${literal(user)},${literal(project)},${literal(tree)},${literal(worker)},${json(label("chat"))},${literal(stamp)},${literal(stamp)})`,
    );
    for (const [table, id, record, stateKind] of [
      ["terminals", prefix + "terminal", "terminal", "terminal-state"],
      ["explorers", prefix + "explorer", "explorer", "explorer-state"],
      ["code_tabs", prefix + "code", "code-tab", null],
    ])
      sql.push(
        `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label${stateKind ? ",protected_state" : ""},created_at,updated_at) VALUES(${literal(id)},${literal(project)},${literal(worker)},${literal(tree)},${json(label(record))}${stateKind ? "," + json(state(stateKind)) : ""},${literal(stamp)},${literal(stamp)})`,
      );
    sql.push(
      `INSERT INTO browsers(id,project_id,protected_label,protected_state,created_at,updated_at) VALUES(${literal(prefix + "browser")},${literal(project)},${json(label("browser"))},${json(state("browser-state"))},${literal(stamp)},${literal(stamp)})`,
    );
    sql.push(
      `INSERT INTO project_views(id,project_id,kind,protected_label,created_at,updated_at) VALUES(${literal(prefix + "desktop")},${literal(project)},'remote-desktop',${json(label("project-view"))},${literal(stamp)},${literal(stamp)})`,
    );
    for (const [id, kind, record, stateKind] of [
      [prefix + "browser", "browser", "browser", "browser-state"],
      [prefix + "desktop", "desktop", "project-view", "remote-desktop-state"],
      [prefix + "remote", "desktop", "remote-surface", "remote-desktop-state"],
      [prefix + "raw-browser", "browser", "remote-surface", "browser-state"],
    ])
      sql.push(
        `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision,created_at,updated_at) VALUES(${literal(id)},${literal(project)},${literal(worker)},${literal(kind)},${json(remoteSurfaceConfigurationSchema.parse({ kind }))},${json(label(record))},${json(state(stateKind))},1,${literal(stamp)},${literal(stamp)})`,
      );
  }
  sql.push(
    `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state,created_at,updated_at) VALUES('�','github','alpha','github-alpha-main',${json(label("terminal"))},${json(state("terminal-state"))},${literal(stamp)},${literal(stamp)})`,
  );
  return sql;
}
