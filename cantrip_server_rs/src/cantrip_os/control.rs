use super::{InstanceObservation, Repository, checked, decode, summary, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn attach(&self, owner: &str, input: &Value) -> Result<Value> {
        checked("cantripOsAttachSchema", input.clone())?;
        let owner = owner.to_owned();
        let input = input.clone();
        self.database.transaction(|tx|Box::pin(async move {
            let worker=text(&input,"workerId")?;
            ensure!(!tx.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL FOR UPDATE", &[&worker,&owner]).await?.is_empty(),"Owning worker not found.");
            let old=decode(tx.query("SELECT to_jsonb(i)::text FROM cantrip_os_instances i WHERE worker_id=$1 AND guest_instance_id=$2", &[&worker,&text(&input,"guestInstanceId")?]).await?)?;
            let previous=old.first().map_or(Value::Null,|v|v["attachment_generation"].clone());
            ensure!(previous==input["expectedAttachmentGeneration"],"OS attachment changed; refresh before attaching again.");
            let id=old.first().and_then(|v|v["id"].as_str()).map(str::to_owned).unwrap_or_else(uuid);
            let values=Json(json!({"id":id,"owner":owner,"worker":worker,"guest":input["guestInstanceId"],"generation":uuid(),"transport":input["transport"],"name":input["name"]}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_instances(id,owner_id,worker_id,guest_instance_id,attachment_generation,transport,name) VALUES($1::jsonb->>'id',$1::jsonb->>'owner',$1::jsonb->>'worker',$1::jsonb->>'guest',$1::jsonb->>'generation',$1::jsonb->'transport',$1::jsonb->>'name') ON CONFLICT(id) DO UPDATE SET attachment_generation=EXCLUDED.attachment_generation,transport=EXCLUDED.transport,name=EXCLUDED.name,status='unknown',runtime_generation=NULL,worker_process_generation=NULL,last_error=NULL,last_observed_at=NULL,updated_at=now() RETURNING to_jsonb(cantrip_os_instances)::text", &[&values]).await?)?;
            summary(&rows[0],"instance",None)
        })).await
    }

    pub async fn observe(
        &self,
        owner: &str,
        id: &str,
        generation: &str,
        status: &str,
        runtime: Option<&str>,
        error: Option<&str>,
    ) -> Result<Value> {
        let rows=self.rows("UPDATE cantrip_os_instances SET status=CASE WHEN $4='connected' AND EXISTS(SELECT 1 FROM cantrip_os_power_operations o JOIN cantrip_os_power_targets p ON p.instance_id=o.instance_id AND p.generation=o.target_generation WHERE o.instance_id=$2 AND o.attachment_generation=$3 AND o.state IN ('admitted','running','unknown')) THEN 'unknown' ELSE $4 END,runtime_generation=$5,last_error=$6,last_observed_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 RETURNING to_jsonb(cantrip_os_instances)::text", &[&owner,&id,&generation,&status,&runtime,&error]).await?;
        summary(
            rows.first()
                .context("OS attachment changed before observation arrived.")?,
            "instance",
            None,
        )
    }

    pub async fn observe_current(
        &self,
        owner: &str,
        id: &str,
        generation: &str,
        observation: InstanceObservation<'_>,
        expected_runtime: Option<&str>,
    ) -> Result<Value> {
        let InstanceObservation {
            status,
            runtime,
            error,
        } = observation;
        let rows=self.rows("UPDATE cantrip_os_instances SET status=CASE WHEN $4='connected' AND EXISTS(SELECT 1 FROM cantrip_os_power_operations o JOIN cantrip_os_power_targets p ON p.instance_id=o.instance_id AND p.generation=o.target_generation WHERE o.instance_id=$2 AND o.attachment_generation=$3 AND o.state IN ('admitted','running','unknown')) THEN 'unknown' ELSE $4 END,runtime_generation=$5,last_error=$6,last_observed_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND runtime_generation IS NOT DISTINCT FROM $7 RETURNING to_jsonb(cantrip_os_instances)::text", &[&owner,&id,&generation,&status,&runtime,&error,&expected_runtime]).await?;
        summary(
            rows.first()
                .context("OS attachment changed before observation arrived.")?,
            "instance",
            None,
        )
    }

    pub async fn record_workspace(
        &self,
        owner: &str,
        id: &str,
        generation: &str,
        observation: &Value,
    ) -> Result<Value> {
        checked("cantripOsWorkspaceObservationSchema", observation.clone())?;
        let (owner, id, generation) = (owner.to_owned(), id.to_owned(), generation.to_owned());
        let observation = observation.clone();
        self.database.transaction(|tx|Box::pin(async move {
            let parents=tx.query("SELECT worker_id FROM cantrip_os_instances WHERE id=$1 AND owner_id=$2 AND attachment_generation=$3 FOR UPDATE", &[&id,&owner,&generation]).await?;
            let worker=parents.first().context("OS attachment changed before workspace observation arrived.")?.get::<String>(0)?;
            let rows=decode(tx.query("SELECT to_jsonb(w)::text FROM cantrip_os_workspaces w WHERE instance_id=$1 AND guest_workspace_id=$2", &[&id,&text(&observation,"guestWorkspaceId")?]).await?)?;
            if let Some(old)=rows.first() {
                ensure!(old["uid"]==observation["uid"] && old["gid"]==observation["gid"] && old["home_guest_path"]==observation["homeGuestPath"],"OS workspace identity changed; the existing placement was preserved.");
                return summary(old,"workspace",Some(&worker));
            }
            let values=Json(json!({"id":uuid(),"instance":id,"observation":observation}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_workspaces(id,instance_id,guest_workspace_id,uid,gid,home_guest_path) VALUES($1::jsonb->>'id',$1::jsonb->>'instance',$1::jsonb->'observation'->>'guestWorkspaceId',($1::jsonb->'observation'->>'uid')::integer,($1::jsonb->'observation'->>'gid')::integer,$1::jsonb->'observation'->>'homeGuestPath') RETURNING to_jsonb(cantrip_os_workspaces)::text", &[&values]).await?)?;
            summary(&rows[0],"workspace",Some(&worker))
        })).await
    }
}
