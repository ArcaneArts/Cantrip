use super::{Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

pub(super) fn scope(owner: &str, server: &str, i: &Value, w: &Value) -> Result<Value> {
    ensure!(
        i["runtime_generation"].is_string(),
        "The OS runtime has not been verified."
    );
    Ok(
        json!({"ownerId":owner,"serverId":server,"workerId":i["worker_id"],"instanceId":i["id"],
        "guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"],"runtimeGeneration":i["runtime_generation"],
        "workspaceId":w["id"],"guestWorkspaceId":w["guest_workspace_id"],"uid":w["uid"],"gid":w["gid"],"homeGuestPath":w["home_guest_path"]}),
    )
}
fn account(w: &Value, target: &Value) -> Result<()> {
    ensure!(
        target["id"] == w["guest_workspace_id"]
            && target["user"] == format!("ctw-{}", text(w, "guest_workspace_id")?)
            && target["uid"] == w["uid"]
            && target["gid"] == w["gid"]
            && target["home"] == w["home_guest_path"]
            && (target["status"] != "running" || target["desktop_generation"].is_string()),
        "The desktop observation belongs to another workspace account."
    );
    Ok(())
}
impl Repository {
    pub async fn desktop_context(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
    ) -> Result<Value> {
        self.rows("SELECT jsonb_build_object('instance',to_jsonb(i),'workspace',to_jsonb(w),'target',CASE WHEN p.attachment_generation=i.attachment_generation AND p.runtime_generation=i.runtime_generation THEN to_jsonb(p) ELSE NULL END)::text FROM cantrip_os_instances i JOIN cantrip_os_workspaces w ON w.instance_id=i.id LEFT JOIN cantrip_os_desktop_targets p ON p.workspace_id=w.id WHERE i.owner_id=$1 AND i.id=$2 AND w.id=$3", &[&owner,&instance,&workspace]).await?.into_iter().next().context("Owned OS workspace not found.")
    }
    pub async fn record_desktop_target(
        &self,
        owner: &str,
        expected: &Value,
        raw: Value,
    ) -> Result<Value> {
        let snapshot = checked("cantripOsGuestDesktopTargetSchema", raw)?;
        account(&expected["workspace"], &snapshot)?;
        let (owner, expected) = (owner.to_owned(), expected.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let i=&expected["instance"]; let w=&expected["workspace"];
            ensure!(!tx.query("SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND runtime_generation=$4 AND power_epoch=$5::bigint FOR UPDATE", &[&owner,&text(i,"id")?,&text(i,"attachment_generation")?,&text(i,"runtime_generation")?,&i["power_epoch"].as_i64().context("Power epoch")?]).await?.is_empty(),"The desktop runtime changed during observation.");
            let actual=decode(tx.query("SELECT to_jsonb(w)::text FROM cantrip_os_workspaces w WHERE id=$1 AND instance_id=$2 FOR UPDATE", &[&text(w,"id")?,&text(i,"id")?]).await?)?;
            ensure!(actual.first()==Some(w),"The desktop authority changed while its observation was in flight. Observe it again.");
            let old=decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_desktop_targets p WHERE workspace_id=$1", &[&text(w,"id")?]).await?)?;
            let generation=old.first().filter(|p|p["attachment_generation"]==i["attachment_generation"] && p["runtime_generation"]==i["runtime_generation"] && p["snapshot"]==snapshot).and_then(|p|p["generation"].as_str()).map(str::to_owned).unwrap_or_else(uuid);
            let rows=decode(tx.query("INSERT INTO cantrip_os_desktop_targets(workspace_id,generation,attachment_generation,runtime_generation,snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET generation=EXCLUDED.generation,attachment_generation=EXCLUDED.attachment_generation,runtime_generation=EXCLUDED.runtime_generation,snapshot=EXCLUDED.snapshot,verified_at=now() RETURNING to_jsonb(cantrip_os_desktop_targets)::text", &[&text(w,"id")?,&generation,&text(i,"attachment_generation")?,&text(i,"runtime_generation")?,&Json(snapshot)]).await?)?;
            tx.query("UPDATE cantrip_os_workspaces SET desktop_epoch=desktop_epoch+1 WHERE id=$1", &[&text(w,"id")?]).await?;
            rows.into_iter().next().context("Desktop target not saved.")
        })).await
    }
    pub async fn desktop_get(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_desktop_operations o WHERE owner_id=$1 AND instance_id=$2 AND workspace_id=$3 AND operation_id=$4", &[&owner,&instance,&workspace,&id]).await?.into_iter().next())
    }
    pub async fn desktop_admit(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        server: &str,
        input: &Value,
    ) -> Result<(Value, bool)> {
        let (owner, instance, workspace, server, input) = (
            owner.to_owned(),
            instance.to_owned(),
            workspace.to_owned(),
            server.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let parents=decode(tx.query("SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers k ON k.id=i.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE i.id=$2 AND i.owner_id=$1 FOR UPDATE OF i", &[&owner,&instance]).await?)?;
            let i=parents.first().context("Owned OS attachment not found.")?;
            let spaces=decode(tx.query("SELECT to_jsonb(w)::text FROM cantrip_os_workspaces w WHERE id=$1 AND instance_id=$2 FOR UPDATE", &[&workspace,&instance]).await?)?;
            let w=spaces.first().context("Owned OS workspace not found.")?;
            let old=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_desktop_operations o WHERE operation_id=$1", &[&text(&input,"operationId")?]).await?)?;
            if let Some(old)=old.first() {
                ensure!(old["owner_id"]==owner && old["instance_id"]==instance && old["workspace_id"]==workspace && old["request"]==input,"This desktop operation ID belongs to another admission.");
                return Ok((old.clone(),false));
            }
            super::system_common::no_active(tx,&instance,None).await?;
            let targets=decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_desktop_targets p WHERE workspace_id=$1", &[&workspace]).await?)?;
            let p=targets.first().context("No observed desktop target is recorded.")?;
            ensure!(i["status"]=="connected" && i["attachment_generation"]==input["attachmentGeneration"] && i["runtime_generation"]==input["runtimeGeneration"] && p["attachment_generation"]==input["attachmentGeneration"] && p["runtime_generation"]==input["runtimeGeneration"] && p["generation"]==input["targetGeneration"],"The selected desktop authority changed. Verify the intended runtime and observe its desktop.");
            ensure!(tx.query("SELECT o.operation_id FROM cantrip_os_power_operations o JOIN cantrip_os_power_targets p ON p.instance_id=o.instance_id AND p.generation=o.target_generation WHERE o.instance_id=$1 AND o.attachment_generation=$2 AND o.state IN ('admitted','running','unknown')", &[&instance,&text(i,"attachment_generation")?]).await?.is_empty(),"An instance power operation remains unresolved.");
            ensure!(tx.query("SELECT operation_id FROM cantrip_os_desktop_operations WHERE workspace_id=$1 AND attachment_generation=$2 AND runtime_generation=$3 AND target_generation=$4 AND state IN ('admitted','running','unknown')", &[&workspace,&text(&input,"attachmentGeneration")?,&text(&input,"runtimeGeneration")?,&text(&input,"targetGeneration")?]).await?.is_empty(),"Another operation for this desktop target remains active or uncertain. Observe it first.");
            account(w,&p["snapshot"])?;
            let command=checked("cantripOsDesktopWorkerCommandSchema",json!({"type":"cantrip-os.desktop.operation","mode":"execute","operationId":input["operationId"],"action":input["action"],"targetGeneration":input["targetGeneration"],"scope":scope(&owner,&server,i,w)?,"transport":i["transport"],"desktopTarget":p["snapshot"]}))?;
            let values=Json(json!({"owner":owner,"instance":instance,"workspace":workspace,"worker":i["worker_id"],"input":input,"command":command}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_desktop_operations(operation_id,owner_id,instance_id,workspace_id,worker_id,attachment_generation,runtime_generation,target_generation,action,request,command) VALUES($1::jsonb->'input'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'workspace',$1::jsonb->>'worker',$1::jsonb->'input'->>'attachmentGeneration',$1::jsonb->'input'->>'runtimeGeneration',$1::jsonb->'input'->>'targetGeneration',$1::jsonb->'input'->>'action',$1::jsonb->'input',$1::jsonb->'command') RETURNING to_jsonb(cantrip_os_desktop_operations)::text", &[&values]).await?)?;
            tx.query("UPDATE cantrip_os_workspaces SET desktop_epoch=desktop_epoch+1 WHERE id=$1", &[&workspace]).await?;
            Ok((rows[0].clone(),true))
        })).await
    }
    pub async fn desktop_begin(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Value> {
        self.rows("UPDATE cantrip_os_desktop_operations SET revision=revision+1 WHERE owner_id=$1 AND instance_id=$2 AND workspace_id=$3 AND operation_id=$4 RETURNING to_jsonb(cantrip_os_desktop_operations)::text", &[&owner,&instance,&workspace,&id]).await?.into_iter().next().context("Desktop operation not found.")
    }
    pub async fn desktop_unknown(&self, owner: &str, row: &Value) -> Result<Value> {
        self.database.query("UPDATE cantrip_os_desktop_operations SET state='unknown',updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND revision=$3::bigint AND state NOT IN ('ready','failed')", &[&owner,&text(row,"operation_id")?,&row["revision"].as_i64().context("Desktop revision")?]).await?;
        self.desktop_get(
            owner,
            text(row, "instance_id")?,
            text(row, "workspace_id")?,
            text(row, "operation_id")?,
        )
        .await?
        .context("Desktop operation not found.")
    }
    pub async fn desktop_record(&self, owner: &str, row: &Value, result: Value) -> Result<Value> {
        let result = checked("cantripOsDesktopOperationResultSchema", result)?;
        let before = &row["command"]["desktopTarget"];
        let matching = |target: &Value| {
            ["id", "user", "uid", "gid", "home", "display"]
                .iter()
                .all(|key| target[*key] == before[*key])
        };
        ensure!(
            result["operationId"] == row["operation_id"]
                && result["action"] == row["action"]
                && (result["observation"].is_null() || matching(&result["observation"])),
            "The desktop outcome belongs to another admission."
        );
        if !result["receipt"].is_null() {
            let r = &result["receipt"];
            let after = &r["after"];
            let same = before["generation"] == after["generation"]
                && before["desktop_generation"] == after["desktop_generation"];
            let requested = if row["action"] == "stop" {
                after["status"] == "stopped" && same
            } else {
                after["status"] == "running"
                    && after["desktop_generation"].is_string()
                    && if row["action"] == "start" && before["status"] == "running" {
                        same
                    } else {
                        after["generation"].as_u64() > before["generation"].as_u64()
                            && after["desktop_generation"] != before["desktop_generation"]
                    }
            };
            ensure!(
                r["targetGeneration"] == row["target_generation"]
                    && r["before"] == *before
                    && matching(after)
                    && requested,
                "The desktop receipt does not prove its original request."
            );
        }
        let values = Json(json!({"owner":owner,"row":row,"result":result}));
        self.database.query("UPDATE cantrip_os_desktop_operations SET state=$1::jsonb->'result'->>'state',result=$1::jsonb->'result',updated_at=now() WHERE owner_id=$1::jsonb->>'owner' AND operation_id=$1::jsonb->'row'->>'operation_id' AND state NOT IN ('ready','failed') AND ($1::jsonb->'result'->>'state'='ready' OR revision=($1::jsonb->'row'->>'revision')::integer)", &[&values]).await?;
        self.desktop_get(
            owner,
            text(row, "instance_id")?,
            text(row, "workspace_id")?,
            text(row, "operation_id")?,
        )
        .await?
        .context("Desktop operation not found.")
    }
    pub async fn desktop_list(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<(Vec<Value>, Option<String>)> {
        self.desktop_context(owner, instance, workspace).await?;
        let cursor = input["cursor"].as_str();
        if let Some(id) = cursor {
            self.desktop_get(owner, instance, workspace, id)
                .await?
                .context("Desktop history cursor not found.")?;
        }
        let limit = input["limit"].as_i64().context("Desktop page limit")?;
        let mut rows=self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_desktop_operations o WHERE owner_id=$1 AND instance_id=$2 AND workspace_id=$3 AND ($4::text IS NULL OR (created_at,operation_id)<(SELECT created_at,operation_id FROM cantrip_os_desktop_operations WHERE owner_id=$1 AND instance_id=$2 AND workspace_id=$3 AND operation_id=$4)) ORDER BY created_at DESC,operation_id DESC LIMIT $5", &[&owner,&instance,&workspace,&cursor,&(limit+1)]).await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last()
                .and_then(|r| r["operation_id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok((rows, next))
    }
}
