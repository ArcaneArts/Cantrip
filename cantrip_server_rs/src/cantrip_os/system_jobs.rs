use super::system_common::owned;
use super::{Repository, checked, decode, text};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::Value;
impl Repository {
    pub async fn system_begin_execution(
        &self,
        owner: &str,
        original: &Value,
    ) -> Result<(Value, bool)> {
        let (owner, original) = (owner.to_owned(), original.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let instance=text(&original,"instance_id")?;let id=text(&original,"operation_id")?;let i=owned(tx,&owner,instance).await?;
            let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&id]).await?)?;
            let row=rows.first().context("The prepared system attachment changed; no execution was dispatched.")?;
            ensure!(row["retired_by"].is_null() && row["worker_id"]==i["worker_id"] && i["attachment_generation"]==row["fence_generation"],"The prepared system attachment changed; no execution was dispatched.");
            if row["dispatch_stage"]=="executing" || matches!(row["state"].as_str(),Some("ready"|"failed"|"rejected")) {return Ok((row.clone(),false));}
            ensure!(row["result"]["phase"]=="prepared" && row["result"]["protectedResult"].is_object(),"The original Worker admission has not been durably prepared.");
            let rows=decode(tx.query("UPDATE cantrip_os_system_operations SET dispatch_stage='executing',revision=revision+1 WHERE operation_id=$1 RETURNING to_jsonb(cantrip_os_system_operations)::text", &[&id]).await?)?;
            Ok((rows[0].clone(),true))
        })).await
    }
    pub async fn system_reject(&self, owner: &str, original: &Value) -> Result<Value> {
        let (owner, original) = (owner.to_owned(), original.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let instance=text(&original,"instance_id")?;let id=text(&original,"operation_id")?;
            tx.query("SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[&owner,&instance]).await?;
            let saved=tx.query("UPDATE cantrip_os_system_operations SET state='rejected',updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND dispatch_stage='preparing' AND state NOT IN ('ready','failed','rejected') RETURNING operation_id", &[&owner,&id]).await?;
            if !saved.is_empty() {let epoch=original["admission_epoch"].as_i64().context("System admission epoch")?;tx.query("UPDATE cantrip_os_instances SET runtime_generation=NULL,worker_process_generation=NULL,status='unknown',power_epoch=power_epoch+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND power_epoch=$4::bigint", &[&owner,&instance,&text(&original,"fence_generation")?,&epoch]).await?;}
            decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&id]).await?)?.into_iter().next().context(crate::cantrip_os::PlacementError("System operation not found."))
        })).await
    }
    pub async fn system_get(&self, owner: &str, instance: &str, id: &str) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner,&instance,&id]).await?.into_iter().next())
    }
    pub async fn system_begin(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
        control: Option<&Value>,
    ) -> Result<Value> {
        let (owner, instance, id, control) = (
            owner.to_owned(),
            instance.to_owned(),
            id.to_owned(),
            control.cloned(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            if let Some(input)=&control {
                let i=owned(tx,&owner,&instance).await?;
                let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner,&instance,&id]).await?)?;
                let o=rows.first().context("The original system attachment changed or was retired; no continuation was dispatched.")?;
                ensure!(o["retired_by"].is_null() && o["worker_id"]==i["worker_id"] && o["fence_generation"]==input["attachmentGeneration"] && o["target_generation"]==input["targetGeneration"] && i["attachment_generation"]==input["attachmentGeneration"],"The original system attachment changed or was retired; no continuation was dispatched.");
            }
            let rows=decode(tx.query("UPDATE cantrip_os_system_operations SET revision=revision+1 WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3 RETURNING to_jsonb(cantrip_os_system_operations)::text", &[&owner,&instance,&id]).await?)?;
            rows.into_iter().next().context(crate::cantrip_os::PlacementError("System operation not found."))
        })).await
    }
    pub async fn system_record(&self, owner: &str, original: &Value, raw: Value) -> Result<Value> {
        let result = checked("cantripOsSystemOperationResultSchema", raw)?;
        let terminal = matches!(result["state"].as_str(), Some("ready" | "failed"));
        ensure!(
            result["operationId"] == original["operation_id"]
                && result["targetGeneration"] == original["target_generation"]
                && result["action"] == original["command"]["action"]
                && (!terminal || result["protectedResult"].is_object())
                && (result["state"] != "ready"
                    || result["action"] == "capture"
                    || result["root"]["targetContainerId"].is_string()),
            "System outcome differs from its immutable admission."
        );
        let (owner, original) = (owner.to_owned(), original.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let instance=text(&original,"instance_id")?;let id=text(&original,"operation_id")?;
            tx.query("SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[&owner,&instance]).await?;
            let revision=original["revision"].as_i64().context("System revision")?;let payload=Json(result.clone());
            let saved=tx.query("UPDATE cantrip_os_system_operations SET state=$3,result=$4,updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND state NOT IN ('ready','failed','rejected') AND ($5 OR revision=$6::bigint) RETURNING operation_id", &[&owner,&id,&text(&result,"state")?,&payload,&terminal,&revision]).await?;
            if !saved.is_empty() && terminal {
                let epoch=original["admission_epoch"].as_i64().context("System admission epoch")?;
                tx.query("UPDATE cantrip_os_instances SET runtime_generation=NULL,worker_process_generation=NULL,status='unknown',last_error=NULL,power_epoch=power_epoch+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND power_epoch=$4::bigint", &[&owner,&instance,&text(&original,"fence_generation")?,&epoch]).await?;
            }
            let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&id]).await?)?;
            rows.into_iter().next().context(crate::cantrip_os::PlacementError("System operation not found."))
        })).await
    }
    pub async fn system_unknown(&self, owner: &str, row: &Value) -> Result<Value> {
        self.database.query("UPDATE cantrip_os_system_operations SET state='unknown',updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND revision=$3::bigint AND state NOT IN ('ready','failed','rejected')", &[&owner,&text(row,"operation_id")?,&row["revision"].as_i64().context("System revision")?]).await?;
        self.system_get(owner, text(row, "instance_id")?, text(row, "operation_id")?)
            .await?
            .context(crate::cantrip_os::PlacementError(
                "System operation not found.",
            ))
    }
    pub async fn system_list(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<(Vec<Value>, Option<String>)> {
        ensure!(!self.rows("SELECT to_jsonb(i)::text FROM cantrip_os_instances i WHERE owner_id=$1 AND id=$2", &[&owner,&instance]).await?.is_empty(),crate::cantrip_os::PlacementError("OS attachment not found."));
        let cursor = input["cursor"].as_str().map(str::to_owned);
        if let Some(cursor) = &cursor {
            self.system_get(owner, instance, cursor).await?.context(
                crate::cantrip_os::PlacementError("System history cursor not found."),
            )?;
        }
        let limit = input["limit"].as_i64().context("System history limit")?;
        let mut rows=self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND instance_id=$2 AND ($3::text IS NULL OR (created_at,operation_id)<(SELECT created_at,operation_id FROM cantrip_os_system_operations WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3)) ORDER BY created_at DESC,operation_id DESC LIMIT $4", &[&owner,&instance,&cursor,&(limit+1)]).await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last()
                .and_then(|row| row["operation_id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok((rows, next))
    }
}
