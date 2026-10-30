//! Public projections deliberately include the reference's unused columns too.
//! A missing persisted column must fail the same read, rather than disappear
//! silently through SELECT * / to_jsonb(table).
use super::*;
use std::collections::HashMap;

const TUNNEL_COLUMNS: &str = "id,owner_id,project_id,position,origin,management,protocol_hint,source_kind,source_adapter,source_worker_id,destination_kind,destination_adapter,destination_resource_id,destination_worker_id,protected_content,protected_operation_id,protected_revision,managed_by_kind,managed_by_id,desired_state,status,error_code,active_connection_count,bytes_from_source,bytes_to_source,created_at,updated_at";
const ATTACHMENT_COLUMNS: &str = "id,tunnel_id,kind,client_id,secret_hash,status,active_connection_count,bytes_from_source,bytes_to_source,error_code,secret_expires_at,expires_at,last_seen_at,created_at,updated_at";
pub(super) fn tunnel_query(suffix: &str) -> String {
    format!(
        "SELECT row_to_json(selected)::text FROM (SELECT {TUNNEL_COLUMNS} FROM tunnels {suffix}) selected"
    )
}
pub(super) fn tunnel_returning(statement: &str) -> String {
    format!(
        "WITH selected AS ({statement} RETURNING {TUNNEL_COLUMNS}) SELECT row_to_json(selected)::text FROM selected"
    )
}
fn attachment_query(suffix: &str) -> String {
    format!(
        "SELECT row_to_json(selected)::text FROM (SELECT {ATTACHMENT_COLUMNS} FROM tunnel_attachments {suffix}) selected"
    )
}
pub(super) fn source(tunnel: &Value) -> Result<Value> {
    if tunnel["source_kind"] == "desktop-loopback" {
        return Ok(json!({"kind":"desktop-loopback"}));
    }
    if tunnel["source_kind"] == "worker-listener"
        && coercion::truthy(tunnel.get("source_worker_id"))
    {
        return Ok(json!({"kind":"worker-listener","workerId":tunnel["source_worker_id"]}));
    }
    bail!("Tunnel source routing metadata is invalid.")
}
fn timestamp(row: &Value, key: &str) -> Result<Value> {
    if row[key].is_null() {
        return Ok(Value::Null);
    }
    // Match driver timestamp text, including expanded years and TimeClip.
    let text = text(row, key)?.replacen('T', " ", 1);
    let millis = crate::wire::date_milliseconds(&text.into()).context("Invalid time value")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(millis).context("Invalid time value")?
    ))
}
fn attachment_summary(row: &Value) -> Result<Value> {
    Ok(
        json!({"id":row["id"],"tunnelId":row["tunnel_id"],"kind":row["kind"],"clientId":row["client_id"],"status":row["status"],"activeConnectionCount":row["active_connection_count"],"bytesFromSource":row["bytes_from_source"],"bytesToSource":row["bytes_to_source"],"errorCode":row["error_code"],"expiresAt":timestamp(row,"expires_at")?,"lastSeenAt":timestamp(row,"last_seen_at")?,"createdAt":timestamp(row,"created_at")?,"updatedAt":timestamp(row,"updated_at")?}),
    )
}
fn capabilities(tunnel: &Value, attachments: &[Value]) -> Value {
    if tunnel["management"] != "user-managed" {
        let attach = (tunnel["origin"] == "browser" || tunnel["origin"] == "project-share")
            && tunnel["management"] == "managed-ephemeral"
            && tunnel["source_kind"] == "desktop-loopback"
            && tunnel["status"] != "stopping";
        return json!({"canEdit":false,"canDelete":false,"canStart":false,"canStop":false,"canAttach":attach,"canOpenOwner":!tunnel["managed_by_kind"].is_null()});
    }
    let attached = attachments
        .iter()
        .any(|a| a["status"] != "stopped" && a["status"] != "failed");
    let stopped = tunnel["status"] == "stopped" || tunnel["status"] == "failed";
    let editable = stopped && !attached;
    json!({"canEdit":editable,"canDelete":editable,"canStart":editable,"canStop":attached||(!stopped&&tunnel["status"]!="stopping"),"canAttach":tunnel["status"]!="stopping","canOpenOwner":false})
}
pub(super) fn summary(tunnel: &Value, attachments: &[Value]) -> Result<Value> {
    let managed = (coercion::truthy(tunnel.get("managed_by_kind"))
        && coercion::truthy(tunnel.get("managed_by_id")))
    .then(|| json!({"kind":tunnel["managed_by_kind"],"id":tunnel["managed_by_id"]}));
    let attachments = attachments
        .iter()
        .map(attachment_summary)
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"id":tunnel["id"],"projectId":tunnel["project_id"],"position":tunnel["position"],"origin":tunnel["origin"],"management":tunnel["management"],"protocolHint":tunnel["protocol_hint"],"source":source(tunnel)?,"destination":destination(tunnel)?,"managedBy":managed,"desiredState":tunnel["desired_state"],"status":tunnel["status"],"errorCode":tunnel["error_code"],"activeConnectionCount":tunnel["active_connection_count"],"bytesFromSource":tunnel["bytes_from_source"],"bytesToSource":tunnel["bytes_to_source"],"attachments":attachments,"capabilities":capabilities(tunnel,&attachments),"protectedRecord":protected(tunnel),"createdAt":timestamp(tunnel,"created_at")?,"updatedAt":timestamp(tunnel,"updated_at")?}),
    )
}
impl Repository {
    pub(super) async fn catalog_row(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.database
            .query(
                &tunnel_query("WHERE id=$1 AND owner_id=$2 LIMIT 1"),
                &[&id, &owner],
            )
            .await?
            .first()
            .map(|r| raw(r, 0))
            .transpose()
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let Some(tunnel) = self.catalog_row(owner, id).await? else {
            return Ok(None);
        };
        let rows = self
            .database
            .query(
                &attachment_query("WHERE tunnel_id=$1 ORDER BY created_at,id"),
                &[&id],
            )
            .await?;
        let attachments = rows.iter().map(|r| raw(r, 0)).collect::<Result<Vec<_>>>()?;
        summary(&tunnel, &attachments).map(Some)
    }
    pub async fn list(&self, owner: &str, project: Option<&str>) -> Result<Vec<Value>> {
        let project = project.filter(|s| !s.is_empty());
        let mut suffix = "WHERE owner_id=$1".to_owned();
        if project.is_some() {
            suffix.push_str(" AND project_id=$2");
        }
        suffix.push_str(" ORDER BY position,created_at");
        let params: Vec<&(dyn postgres_types::ToSql + Sync)> = if let Some(ref project) = project {
            vec![&owner, project]
        } else {
            vec![&owner]
        };
        let rows = self.database.query(&tunnel_query(&suffix), &params).await?;
        let tunnels = rows.iter().map(|r| raw(r, 0)).collect::<Result<Vec<_>>>()?;
        if tunnels.is_empty() {
            return Ok(Vec::new());
        }
        let ids = tunnels
            .iter()
            .map(|t| text(t, "id"))
            .collect::<Result<Vec<_>>>()?;
        let rows = self
            .database
            .query(
                &attachment_query("WHERE tunnel_id=ANY($1::text[]) ORDER BY created_at,id"),
                &[&ids],
            )
            .await?;
        let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
        for row in &rows {
            let attachment = raw(row, 0)?;
            grouped
                .entry(text(&attachment, "tunnel_id")?)
                .or_default()
                .push(attachment);
        }
        tunnels
            .iter()
            .map(|t| summary(t, grouped.get(&text(t, "id")?).map_or(&[], Vec::as_slice)))
            .collect()
    }
}
