use super::system_common::{identity, no_active, owned};
use super::{Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn system_begin_status(&self, owner: &str, instance: &str) -> Result<Value> {
        let (owner, instance) = (owner.to_owned(), instance.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let i=owned(tx,&owner,&instance).await?;
            let old=decode(tx.query("SELECT to_jsonb(t)::text FROM cantrip_os_system_targets t WHERE instance_id=$1", &[&instance]).await?)?.into_iter().next().unwrap_or(Value::Null);
            let same=old["attachment_generation"]==i["attachment_generation"];
            let v=Json(json!({"instance":instance,"attachment":i["attachment_generation"],"epoch":old["observation_epoch"].as_i64().unwrap_or(0)+1,"catalog":if same{old["catalog"].clone()}else{Value::Null},"power":if same{old["catalog_power_epoch"].clone()}else{Value::Null},"verified":if same{old["verified_at"].clone()}else{Value::Null}}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_system_targets(instance_id,attachment_generation,observation_epoch,catalog,catalog_power_epoch,verified_at) VALUES($1::jsonb->>'instance',$1::jsonb->>'attachment',($1::jsonb->>'epoch')::integer,NULLIF($1::jsonb->'catalog','null'::jsonb),($1::jsonb->>'power')::integer,($1::jsonb->>'verified')::timestamptz) ON CONFLICT(instance_id) DO UPDATE SET attachment_generation=EXCLUDED.attachment_generation,observation_epoch=EXCLUDED.observation_epoch,catalog=EXCLUDED.catalog,catalog_power_epoch=EXCLUDED.catalog_power_epoch,verified_at=EXCLUDED.verified_at RETURNING to_jsonb(cantrip_os_system_targets)::text", &[&v]).await?)?;
            Ok(json!({"instance":i,"target":rows[0]}))
        })).await
    }
    pub async fn system_record_target(
        &self,
        owner: &str,
        context: &Value,
        raw: Value,
    ) -> Result<Value> {
        let mut catalog = checked("cantripOsSystemStatusResultSchema", raw)?;
        if catalog["target"].is_object() {
            let expected = &catalog["target"]["expected"];
            ensure!(
                expected["ownerId"] == owner
                    && expected["workerId"] == context["instance"]["worker_id"]
                    && expected["guestInstanceId"] == context["instance"]["guest_instance_id"],
                "The system observation belongs to another OS attachment."
            );
        }
        let (owner, context) = (owner.to_owned(), context.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let id=text(&context["instance"],"id")?;let i=owned(tx,&owner,id).await?;
            let rows=decode(tx.query("SELECT to_jsonb(t)::text FROM cantrip_os_system_targets t WHERE instance_id=$1", &[&id]).await?)?;
            let previous=rows.first().context("System observation not found.")?;
            ensure!(i["attachment_generation"]==context["instance"]["attachment_generation"] && i["worker_id"]==context["instance"]["worker_id"] && i["guest_instance_id"]==context["instance"]["guest_instance_id"] && i["power_epoch"]==context["instance"]["power_epoch"] && previous["observation_epoch"]==context["target"]["observation_epoch"] && previous["attachment_generation"]==i["attachment_generation"],"The system observation changed before its target was recorded.");
            if catalog["target"].is_object() {catalog["target"]["generation"]=if previous["catalog"]["target"].is_object() && previous["catalog_power_epoch"]==i["power_epoch"] && identity(&previous["catalog"]["target"])==identity(&catalog["target"]) {previous["catalog"]["target"]["generation"].clone()} else {json!(uuid())};}
            let payload=Json(catalog);let epoch=i["power_epoch"].as_i64().context("System power epoch")?;
            let rows=decode(tx.query("UPDATE cantrip_os_system_targets SET catalog=$2,catalog_power_epoch=$3::bigint,verified_at=now() WHERE instance_id=$1 RETURNING to_jsonb(cantrip_os_system_targets)::text", &[&id,&payload,&epoch]).await?)?;
            Ok(rows[0].clone())
        })).await
    }
    pub async fn system_begin_recovery(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
        input: &Value,
    ) -> Result<Value> {
        let (owner, instance, id, input) = (
            owner.to_owned(),
            instance.to_owned(),
            id.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let i=owned(tx,&owner,&instance).await?;
            let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner,&instance,&id]).await?)?;
            let o=rows.first().context("No completed original system transition authorizes this recovery.")?;
            ensure!(o["worker_id"]==i["worker_id"] && o["command"]["action"]!="capture" && o["state"]=="ready" && o["result"]["root"]["targetContainerId"].is_string() && o["retired_by"].is_null() && input["attachmentGeneration"]==o["fence_generation"] && input["targetGeneration"]==o["target_generation"],"No completed original system transition authorizes this recovery.");
            no_active(tx,&instance,None).await?;
            let recovered=!o["recovery_generation"].is_null();
            ensure!(i["attachment_generation"]==if recovered{o["recovery_generation"].clone()}else{o["fence_generation"].clone()},"The system recovery attachment changed; no historical target was substituted.");
            Ok(json!({"instance":i,"operation":o,"recovered":recovered}))
        })).await
    }
    pub async fn system_adopt(&self, owner: &str, original: &Value, raw: Value) -> Result<Value> {
        let mut catalog = checked("cantripOsSystemStatusResultSchema", raw)?;
        let target = catalog["target"].clone();
        let op = &original["operation"];
        ensure!(
            catalog["supported"] == true
                && target.is_object()
                && target["identityEvidence"] == "guest-identity"
                && target["containerId"] == op["result"]["root"]["targetContainerId"]
                && target["containerName"] == op["command"]["target"]["containerName"]
                && target["expected"]["ownerId"] == owner
                && target["expected"]["workerId"] == original["instance"]["worker_id"],
            "The recovered system does not match the exact completed transition."
        );
        let (owner, original) = (owner.to_owned(), original.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let instance=text(&original["instance"],"id")?;let op=&original["operation"];let id=text(op,"operation_id")?;
            let i=owned(tx,&owner,instance).await?;
            let rows=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE operation_id=$1", &[&id]).await?)?;
            let current=rows.first().context(crate::cantrip_os::PlacementError("System operation not found."))?;
            if current["recovery_generation"].is_string() && i["attachment_generation"]==current["recovery_generation"] {return Ok(i);}
            ensure!(current["retired_by"].is_null() && current["state"]=="ready" && i["attachment_generation"]==op["fence_generation"] && i["power_epoch"]==original["instance"]["power_epoch"] && i["worker_id"]==original["instance"]["worker_id"] && i["guest_instance_id"]==original["instance"]["guest_instance_id"],"The system recovery changed before its identity was adopted.");
            no_active(tx,instance,None).await?;
            let generation=uuid();catalog["target"]["generation"]=json!(uuid());
            let epoch=i["power_epoch"].as_i64().context("System power epoch")?+1;let payload=Json(catalog);
            tx.query("INSERT INTO cantrip_os_system_targets(instance_id,attachment_generation,observation_epoch,catalog_power_epoch,catalog,verified_at) VALUES($1,$2,1,$3::bigint,$4,now()) ON CONFLICT(instance_id) DO UPDATE SET attachment_generation=EXCLUDED.attachment_generation,observation_epoch=cantrip_os_system_targets.observation_epoch+1,catalog_power_epoch=EXCLUDED.catalog_power_epoch,catalog=EXCLUDED.catalog,verified_at=EXCLUDED.verified_at", &[&instance,&generation,&epoch,&payload]).await?;
            tx.query("UPDATE cantrip_os_system_operations SET recovery_generation=$2 WHERE operation_id=$1", &[&id,&generation]).await?;
            let guest=text(&target["expected"],"guestInstanceId")?;
            let rows=decode(tx.query("UPDATE cantrip_os_instances SET guest_instance_id=$2,attachment_generation=$3,runtime_generation=NULL,worker_process_generation=NULL,status='unknown',power_epoch=power_epoch+1,last_error=NULL,last_observed_at=NULL,updated_at=now() WHERE id=$1 RETURNING to_jsonb(cantrip_os_instances)::text", &[&instance,&guest,&generation]).await?)?;
            Ok(rows[0].clone())
        })).await
    }
}
