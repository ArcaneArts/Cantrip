use super::{InstanceObservation, checked, coordinator::Coordinator, text};
use anyhow::{Context, Result, ensure};
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
        let actual = self
            .inspect(
                owner,
                &json!({
                    "workerId": instance["workerId"], "transport": attachment["transport"]
                }),
            )
            .await
            .ok();
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
        let observed = self
            .repository
            .observe_current(
                owner,
                id,
                text(instance, "attachmentGeneration")?,
                InstanceObservation {
                    status: if matches { "connected" } else { "unknown" },
                    // Failure is not evidence that the last observed runtime vanished.
                    runtime: if matches {
                        observed_runtime.as_str()
                    } else {
                        instance["runtimeGeneration"].as_str()
                    },
                    error: if matches { None } else { Some(message) },
                },
                instance["runtimeGeneration"].as_str(),
            )
            .await?;
        checked(
            "cantripOsRecoveryResultSchema",
            json!({
                "instance": observed,
                "workspaces": self.repository.workspaces(owner, id).await?,
                "recovery": {
                    "kind": kind, "message": message,
                    "previousRuntimeGeneration": instance["runtimeGeneration"],
                    "observedRuntimeGeneration": observed_runtime
                }
            }),
        )
    }
}
