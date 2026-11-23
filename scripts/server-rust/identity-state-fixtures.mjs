import { securityFixtures } from "./security-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
export { localOwner as owner, otherOwner as other, literal, json, stamp };
export const principalId = "33333333-3333-4333-8333-333333333333";
export const replacementId = "77777777-7777-4777-8777-777777777777";
export const publicKey =
  securityFixtures.encryptionPrincipalSchema[1].publicKey;
export const wrappedKey =
  securityFixtures.encryptionKeyGrantSchema[1].wrappedKey;
export const replacement = {
  id: replacementId,
  kind: "worker",
  workerId: "alpha",
  label: "Replacement 工作者",
  publicKey,
};
export const usage = structuredClone(
  securityFixtures.modelOperationUsageEvidenceSchema[0],
);
usage.identity.workerId = "alpha";
export function identityStateSql() {
  const sql = targetStateSql();
  for (const [id, revoked, expires] of [
    ["valid-session", false, "2099-01-01T00:00:00.000Z"],
    ["expired-session", false, stamp],
    ["revoked-session", true, "2099-01-01T00:00:00.000Z"],
  ])
    sql.push(
      `INSERT INTO user_sessions(id,user_id,auth_method,token_hash,csrf_token_hash,expires_at,revoked_at,created_at,last_seen_at,updated_at) VALUES(${literal(id)},${literal(localOwner)},'password',${literal(id + "-token")},'original-csrf',${literal(expires)},${literal(revoked ? stamp : null)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    );
  for (const [id, offset, consumed] of [
    ["older", -1, false],
    ["boundary", 0, false],
    ["newer", 1, false],
    ["consumed-older", -1, true],
    ["consumed-newer", 1, true],
  ]) {
    const expires = new Date(Date.parse(stamp) + offset).toISOString();
    sql.push(
      `INSERT INTO mobile_sign_in_grants(id,owner_id,created_by_session_id,code_hash,expires_at,consumed_at,created_at) VALUES(${literal(id)},${literal(localOwner)},'valid-session',${literal(id + "-code")},${literal(expires)},${literal(consumed ? stamp : null)},${literal(stamp)})`,
    );
  }
  sql.push(
    `INSERT INTO account_license_whitelist(id,email,normalized_email,added_by_user_id,created_at) VALUES('license-entry','Alice@Example.invalid','alice@example.invalid',${literal(localOwner)},${literal(stamp)})`,
  );
  sql.push(
    `INSERT INTO encryption_principals(id,owner_id,kind,worker_id,label,public_key,state,revision,approved_at,created_at,updated_at) VALUES(${literal(principalId)},${literal(localOwner)},'worker','alpha','Original worker',${json(publicKey)},'approved',1,${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  sql.push(
    `INSERT INTO encryption_key_grants(id,owner_id,principal_id,component,key_revision,wrapped_key,state,revision,created_at,updated_at) VALUES('key-grant',${literal(localOwner)},${literal(principalId)},'chat-content',1,${json(wrappedKey)},'active',1,${literal(stamp)},${literal(stamp)})`,
  );
  for (const [id, user] of [
    ["fixture", localOwner],
    ["foreign-provider", otherOwner],
  ])
    sql.push(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,created_at,updated_at) VALUES(${literal(id)},${literal(user)},${literal(id)},'ollama','http://localhost:11434',${literal(stamp)},${literal(stamp)})`,
    );
  for (const [id, user] of [
    ["model", localOwner],
    ["foreign-model", otherOwner],
  ])
    sql.push(
      `INSERT INTO model_profiles(id,owner_id,name,operation,created_at,updated_at) VALUES(${literal(id)},${literal(user)},${literal(id)},'embedding',${literal(stamp)},${literal(stamp)})`,
    );
  sql.push(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('route','model','fixture','native-model',0,true)",
  );
  sql.push(
    `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,created_at,updated_at) VALUES('usage-account','fixture',${json(securityFixtures.encryptedModelProviderAccountCreateSchema[0].protectedLabel)},'usage-account-home',${literal(stamp)},${literal(stamp)})`,
  );
  const secret =
    securityFixtures.encryptedModelProviderAccountCreateSchema[0]
      .protectedLabel;
  const mcp = securityFixtures.encryptedMcpServerCreateSchema[0];
  sql.push(
    `UPDATE model_providers SET protected_api_key=${json(secret)} WHERE id='fixture'`,
  );
  sql.push(
    `UPDATE model_provider_accounts SET credential_state='signed-in',protected_credential=${json(secret)},credential_revision=2 WHERE id='usage-account'`,
  );
  sql.push(
    `INSERT INTO mcp_servers(id,owner_id,enabled,name_blind_index,protected_configuration,created_at,updated_at) VALUES(${literal(mcp.id)},${literal(localOwner)},true,${literal(mcp.nameBlindIndex)},${json(mcp.protectedConfiguration)},${literal(stamp)},${literal(stamp)})`,
  );
  return sql;
}
export const identitySnapshotSql =
  "SELECT jsonb_build_object(" +
  [
    ["sessions", "user_sessions"],
    ["mobile", "mobile_sign_in_grants"],
    ["principals", "encryption_principals"],
    ["grants", "encryption_key_grants"],
    ["usage", "token_usage_records"],
    ["whitelist", "account_license_whitelist"],
    ["providers", "model_providers"],
    ["providerAccounts", "model_provider_accounts"],
    ["mcp", "mcp_servers"],
  ]
    .map(
      ([key, table]) =>
        `${literal(key)},(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${table === "token_usage_records" ? "source_key,id" : "id"}),'[]'::jsonb) FROM ${table} t)`,
    )
    .join(",") +
  ") result";
