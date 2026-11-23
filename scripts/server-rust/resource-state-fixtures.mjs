import { encryptedTaskCreateSchema } from "../../packages/protocol/dist/index.js";
import { taskContent } from "./task-wire-fixtures.mjs";
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
export const taskIds = Array.from(
  { length: 12 },
  (_, i) => `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
);
export const createInput = (index, extra = {}) =>
  encryptedTaskCreateSchema.parse({
    chatId: taskIds[index],
    titleProtection: label("chat"),
    task: taskContent(),
    ...extra,
  });
export function resourceStateSql() {
  return [
    ...targetStateSql(),
    ...[
      ["model", localOwner, "high"],
      ["null-model", localOwner, null],
      ["foreign-model", otherOwner, "low"],
    ].map(
      ([id, owner, effort]) =>
        `INSERT INTO model_profiles(id,owner_id,name,default_reasoning_effort,created_at,updated_at) VALUES(${literal(id)},${literal(owner)},${literal(id)},${literal(effort)},${literal(stamp)},${literal(stamp)})`,
    ),
    `UPDATE user_settings SET default_model_id='model',default_reasoning_effort='medium',default_custom_subagent_model=true,default_subagent_model_id='null-model',default_subagent_reasoning_effort='low' WHERE user_id=${literal(localOwner)}`,
  ];
}
const tables = [
  "projects",
  "chats",
  "tasks",
  "chat_runtime_sessions",
  "chat_execution_lanes",
  "standalone_chat_roots",
  "managed_queue_states",
  "model_profiles",
  "remote_surfaces",
  "terminals",
  "explorers",
  "code_tabs",
  "browsers",
  "project_views",
  "tab_groups",
  "tab_group_members",
];
export const snapshotSql = `SELECT jsonb_build_object(${tables
  .map(
    (table) =>
      `${literal(table)},(SELECT coalesce(jsonb_agg(row ORDER BY row->>'chat_id',row->>'id',row->>'tab_key'),'[]'::jsonb) FROM (SELECT to_jsonb(t) row FROM ${table} t) records)`,
  )
  .join(",")}) result`;
