use super::Coordinator;
use crate::cantrip_os::{
    checked, summary as instance_summary,
    system_common::{scope, status, summary},
    text,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::time::Duration;
impl Coordinator {
    pub async fn system_status(&self, owner: &str, instance: &str) -> Result<Value> {
        let context = self.repository.system_begin_status(owner, instance).await?;
        let observed: Result<Value>=async {
            let i=&context["instance"];self.repository.owned_worker(owner,text(i,"worker_id")?).await?;
            let mut command=json!({"type":"cantrip-os.system.status","scope":scope(i,&self.service.server_id),"transport":i["transport"]});
            if context["target"]["catalog"]["target"].is_object() {command["target"]=context["target"]["catalog"]["target"].clone();}
            let command=checked("cantripOsSystemWorkerCommandSchema",command)?;
            let raw=self.request_with_timeout(text(i,"worker_id")?,command,"cantripOsSystemStatusResultSchema",Duration::from_secs(180)).await?;
            let target=self.repository.system_record_target(owner,&context,raw).await?;
            status(i,&target)
        }.await;
        match observed {
            Ok(value) => Ok(value),
            Err(_) => checked(
                "cantripOsSystemStatusSchema",
                json!({"supported":context["instance"]["transport"]["kind"]=="docker","target":null,"bases":[],"error":"System status could not be observed. Check the owning Worker's Docker management connection; no system transition was dispatched."}),
            ),
        }
    }
    pub async fn system_create(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (row, created) = self
            .repository
            .system_admit(owner, instance, &self.service.server_id, input)
            .await?;
        let row = if created {
            row
        } else {
            self.repository
                .system_begin(owner, instance, text(&row, "operation_id")?, None)
                .await?
        };
        self.system_dispatch(owner, row, if created { "execute" } else { "observe" })
            .await
    }
    pub async fn system_observe(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        self.system_dispatch(
            owner,
            self.repository
                .system_begin(owner, instance, id, None)
                .await?,
            "observe",
        )
        .await
    }
    pub async fn system_control(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
        mode: &str,
        input: &Value,
    ) -> Result<Value> {
        ensure!(
            matches!(mode, "continue" | "recover" | "abandon"),
            "Invalid system control."
        );
        if mode == "recover" {
            return self.system_recover(owner, instance, id, input).await;
        }
        if mode == "abandon" {
            let row = self
                .repository
                .system_begin(owner, instance, id, Some(input))
                .await?;
            let closed = self.repository.system_reject(owner, &row).await?;
            ensure!(
                closed["state"] == "rejected",
                "System execution was already dispatched; observe its original outcome instead."
            );
            return summary(&closed);
        }
        self.system_dispatch(
            owner,
            self.repository
                .system_begin(owner, instance, id, Some(input))
                .await?,
            "continue",
        )
        .await
    }
    pub async fn system_get(&self, owner: &str, instance: &str, id: &str) -> Result<Value> {
        summary(
            &self
                .repository
                .system_get(owner, instance, id)
                .await?
                .context(crate::cantrip_os::PlacementError(
                    "System operation not found.",
                ))?,
        )
    }
    pub async fn system_list(&self, owner: &str, instance: &str, input: &Value) -> Result<Value> {
        let (rows, next) = self.repository.system_list(owner, instance, input).await?;
        let items = rows.iter().map(summary).collect::<Result<Vec<_>>>()?;
        checked(
            "cantripOsSystemPageSchema",
            json!({"items":items,"nextCursor":next}),
        )
    }
    async fn system_dispatch(&self, owner: &str, mut row: Value, mode: &str) -> Result<Value> {
        if matches!(row["state"].as_str(), Some("ready" | "failed" | "rejected")) {
            return summary(&row);
        }
        if self
            .repository
            .owned_worker(owner, text(&row, "worker_id")?)
            .await
            .is_err()
        {
            return summary(
                &if mode != "observe" && row["dispatch_stage"] == "preparing" {
                    self.repository.system_reject(owner, &row).await?
                } else {
                    self.repository.system_unknown(owner, &row).await?
                },
            );
        }
        let outcome: Result<Value> = async {
            let mut effective = if mode == "observe" {
                "observe"
            } else {
                "continue"
            };
            if mode != "observe" && row["dispatch_stage"] == "preparing" {
                let mut prepare = row["command"].clone();
                prepare["mode"] = json!("prepare");
                let prepare = checked("cantripOsSystemWorkerCommandSchema", prepare)?;
                let result = self
                    .request_with_timeout(
                        text(&row, "worker_id")?,
                        prepare,
                        "cantripOsSystemOperationResultSchema",
                        Duration::from_secs(180),
                    )
                    .await?;
                row = self.repository.system_record(owner, &row, result).await?;
                if matches!(row["state"].as_str(), Some("ready" | "failed" | "rejected")) {
                    return Ok(row.clone());
                }
                let (armed, created) = self.repository.system_begin_execution(owner, &row).await?;
                row = armed;
                if !created {
                    effective = "observe";
                }
            }
            let mut command = row["command"].clone();
            command["mode"] = json!(effective);
            let command = checked("cantripOsSystemWorkerCommandSchema", command)?;
            let raw = self
                .request_with_timeout(
                    text(&row, "worker_id")?,
                    command,
                    "cantripOsSystemOperationResultSchema",
                    Duration::from_secs(180),
                )
                .await?;
            self.repository.system_record(owner, &row, raw).await
        }
        .await;
        let saved = match outcome {
            Ok(value) => value,
            Err(error)
                if mode != "observe"
                    && row["dispatch_stage"] == "preparing"
                    && error
                        .chain()
                        .filter_map(|cause| {
                            cause.downcast_ref::<crate::workers::bridge::CommandError>()
                        })
                        .any(|e| {
                            e.unavailable && e.code.as_deref() == Some("worker-command-not-sent")
                        }) =>
            {
                self.repository.system_reject(owner, &row).await?
            }
            Err(_) => self.repository.system_unknown(owner, &row).await?,
        };
        summary(&saved)
    }
    async fn system_recover(
        &self,
        owner: &str,
        instance: &str,
        id: &str,
        input: &Value,
    ) -> Result<Value> {
        let context = self
            .repository
            .system_begin_recovery(owner, instance, id, input)
            .await?;
        let (i, op) = (&context["instance"], &context["operation"]);
        if context["recovered"] == true {
            return instance_summary(i, "instance", None);
        }
        let worker = text(op, "worker_id")?;
        self.repository.owned_worker(owner, worker).await?;
        let command = checked(
            "cantripOsSystemWorkerCommandSchema",
            json!({"type":"cantrip-os.system.status","scope":scope(i,&self.service.server_id),"transport":i["transport"],"target":op["command"]["target"],"recovery":{"operationId":op["operation_id"],"scope":op["command"]["scope"],"targetGeneration":op["target_generation"]}}),
        )?;
        let mut raw = self
            .request_with_timeout(
                worker,
                command.clone(),
                "cantripOsSystemStatusResultSchema",
                Duration::from_secs(180),
            )
            .await?;
        if raw["enrollment"].is_object() {
            ensure!(
                raw["enrollment"]["containerId"] == op["result"]["root"]["targetContainerId"],
                "The enrollment candidate differs from the completed physical root."
            );
            let transport = json!({"kind":"docker","container":raw["enrollment"]["containerId"]});
            let inspect = checked(
                "workerCommandSchema",
                json!({"type":"cantrip-os.inspect","ownerId":owner,"workerId":worker,"transport":transport}),
            )?;
            let observed = self
                .request_with_timeout(
                    worker,
                    inspect,
                    "cantripOsObservedInstanceSchema",
                    Duration::from_secs(180),
                )
                .await?;
            ensure!(
                observed["guestInstanceId"] == raw["enrollment"]["guestInstanceId"],
                "The enrollment candidate's guest identity changed."
            );
            ensure!(
                observed["attachment"].is_null()
                    || (observed["attachment"]["ownerId"] == owner
                        && observed["attachment"]["workerId"] == worker),
                "The resulting system belongs to another attachment."
            );
            if observed["attachment"].is_null() {
                let mut current = scope(i, &self.service.server_id);
                current["guestInstanceId"] = observed["guestInstanceId"].clone();
                current["runtimeGeneration"] = observed["runtimeGeneration"].clone();
                let attach = checked(
                    "workerCommandSchema",
                    json!({"type":"cantrip-os.attach","transport":transport,"scope":current}),
                )?;
                self.request_with_timeout(
                    worker,
                    attach,
                    "cantripOsObservedInstanceSchema",
                    Duration::from_secs(180),
                )
                .await?;
            }
            raw = self
                .request_with_timeout(
                    worker,
                    command,
                    "cantripOsSystemStatusResultSchema",
                    Duration::from_secs(180),
                )
                .await?;
        }
        let adopted = self.repository.system_adopt(owner, &context, raw).await?;
        instance_summary(&adopted, "instance", None)
    }
}
