import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as primary,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { literal as q, json, label, state } from "./project-target-state.mjs";

const id = (group, n) =>
  `${group.repeat(8)}-${group.repeat(4)}-4${group.repeat(3)}-8${group.repeat(3)}-${String(n).padStart(12, "0")}`;
export { chat, project, primary, worker, q };
export const tree = (n) => id("9", n),
  lane = (n) => id("7", n),
  peer = id("8", 1),
  standalone = id("8", 2),
  scratch = id("6", 1),
  offlineChat = id("8", 3),
  folderChat = id("8", 4),
  folderProject = id("5", 1),
  model = "inventory-provider-model-1",
  route = "inventory-provider-route-1",
  offlineWorker = "chat-control-offline-worker";

export function seed(owner) {
  return [
    ...inventorySeed(owner, { kind: "openai-compatible", worker }),
    `UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false WHERE user_id=${q(owner)}`,
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${q(offlineWorker)},${q(owner)},'Offline control worker','linux','x64','2026-10-25T00:00:00.123Z','2026-10-25T00:00:00.123Z')`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('control-offline-source',${q(project)},${q(offlineWorker)},'git','/offline/control','/offline/control')`,
    ...[1, 2, 3].map(
      (n) =>
        `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,head,branch) VALUES(${q(tree(n))},'settings-source',${q(worker)},${q("lane-" + n)},${q("/worker-owned/settings/lane-" + n)},${q("/worker-owned/settings/lane-" + n)},false,'cantrip',${q(n === 3 ? "provisioning" : "ready")},'abc123',${q("lane-" + n)})`,
    ),
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${q(tree(4))},'control-offline-source',${q(offlineWorker)},'offline','/offline/control','/offline/control',true,'cantrip','ready')`,
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id) VALUES(${q(folderProject)},${q(owner)},${json(label("project"))},'managed-folder','external',false,false,'direct',${q(worker)})`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('control-folder-source',${q(folderProject)},${q(worker)},'folder','/worker-owned/folder','/worker-owned/folder')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,root_kind,origin,lifecycle_state) VALUES(${q(tree(5))},'control-folder-source',${q(worker)},'folder','/worker-owned/folder','/worker-owned/folder',true,true,'folder-root','external','ready')`,
    ...[
      [peer, project, primary, worker, "agent"],
      [offlineChat, project, tree(4), offlineWorker, "agent"],
      [folderChat, folderProject, tree(5), worker, "agent"],
    ].flatMap(([c, p, t, w, experience]) => [
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,automation_paused,model_id) VALUES(${q(c)},${q(owner)},${q(p)},${q(t)},${q(w)},${json(label("chat"))},${q(experience)},true,${q(model)})`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES(${q("runtime-" + c)},${q(c)},${q(w)},${q(t)},'control-thread')`,
    ]),
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,automation_paused,model_id) VALUES(${q(standalone)},${q(owner)},'standalone',${q(worker)},${q(scratch)},NULL,${json(label("chat"))},true,${q(model)})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${q(scratch)},${q(standalone)},${q(owner)},${q(worker)},'ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('control-standalone-runtime',${q(standalone)},${q(worker)},${q(scratch)},'standalone-thread')`,
    `INSERT INTO terminals(id,project_id,kind,protected_label,protected_state,active_worker_id,worktree_id,linked_chat_id) VALUES('control-console',${q(project)},'chat-console',${json(label("terminal"))},${json(state("terminal-state"))},${q(worker)},${q(primary)},${q(chat)})`,
    `UPDATE chats SET automation_paused=true,model_id=${q(model)} WHERE id=${q(chat)}`,
    `UPDATE chat_runtime_sessions SET model_route_id=${q(route)} WHERE id='settings-runtime'`,
  ];
}

export function reset() {
  return [
    `DELETE FROM chat_messages WHERE chat_id=${q(chat)}`,
    `DELETE FROM project_branch_leases WHERE project_id=${q(project)}`,
    `DELETE FROM chat_execution_lanes WHERE chat_id IN (${q(chat)},${q(peer)},${q(offlineChat)})`,
    `DELETE FROM chat_runtime_sessions WHERE chat_id=${q(chat)} AND id<>'settings-runtime'`,
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${q(primary)}`,
    `UPDATE chats SET status='idle',experience='agent',active_worktree_id=${q(primary)},active_worker_id=${q(worker)},worktree_mode='agent-managed',model_id=${q(model)},automation_paused=true WHERE id=${q(chat)}`,
    `UPDATE chat_runtime_sessions SET codex_thread_id='thread',model_route_id=${q(route)} WHERE id='settings-runtime'`,
    `UPDATE terminals SET status='idle',worktree_id=${q(primary)},active_worker_id=${q(worker)} WHERE id='control-console'`,
  ];
}

export function seedLane({
  n = 1,
  c = chat,
  t = tree(1),
  w = worker,
  state = "suspended",
  exclusive = true,
} = {}) {
  return `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,created_at,updated_at) VALUES(${q(lane(n))},${q(c)},${q(t)},${q(w)},'user',${q(exclusive)},'Controlled lane',${q(state)},'abc123',${q(`2026-10-25T00:00:${String(n).padStart(2, "0")}.123Z`)},'2026-10-25T00:00:00.123Z')`;
}
export function placed(n = 1) {
  return [
    seedLane({ n }),
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('control-secondary-runtime',${q(chat)},${q(worker)},${q(tree(1))},'secondary-thread')`,
    `UPDATE chats SET active_worktree_id=${q(tree(1))},worktree_mode='pinned' WHERE id=${q(chat)}`,
    `UPDATE terminals SET worktree_id=${q(tree(1))} WHERE id='control-console'`,
    `INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,state) VALUES('control-branch-lease',${q(project)},'lane-1',${q(lane(n))},${q(tree(1))},${q(worker)},'active')`,
  ];
}

const tables = [
  "projects",
  "project_sources",
  "project_worktrees",
  "chats",
  "chat_runtime_sessions",
  "chat_execution_lanes",
  "project_branch_leases",
  "terminals",
  "chat_messages",
  "standalone_chat_roots",
];
export const snapshotQuery = `SELECT jsonb_build_object(${tables.map((t) => `'${t}',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM ${t} r),'[]'::jsonb)`).join(",")})::text result`;
