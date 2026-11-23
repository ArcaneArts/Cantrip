//! Read an owned binding without turning unavailable placement into an exception.
use super::{PlacementError, Repository, checked, summary, text};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

impl Repository {
    pub async fn binding_context(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows=self.rows("SELECT jsonb_build_object('binding',to_jsonb(b),'instance',to_jsonb(i),'workspace',to_jsonb(w),'worktree',to_jsonb(t),'local',to_jsonb(s),'linux',to_jsonb(l))::text FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id JOIN project_worktrees t ON t.id=b.worktree_id JOIN workers a ON a.id=b.worker_id AND a.owner_id=$1 AND a.unlinked_at IS NULL LEFT JOIN project_sources s ON s.id=b.project_source_id LEFT JOIN cantrip_os_project_sources l ON l.id=b.project_source_id WHERE b.id=$2 AND b.owner_id=$1 AND b.retired_at IS NULL",&[&owner,&id]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let (b, i, w, t) = (
            &row["binding"],
            &row["instance"],
            &row["workspace"],
            &row["worktree"],
        );
        let linked = b["mode"] == "linked";
        let details = if linked { &row["local"] } else { &row["linux"] };
        let transport = checked("cantripOsTransportSchema", i["transport"].clone())?;
        let physical = if linked {
            ensure!(
                !b["linked_worker_path"].is_null(),
                "This checkout requires a CantripOS execution target."
            );
            json!({"kind":"worker-local","workerPath":b["linked_worker_path"]})
        } else {
            json!({"kind":"cantrip-os","instanceId":i["id"],"workspaceId":w["id"],"guestPath":b["guest_path"]})
        };
        let source_kind = details
            .get("source_kind")
            .filter(|v| !v.is_null())
            .context(PlacementError("Source details are unavailable."))?;
        let matches = t["project_source_id"] == b["project_source_id"]
            && t["worker_id"] == b["worker_id"]
            && !details.is_null()
            && details["removed_at"].is_null()
            && if linked {
                b["linked_worker_path"] == t["absolute_path"] && i["transport"]["kind"] == "docker"
            } else {
                b["guest_path"] == t["guest_path"]
            };
        let name = if t["is_primary"] == true {
            "Primary".to_owned()
        } else {
            format!(
                "Worktree {}",
                text(t, "id")?.chars().take(8).collect::<String>()
            )
        };
        let mut result = json!({
            "binding":summary(b,"binding",Some(text(i,"id")?))?,"instance":summary(i,"instance",None)?,"workspace":summary(w,"workspace",Some(text(i,"worker_id")?))?,
            "transport":transport,"physicalLocation":physical,"sourceKind":source_kind,"repositoryFingerprint":row["linux"]["repository_fingerprint"],
            "sourceMatches":matches,"worktreeState":t["lifecycle_state"],
            "runTarget":{"id":t["id"],"workerId":t["worker_id"],"isPrimary":t["is_primary"],"isDefault":t["is_default"],"name":name,"branch":null,"lifecycleState":t["lifecycle_state"],"displayPath":b["guest_path"]},
            "available":b["state"]=="ready"&&matches&&t["lifecycle_state"]=="ready"&&i["status"]=="connected"&&b["provisioned_attachment_generation"]==i["attachment_generation"]&&b["provisioned_runtime_generation"]==i["runtime_generation"],
        });
        if let Some(path) = row["linux"].get("guest_path") {
            result["primaryGuestPath"] = path.clone();
        }
        Ok(Some(result))
    }
}
