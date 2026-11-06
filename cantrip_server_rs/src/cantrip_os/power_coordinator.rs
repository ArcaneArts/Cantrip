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
fn public_state(value: &Value) -> Value {
    let mut state = value.clone();
    if let Some(fields) = state.as_object_mut() {
        fields.remove("containerId");
    }
    state
}
impl Coordinator {
    fn power_summary(&self, row: &Value) -> Result<Value> {
        let result = &row["result"];
        checked(
            "cantripOsPowerSummarySchema",
            json!({
                "operationId":row["operation_id"],"instanceId":row["instance_id"],"workerId":row["worker_id"],
                "attachmentGeneration":row["attachment_generation"],"targetGeneration":row["target_generation"],
                "action":row["action"],"state":row["state"],"createdAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?,
                "error":if !result["error"].is_null(){result["error"].clone()}else if row["state"]=="unknown"{json!("Power delivery is unknown. Observe this original operation before continuing.")}else{Value::Null},
                "completionEvidence":result["receipt"]["completionEvidence"],"powerState":public_state(&result["observation"])
            }),
        )
    }
    pub async fn power_status(&self, owner: &str, instance: &str) -> Result<Value> {
        let context = self.repository.power_context(owner, instance).await?;
        let (i, p) = (&context["instance"], &context["target"]);
        if p.is_null() {
            return checked(
                "cantripOsPowerStatusSchema",
                json!({"target":null,"observation":null,"error":if i["transport"]["kind"]=="ssh"{"SSH attachment does not provide a powered-off machine control path."}else{"No verified local Docker power target is recorded for this attachment."}}),
            );
        }
        let target = checked(
            "cantripOsPowerTargetSummarySchema",
            json!({"kind":"docker","generation":p["generation"],"instanceId":instance,"workerId":i["worker_id"],"attachmentGeneration":p["attachment_generation"],"verifiedAt":date(p,"verified_at")?}),
        )?;
        let observed:Result<Value>=async{
            self.repository.owned_worker(owner,text(i,"worker_id")?).await?;
            let command=checked("cantripOsPowerWorkerCommandSchema",json!({"type":"cantrip-os.power.status",
                "scope":{"ownerId":owner,"serverId":self.service.server_id,"workerId":i["worker_id"],"instanceId":instance,"guestInstanceId":i["guest_instance_id"],"attachmentGeneration":i["attachment_generation"],"runtimeGeneration":p["runtime_generation"]},
                "transport":i["transport"],"powerTarget":{"kind":"docker","generation":p["generation"],"containerId":p["container_id"]}}))?;
            let value=self.request(text(i,"worker_id")?,command,"cantripOsPowerObservationSchema").await?;
            ensure!(value["containerId"]==p["container_id"],"Power status came from another container.");
            Ok(public_state(&value))
        }.await;
        match observed {
            Ok(value) => checked(
                "cantripOsPowerStatusSchema",
                json!({"target":target,"observation":value,"error":null}),
            ),
            Err(_) => checked(
                "cantripOsPowerStatusSchema",
                json!({"target":target,"observation":null,"error":"The power carrier could not be observed. Check Worker diagnostics."}),
            ),
        }
    }
    pub async fn power_create(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (row, created) = self
            .repository
            .power_admit(owner, instance, &self.service.server_id, input)
            .await?;
        let row = if created {
            row
        } else {
            self.repository
                .power_begin(owner, instance, text(&row, "operation_id")?)
                .await?
        };
        self.power_dispatch(owner, row, created).await
    }
    pub async fn power_observe(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.power_dispatch(
            owner,
            self.repository.power_begin(owner, instance, id).await?,
            false,
        )
        .await
    }
    pub async fn power_get(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.power_summary(
            &self
                .repository
                .power_get(owner, instance, id)
                .await?
                .context("Power operation not found.")?,
        )
    }
    pub async fn power_list(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (rows, next) = self.repository.power_list(owner, instance, input).await?;
        let items = rows
            .iter()
            .map(|row| self.power_summary(row))
            .collect::<Result<Vec<_>>>()?;
        checked(
            "cantripOsPowerPageSchema",
            json!({"items":items,"nextCursor":next}),
        )
    }
    async fn power_dispatch(&self, owner: &str, row: Value, execute: bool) -> Result<Value> {
        let outcome: Result<Value> = async {
            self.repository
                .owned_worker(owner, text(&row, "worker_id")?)
                .await?;
            let mut command = row["command"].clone();
            command["mode"] = json!(if execute { "execute" } else { "observe" });
            let command = checked("cantripOsPowerWorkerCommandSchema", command)?;
            let result = self
                .request_with_timeout(
                    text(&row, "worker_id")?,
                    command,
                    "cantripOsPowerOperationResultSchema",
                    Duration::from_secs(180),
                )
                .await?;
            self.repository.power_record(owner, &row, result).await
        }
        .await;
        let saved = match outcome {
            Ok(saved) => saved,
            Err(_) => self.repository.power_unknown(owner, &row).await?,
        };
        self.power_summary(&saved)
    }
}
