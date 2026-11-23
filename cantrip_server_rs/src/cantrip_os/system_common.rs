use super::{checked, decode, text};
use crate::database::Transaction;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub(super) const OWNED: &str = "SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers w ON w.id=i.worker_id AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE i.owner_id=$1 AND i.id=$2 FOR UPDATE OF i";
pub(super) async fn owned(tx: &Transaction<'_>, owner: &str, instance: &str) -> Result<Value> {
    decode(tx.query(OWNED, &[&owner, &instance]).await?)?
        .into_iter()
        .next()
        .context(crate::cantrip_os::PlacementError(
            "Owned OS attachment not found.",
        ))
}
pub(super) async fn no_active(
    tx: &Transaction<'_>,
    instance: &str,
    except: Option<&str>,
) -> Result<()> {
    ensure!(tx.query("SELECT operation_id FROM cantrip_os_system_operations WHERE instance_id=$1 AND retired_by IS NULL AND state IN ('admitted','running','unknown') AND ($2::text IS NULL OR operation_id<>$2) LIMIT 1", &[&instance, &except]).await?.is_empty(), "Another system operation remains active or uncertain. Observe its original admission first.");
    Ok(())
}
pub(super) async fn source(
    tx: &Transaction<'_>,
    owner: &str,
    instance: &str,
    worker: &str,
    id: &str,
) -> Result<Value> {
    decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND instance_id=$2 AND worker_id=$3 AND operation_id=$4", &[&owner,&instance,&worker,&id]).await?)?.into_iter().next().context("The original system operation is unavailable on this owning Worker.")
}
pub(super) fn scope(instance: &Value, server: &str) -> Value {
    json!({"ownerId":instance["owner_id"],"serverId":server,"workerId":instance["worker_id"],"instanceId":instance["id"],"guestInstanceId":instance["guest_instance_id"],"attachmentGeneration":instance["attachment_generation"]})
}
pub(super) fn identity(target: &Value) -> Value {
    json!([
        target["containerId"],
        target["containerName"],
        target["imageId"],
        target["expected"]["ownerId"],
        target["expected"]["workerId"],
        target["expected"]["guestInstanceId"]
    ])
}
pub(super) fn date(row: &Value, key: &str) -> Result<String> {
    Ok(chrono::DateTime::parse_from_rfc3339(text(row, key)?)?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
pub(super) fn summary(row: &Value) -> Result<Value> {
    let (result, c) = (&row["result"], &row["command"]);
    let mut context = c["scope"].clone();
    context["operationId"] = c["operationId"].clone();
    context["targetGeneration"] = c["target"]["generation"].clone();
    context["containerId"] = c["target"]["containerId"].clone();
    checked(
        "cantripOsSystemSummarySchema",
        json!({
            "operationId":row["operation_id"],"instanceId":row["instance_id"],"workerId":row["worker_id"],
            "attachmentGeneration":row["fence_generation"],"targetGeneration":row["target_generation"],
            "request":row["request"],"context":context,"state":row["state"],"dispatchStage":row["dispatch_stage"],"phase":if row["state"]=="rejected"{"not-dispatched"}else{result["phase"].as_str().unwrap_or("admitted")},
            "retiredBy":row["retired_by"],"recoveryGeneration":row["recovery_generation"],"root":result["root"],"protectedResult":result["protectedResult"],
            "error":if !result["error"].is_null(){result["error"].clone()} else if row["state"]=="rejected"{json!("The system transition was not dispatched. Refresh system status before submitting a new operation.")} else if row["state"]=="unknown"{json!("System delivery is unknown. Observe the original operation; no claimed effect was repeated.")} else {Value::Null},
            "createdAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?,
        }),
    )
}
pub(super) fn status(instance: &Value, row: &Value) -> Result<Value> {
    let c = &row["catalog"];
    let t = &c["target"];
    checked(
        "cantripOsSystemStatusSchema",
        json!({
            "supported":c["supported"].as_bool().unwrap_or(instance["transport"]["kind"]=="docker"),
            "target":if t.is_object() && !row["verified_at"].is_null(){json!({"generation":t["generation"],"instanceId":instance["id"],"workerId":instance["worker_id"],"attachmentGeneration":instance["attachment_generation"],"architecture":t["architecture"],"running":c["running"],"verifiedAt":date(row,"verified_at")?})}else{Value::Null},
            "bases":c["bases"].as_array().cloned().unwrap_or_default(),"error":c["error"],
        }),
    )
}
