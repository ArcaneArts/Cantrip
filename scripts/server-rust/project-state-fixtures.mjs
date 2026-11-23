import { securityFixtures } from "./security-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
export { localOwner as owner, otherOwner as other, literal, json, stamp };
export const runtime = "66666666-6666-4666-8666-666666666666";
export const osRuntime = "66666666-6666-4666-8666-000000000002";
export const configuration = "77777777-7777-4777-8777-777777777777";
export const operation = "88888888-8888-4888-8888-888888888888";
export const skillKeys = {
  chat: "b".repeat(43),
  both: "a".repeat(43),
  ide: "c".repeat(43),
  beta: "d".repeat(43),
  foreign: "e".repeat(43),
};
export const githubInput = {
  ...structuredClone(securityFixtures.encryptedGithubProjectCreateSchema[0]),
  id: "99999999-9999-4999-8999-999999999999",
  workerId: "alpha",
  workspaceId: "workspace:default:" + localOwner,
  nameProtection: label("project"),
};
export const protectedValue =
  securityFixtures.runConfigurationSecretSetRequestSchema[0].protectedValue;
export const osRoots = structuredClone(
  securityFixtures.cantripOsRunRootsSchema[0],
);
export function projectStateSql() {
  const sql = targetStateSql();
  for (const user of [localOwner, otherOwner]) {
    const workspace = "workspace:default:" + user;
    sql.push(
      `INSERT INTO project_workspaces(id,owner_id,position,is_default,created_at,updated_at) VALUES(${literal(workspace)},${literal(user)},0,true,${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
    );
    sql.push(
      `INSERT INTO project_workspace_storage_profiles(workspace_id,kind,created_at,updated_at) VALUES(${literal(workspace)},'system',${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
    );
  }
  sql.push(
    `INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) SELECT 'workspace:default:'||owner_id,id,${literal(stamp)} FROM projects`,
  );
  sql.push(
    `UPDATE user_settings SET mobile_project_tab_configurations=${json({ github: [null, "chat"], folder: [null, "chat"] })},created_at=${literal(stamp)},updated_at=${literal(stamp)} WHERE user_id=${literal(localOwner)}`,
  );
  for (const [provider, user] of [
    ["fixture", localOwner],
    ["foreign-provider", otherOwner],
  ])
    sql.push(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,created_at,updated_at) VALUES(${literal(provider)},${literal(user)},${literal(provider)},'ollama','http://localhost:11434',${literal(stamp)},${literal(stamp)})`,
    );
  for (const [worker, user, provider, key, audience] of [
    ["alpha", localOwner, "fixture", skillKeys.chat, "chat"],
    ["alpha", localOwner, "fixture", skillKeys.both, "both"],
    ["alpha", localOwner, "fixture", skillKeys.ide, "ide"],
    ["beta", localOwner, "fixture", skillKeys.beta, "chat"],
    ["foreign", otherOwner, "foreign-provider", skillKeys.foreign, "chat"],
  ])
    sql.push(
      `INSERT INTO skill_audiences(owner_id,worker_id,provider_id,audience_key,audience,created_at,updated_at) VALUES(${literal(user)},${literal(worker)},${literal(provider)},${literal(key)},${literal(audience)},${literal(stamp)},${literal(stamp)})`,
    );
  for (const [index, reference] of ["run/z", "run/a"].entries())
    sql.push(
      `INSERT INTO run_configuration_secrets(id,owner_id,project_id,reference,protected_value,revision,created_at,updated_at) VALUES('eeeeeeee-eeee-4eee-8eee-${String(index + 1).padStart(12, "0")}',${literal(localOwner)},'github',${literal(reference)},${json(protectedValue)},3,${literal(stamp)},${literal(stamp)})`,
    );
  sql.push(
    `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,state,created_at,updated_at) VALUES(${literal(runtime)},${literal(localOwner)},'github',${literal(configuration)},'github-alpha-main','alpha','${"a".repeat(64)}',${literal(operation)},'running',${literal(stamp)},${literal(stamp)})`,
  );
  sql.push(
    `INSERT INTO run_configuration_runtime_operations(id,owner_id,project_id,configuration_id,worktree_id,runtime_id,worker_id,operation,outcome,generation,definition_revision,created_at) VALUES(${literal(operation)},${literal(localOwner)},'github',${literal(configuration)},'github-alpha-main',${literal(runtime)},'alpha','start','accepted',0,'${"a".repeat(64)}',${literal(stamp)})`,
  );
  sql.push(
    `INSERT INTO project_github_conversion_jobs(id,owner_id,project_id,project_source_id,worker_id,repository_blind_index,repository_id,repository_full_name,repository_url,confirmation_token,state,created_at,updated_at) VALUES('conversion',${literal(localOwner)},'local-git','local-git-alpha','alpha','pending-blind','opaque-repository','opaque-owner','opaque-url','fixture-confirmation','queued',${literal(stamp)},${literal(stamp)})`,
  );
  return sql;
}
const tables = [
  "projects",
  "project_sources",
  "project_worktrees",
  "project_workspaces",
  "project_workspace_storage_profiles",
  "project_workspace_memberships",
  "project_replica_jobs",
  "project_github_conversion_jobs",
  "chats",
  "terminals",
  "remote_surfaces",
  "browsers",
  "explorers",
  "code_tabs",
  "project_views",
  "model_providers",
  "skill_audiences",
  "run_configuration_secrets",
  "run_configuration_runtimes",
  "run_configuration_runtime_operations",
];
export const snapshotSql = `SELECT jsonb_build_object(${tables.map((table) => `${literal(table)},(SELECT coalesce(jsonb_agg(row ORDER BY coalesce(row->>'id',row->>'workspace_id',''),row->>'project_id',row->>'audience_key'),'[]'::jsonb) FROM (SELECT to_jsonb(t) row FROM ${table} t) rows)`).join(",")},'settings',(SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'mobile_project_tab_configurations',mobile_project_tab_configurations,'updated_at',updated_at) ORDER BY user_id),'[]'::jsonb) FROM user_settings)) result`;
