//! Open an explicit client patch and dispatch it through the existing native
//! command controller and settings evidence outbox.
use super::{Scope, Turns, UPDATE, assert_ordinary_settings, id, permission, snapshot::Source};
use crate::{http::checked, metadata::Signal};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::open_native_settings_patch;
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::sync::Arc;

pub(crate) const COMMAND: &str = "chat.settings.update";

impl Turns {
    pub(crate) async fn update_settings(&self, command: &Value, signal: Signal) -> Result<Value> {
        let command = checked("nativeSettingsUpdateCommandSchema", command)?;
        let binding = &command["binding"];
        ensure!(
            command["bindingId"] == binding["bindingId"],
            "The settings request belongs to another binding."
        );
        let source = self.preparation.settings_source(binding, true)?;
        let scope = source.encryption_scope()?;
        let patch = (|| {
            let envelope = &command["protectedPatch"];
            let revision = envelope["keyRevision"].as_u64().context("Missing settings key revision.")?;
            let grant = scope.material(Some(revision))?;
            open_native_settings_patch(
                &grant.key,
                &json!({"ownerId":grant.owner_id,"serverId":grant.server_id,"keyRevision":grant.key_revision}),
                &json!({"chatId":binding["chatId"],"operationId":command["operationId"],"bindingId":command["bindingId"]}),
                envelope,
            )
        })().map_err(|_| anyhow!("The encrypted settings patch could not be opened. No native update was requested."))?;

        let result = self.apply_settings_update(source, scope, &command, patch, None, signal).await
            .map_err(|_| anyhow!("Native settings update did not return a confirmed receipt. Read its recorded state before submitting another change."))?;
        Ok(result)
    }

    pub(super) async fn apply_settings_update(
        &self,
        source: Arc<Source>,
        scope: Scope,
        command: &Value,
        mut params: Value,
        transition: Option<Value>,
        signal: Signal,
    ) -> Result<Value> {
        let runtime = source.runtime()?;
        if transition.is_none() {
            assert_ordinary_settings(&params)?;
        }
        if !params["cwd"].is_null() {
            crate::codex::turn::autonomous::same_workspace(&source.cwd, &params["cwd"]).await?;
        }
        let binding = &command["binding"];
        let chat = id(&binding["chatId"], "settings chat")?;
        let thread = id(&binding["threadId"], "settings thread")?;
        let session = source.command_session();
        params["threadId"] = json!(thread);
        params["operationId"] = command["operationId"].clone();

        let gate = runtime.inference_router().goal_mutations(&thread);
        let _mutation = match gate {
            Some(gate) => Some(gate.lock_owned().await),
            None => None,
        };
        let current = source.read_native(signal.clone()).await?;
        ensure!(
            current["settingsVersion"]["epoch"] == binding["nativeEpoch"],
            "The native settings runtime epoch changed."
        );
        let activation = self.settings_activation(&scope, chat);
        let mut intent = json!({"operationId":command["operationId"],
            "permissionProfileId":source.permission(),"settingsBindingId":binding["bindingId"]});
        let permission = transition.map(|transition| {
            intent["permissionTransition"] = transition.clone();
            permission::Change {
                transition,
                epoch: binding["nativeEpoch"].clone(),
                source: source.clone(),
                binding: binding["bindingId"].clone(),
            }
        });
        let check = || {
            signal.check()?;
            source.assert_current()
        };
        check()?;
        let (receipt, _, _) = self
            .receipts
            .admit_command(scope, session, UPDATE, &params, &intent, activation)
            .await?;
        let (reply, status) = self
            .dispatch_settings(&runtime, &receipt, params, permission, check)
            .await?;
        source.assert_current()?;
        checked(
            "nativeSettingsUpdateReceiptSchema",
            &json!({
                "operationId":reply["operationId"],"submissionId":reply["submissionId"],"status":status,
            }),
        )
    }
}
