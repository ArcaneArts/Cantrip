use super::{Repository, checked, decode, text};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn backup_get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_backup_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&id]).await?.into_iter().next())
    }
    pub async fn backup_list(
        &self,
        owner: &str,
        input: &Value,
        captures: bool,
    ) -> Result<(Vec<Value>, Option<String>)> {
        let cursor = if let Some(id) = input["cursor"].as_str() {
            let row = self
                .backup_get(owner, id)
                .await?
                .context("Backup cursor not found.")?;
            ensure!(
                !captures || row["action"] == "capture",
                "Backup cursor not found."
            );
            Some(row)
        } else {
            None
        };
        let id = cursor.as_ref().and_then(|v| v["operation_id"].as_str());
        let at = cursor.as_ref().and_then(|v| v["created_at"].as_str());
        let limit = input["limit"].as_i64().context("Backup page limit")?;
        let mut rows=self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_backup_operations o WHERE owner_id=$1 AND (NOT $2 OR action='capture') AND ($3::text IS NULL OR (created_at,operation_id) < ($4::text::timestamptz,$3::text)) ORDER BY created_at DESC,operation_id DESC LIMIT $5", &[&owner,&captures,&id,&at,&(limit+1)]).await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last()
                .and_then(|v| v["operation_id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok((rows, next))
    }
    pub async fn backup_admit(
        &self,
        owner: &str,
        instance: &str,
        server: &str,
        input: &Value,
    ) -> Result<(Value, bool)> {
        let (owner, instance, server, input) = (
            owner.to_owned(),
            instance.to_owned(),
            server.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            ensure!(!tx.query("SELECT id FROM cantrip_os_instances WHERE id=$1 AND owner_id=$2 FOR UPDATE", &[&instance,&owner]).await?.is_empty(),"OS attachment not found.");
            let old=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_backup_operations o WHERE operation_id=$1", &[&text(&input,"operationId")?]).await?)?;
            if let Some(old)=old.first() {
                ensure!(old["owner_id"]==owner && old["instance_id"]==instance && old["request"]==input,"The operation ID belongs to a different backup admission.");
                return Ok((old.clone(),false));
            }
            let targets=decode(tx.query("SELECT jsonb_build_object('instance',to_jsonb(i),'workspace',to_jsonb(w))::text FROM cantrip_os_instances i JOIN cantrip_os_workspaces w ON w.instance_id=i.id JOIN workers k ON k.id=i.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE i.owner_id=$1 AND i.id=$2 AND w.id=$3 FOR UPDATE", &[&owner,&instance,&text(&input,"workspaceId")?]).await?)?;
            let target=targets.first().context("The selected OS workspace or runtime changed before backup admission.")?;
            let (i,w)=(&target["instance"],&target["workspace"]);
            ensure!(i["attachment_generation"]==input["attachmentGeneration"] && i["runtime_generation"]==input["runtimeGeneration"],"The selected OS workspace or runtime changed before backup admission.");
            let scope=json!({"ownerId":owner,"serverId":server,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"],"runtimeGeneration":i["runtime_generation"]});
            let action=text(&input,"action")?;
            let mut command=json!({"type":format!("cantrip-os.backup.{action}"),"scope":scope,"operationId":input["operationId"],"transport":i["transport"],"protectedRequest":input["protectedRequest"],"workspace":{"id":w["id"],"guestWorkspaceId":w["guest_workspace_id"],"uid":w["uid"],"gid":w["gid"],"homeGuestPath":w["home_guest_path"]}});
            if action=="capture" {
                let sources=decode(tx.query("SELECT jsonb_build_object('binding',to_jsonb(b),'common',s.git_common_guest_path)::text FROM cantrip_os_source_bindings b LEFT JOIN cantrip_os_project_sources s ON s.id=b.project_source_id WHERE b.owner_id=$1 AND b.workspace_id=$2 AND b.retired_at IS NULL ORDER BY b.id", &[&owner,&text(w,"id")?]).await?)?;
                command["sources"]=Value::Array(sources.iter().map(|v|{let b=&v["binding"];json!({"bindingId":b["id"],"projectId":b["project_id"],"projectSourceId":b["project_source_id"],"worktreeId":b["worktree_id"],"mode":b["mode"],"guestPath":b["guest_path"],"gitCommonGuestPath":if b["mode"]=="linux-owned" {v["common"].clone()} else {Value::Null}})}).collect());
            } else {
                let reference=if action=="restore" {text(&input,"backupId")?} else {text(&input,"restoreOperationId")?};
                let references=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_backup_operations o WHERE operation_id=$1 AND owner_id=$2", &[&reference,&owner]).await?)?;
                let r=references.first().context("The referenced backup operation belongs to another target or storage Worker.")?;
                ensure!(r["worker_id"]==i["worker_id"] && r["action"]==if action=="restore" {"capture"} else {"restore"},"The referenced backup operation belongs to another target or storage Worker.");
                if action=="restore" {command["backupId"]=input["backupId"].clone();command["backupScope"]=r["command"]["scope"].clone();command["replace"]=input["replace"].clone();}
                else {ensure!(r["instance_id"]==i["id"] && r["workspace_id"]==w["id"],"Rollback must target the original restore workspace.");command["restoreOperationId"]=input["restoreOperationId"].clone();}
            }
            let command=checked("workerRequestEnvelopeSchema",json!({"kind":"request","requestId":"backup-admission","command":command}))?["command"].clone();
            let values=Json(json!({"owner":owner,"instance":instance,"worker":i["worker_id"],"workspace":w["id"],"input":input,"command":command}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_backup_operations(operation_id,owner_id,instance_id,worker_id,workspace_id,action,backup_id,restore_operation_id,request,command) VALUES($1::jsonb->'input'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'worker',$1::jsonb->>'workspace',$1::jsonb->'input'->>'action',$1::jsonb->'input'->>'backupId',$1::jsonb->'input'->>'restoreOperationId',$1::jsonb->'input',$1::jsonb->'command') RETURNING to_jsonb(cantrip_os_backup_operations)::text", &[&values]).await?)?;
            Ok((rows[0].clone(),true))
        })).await
    }
    pub async fn backup_begin(&self, owner: &str, id: &str) -> Result<Value> {
        self.rows("UPDATE cantrip_os_backup_operations SET revision=revision+1 WHERE owner_id=$1 AND operation_id=$2 RETURNING to_jsonb(cantrip_os_backup_operations)::text", &[&owner,&id]).await?.into_iter().next().context("Backup operation not found.")
    }
    pub async fn backup_authorize(
        &self,
        owner: &str,
        id: &str,
        server: &str,
        input: &Value,
    ) -> Result<Value> {
        let (owner, id, server, input) = (
            owner.to_owned(),
            id.to_owned(),
            server.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            tx.query("SELECT i.id FROM cantrip_os_instances i JOIN cantrip_os_backup_operations o ON o.instance_id=i.id WHERE o.owner_id=$1 AND o.operation_id=$2 FOR UPDATE OF i", &[&owner,&id]).await?;
            let rows=decode(tx.query("SELECT jsonb_build_object('operation',to_jsonb(o),'instance',to_jsonb(i),'workspace',to_jsonb(w))::text FROM cantrip_os_backup_operations o JOIN cantrip_os_instances i ON i.id=o.instance_id JOIN cantrip_os_workspaces w ON w.id=o.workspace_id WHERE o.owner_id=$1 AND o.operation_id=$2 FOR UPDATE", &[&owner,&id]).await?)?;
            let current=rows.first().context("Backup operation not found.")?;
            let (o,i,w)=(&current["operation"],&current["instance"],&current["workspace"]);let original=&o["command"]["scope"];
            let workspace=json!({"id":w["id"],"guestWorkspaceId":w["guest_workspace_id"],"uid":w["uid"],"gid":w["gid"],"homeGuestPath":w["home_guest_path"]});
            ensure!(i["owner_id"]==owner && i["attachment_generation"]==input["attachmentGeneration"] && i["attachment_generation"]==original["attachmentGeneration"] && i["runtime_generation"]==input["runtimeGeneration"] && i["guest_instance_id"]==original["guestInstanceId"] && i["worker_id"]==original["workerId"] && original["serverId"]==server && o["command"]["workspace"]==workspace,"The continuation target changed. Check recovery and select its current runtime before continuing.");
            let mut scope=original.clone();scope["runtimeGeneration"]=input["runtimeGeneration"].clone();let scope=Json(scope);
            let rows=decode(tx.query("UPDATE cantrip_os_backup_operations SET revision=revision+1,continuation_scope=$3 WHERE owner_id=$1 AND operation_id=$2 RETURNING to_jsonb(cantrip_os_backup_operations)::text", &[&owner,&id,&scope]).await?)?;
            Ok(rows[0].clone())
        })).await
    }
    pub async fn backup_record(&self, owner: &str, row: &Value, result: Value) -> Result<Value> {
        let result = checked("cantripOsBackupOperationResultSchema", result)?;
        ensure!(
            result["operationId"] == row["operation_id"] && result["action"] == row["action"],
            "The backup response belongs to another admission."
        );
        let values = Json(
            json!({"owner":owner,"id":row["operation_id"],"revision":row["revision"],"result":result}),
        );
        self.database.query("UPDATE cantrip_os_backup_operations SET result=$1::jsonb->'result',updated_at=now() WHERE owner_id=$1::jsonb->>'owner' AND operation_id=$1::jsonb->>'id' AND result->>'state' IS DISTINCT FROM 'ready' AND (revision=($1::jsonb->>'revision')::integer OR $1::jsonb->'result'->>'state'='ready')", &[&values]).await?;
        self.backup_get(owner, text(row, "operation_id")?)
            .await?
            .context("Backup operation not found.")
    }
}
