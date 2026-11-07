use super::{Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn power_context(&self, owner: &str, instance: &str) -> Result<Value> {
        self.rows("SELECT jsonb_build_object('instance',to_jsonb(i),'target',CASE WHEN i.transport->>'kind'='docker' AND p.attachment_generation=i.attachment_generation THEN to_jsonb(p) ELSE NULL END)::text FROM cantrip_os_instances i LEFT JOIN cantrip_os_power_targets p ON p.instance_id=i.id WHERE i.owner_id=$1 AND i.id=$2", &[&owner,&instance]).await?.into_iter().next().context("OS attachment not found.")
    }
    pub async fn record_power_target(
        &self,
        owner: &str,
        instance: &str,
        attachment: &str,
        runtime: &str,
        container: &str,
        expected_power_epoch: i32,
    ) -> Result<()> {
        let (owner, instance, attachment, runtime, container) = (
            owner.to_owned(),
            instance.to_owned(),
            attachment.to_owned(),
            runtime.to_owned(),
            container.to_owned(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            ensure!(!tx.query("SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND runtime_generation=$4 AND transport->>'kind'='docker' AND power_epoch=$5 FOR UPDATE", &[&owner,&instance,&attachment,&runtime,&expected_power_epoch]).await?.is_empty(),"The verified Docker attachment changed before its power target was recorded.");
            let old=decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_power_targets p WHERE instance_id=$1", &[&instance]).await?)?;
            let generation=old.first().filter(|p|p["attachment_generation"]==attachment && p["container_id"]==container).and_then(|p|p["generation"].as_str()).map(str::to_owned).unwrap_or_else(uuid);
            tx.query("INSERT INTO cantrip_os_power_targets(instance_id,generation,attachment_generation,runtime_generation,container_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id) DO UPDATE SET generation=EXCLUDED.generation,attachment_generation=EXCLUDED.attachment_generation,runtime_generation=EXCLUDED.runtime_generation,container_id=EXCLUDED.container_id,verified_at=now()", &[&instance,&generation,&attachment,&runtime,&container]).await?;
            tx.query("UPDATE cantrip_os_instances SET status=CASE WHEN EXISTS(SELECT 1 FROM cantrip_os_power_operations WHERE instance_id=$1 AND attachment_generation=$2 AND target_generation=$3 AND state IN ('admitted','running','unknown')) OR EXISTS(SELECT 1 FROM cantrip_os_system_operations s WHERE s.instance_id=$1 AND s.retired_by IS NULL AND s.state IN ('admitted','running','unknown')) THEN 'unknown' ELSE 'connected' END,last_error=NULL WHERE id=$1", &[&instance,&attachment,&generation]).await?;
            Ok(())
        })).await
    }
    pub async fn power_get(&self, owner: &str, instance: &str, id: &str) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_power_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner,&instance,&id]).await?.into_iter().next())
    }
    pub async fn power_admit(
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
            let parents=decode(tx.query("SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers w ON w.id=i.worker_id AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE i.id=$2 AND i.owner_id=$1 FOR UPDATE OF i", &[&owner,&instance]).await?)?;
            let i=parents.first().context("Owned OS attachment not found.")?;
            let old=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_power_operations o WHERE operation_id=$1", &[&text(&input,"operationId")?]).await?)?;
            if let Some(old)=old.first() {
                ensure!(old["owner_id"]==owner && old["instance_id"]==instance && old["request"]==input,"This power operation ID belongs to another admission.");
                return Ok((old.clone(),false));
            }
            super::system_common::no_active(tx,&instance,None).await?;
            let targets=decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_power_targets p WHERE instance_id=$1", &[&instance]).await?)?;
            let p=targets.first().context("No retained power target is recorded.")?;
            ensure!(i["transport"]["kind"]=="docker" && i["attachment_generation"]==input["attachmentGeneration"] && p["attachment_generation"]==input["attachmentGeneration"] && p["generation"]==input["targetGeneration"],"The selected retained power target changed.");
            ensure!(tx.query("SELECT operation_id FROM cantrip_os_power_operations WHERE instance_id=$1 AND attachment_generation=$2 AND target_generation=$3 AND state IN ('admitted','running','unknown')", &[&instance,&text(&input,"attachmentGeneration")?,&text(&input,"targetGeneration")?]).await?.is_empty(),"Another power operation remains active or uncertain. Observe its outcome first.");
            let command=checked("cantripOsPowerWorkerCommandSchema",json!({"type":"cantrip-os.power.operation","mode":"execute","operationId":input["operationId"],"action":input["action"],"scope":{"ownerId":owner,"serverId":server,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"],"runtimeGeneration":p["runtime_generation"]},"transport":i["transport"],"powerTarget":{"kind":"docker","generation":p["generation"],"containerId":p["container_id"]}}))?;
            let values=Json(json!({"owner":owner,"instance":instance,"worker":i["worker_id"],"input":input,"command":command}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_power_operations(operation_id,owner_id,instance_id,worker_id,attachment_generation,target_generation,action,request,command) VALUES($1::jsonb->'input'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'worker',$1::jsonb->'input'->>'attachmentGeneration',$1::jsonb->'input'->>'targetGeneration',$1::jsonb->'input'->>'action',$1::jsonb->'input',$1::jsonb->'command') RETURNING to_jsonb(cantrip_os_power_operations)::text", &[&values]).await?)?;
            tx.query("UPDATE cantrip_os_instances SET status='unknown',power_epoch=power_epoch+1,updated_at=now() WHERE id=$1", &[&instance]).await?;
            Ok((rows[0].clone(),true))
        })).await
    }
    pub async fn power_begin(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.rows("UPDATE cantrip_os_power_operations SET revision=revision+1 WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3 RETURNING to_jsonb(cantrip_os_power_operations)::text", &[&owner,&instance,&id]).await?.into_iter().next().context("Power operation not found.")
    }
    pub async fn power_unknown(&self, owner: &str, row: &Value) -> Result<Value> {
        self.database.query("UPDATE cantrip_os_power_operations SET state='unknown',updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND revision=$3::bigint AND state NOT IN ('ready','failed')", &[&owner,&text(row,"operation_id")?,&row["revision"].as_i64().context("Power revision")?]).await?;
        self.power_get(owner, text(row, "instance_id")?, text(row, "operation_id")?)
            .await?
            .context("Power operation not found.")
    }
    pub async fn power_record(&self, owner: &str, row: &Value, result: Value) -> Result<Value> {
        let result = checked("cantripOsPowerOperationResultSchema", result)?;
        let target = &row["command"]["powerTarget"];
        let matches =
            |value: &Value| value.is_null() || value["containerId"] == target["containerId"];
        ensure!(
            result["operationId"] == row["operation_id"]
                && result["action"] == row["action"]
                && matches(&result["observation"]),
            "Power response differs from its immutable target or action."
        );
        if !result["receipt"].is_null() {
            let receipt = &result["receipt"];
            ensure!(
                receipt["targetGeneration"] == target["generation"]
                    && receipt["containerId"] == target["containerId"]
                    && matches(&receipt["before"])
                    && matches(&receipt["after"]),
                "Power receipt changed target."
            );
            ensure!(
                receipt["after"]["running"] == json!(row["action"] != "stop")
                    && (row["action"] != "restart"
                        || receipt["before"]["startedAt"] != receipt["after"]["startedAt"]),
                "Power receipt does not verify its action."
            );
        }
        let (owner, row) = (owner.to_owned(), row.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let values=Json(json!({"owner":owner,"row":row,"result":result}));
            let saved=tx.query("UPDATE cantrip_os_power_operations SET state=$1::jsonb->'result'->>'state',result=$1::jsonb->'result',updated_at=now() WHERE owner_id=$1::jsonb->>'owner' AND operation_id=$1::jsonb->'row'->>'operation_id' AND state NOT IN ('ready','failed') AND ($1::jsonb->'result'->>'state'='ready' OR revision=($1::jsonb->'row'->>'revision')::integer) RETURNING operation_id", &[&values]).await?;
            if !saved.is_empty() {
                tx.query("UPDATE cantrip_os_instances SET status=CASE WHEN $1::jsonb->'result'->'observation'->>'running'='false' THEN 'disconnected' ELSE 'unknown' END,updated_at=now() WHERE id=$1::jsonb->'row'->>'instance_id' AND attachment_generation=$1::jsonb->'row'->>'attachment_generation' AND EXISTS(SELECT 1 FROM cantrip_os_power_targets p WHERE p.instance_id=cantrip_os_instances.id AND p.generation=$1::jsonb->'row'->>'target_generation')", &[&values]).await?;
            }
            let current=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_power_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&text(&row,"operation_id")?]).await?)?;
            current.into_iter().next().context("Power operation not found.")
        })).await
    }
    pub async fn power_list(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<(Vec<Value>, Option<String>)> {
        self.power_context(owner, instance).await?;
        let cursor = input["cursor"].as_str();
        if let Some(id) = cursor {
            self.power_get(owner, instance, id)
                .await?
                .context("Power history cursor not found.")?;
        }
        let limit = input["limit"].as_i64().context("Power page limit")?;
        let mut rows=self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_power_operations o WHERE owner_id=$1 AND instance_id=$2 AND ($3::text IS NULL OR (created_at,operation_id)<(SELECT created_at,operation_id FROM cantrip_os_power_operations WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3)) ORDER BY created_at DESC,operation_id DESC LIMIT $4", &[&owner,&instance,&cursor,&(limit+1)]).await?;
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
}
