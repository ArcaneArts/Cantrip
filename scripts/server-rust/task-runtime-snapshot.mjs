// Development-only evidence from the server's open database, before teardown.
// Keep credentials and provider secrets out of these scoped operational rows.
const tables = [
  "chats",
  "managed_queue_states",
  "tasks",
  "task_planning_rounds",
  "task_dispatch_cycles",
  "chat_messages",
  "chat_execution_lanes",
  "native_commands",
  "native_runtime_handoffs",
  "chat_runtime_sessions",
];
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

export async function captureTaskRuntimeState({ ownerId, projectId, query }) {
  const values = await query(
    ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"],
    tables.map((table) =>
      table === "chats"
        ? `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb)::text AS result FROM chats r WHERE r.owner_id=${literal(ownerId)} AND r.project_id=${literal(projectId)}`
        : `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.chat_id,to_jsonb(r)->>'id'),'[]'::jsonb)::text AS result FROM ${table} r JOIN chats c ON c.id=r.chat_id WHERE c.owner_id=${literal(ownerId)} AND c.project_id=${literal(projectId)}`,
    ),
  );
  if (values.length !== tables.length)
    throw new Error("Incomplete live Task database snapshot");
  return {
    capturedAt: new Date().toISOString(),
    ownerId,
    projectId,
    isolation: "repeatable-read, read-only",
    rows: Object.fromEntries(
      tables.map((table, index) => [table, values[index]]),
    ),
  };
}
