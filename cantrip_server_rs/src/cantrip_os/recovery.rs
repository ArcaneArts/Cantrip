use super::{Repository, checked, coordinator::Coordinator, summary, text};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Coordinator {
    /// Observe an exact attachment without replaying work or moving any chat.
    pub async fn recover_instance(&self, owner: &str, id: &str, expected: &Value) -> Result<Value> {
        let attachment = self.repository.attachment(owner, id).await?;
        let instance = &attachment["instance"];
        ensure!(
            instance["attachmentGeneration"] == expected["attachmentGeneration"]
                && instance["runtimeGeneration"] == expected["runtimeGeneration"],
            "The selected OS attachment changed. Refresh the instance list before checking recovery."
        );
        let worker = text(instance, "workerId")?;
        let worker_identity = || self.recovery_worker_identity(owner, worker);
        let before = worker_identity();
        let actual = self
            .inspect(
                owner,
                &json!({
                    "workerId": instance["workerId"], "transport": attachment["transport"]
                }),
            )
            .await
            .ok();
        let after = worker_identity();
        let observed_worker = before
            .filter(|before| Some(before) == after.as_ref())
            .map(|identity| identity.process_generation);
        let previous_worker = attachment["workerProcessGeneration"].as_str();
        let worker_continuity = match (previous_worker, observed_worker.as_deref()) {
            (_, None) => "unavailable",
            (None, Some(_)) => "first-observation",
            (Some(previous), Some(actual)) if previous == actual => "same-worker",
            _ => "worker-restarted",
        };
        let matches = actual.as_ref().is_some_and(|actual| {
            actual["guestInstanceId"] == instance["guestInstanceId"]
                && actual["attachment"]["ownerId"] == owner
                && actual["attachment"]["workerId"] == instance["workerId"]
        });
        let (kind, message) = match actual.as_ref() {
            None => (
                "unavailable",
                "The OS could not be verified through its Worker. Saved work remains recorded; check the connection and observe again before retrying work.",
            ),
            Some(_) if !matches => (
                "identity-changed",
                "This connection reaches a different OS identity or attachment. The existing workspace was preserved; explicitly attach the intended instance.",
            ),
            Some(_) if instance["runtimeGeneration"].is_null() => (
                "first-observation",
                "The OS is verified. Verify the intended project source before opening work.",
            ),
            Some(actual) if actual["runtimeGeneration"] == instance["runtimeGeneration"] => (
                "same-runtime",
                "The same OS runtime is verified. Existing captured targets still require their own current authorization; unfinished operations must be observed before retrying.",
            ),
            Some(_) => (
                "runtime-changed",
                "The OS runtime changed. Verify retained project files, then create a new Linux agent or desktop view. Existing chats and old handles keep their original placement.",
            ),
        };
        let worker_message = match worker_continuity {
            "same-worker" => "The same Worker process was verified.",
            "worker-restarted" => {
                "The Worker process restarted. Observe previously admitted guest work before deciding whether to launch new work."
            }
            "first-observation" => {
                "This is the first recorded Worker process observation for this attachment."
            }
            _ => "Worker process continuity could not be verified.",
        };
        let message = format!("{message} {worker_message}");
        let observed_runtime = actual
            .as_ref()
            .filter(|_| matches)
            .map(|actual| actual["runtimeGeneration"].clone())
            .unwrap_or(Value::Null);
        if let Some(actual) = actual.as_ref().filter(|_| matches) {
            for workspace in actual["workspaces"]
                .as_array()
                .context("OS workspace observation")?
            {
                self.repository
                    .record_workspace(
                        owner,
                        id,
                        text(instance, "attachmentGeneration")?,
                        workspace,
                    )
                    .await?;
            }
        }
        let mut observed = self
            .repository
            .observe_recovery(
                owner,
                id,
                &json!({
                    "attachment": instance["attachmentGeneration"],
                    "status": if matches { "connected" } else { "unknown" },
                    "runtime": if matches { &observed_runtime } else { &instance["runtimeGeneration"] },
                    "error": if matches { None } else { Some(message.as_str()) },
                    "expectedRuntime": instance["runtimeGeneration"],
                    "expectedWorker": previous_worker,
                    "expectedPowerEpoch": attachment["powerEpoch"],
                    "observedWorker": observed_worker,
                }),
            )
            .await?;
        if let Some(actual) = actual.as_ref().filter(|actual| {
            matches
                && actual["powerTarget"].is_object()
                && attachment["transport"]["kind"] == "docker"
        }) {
            self.repository
                .record_power_target(
                    owner,
                    id,
                    text(instance, "attachmentGeneration")?,
                    text(actual, "runtimeGeneration")?,
                    text(&actual["powerTarget"], "containerId")?,
                    i32::try_from(
                        attachment["powerEpoch"]
                            .as_i64()
                            .context("OS power observation epoch")?,
                    )?,
                )
                .await?;
            observed = self.repository.attachment(owner, id).await?["instance"].clone();
        }
        checked(
            "cantripOsRecoveryResultSchema",
            json!({
                "instance": observed,
                "workspaces": self.repository.workspaces(owner, id).await?,
                "recovery": {
                    "kind": kind, "message": message,
                    "previousRuntimeGeneration": instance["runtimeGeneration"],
                    "observedRuntimeGeneration": observed_runtime,
                    "workerContinuity": worker_continuity,
                    "previousWorkerProcessGeneration": previous_worker,
                    "observedWorkerProcessGeneration": observed_worker
                }
            }),
        )
    }
}

impl Repository {
    /// Compare both historical generations so a late observation cannot
    /// overwrite a newer Worker recovery on an unchanged guest runtime.
    async fn observe_recovery(&self, owner: &str, id: &str, observation: &Value) -> Result<Value> {
        let observation = Json(observation);
        let rows = self.rows("UPDATE cantrip_os_instances SET status=CASE WHEN $3::jsonb->>'status'='connected' AND EXISTS(SELECT 1 FROM cantrip_os_power_operations o JOIN cantrip_os_power_targets p ON p.instance_id=o.instance_id AND p.generation=o.target_generation WHERE o.instance_id=$2 AND o.attachment_generation=$3::jsonb->>'attachment' AND o.state IN ('admitted','running','unknown')) THEN 'unknown' ELSE $3::jsonb->>'status' END, runtime_generation=$3::jsonb->>'runtime', last_error=$3::jsonb->>'error', worker_process_generation=COALESCE($3::jsonb->>'observedWorker',worker_process_generation), last_observed_at=now(), updated_at=now() WHERE owner_id=$1 AND id=$2 AND attachment_generation=$3::jsonb->>'attachment' AND runtime_generation IS NOT DISTINCT FROM ($3::jsonb->>'expectedRuntime') AND worker_process_generation IS NOT DISTINCT FROM ($3::jsonb->>'expectedWorker') AND power_epoch=($3::jsonb->>'expectedPowerEpoch')::integer RETURNING to_jsonb(cantrip_os_instances)::text", &[&owner, &id, &observation]).await?;
        summary(
            rows.first()
                .context("OS attachment changed before observation arrived.")?,
            "instance",
            None,
        )
    }
}
