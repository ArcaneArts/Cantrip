use super::Coordinator;
use crate::cantrip_os::{checked, text};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::time::Duration;

fn date(row: &Value, key: &str) -> Result<String> {
    Ok(chrono::DateTime::parse_from_rfc3339(text(row, key)?)?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
impl Coordinator {
    fn desktop_summary(&self, row: &Value) -> Result<Value> {
        let result = &row["result"];
        checked(
            "cantripOsDesktopSummarySchema",
            json!({
                "operationId":row["operation_id"],"instanceId":row["instance_id"],"workspaceId":row["workspace_id"],"runtimeGeneration":row["runtime_generation"],"workerId":row["worker_id"],
                "attachmentGeneration":row["attachment_generation"],"targetGeneration":row["target_generation"],
                "action":row["action"],"state":row["state"],"createdAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?,
                "error":if !result["error"].is_null(){result["error"].clone()}else if row["state"]=="unknown"{json!("Desktop delivery is unknown. Observe this original operation before continuing.")}else{Value::Null},
                "completionEvidence":result["receipt"]["completionEvidence"]
            }),
        )
    }
    pub async fn desktop_status(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
    ) -> Result<Value> {
        let context = self
            .repository
            .desktop_context(owner, instance, workspace)
            .await?;
        let i = &context["instance"];
        let w = &context["workspace"];
        let observed:Result<Value>=async {
            self.repository.owned_worker(owner,text(i,"worker_id")?).await?;
            let command=checked("cantripOsDesktopWorkerCommandSchema",json!({"type":"cantrip-os.desktop.status","scope":crate::cantrip_os::desktop::scope(owner,&self.service.server_id,i,w)?,"transport":i["transport"]}))?;
            let actual=self.request_with_timeout(text(i,"worker_id")?,command,"cantripOsGuestDesktopTargetSchema",Duration::from_secs(180)).await?;
            let p=self.repository.record_desktop_target(owner,&context,actual.clone()).await?;
            checked("cantripOsDesktopStatusSchema",json!({"target":{"generation":p["generation"],"instanceId":instance,"workspaceId":workspace,"workerId":i["worker_id"],"attachmentGeneration":p["attachment_generation"],"runtimeGeneration":p["runtime_generation"],"verifiedAt":date(&p,"verified_at")?},"observation":{"status":actual["status"]},"error":null}))
        }.await;
        match observed {
            Ok(value) => Ok(value),
            Err(_) => checked(
                "cantripOsDesktopStatusSchema",
                json!({"target":null,"observation":null,"error":"The captured desktop could not be observed. Check recovery and Worker diagnostics; no operation was dispatched."}),
            ),
        }
    }
    pub async fn desktop_create(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Value> {
        let (row, created) = self
            .repository
            .desktop_admit(owner, instance, workspace, &self.service.server_id, input)
            .await?;
        let row = if created {
            row
        } else {
            self.repository
                .desktop_begin(owner, instance, workspace, text(&row, "operation_id")?)
                .await?
        };
        self.desktop_dispatch(owner, row, created).await
    }
    pub async fn desktop_observe(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Value> {
        self.desktop_dispatch(
            owner,
            self.repository
                .desktop_begin(owner, instance, workspace, id)
                .await?,
            false,
        )
        .await
    }
    pub async fn desktop_get(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Value> {
        self.desktop_summary(
            &self
                .repository
                .desktop_get(owner, instance, workspace, id)
                .await?
                .context("Desktop operation not found.")?,
        )
    }
    pub async fn desktop_list(
        &self,
        owner: &str,
        instance: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Value> {
        let (rows, next) = self
            .repository
            .desktop_list(owner, instance, workspace, input)
            .await?;
        let items = rows
            .iter()
            .map(|row| self.desktop_summary(row))
            .collect::<Result<Vec<_>>>()?;
        checked(
            "cantripOsDesktopPageSchema",
            json!({"items":items,"nextCursor":next}),
        )
    }
    async fn desktop_dispatch(&self, owner: &str, row: Value, execute: bool) -> Result<Value> {
        let outcome: Result<Value> = async {
            self.repository
                .owned_worker(owner, text(&row, "worker_id")?)
                .await?;
            let mut command = row["command"].clone();
            command["mode"] = json!(if execute { "execute" } else { "observe" });
            let command = checked("cantripOsDesktopWorkerCommandSchema", command)?;
            let result = self
                .request_with_timeout(
                    text(&row, "worker_id")?,
                    command,
                    "cantripOsDesktopOperationResultSchema",
                    Duration::from_secs(180),
                )
                .await?;
            self.repository.desktop_record(owner, &row, result).await
        }
        .await;
        let saved = match outcome {
            Ok(saved) => saved,
            Err(_) => self.repository.desktop_unknown(owner, &row).await?,
        };
        self.desktop_summary(&saved)
    }
}
