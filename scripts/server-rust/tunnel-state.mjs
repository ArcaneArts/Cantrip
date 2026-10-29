import {
  literal,
  json,
  localOwner,
  otherOwner,
  stamp,
} from "./project-target-state.mjs";
export const tunnelIds = Object.fromEntries(
  [
    "main",
    "foreign",
    "placement",
    "listener",
    "durable",
    "ephemeralBrowser",
    "ephemeralShare",
  ].map((key, index) => [
    key,
    `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
  ]),
);
export const attachmentIds = {
  main: "88888888-8888-4888-8888-000000000001",
  sibling: "88888888-8888-4888-8888-000000000002",
  foreign: "88888888-8888-4888-8888-000000000003",
};
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
export { tunnelRecord };
export const tunnelNow = "2026-10-29T00:00:00.000Z";
export const tunnelExpiry = "2030-01-01T00:00:00.000Z",
  secretExpiry = "2029-01-01T00:00:00.000Z";
export function tunnelStateSql(owner = localOwner, other = otherOwner) {
  const statements = [];
  for (const [key, id] of Object.entries(tunnelIds)) {
    const foreign = key === "foreign",
      managed = key.startsWith("ephemeral") || key === "durable",
      origin = managed
        ? key === "ephemeralShare"
          ? "project-share"
          : "browser"
        : "user",
      management = key.startsWith("ephemeral")
        ? "managed-ephemeral"
        : key === "durable"
          ? "managed-durable"
          : "user-managed";
    statements.push(
      `INSERT INTO tunnels(id,owner_id,project_id,position,origin,management,protocol_hint,source_kind,source_worker_id,destination_kind,destination_worker_id,protected_content,protected_operation_id,protected_revision,managed_by_kind,managed_by_id,created_at,updated_at) VALUES(${literal(id)},${literal(foreign ? other : owner)},${literal(foreign ? "other" : "github")},${statements.length},${literal(origin)},${literal(management)},'tcp',${literal(key === "listener" ? "worker-listener" : "desktop-loopback")},${literal(key === "listener" ? "alpha" : null)},'worker-tcp',${literal(foreign ? "foreign" : key === "placement" ? "beta" : "alpha")},${json(tunnelRecord.protectedContent)},${literal(tunnelRecord.operationId)},1,${literal(managed ? origin : null)},${literal(managed ? id + "-managed" : null)},${literal(stamp)},${literal(stamp)})`,
    );
  }
  for (const [key, id] of Object.entries(attachmentIds))
    statements.push(
      `INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,secret_hash,status,secret_expires_at,expires_at,created_at,updated_at) VALUES(${literal(id)},${literal(key === "foreign" ? tunnelIds.foreign : tunnelIds.main)},'desktop-loopback',${literal("client-" + key)},${literal("hash-" + key)},'offline',${literal(secretExpiry)},${literal(tunnelExpiry)},${literal(stamp)},${literal(stamp)})`,
    );
  return statements;
}
