//! Managed queued shell commands use the acknowledged native-start lifecycle.
use super::Turns;
use crate::chat_content::Scope;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};

pub(in crate::codex) const METHOD: &str = "thread/shellCommand";

impl Turns {
    pub(in crate::codex) async fn run_queued_shell(
        &self,
        command: &Value,
        scope: Scope,
        program: JsString,
        acknowledge: impl FnOnce(&Value) + Send,
    ) -> Result<Value> {
        // The native shell method runs outside the thread sandbox.
        if !matches!(
            command["permissionProfileId"].as_str(),
            Some(":yolo" | ":danger-full-access")
        ) {
            bail!(
                "This native command runs without a sandbox and requires an authorized full-access profile."
            );
        }
        if !command["session"].is_object() {
            bail!("The queued shell command belongs to no managed conversation.");
        }
        let params = json!({"threadId":command["threadId"],"command":program});
        self.run_acknowledged_start(command, scope, METHOD, params, acknowledge)
            .await
    }
}
