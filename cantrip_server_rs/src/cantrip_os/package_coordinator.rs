use super::Coordinator;
use crate::cantrip_os::{checked, text};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::time::Duration;

fn date(row: &Value, key: &str) -> Result<String> {
    Ok(chrono::DateTime::parse_from_rfc3339(text(row, key)?)?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
impl Coordinator {
    fn package_summary(&self, row: &Value) -> Result<Value> {
        let result = &row["result"];
        checked(
            "cantripOsPackageSummarySchema",
            json!({
                "operationId":row["operation_id"],"instanceId":row["instance_id"],"workerId":row["worker_id"],
                "attachmentGeneration":row["attachment_generation"],"targetGeneration":row["target_generation"],
                "action":row["request"]["action"],"configuration":row["request"]["configuration"],"packages":row["request"]["packages"],
                "state":row["state"],"phase":result["phase"].as_str().unwrap_or("admitted"),
                "createdAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?,"protectedResult":result["protectedResult"],
                "error":if !result["error"].is_null(){result["error"].clone()}else if row["state"]=="unknown"{json!("Package delivery is unknown. Observe the original operation; no installation was repeated.")}else{Value::Null}
            }),
        )
    }
    pub async fn package_status(&self, owner: &str, instance: &str) -> Result<Value> {
        let context = self
            .repository
            .package_begin_status(owner, instance)
            .await?;
        let observed: Result<Value> = async {
            let i = &context["instance"];
            self.repository.owned_worker(owner,text(i,"worker_id")?).await?;
            let mut command = json!({"type":"cantrip-os.packages.status",
                "scope":{"ownerId":owner,"serverId":self.service.server_id,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"]},
                "transport":i["transport"]});
            if context["target"]["catalog"]["target"].is_object() {command["target"]=context["target"]["catalog"]["target"].clone();}
            let command = checked("cantripOsPackageWorkerCommandSchema",command)?;
            let result = self.request_with_timeout(text(i,"worker_id")?,command,"cantripOsPackageCatalogResultSchema",Duration::from_secs(180)).await?;
            let target = self.repository.package_record_target(owner,&context,result).await?;
            let catalog = &target["catalog"];
            checked("cantripOsPackageStatusSchema",json!({
                "target":{"generation":catalog["target"]["generation"],"instanceId":instance,"workerId":i["worker_id"],"attachmentGeneration":target["attachment_generation"],"architecture":catalog["target"]["architecture"],"verifiedAt":date(&target,"verified_at")?},
                "installed":catalog["installed"],"available":catalog["available"],"unavailable":catalog["unavailable"],"error":null
            }))
        }.await;
        match observed {
            Ok(value) => Ok(value),
            Err(_) => checked(
                "cantripOsPackageStatusSchema",
                json!({"target":null,"installed":[],"available":[],"unavailable":0,"error":"Package status could not be observed. Check the owning Worker's Docker/SSH connection; no installation was dispatched."}),
            ),
        }
    }
    pub async fn package_create(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<Value> {
        let (row, created) = self
            .repository
            .package_admit(owner, instance, &self.service.server_id, input)
            .await?;
        let row = if created {
            row
        } else {
            self.repository
                .package_begin(owner, instance, text(&row, "operation_id")?, None)
                .await?
        };
        self.package_dispatch(owner, row, if created { "execute" } else { "observe" })
            .await
    }
    pub async fn package_observe(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.package_dispatch(
            owner,
            self.repository
                .package_begin(owner, instance, id, None)
                .await?,
            "observe",
        )
        .await
    }
    pub async fn package_control(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
        mode: &str,
        input: &Value,
    ) -> Result<Value> {
        ensure!(
            matches!(mode, "continue" | "abandon"),
            "Invalid package control."
        );
        self.package_dispatch(
            owner,
            self.repository
                .package_begin(owner, instance, id, Some(input))
                .await?,
            mode,
        )
        .await
    }
    pub async fn package_get(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.package_summary(
            &self
                .repository
                .package_get(owner, instance, id)
                .await?
                .context("Package operation not found.")?,
        )
    }
    pub async fn package_list(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (rows, next) = self.repository.package_list(owner, instance, input).await?;
        let items = rows
            .iter()
            .map(|row| self.package_summary(row))
            .collect::<Result<Vec<_>>>()?;
        checked(
            "cantripOsPackagePageSchema",
            json!({"items":items,"nextCursor":next}),
        )
    }
    async fn package_dispatch(&self, owner: &str, row: Value, mode: &str) -> Result<Value> {
        if matches!(row["state"].as_str(), Some("ready" | "failed")) {
            return self.package_summary(&row);
        }
        let outcome: Result<Value> = async {
            self.repository
                .owned_worker(owner, text(&row, "worker_id")?)
                .await?;
            let mut command = row["command"].clone();
            command["mode"] = json!(mode);
            let command = checked("cantripOsPackageWorkerCommandSchema", command)?;
            let result = self
                .request_with_timeout(
                    text(&row, "worker_id")?,
                    command,
                    "cantripOsPackageOperationResultSchema",
                    Duration::from_secs(180),
                )
                .await?;
            self.repository.package_record(owner, &row, result).await
        }
        .await;
        let saved = match outcome {
            Ok(saved) => saved,
            Err(_) => self.repository.package_unknown(owner, &row).await?,
        };
        self.package_summary(&saved)
    }
}
