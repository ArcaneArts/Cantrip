//! The selected account's writable config layer is independent of thread settings.
use super::{Scope, Turns, id, snapshot::Source};
use crate::{
    codex::{managed::Runtime, rpc_requests::Failure},
    http::checked,
    metadata::Signal,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::{
    open_native_account_defaults_write, protect_native_account_defaults_result,
};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, payload_digest, value::json};
use std::io::ErrorKind;
use std::time::Duration;

pub(crate) const COMMAND: &str = "chat.account-defaults";
pub(in crate::codex::turn) const WRITE: &str = "config/batchWrite";
const READ: &str = "config/read";
const TIMEOUT: Duration = Duration::from_secs(30);
const FIELDS: &[&str] = &[
    "model",
    "model_reasoning_effort",
    "service_tier",
    "personality",
];

impl Turns {
    pub(crate) async fn account_defaults(&self, command: &Value, signal: Signal) -> Result<Value> {
        let command = checked("nativeAccountDefaultsCommandSchema", command)?;
        let binding = &command["binding"];
        let request = &command["request"];
        ensure!(
            request["bindingId"] == binding["bindingId"],
            "The account defaults binding changed."
        );
        let source = self.preparation.settings_source(binding, true)?;
        let scope = source.encryption_scope()?;
        let runtime = source.runtime()?;
        let context = json!({
            "chatId":binding["chatId"],"bindingId":binding["bindingId"],"operationId":request["operationId"],
        });
        let envelope = request.get("protectedWrite");
        let grant =
            scope.material(envelope.and_then(|envelope| envelope["keyRevision"].as_u64()))?;
        let authority = json!({
            "ownerId":grant.owner_id,"serverId":grant.server_id,"keyRevision":grant.key_revision,
        });
        signal.check()?;
        let write = envelope
            .map(|envelope| {
                open_native_account_defaults_write(&grant.key, &authority, &context, envelope)
                    .map_err(|_| anyhow!("The encrypted account defaults could not be opened. No write was requested."))
            })
            .transpose()?;
        let result = match write {
            Some(write) => self.write_account_defaults(&source, &runtime, scope, &context, &write, &signal).await,
            None => read_defaults(&runtime, &|| {
                signal.check()?;
                source.assert_current()
            }).await.map(|snapshot| json!({"snapshot":snapshot,"write":Value::Null,"verification":"read"})),
        }.map_err(|_| anyhow!("Account defaults did not return a confirmed result. Read current defaults before making another change."))?;
        source.assert_current()?;
        let protected =
            protect_native_account_defaults_result(&grant.key, &authority, &context, &result)?;
        source.assert_current()?;
        checked(
            "nativeAccountDefaultsResponseSchema",
            &json!({
                "operationId":request["operationId"],"bindingId":request["bindingId"],"protectedResult":protected,
            }),
        )
    }

    async fn write_account_defaults(
        &self,
        source: &Source,
        runtime: &Runtime,
        scope: Scope,
        context: &Value,
        write: &Value,
        signal: &Signal,
    ) -> Result<Value> {
        let edits = write["values"]
            .as_object()
            .context("Missing account defaults values.")?
            .iter()
            .map(|(key, value)| json!({"keyPath":key,"value":value,"mergeStrategy":"replace"}))
            .collect::<Vec<_>>();
        let params = json!({
            "edits":edits,"expectedVersion":write["expectedVersion"],"reloadUserConfig":false,
        });
        let intent = json!({
            "operationId":context["operationId"],"permissionProfileId":source.permission(),
            "settingsBindingId":context["bindingId"],
        });
        let check_dispatch = || {
            signal.check()?;
            source.assert_current()?;
            assert_config_target(runtime)
        };
        check_dispatch()?;
        let activation = self.settings_activation(&scope, id(&context["chatId"], "defaults chat")?);
        let (receipt, _, _) = self
            .receipts
            .admit_command(
                scope,
                source.command_session(),
                WRITE,
                &params,
                &intent,
                activation,
            )
            .await?;
        let dispatch = async {
            check_dispatch()?;
            receipt.dispatch().await?;
            check_dispatch()
        }
        .await;
        if let Err(error) = dispatch {
            receipt.rejected(&json!({"code":-32000,"message":"Native account defaults were not dispatched."})).await?;
            return Err(error);
        }

        let reply = runtime
            .request(WRITE.into(), Some(params), Some(TIMEOUT), None)
            .await;
        let write = match reply
            .and_then(|reply| write_evidence(reply.context("No native write result.")?))
        {
            Ok(write) => write,
            Err(error) => {
                if let Some(native) = error
                    .downcast_ref::<Failure>()
                    .and_then(|error| error.native_error.as_ref())
                {
                    receipt.rejected(native).await?;
                    return Ok(
                        json!({"snapshot":Value::Null,"write":Value::Null,"verification":"rejected"}),
                    );
                }
                receipt.uncertain().await?;
                return Err(error);
            }
        };
        let result = match read_defaults(runtime, &|| source.assert_current()).await {
            Ok(snapshot) => {
                let verification = if snapshot["version"] == write["version"] {
                    "confirmed"
                } else {
                    "changed"
                };
                json!({"snapshot":snapshot,"write":write,"verification":verification})
            }
            Err(_) => json!({"snapshot":Value::Null,"write":write,"verification":"unavailable"}),
        };
        receipt.applied(&json!({"result":result}), None).await?;
        Ok(result)
    }
}

fn assert_config_target(runtime: &Runtime) -> Result<()> {
    // The RPC's implicit path is set when the managed process is launched.
    // A config.toml symlink could otherwise make the edit escape that account.
    match std::fs::symlink_metadata(runtime.user_config_path()) {
        Ok(metadata) => ensure!(
            !metadata.file_type().is_symlink(),
            "Account defaults must target the managed account's config.toml."
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

async fn read_defaults(
    runtime: &Runtime,
    assert_current: &impl Fn() -> Result<()>,
) -> Result<Value> {
    assert_current()?;
    let reply = runtime
        .request(
            READ.into(),
            Some(json!({"includeLayers":true,"cwd":Value::Null})),
            Some(TIMEOUT),
            None,
        )
        .await?
        .context("No native config read result.")?;
    assert_current()?;
    let user = reply["layers"]
        .as_array()
        .context("Missing native configuration layers.")?
        .iter()
        .find(|layer| layer["name"]["type"] == "user" && layer["name"]["profile"].is_null());
    let (version, stored) = match user {
        Some(layer) => (layer["version"].clone(), default_fields(&layer["config"])?),
        None => (
            json!(format!("sha256:{}", payload_digest(&json!({})))),
            json!({}),
        ),
    };
    checked(
        "nativeAccountDefaultsSnapshotSchema",
        &json!({
            "version":version,"stored":stored,"effective":default_fields(&reply["config"])?,
        }),
    )
}

fn default_fields(config: &Value) -> Result<Value> {
    ensure!(config.is_object(), "Missing native configuration.");
    let mut result = json!({});
    for key in FIELDS {
        if let Some(value) = config.get(*key) {
            result[*key] = value.clone();
        }
    }
    Ok(result)
}

fn write_evidence(reply: Value) -> Result<Value> {
    ensure!(
        matches!(reply["status"].as_str(), Some("ok" | "okOverridden"))
            && reply["version"]
                .as_js_string()
                .is_some_and(|version| !version.is_empty()),
        "Invalid native config write receipt."
    );
    Ok(json!({"status":reply["status"],"version":reply["version"]}))
}
