use super::{Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn workspace_operation_get(
        &self,
        owner: &str,
        instance: &str,
        operation: &str,
    ) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_workspace_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner,&instance,&operation]).await?.into_iter().next())
    }
    pub async fn workspace_operation_admit(
        &self,
        owner: &str,
        instance: &str,
        server: &str,
        input: &Value,
    ) -> Result<(Value, bool)> {
        checked("cantripOsWorkspaceCreateSchema", input.clone())?;
        let (owner, instance, server, input) = (
            owner.to_owned(),
            instance.to_owned(),
            server.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let parents=decode(tx.query("SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers w ON w.id=i.worker_id WHERE i.owner_id=$1 AND i.id=$2 AND w.owner_id=$1 AND w.unlinked_at IS NULL FOR UPDATE OF i", &[&owner,&instance]).await?)?;
            let i=parents.first().context(crate::cantrip_os::PlacementError("Owned OS attachment not found."))?;
            let old=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_workspace_operations o WHERE operation_id=$1", &[&text(&input,"operationId")?]).await?)?;
            if let Some(old)=old.first() {
                ensure!(old["owner_id"]==owner && old["instance_id"]==instance && old["command"]["scope"]["serverId"]==server && old["request"]==input,"This workspace operation ID belongs to another admission.");
                return Ok((old.clone(),false));
            }
            super::system_common::no_active(tx,&instance,None).await?;
            ensure!((input.get("attachmentGeneration").is_none() || input["attachmentGeneration"]==i["attachment_generation"]) && (input.get("runtimeGeneration").is_none() || input["runtimeGeneration"]==i["runtime_generation"]),"The selected OS attachment or runtime changed before workspace admission.");
            let scope=checked("cantripOsDispatchScopeSchema",json!({"ownerId":owner,"serverId":server,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"],"runtimeGeneration":i["runtime_generation"]}))?;
            let command=json!({"type":"cantrip-os.workspaces.create","scope":scope,"transport":i["transport"],"guestWorkspaceId":input["guestWorkspaceId"],"operationId":input["operationId"]});
            let values=Json(json!({"owner":owner,"instance":instance,"worker":i["worker_id"],"request":input,"command":command}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_workspace_operations(operation_id,owner_id,instance_id,worker_id,guest_workspace_id,attachment_generation,runtime_generation,request,command) VALUES($1::jsonb->'request'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'worker',$1::jsonb->'request'->>'guestWorkspaceId',$1::jsonb->'command'->'scope'->>'attachmentGeneration',$1::jsonb->'command'->'scope'->>'runtimeGeneration',$1::jsonb->'request',$1::jsonb->'command') ON CONFLICT DO NOTHING RETURNING to_jsonb(cantrip_os_workspace_operations)::text", &[&values]).await?)?;
            Ok((rows.first().context("This workspace operation ID belongs to another admission.")?.clone(),true))
        })).await
    }
    pub async fn workspace_operation_begin(
        &self,
        owner: &str,
        instance: &str,
        operation: &str,
    ) -> Result<Value> {
        self.rows("UPDATE cantrip_os_workspace_operations SET revision=revision+1 WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3 RETURNING to_jsonb(cantrip_os_workspace_operations)::text", &[&owner,&instance,&operation]).await?.into_iter().next().context(crate::cantrip_os::PlacementError("Workspace operation not found."))
    }
    pub async fn workspace_operation_unknown(&self, original: &Value) -> Result<Value> {
        let revision = original["revision"]
            .as_i64()
            .context("Operation revision")? as i32;
        let rows=self.rows("UPDATE cantrip_os_workspace_operations SET state='unknown',result=NULL,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND revision=$3 AND state NOT IN ('ready','failed') RETURNING to_jsonb(cantrip_os_workspace_operations)::text", &[&text(original,"owner_id")?,&text(original,"operation_id")?,&revision]).await?;
        if let Some(row) = rows.into_iter().next() {
            return Ok(row);
        }
        self.workspace_operation_get(
            text(original, "owner_id")?,
            text(original, "instance_id")?,
            text(original, "operation_id")?,
        )
        .await?
        .context(crate::cantrip_os::PlacementError(
            "Workspace operation not found.",
        ))
    }
    pub async fn workspace_operation_record(
        &self,
        original: &Value,
        result: Value,
    ) -> Result<Value> {
        let result = checked("cantripOsOperationResultSchema", result)?;
        ensure!(
            result["operationId"] == original["operation_id"]
                && (result["receipt"].is_null()
                    || (result["receipt"]["kind"] == "workspace"
                        && result["receipt"]["workspace"]["guestWorkspaceId"]
                            == original["guest_workspace_id"])),
            "Workspace receipt does not match its original admission."
        );
        let original = original.clone();
        self.database.transaction(|tx|Box::pin(async move {
            let owner=text(&original,"owner_id")?;
            let instance=text(&original,"instance_id")?;
            let parents=decode(tx.query("SELECT to_jsonb(i)::text FROM cantrip_os_instances i WHERE id=$1 AND owner_id=$2 FOR UPDATE", &[&instance,&owner]).await?)?;
            let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_workspace_operations o WHERE operation_id=$1 AND owner_id=$2 FOR UPDATE", &[&text(&original,"operation_id")?,&owner]).await?)?;
            let current=rows.first().context(crate::cantrip_os::PlacementError("Workspace operation not found."))?;
            if current["revision"]!=original["revision"] || ["ready","failed"].iter().any(|s|current["state"]==*s) {return Ok(current.clone());}
            if result["state"]=="ready" && let Some(i)=parents.first() && i["worker_id"]==original["worker_id"] && i["guest_instance_id"]==original["command"]["scope"]["guestInstanceId"] && i["attachment_generation"]==original["attachment_generation"] && i["runtime_generation"]==original["runtime_generation"] {
                let observation=&result["receipt"]["workspace"];
                let workspaces=decode(tx.query("SELECT to_jsonb(w)::text FROM cantrip_os_workspaces w WHERE instance_id=$1 AND guest_workspace_id=$2", &[&instance,&text(observation,"guestWorkspaceId")?]).await?)?;
                if let Some(old)=workspaces.first() {
                    ensure!(old["uid"]==observation["uid"] && old["gid"]==observation["gid"] && old["home_guest_path"]==observation["homeGuestPath"],"OS workspace identity changed; the existing placement was preserved.");
                }else{
                    let values=Json(json!({"id":uuid(),"instance":instance,"observation":observation}));
                    tx.query("INSERT INTO cantrip_os_workspaces(id,instance_id,guest_workspace_id,uid,gid,home_guest_path) VALUES($1::jsonb->>'id',$1::jsonb->>'instance',$1::jsonb->'observation'->>'guestWorkspaceId',($1::jsonb->'observation'->>'uid')::integer,($1::jsonb->'observation'->>'gid')::integer,$1::jsonb->'observation'->>'homeGuestPath')", &[&values]).await?;
                }
            }
            let data=Json(result);
            let rows=decode(tx.query("UPDATE cantrip_os_workspace_operations SET state=$1::jsonb->>'state',result=$1,revision=revision+1,updated_at=now() WHERE operation_id=$2 RETURNING to_jsonb(cantrip_os_workspace_operations)::text", &[&data,&text(&original,"operation_id")?]).await?)?;
            Ok(rows[0].clone())
        })).await
    }
    pub async fn workspace_operation_list(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<(Vec<Value>, Option<String>)> {
        ensure!(
            !self
                .database
                .query(
                    "SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2",
                    &[&owner, &instance]
                )
                .await?
                .is_empty(),
            crate::cantrip_os::PlacementError("Owned OS attachment not found.")
        );
        let cursor = input["cursor"].as_str();
        if let Some(cursor) = cursor {
            ensure!(
                self.workspace_operation_get(owner, instance, cursor)
                    .await?
                    .is_some(),
                crate::cantrip_os::PlacementError("Workspace history cursor not found.")
            );
        }
        let limit = input["limit"].as_i64().context("History limit")?;
        let mut rows=self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_workspace_operations o WHERE owner_id=$1 AND instance_id=$2 AND ($3::text IS NULL OR (created_at,operation_id)<(SELECT created_at,operation_id FROM cantrip_os_workspace_operations WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3)) ORDER BY created_at DESC,operation_id DESC LIMIT $4", &[&owner,&instance,&cursor,&(limit+1)]).await?;
        let next = if rows.len() > limit as usize {
            rows.truncate(limit as usize);
            Some(text(rows.last().unwrap(), "operation_id")?.to_owned())
        } else {
            None
        };
        Ok((rows, next))
    }
}
