use super::system_common::{no_active, owned, scope, source};
use super::{Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};
impl Repository {
    pub async fn system_admit(
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
            checked("cantripOsSystemCreateSchema", input.clone())?,
        );
        self.database.transaction(|tx|Box::pin(async move {
            let i=owned(tx,&owner,&instance).await?;
            let id=text(&input,"operationId")?;
            let old=decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_system_operations o WHERE operation_id=$1", &[&id]).await?)?;
            if let Some(old)=old.first() {
                ensure!(old["owner_id"]==owner && old["instance_id"]==instance && old["request"]==input,"This system operation ID belongs to another immutable admission.");
                return Ok((old.clone(),false));
            }
            ensure!(i["attachment_generation"]==input["attachmentGeneration"] && i["transport"]["kind"]=="docker","The selected system attachment changed or has no Docker management path.");
            let worker=text(&i,"worker_id")?;
            let original=if input["action"]=="rollback" {
                let original=source(tx,&owner,&instance,worker,text(&input,"replacementOperationId")?).await?;
                ensure!(original["command"]["action"]=="replace" && original["state"]!="rejected" && original["target_generation"]==input["targetGeneration"],"Rollback requires the original replacement's exact management target.");
                ensure!(original["dispatch_stage"]=="executing" || original["result"]["root"]["targetContainerId"].is_string(),"The replacement has not been dispatched. Cancel its prepared admission instead.");
                original
            } else {Value::Null};
            no_active(tx,&instance,original["operation_id"].as_str()).await?;
            ensure!(tx.query("SELECT operation_id FROM cantrip_os_power_operations WHERE instance_id=$1 AND attachment_generation=$2 AND state IN ('admitted','running','unknown') LIMIT 1", &[&instance,&text(&i,"attachment_generation")?]).await?.is_empty(),"A power operation remains active or uncertain. Observe its original outcome before replacing system state.");
            let targets=decode(tx.query("SELECT to_jsonb(t)::text FROM cantrip_os_system_targets t WHERE instance_id=$1", &[&instance]).await?)?;
            let target_row=targets.first().cloned().unwrap_or(Value::Null);let catalog=&target_row["catalog"];
            if original.is_null() {
                ensure!(catalog["target"].is_object() && catalog["supported"]==true && target_row["attachment_generation"]==i["attachment_generation"] && target_row["catalog_power_epoch"]==i["power_epoch"] && catalog["target"]["generation"]==input["targetGeneration"],"The selected system target changed. Observe actual system status before admitting another operation.");
            }
            let target=if original.is_object(){original["command"]["target"].clone()}else{catalog["target"].clone()};
            let mut command=json!({"mode":"execute","operationId":id,"scope":scope(&i,&server),"transport":i["transport"],"target":target,"action":input["action"]});
            match text(&input,"action")? {
                "capture"=>{command["type"]=json!("cantrip-os.system.capture");command["checkpointId"]=json!(uuid());command["resumeOriginal"]=input["resumeOriginal"].clone();},
                "rollback"=>{command["type"]=json!("cantrip-os.system.rollback");command["startTarget"]=input["startTarget"].clone();command["replacement"]=json!({"operationId":original["operation_id"],"scope":original["command"]["scope"],"targetGeneration":original["target_generation"]});},
                "replace"=>{
                    command["type"]=json!("cantrip-os.system.replace");command["startTarget"]=input["startTarget"].clone();
                    command["source"]=if input["source"]["kind"]=="checkpoint" {
                        let capture=source(tx,&owner,&instance,worker,text(&input["source"],"operationId")?).await?;let c=&capture["command"];
                        ensure!(c["action"]=="capture" && capture["state"]=="ready" && capture["result"]["protectedResult"].is_object(),"The selected private system checkpoint is not complete.");
                        let mut context=c["scope"].clone();context["operationId"]=c["operationId"].clone();context["targetGeneration"]=c["target"]["generation"].clone();context["containerId"]=c["target"]["containerId"].clone();context["checkpointId"]=c["checkpointId"].clone();
                        json!({"kind":"checkpoint","capture":{"context":context,"container":c["target"]["containerName"],"resumeOriginal":c["resumeOriginal"]}})
                    } else {
                        ensure!(catalog["bases"].as_array().context("System base catalogue")?.iter().any(|base|base["imageId"]==input["source"]["imageId"]),"The exact base image is not in this verified system catalogue.");
                        input["source"].clone()
                    };
                },
                _=>unreachable!(),
            }
            let command=checked("cantripOsSystemOperationCommandSchema",command)?; let fence=uuid();
            let v=Json(json!({"owner":owner,"instance":instance,"worker":worker,"fence":fence,"epoch":i["power_epoch"].as_i64().context("System admission epoch")?+1,"input":input,"command":command}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_system_operations(operation_id,owner_id,instance_id,worker_id,attachment_generation,target_generation,fence_generation,admission_epoch,request,command) VALUES($1::jsonb->'input'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'worker',$1::jsonb->'input'->>'attachmentGeneration',$1::jsonb->'input'->>'targetGeneration',$1::jsonb->>'fence',($1::jsonb->>'epoch')::integer,$1::jsonb->'input',$1::jsonb->'command') RETURNING to_jsonb(cantrip_os_system_operations)::text", &[&v]).await?)?;
            if original.is_object() {tx.query("UPDATE cantrip_os_system_operations SET retired_by=$2 WHERE operation_id=$1", &[&text(&original,"operation_id")?,&id]).await?;}
            tx.query("UPDATE cantrip_os_system_targets SET attachment_generation=$2,catalog_power_epoch=NULL,observation_epoch=observation_epoch+1 WHERE instance_id=$1", &[&instance,&fence]).await?;
            let transport=Json(json!({"kind":"docker","container":target["containerName"]}));
            tx.query("UPDATE cantrip_os_instances SET attachment_generation=$2,transport=$3,runtime_generation=NULL,worker_process_generation=NULL,status='unknown',last_error=NULL,power_epoch=power_epoch+1,updated_at=now() WHERE id=$1", &[&instance,&fence,&transport]).await?;
            Ok((rows[0].clone(),true))
        })).await
    }
}
