use super::{PlacementError, Repository, checked, decode, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

const OWNED: &str = "SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers w ON w.id=i.worker_id AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE i.owner_id=$1 AND i.id=$2 FOR UPDATE OF i";

impl Repository {
    pub async fn package_begin_status(&self, owner: &str, instance: &str) -> Result<Value> {
        let (owner, instance) = (owner.to_owned(), instance.to_owned());
        self.database.transaction(|tx| Box::pin(async move {
            let rows = decode(tx.query(OWNED, &[&owner, &instance]).await?)?;
            let i = rows.first().context(crate::cantrip_os::PlacementError("Owned OS attachment not found."))?;
            let old = decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_package_targets p WHERE instance_id=$1", &[&instance]).await?)?;
            let old = old.first().cloned().unwrap_or(Value::Null);
            let same = old["attachment_generation"] == i["attachment_generation"];
            let value = Json(json!({ "instance":instance, "attachment":i["attachment_generation"],
                "epoch":old["observation_epoch"].as_i64().unwrap_or(0)+1,
                "catalog":if same {old["catalog"].clone()} else {Value::Null},
                "power":if same {old["catalog_power_epoch"].clone()} else {Value::Null},
                "verified":if same {old["verified_at"].clone()} else {Value::Null} }));
            let targets = decode(tx.query("INSERT INTO cantrip_os_package_targets(instance_id,attachment_generation,observation_epoch,catalog,catalog_power_epoch,verified_at) VALUES($1::jsonb->>'instance',$1::jsonb->>'attachment',($1::jsonb->>'epoch')::integer,NULLIF($1::jsonb->'catalog','null'::jsonb),($1::jsonb->>'power')::integer,($1::jsonb->>'verified')::timestamptz) ON CONFLICT(instance_id) DO UPDATE SET attachment_generation=EXCLUDED.attachment_generation,observation_epoch=EXCLUDED.observation_epoch,catalog=EXCLUDED.catalog,catalog_power_epoch=EXCLUDED.catalog_power_epoch,verified_at=EXCLUDED.verified_at RETURNING to_jsonb(cantrip_os_package_targets)::text", &[&value]).await?)?;
            Ok(json!({"instance":i,"target":targets[0]}))
        })).await
    }
    pub async fn package_record_target(
        &self,
        owner: &str,
        context: &Value,
        raw: Value,
    ) -> Result<Value> {
        let mut catalog = checked("cantripOsPackageCatalogResultSchema", raw)?;
        let expected = &catalog["target"]["expected"];
        ensure!(
            expected["ownerId"] == owner
                && expected["workerId"] == context["instance"]["worker_id"]
                && expected["guestInstanceId"] == context["instance"]["guest_instance_id"],
            "The package observation belongs to another OS attachment."
        );
        let (owner, context) = (owner.to_owned(), context.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let instance = text(&context["instance"], "id")?;
            let rows = decode(tx.query(OWNED, &[&owner, &instance]).await?)?;
            let i = rows.first().context(crate::cantrip_os::PlacementError("Owned OS attachment not found."))?;
            let targets = decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_package_targets p WHERE instance_id=$1", &[&instance]).await?)?;
            let p = targets.first().context("Package observation not found.")?;
            ensure!(i["attachment_generation"] == context["instance"]["attachment_generation"] && i["worker_id"] == context["instance"]["worker_id"] && i["guest_instance_id"] == context["instance"]["guest_instance_id"] && i["power_epoch"] == context["instance"]["power_epoch"] && p["attachment_generation"] == i["attachment_generation"] && p["observation_epoch"] == context["target"]["observation_epoch"], "The package observation changed before its target was recorded.");
            let mut actual = catalog["target"].clone();
            actual.as_object_mut().context("Package target")?.remove("generation");
            let mut previous = p["catalog"]["target"].clone();
            if let Some(fields) = previous.as_object_mut() { fields.remove("generation"); }
            let generation = if p["catalog_power_epoch"] == i["power_epoch"] && actual == previous {
                text(&p["catalog"]["target"], "generation")?.to_owned()
            } else { uuid() };
            catalog["target"]["generation"] = json!(generation);
            let value = Json(catalog);
            let epoch = i["power_epoch"].as_i64().context("Package power epoch")?;
            let saved = decode(tx.query("UPDATE cantrip_os_package_targets SET catalog=$2,catalog_power_epoch=$3::bigint,verified_at=now() WHERE instance_id=$1 RETURNING to_jsonb(cantrip_os_package_targets)::text", &[&instance, &value, &epoch]).await?)?;
            Ok(saved[0].clone())
        })).await
    }
    pub async fn package_get(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        Ok(self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_package_operations o WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3", &[&owner, &instance, &id]).await?.into_iter().next())
    }
    pub async fn package_admit(
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
            checked("cantripOsPackageCreateSchema", input.clone())?,
        );
        self.database.transaction(|tx| Box::pin(async move {
            let rows = decode(tx.query(OWNED, &[&owner, &instance]).await?)?;
            let i = rows.first().context(crate::cantrip_os::PlacementError("Owned OS attachment not found."))?;
            let old = decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_package_operations o WHERE operation_id=$1", &[&text(&input,"operationId")?]).await?)?;
            if let Some(old) = old.first() {
                ensure!(old["owner_id"] == owner && old["instance_id"] == instance && old["request"] == input, "This package operation ID belongs to another admission.");
                return Ok((old.clone(),false));
            }
            super::system_common::no_active(tx,&instance,None).await?;
            let targets = decode(tx.query("SELECT to_jsonb(p)::text FROM cantrip_os_package_targets p WHERE instance_id=$1", &[&instance]).await?)?;
            let p = targets.first().context("No verified package target is recorded.")?;
            let catalog = &p["catalog"];
            ensure!(catalog.is_object() && i["attachment_generation"] == input["attachmentGeneration"] && p["attachment_generation"] == input["attachmentGeneration"] && p["catalog_power_epoch"] == i["power_epoch"] && catalog["target"]["generation"] == input["targetGeneration"], "The selected package target changed. Observe actual package status before admitting another operation.");
            let available = catalog["available"].as_array().context("Verified package catalogue")?;
            ensure!(input["packages"].as_array().context("Selected packages")?.iter().all(|artifact|available.contains(artifact)), "A selected package artifact is not in this verified catalogue.");
            let command = checked("cantripOsPackageOperationCommandSchema", json!({"type":"cantrip-os.packages.operation","mode":"execute","operationId":input["operationId"],
                "scope":{"ownerId":owner,"serverId":server,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"]},
                "transport":i["transport"],"target":catalog["target"],"action":input["action"],"configuration":input["configuration"],"packages":input["packages"]}))?;
            let value = Json(json!({"owner":owner,"instance":instance,"worker":i["worker_id"],"epoch":i["power_epoch"].as_i64().context("Package admission epoch")?+1,"input":input,"command":command}));
            let saved = decode(tx.query("INSERT INTO cantrip_os_package_operations(operation_id,owner_id,instance_id,worker_id,attachment_generation,target_generation,admission_epoch,request,command) VALUES($1::jsonb->'input'->>'operationId',$1::jsonb->>'owner',$1::jsonb->>'instance',$1::jsonb->>'worker',$1::jsonb->'input'->>'attachmentGeneration',$1::jsonb->'input'->>'targetGeneration',($1::jsonb->>'epoch')::integer,$1::jsonb->'input',$1::jsonb->'command') RETURNING to_jsonb(cantrip_os_package_operations)::text", &[&value]).await?)?;
            tx.query("UPDATE cantrip_os_instances SET runtime_generation=NULL,status='unknown',last_error=NULL,power_epoch=power_epoch+1,updated_at=now() WHERE id=$1", &[&instance]).await?;
            Ok((saved[0].clone(),true))
        })).await
    }
    pub async fn package_begin(
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
        self.database.transaction(|tx| Box::pin(async move {
            let (attachment, target) = if let Some(control) = &control {
                let rows = decode(tx.query(OWNED, &[&owner, &instance]).await?)?;
                let i = rows.first().context(PlacementError("Owned OS attachment not found."))?;
                let attachment = text(control, "attachmentGeneration")?;
                ensure!(i["attachment_generation"] == attachment, PlacementError("The original package attachment changed; no continuation was dispatched."));
                (Some(attachment), Some(text(control, "targetGeneration")?))
            } else {
                (None, None)
            };
            let rows = decode(tx.query(
                "UPDATE cantrip_os_package_operations SET revision=revision+1
                 WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3
                 AND ($4::text IS NULL OR (attachment_generation=$4 AND target_generation=$5::text))
                 RETURNING to_jsonb(cantrip_os_package_operations)::text",
                &[&owner, &instance, &id, &attachment, &target],
            ).await?)?;
            rows.into_iter().next().context(PlacementError("Package operation not found for the original target."))
        })).await
    }
    pub async fn package_record(&self, owner: &str, original: &Value, raw: Value) -> Result<Value> {
        let result = checked("cantripOsPackageOperationResultSchema", raw)?;
        let terminal = matches!(result["state"].as_str(), Some("ready" | "failed"));
        ensure!(
            result["operationId"] == original["operation_id"]
                && result["targetGeneration"] == original["target_generation"]
                && result["action"] == original["request"]["action"]
                && result["configuration"] == original["request"]["configuration"]
                && (!terminal || !result["protectedResult"].is_null()),
            "Package outcome differs from its immutable admission."
        );
        let (owner, original) = (owner.to_owned(), original.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let instance = text(&original,"instance_id")?;
            let id = text(&original,"operation_id")?;
            tx.query("SELECT id FROM cantrip_os_instances WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[&owner,&instance]).await?;
            let revision = original["revision"].as_i64().context("Package revision")?;
            let payload = Json(result.clone());
            let saved = tx.query("UPDATE cantrip_os_package_operations SET state=$3,result=$4,updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND state NOT IN ('ready','failed') AND ($5 OR revision=$6::bigint) RETURNING operation_id", &[&owner,&id,&text(&result,"state")?,&payload,&terminal,&revision]).await?;
            if !saved.is_empty() && terminal {
                let epoch = original["admission_epoch"].as_i64().context("Package admission epoch")?;
                tx.query("UPDATE cantrip_os_instances SET runtime_generation=NULL,status='unknown',last_error=NULL,power_epoch=power_epoch+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3 AND power_epoch=$4::bigint", &[&owner,&instance,&text(&original,"attachment_generation")?,&epoch]).await?;
            }
            let rows = decode(tx.query("SELECT to_jsonb(o)::text FROM cantrip_os_package_operations o WHERE owner_id=$1 AND operation_id=$2", &[&owner,&id]).await?)?;
            Ok(rows.first().context(crate::cantrip_os::PlacementError("Package operation not found."))?.clone())
        })).await
    }
    pub async fn package_unknown(&self, owner: &str, row: &Value) -> Result<Value> {
        self.database.query("UPDATE cantrip_os_package_operations SET state='unknown',updated_at=now() WHERE owner_id=$1 AND operation_id=$2 AND revision=$3::bigint AND state NOT IN ('ready','failed')", &[&owner,&text(row,"operation_id")?,&row["revision"].as_i64().context("Package revision")?]).await?;
        self.package_get(owner, text(row, "instance_id")?, text(row, "operation_id")?)
            .await?
            .context(crate::cantrip_os::PlacementError(
                "Package operation not found.",
            ))
    }
    pub async fn package_list(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<(Vec<Value>, Option<String>)> {
        ensure!(!self.rows("SELECT to_jsonb(i)::text FROM cantrip_os_instances i WHERE owner_id=$1 AND id=$2", &[&owner,&instance]).await?.is_empty(),crate::cantrip_os::PlacementError("OS attachment not found."));
        let cursor = input["cursor"].as_str().map(str::to_owned);
        if let Some(cursor) = &cursor {
            self.package_get(owner, instance, cursor).await?.context(
                crate::cantrip_os::PlacementError("Package history cursor not found."),
            )?;
        }
        let limit = input["limit"].as_i64().context("Package history limit")?;
        let mut rows = self.rows("SELECT to_jsonb(o)::text FROM cantrip_os_package_operations o WHERE owner_id=$1 AND instance_id=$2 AND ($3::text IS NULL OR (created_at,operation_id)<(SELECT created_at,operation_id FROM cantrip_os_package_operations WHERE owner_id=$1 AND instance_id=$2 AND operation_id=$3)) ORDER BY created_at DESC,operation_id DESC LIMIT $4", &[&owner,&instance,&cursor,&(limit+1)]).await?;
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
