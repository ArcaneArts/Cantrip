use super::Coordinator;
use crate::cantrip_os::{checked, text};
use crate::workers::command_bus::RequestTimeout;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

impl Coordinator {
    fn backup_summary(&self, row: &Value) -> Result<Value> {
        let connected = self
            .service
            .workers
            .bridge
            .is_connected(text(row, "worker_id")?);
        let date = |key: &str| -> Result<String> {
            Ok(chrono::DateTime::parse_from_rfc3339(text(row, key)?)?
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        };
        checked(
            "cantripOsBackupSummarySchema",
            json!({
                "operationId":row["operation_id"],"action":row["action"],"instanceId":row["instance_id"],"workspaceId":row["workspace_id"],"workerId":row["worker_id"],
                "backupId":row["backup_id"],"restoreOperationId":row["restore_operation_id"],"protectedRequest":row["request"]["protectedRequest"],"result":row["result"],
                "workerConnected":connected,"archiveAvailability":if row["action"]=="capture" {json!(if connected {"not-checked"} else {"worker-offline"})} else {Value::Null},
                "createdAt":date("created_at")?,"updatedAt":date("updated_at")?
            }),
        )
    }
    pub async fn backup_list(&self, owner: &str, input: &Value, captures: bool) -> Result<Value> {
        let (rows, next) = self.repository.backup_list(owner, input, captures).await?;
        let items = rows
            .iter()
            .map(|row| self.backup_summary(row))
            .collect::<Result<Vec<_>>>()?;
        checked(
            "cantripOsBackupPageSchema",
            json!({"items":items,"nextCursor":next}),
        )
    }
    pub async fn backup_get(&self, owner: &str, id: &str) -> Result<Value> {
        self.backup_summary(&self.repository.backup_get(owner, id).await?.context(
            crate::cantrip_os::PlacementError("Backup operation not found."),
        )?)
    }
    pub async fn backup_admit(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (row, created) = self
            .repository
            .backup_admit(owner, instance, &self.service.server_id, input)
            .await?;
        self.backup_dispatch(
            owner,
            text(&row, "operation_id")?,
            if created { "new" } else { "observe" },
            None,
        )
        .await
    }
    pub async fn backup_recover(&self, owner: &str, id: &str, input: &Value) -> Result<Value> {
        self.backup_dispatch(owner, id, text(input, "mode")?, Some(input))
            .await
    }
    async fn backup_dispatch(
        &self,
        owner: &str,
        id: &str,
        mode: &str,
        input: Option<&Value>,
    ) -> Result<Value> {
        let row = if mode == "continue" {
            self.repository
                .backup_authorize(
                    owner,
                    id,
                    &self.service.server_id,
                    input.context("Continuation authority")?,
                )
                .await?
        } else {
            self.repository.backup_begin(owner, id).await?
        };
        let mut command = if mode == "new" {
            row["command"].clone()
        } else {
            json!({"type":"cantrip-os.backup.observe","operationId":id,"scope":row["command"]["scope"],"action":row["action"],"mode":mode})
        };
        if mode == "continue" {
            command["continuationScope"] = row["continuation_scope"].clone();
        }
        let observed: Result<Value> = async {
            let reply = self
                .service
                .workers
                .commands
                .request_with_timeout(
                    text(&row, "worker_id")?,
                    crate::wire::Value::from_serialize(&command),
                    RequestTimeout::Disabled,
                    None,
                )
                .await?;
            let parsed = crate::settings::parse_response(
                "cantripOsBackupOperationResultSchema",
                reply.as_ref(),
            )?;
            let result: Value = serde_json::from_str(&parsed.stringify())?;
            ensure!(
                result["operationId"] == id && result["action"] == row["action"],
                "The backup response was misrouted."
            );
            Ok(result)
        }
        .await;
        let result = match observed {
            Ok(value) => value,
            Err(_) => {
                json!({"operationId":id,"action":row["action"],"state":"unknown","phase":"recovery-required","protectedResult":null,"startedAt":chrono::DateTime::parse_from_rfc3339(text(&row,"created_at")?)?.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"updatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"error":"Backup delivery is uncertain. Observe the original admission; its mutation was not replayed."})
            }
        };
        self.backup_summary(&self.repository.backup_record(owner, &row, result).await?)
    }
}
