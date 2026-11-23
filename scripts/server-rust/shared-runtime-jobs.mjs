// Valid linked SQL fixtures represent already claimed work on another instance.
// This checks startup preservation; real worker lease renewal/expiry is separate.
import assert from "node:assert/strict";
import { projectLabel } from "./security-fixtures.mjs";
const worker = "shared-lease-worker";
const uuid = (n) => `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`;
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const snapshot = `SELECT json_build_object(
  'folder',(SELECT to_jsonb(j) FROM project_folder_setup_jobs j WHERE id='${uuid(1)}'),
  'replica',(SELECT to_jsonb(j) FROM project_replica_jobs j WHERE id='${uuid(2)}'),
  'conversion',(SELECT to_jsonb(j) FROM project_github_conversion_jobs j WHERE id='${uuid(3)}'),
  'discovery',(SELECT to_jsonb(j) FROM workspace_repository_discovery_jobs j WHERE id='${uuid(4)}'),
  'import',(SELECT to_jsonb(j) FROM workspace_repository_candidates j WHERE id='${uuid(5)}'),
  'scratch',(SELECT to_jsonb(j) FROM standalone_chat_root_jobs j WHERE id='${uuid(6)}')
)::text AS result`;
export async function seedPeerJobLeases(peer) {
  const owner = peer.records.get("bootstrap").auth.currentUser.id;
  const label = literal(JSON.stringify(projectLabel));
  const chatLabel = literal(
    JSON.stringify({ ...projectLabel, classification: { recordKind: "chat" } }),
  );
  const progress = literal(
    JSON.stringify({
      stage: "dispatching",
      percent: 5,
      updatedAt: new Date().toISOString(),
    }),
  );
  const projects = ["folder", "replica", "conversion", "import"].map((kind) =>
    kind === "replica"
      ? `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('shared-lease-${kind}-project','${owner}',${label}::jsonb,'shared-lease-repository')`
      : `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES ('shared-lease-${kind}-project','${owner}',${label}::jsonb,'managed-folder','${kind === "import" ? "external" : "managed"}','direct',${kind === "import"},false)`,
  );
  await peer.sql([
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('${worker}','${owner}','Shared lease worker','linux','x64',now(),now())`,
    ...projects,
    `INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('shared-lease-source','shared-lease-conversion-project','${worker}','/fixture','/fixture')`,
    `INSERT INTO project_workspaces(id,owner_id,is_default) VALUES ('workspace:default:${owner}','${owner}',true) ON CONFLICT DO NOTHING`,
    `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode) VALUES ('${uuid(8)}','${owner}','standalone',${chatLabel}::jsonb,'${worker}','${uuid(9)}',NULL)`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id) VALUES ('${uuid(9)}','${uuid(8)}','${owner}','${worker}')`,
    `INSERT INTO project_folder_setup_jobs(id,owner_id,project_id,worker_id,state,state_revision,attempt,command_id,started_at,lease_expires_at) VALUES ('${uuid(1)}','${owner}','shared-lease-folder-project','${worker}','running',2,1,'${uuid(11)}',now(),now()+interval '10 minutes')`,
    `INSERT INTO project_replica_jobs(id,owner_id,project_id,worker_id,kind,state,state_revision,attempt,idempotency_key,payload_fingerprint,progress,command_id,started_at,lease_expires_at) VALUES ('${uuid(2)}','${owner}','shared-lease-replica-project','${worker}','provision','running',2,1,'shared-lease-replica','${"a".repeat(64)}',${progress}::jsonb,'${uuid(12)}',now(),now()+interval '10 minutes')`,
    `INSERT INTO project_github_conversion_jobs(id,owner_id,project_id,project_source_id,worker_id,repository_id,repository_full_name,repository_url,repository_blind_index,confirmation_token,state,state_revision,attempt,command_id,started_at,lease_expires_at) VALUES ('${uuid(3)}','${owner}','shared-lease-conversion-project','shared-lease-source','${worker}','${handle(1)}','${handle(2)}','${handle(3)}','${"b".repeat(64)}','shared-confirmation','running',2,1,'${uuid(13)}',now(),now()+interval '10 minutes')`,
    `INSERT INTO workspace_repository_discovery_jobs(id,owner_id,workspace_id,worker_id,state,state_revision,attempt,command_id,started_at,lease_expires_at) SELECT '${uuid(4)}','${owner}',id,'${worker}','running',2,1,'${uuid(14)}',now(),now()+interval '10 minutes' FROM project_workspaces WHERE owner_id='${owner}' AND is_default=true`,
    `INSERT INTO workspace_repository_candidates(id,owner_id,job_id,workspace_id,worker_id,protected_path_handle,protected_display_handle,repository_fingerprint,classification,import_state,import_project_id,protected_import_name,import_attempt,import_command_id,import_available_at,import_lease_expires_at) SELECT '${uuid(5)}','${owner}',id,workspace_id,'${worker}','${handle(4)}','${handle(5)}','${"c".repeat(64)}','local-git','importing','shared-lease-import-project',${label}::jsonb,1,'${uuid(15)}',now(),now()+interval '10 minutes' FROM workspace_repository_discovery_jobs WHERE id='${uuid(4)}'`,
    `INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state,state_revision,attempt,command_id,started_at,lease_expires_at) VALUES ('${uuid(6)}','${owner}','${uuid(9)}','${uuid(8)}','${worker}','provision','running',2,1,'${uuid(16)}',now(),now()+interval '10 minutes')`,
  ]);
  const [rows] = await peer.sql([], [snapshot]);
  assert.equal(Object.keys(rows).length, 6);
  for (const [kind, row] of Object.entries(rows)) {
    assert.ok(row, "Actual claimed " + kind + " row exists");
    assert.equal(
      kind === "import" ? row.import_state : row.state,
      kind === "import" ? "importing" : "running",
    );
    assert.ok(
      Date.parse(
        kind === "import" ? row.import_lease_expires_at : row.lease_expires_at,
      ) > Date.now(),
    );
  }
  return rows;
}
export async function verifyPeerJobLeases(peer, before, result) {
  const [after] = await peer.sql([], [snapshot]);
  assert.deepEqual(
    after,
    before,
    "Shared startup preserves every field of six active peer job attempts and their unexpired leases",
  );
  result.cases.push(
    "shared startup preserves six claimed job rows across folder, replica, conversion, discovery scan/import and standalone scratch services",
  );
  result.retainedJobLeases = after;
}
