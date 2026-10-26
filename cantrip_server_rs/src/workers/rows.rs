use crate::{auth::iso, database::Row};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

pub(super) const WORKER: &str = "id,coalesce(display_name,name),platform,architecture,codex_version,codex_runtime,remote_surface_capabilities,direct_broker_advertisement,codegraph_status,web_runtime_capabilities,encryption_status,project_replica_capabilities,managed_folder_capabilities,standalone_chat_capabilities,chat_relocation_capability,external_codex_history_capability,started_at,last_seen_at";
pub(super) const CREDENTIAL: &str =
    "id,worker_id,label,scopes,created_at,expires_at,last_used_at,revoked_at,revoked_reason";

pub(super) fn worker(row: &Row) -> Result<Value> {
    let seen = row.get::<DateTime<Utc>>(17)?;
    Ok(
        json!({"workerId":row.get::<String>(0)?,"name":row.get::<String>(1)?,"platform":row.get::<String>(2)?,"architecture":row.get::<String>(3)?,"codexVersion":row.get::<Option<String>>(4)?,"codexRuntime":row.get::<Value>(5)?,"remoteSurfaces":row.get::<Value>(6)?,"directBroker":row.get::<Value>(7)?,"codegraph":row.get::<Value>(8)?,"webRuntimes":row.get::<Value>(9)?,"encryption":row.get::<Value>(10)?,"projectReplicas":row.get::<Value>(11)?,"managedFolders":row.get::<Value>(12)?,"standaloneChat":row.get::<Value>(13)?,"chatRelocation":row.get::<bool>(14)?,"externalCodexHistory":row.get::<bool>(15)?,"startedAt":iso(row.get::<DateTime<Utc>>(16)?),"lastSeenAt":iso(seen),"online":Utc::now().timestamp_millis()-seen.timestamp_millis()<=30000}),
    )
}
pub(super) fn credential(row: &Row, at: DateTime<Utc>) -> Result<Value> {
    let expiry = row.get::<Option<DateTime<Utc>>>(5)?;
    let revoked = row.get::<Option<DateTime<Utc>>>(7)?;
    Ok(
        json!({"id":row.get::<String>(0)?,"workerId":row.get::<String>(1)?,"label":row.get::<Option<String>>(2)?,"scopes":row.get::<Value>(3)?,"createdAt":iso(row.get::<DateTime<Utc>>(4)?),"expiresAt":expiry.map(iso),"lastUsedAt":row.get::<Option<DateTime<Utc>>>(6)?.map(iso),"revokedAt":revoked.map(iso),"revokedReason":row.get::<Option<String>>(8)?,"active":revoked.is_none()&&expiry.is_none_or(|expires|expires.timestamp_millis()>at.timestamp_millis())}),
    )
}
