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
fn result(row: &Value) -> Result<Value> {
    if !row["result"].is_null() {
        return Ok(row["result"].clone());
    }
    checked(
        "cantripOsOperationResultSchema",
        json!({"operationId":row["operation_id"],"state":"unknown","startedAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?,"receipt":null,"error":"Workspace creation has no verified outcome. Observe this original operation; creation was not repeated."}),
    )
}
fn summary(row: &Value) -> Result<Value> {
    checked(
        "cantripOsWorkspaceOperationSummarySchema",
        json!({"operationId":row["operation_id"],"instanceId":row["instance_id"],"workerId":row["worker_id"],"guestWorkspaceId":row["guest_workspace_id"],"attachmentGeneration":row["attachment_generation"],"runtimeGeneration":row["runtime_generation"],"state":row["state"],"result":row["result"],"createdAt":date(row,"created_at")?,"updatedAt":date(row,"updated_at")?}),
    )
}
impl Coordinator {
    pub async fn create_workspace(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<Value> {
        let (row, created) = self
            .repository
            .workspace_operation_admit(owner, instance, &self.service.server_id, input)
            .await?;
        let row = if created {
            row
        } else {
            self.repository
                .workspace_operation_begin(owner, instance, text(input, "operationId")?)
                .await?
        };
        self.workspace_operation_dispatch(row, created).await
    }
    pub async fn workspace_operation_observe(
        &self,
        owner: &str,
        instance: &str,
        operation: &str,
    ) -> Result<Value> {
        self.workspace_operation_dispatch(
            self.repository
                .workspace_operation_begin(owner, instance, operation)
                .await?,
            false,
        )
        .await
    }
    pub async fn workspace_operation_get(
        &self,
        owner: &str,
        instance: &str,
        operation: &str,
    ) -> Result<Value> {
        summary(
            &self
                .repository
                .workspace_operation_get(owner, instance, operation)
                .await?
                .context("Workspace operation not found.")?,
        )
    }
    pub async fn workspace_operation_list(
        &self,
        owner: &str,
        instance: &str,
        input: &Value,
    ) -> Result<Value> {
        let (rows, next) = self
            .repository
            .workspace_operation_list(owner, instance, input)
            .await?;
        checked(
            "cantripOsWorkspaceOperationPageSchema",
            json!({"items":rows.iter().map(summary).collect::<Result<Vec<_>>>()?,"nextCursor":next}),
        )
    }
    async fn workspace_operation_dispatch(&self, row: Value, execute: bool) -> Result<Value> {
        if ["ready", "failed"].iter().any(|s| row["state"] == *s) {
            return result(&row);
        }
        let outcome:Result<Value>=async {
            ensure!(row["command"]["scope"]["serverId"]==self.service.server_id,"The operation belongs to another Server.");
            self.repository.owned_worker(text(&row,"owner_id")?,text(&row,"worker_id")?).await?;
            let command=if execute {row["command"].clone()}else{json!({"type":"cantrip-os.operation.inspect","scope":row["command"]["scope"],"operationId":row["operation_id"]})};
            let actual=self.request_with_timeout(text(&row,"worker_id")?,command,"cantripOsOperationResultSchema",Duration::from_secs(180)).await?;
            self.repository.workspace_operation_record(&row,actual).await
        }.await;
        let saved = match outcome {
            Ok(saved) => saved,
            Err(_) => self.repository.workspace_operation_unknown(&row).await?,
        };
        result(&saved)
    }
}
