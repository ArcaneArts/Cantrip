import { label, literal, json, stamp } from "./project-target-state.mjs";
export const ids = Array.from(
  { length: 15 },
  (_, i) => `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`,
);
export const chatId = "55555555-5555-4555-8555-555555555551",
  rootId = "55555555-5555-4555-8555-555555555552";
export const shareStateSql = () => [
  `CREATE FUNCTION reject_share_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(ids[10])} OR NEW.protected_operation_id=${literal(ids[11])} THEN RAISE EXCEPTION 'Controlled actual share registration failure'; END IF; RETURN NEW; END $$`,
  "CREATE TRIGGER reject_share_registration BEFORE INSERT OR UPDATE ON tunnels FOR EACH ROW EXECUTE FUNCTION reject_share_registration()",
];
export const standaloneSql = (owner, options = {}) => {
  const chat = options.chatId ?? chatId,
    root = options.rootId ?? rootId,
    worker = options.workerId ?? "alpha";
  return [
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at) VALUES(${literal(chat)},${literal(owner)},'standalone',${literal(worker)},${literal(root)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${literal(root)},${literal(chat)},${literal(owner)},${literal(worker)},'ready',${literal("ctrr_" + "a".repeat(43))})`,
  ];
};
