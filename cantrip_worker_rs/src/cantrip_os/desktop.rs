//! Desktop administration through the captured native workspace executor.
use super::{
    assert_scope,
    carrier::{DeliveryUnknown, Transport},
    checked,
    operations::{Journal, Operations, digest},
    process::{self, Invocation, Limits},
    session::Session,
    text,
};
use crate::filesystem::Scope;
use anyhow::{Result, bail, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::time::Duration;

pub(super) const STATUS: &str = "cantrip-os.desktop.status";
pub(super) const OPERATION: &str = "cantrip-os.desktop.operation";
const LIMITS: Limits = Limits {
    deadline: Duration::from_secs(90),
    output: 512 * 1024,
};

fn assert_account(scope: &Value, target: &Value) -> Result<()> {
    let user = format!("ctw-{}", text(scope, "guestWorkspaceId")?);
    ensure!(
        target["id"] == scope["guestWorkspaceId"]
            && target["user"] == user
            && target["uid"] == scope["uid"]
            && target["gid"] == scope["gid"]
            && target["home"] == scope["homeGuestPath"]
            && (target["status"] != "running" || !target["desktop_generation"].is_null()),
        "The observed desktop does not match its admitted workspace."
    );
    Ok(())
}

fn guest_request(command: &Value) -> Value {
    let scope = &command["scope"];
    let mut scope_key = [
        "serverId",
        "ownerId",
        "workerId",
        "instanceId",
        "guestInstanceId",
        "attachmentGeneration",
        "runtimeGeneration",
        "workspaceId",
        "guestWorkspaceId",
        "uid",
        "gid",
        "homeGuestPath",
    ]
    .map(|field| scope[field].clone())
    .to_vec();
    scope_key.push(command["targetGeneration"].clone());
    json!({"operation_id":command["operationId"],"action":command["action"],
        "scope_key":digest(Value::Array(scope_key)),"target":command["desktopTarget"]})
}

fn receipt(command: &Value, result: &Value) -> Result<Value> {
    let before = &result["receipt"]["before"];
    let after = &result["receipt"]["after"];
    let same_generation = before["generation"] == after["generation"]
        && before["desktop_generation"] == after["desktop_generation"];
    let transitioned = if command["action"] == "stop" {
        after["status"] == "stopped" && same_generation
    } else if after["status"] != "running" || after["desktop_generation"].is_null() {
        false
    } else if command["action"] == "start" && before["status"] == "running" {
        same_generation
    } else {
        after["generation"].as_u64() > before["generation"].as_u64()
            && after["desktop_generation"] != before["desktop_generation"]
    };
    ensure!(
        result["error"].is_null()
            && before == &command["desktopTarget"]
            && ["id", "user", "uid", "gid", "home", "display"]
                .into_iter()
                .all(|field| before[field] == after[field])
            && transitioned,
        "The desktop receipt does not prove its requested state."
    );
    checked(
        "cantripOsDesktopReceiptSchema",
        json!({"targetGeneration":command["targetGeneration"],"before":before,
            "after":after,"completionEvidence":result["receipt"]["completion"]}),
    )
}

fn guest_outcome(command: &Value, request: &Value, raw: &Value) -> Result<Value> {
    let guest = checked("cantripOsGuestDesktopResultSchema", raw.clone())?;
    ensure!(
        &guest["request"] == request,
        "The desktop receipt belongs to another admission."
    );
    let (state, receipt) = if guest["state"] == "ready" {
        ("ready", receipt(command, &guest)?)
    } else {
        ensure!(
            guest["receipt"].is_null(),
            "The desktop result has a conflicting receipt."
        );
        let state = if guest["state"] == "failed" {
            "failed"
        } else {
            "unknown"
        };
        (state, Value::Null)
    };
    Ok(
        json!({"state":state,"receipt":receipt,"error":guest["error"],
        "startedAt":guest["started_at"],"updatedAt":guest["updated_at"]}),
    )
}

struct Driver<'a> {
    scope: &'a Value,
    transport: Transport,
    lifetime: &'a Scope,
}

impl Driver<'_> {
    async fn run(
        &self,
        arguments: &[&str],
        mut journal: Option<&mut Journal<'_>>,
    ) -> Result<Value> {
        assert_scope(&self.transport, self.scope, true, self.lifetime).await?;
        let (mut session, session_id) = Session::open(
            &self.transport,
            self.scope,
            "cantrip-desktop-administration",
            self.lifetime,
        )
        .await?;
        let result = async {
            if let Some(journal) = &mut journal {
                journal.bind(&session.binding, &session_id)?;
            }
            let mut argv = vec!["sudo", "-n", "--", "/usr/bin/cantrip-workspaces"];
            argv.extend_from_slice(arguments);
            let output = process::run(
                &mut session,
                journal,
                Invocation {
                    argv: &argv,
                    cwd: text(self.scope, "homeGuestPath")?,
                    env: json!({}),
                    input: None,
                },
                LIMITS,
            )
            .await?;
            if !output.successful {
                return Err(DeliveryUnknown(
                    "The desktop command did not return a complete verified outcome.".into(),
                )
                .into());
            }
            parse_json_text(&output.stdout).map_err(|_| {
                DeliveryUnknown("The desktop command returned an unreadable outcome.".into()).into()
            })
        }
        .await;
        session.close().await;
        result
    }

    async fn current(&self) -> Result<Value> {
        let workspace = text(self.scope, "guestWorkspaceId")?;
        let target = checked(
            "cantripOsGuestDesktopTargetSchema",
            self.run(&["desktop-target", workspace], None).await?,
        )?;
        assert_account(self.scope, &target)?;
        Ok(target)
    }

    async fn observe(
        &self,
        command: &Value,
        request: &Value,
        input: &str,
    ) -> Result<Option<Value>> {
        let guest = self.run(&["desktop-observe", input], None).await?;
        if guest.is_null() {
            return Ok(None);
        }
        guest_outcome(command, request, &guest).map(Some)
    }
}

pub(super) async fn execute(
    operations: &Operations,
    command: &Value,
    lifetime: &Scope,
) -> Result<Value> {
    let command = checked("cantripOsDesktopWorkerCommandSchema", command.clone())?;
    let scope = &command["scope"];
    let driver = Driver {
        scope,
        transport: Transport::from_value(&command["transport"])?,
        lifetime,
    };
    if command["type"] == STATUS {
        return driver.current().await;
    }
    assert_account(scope, &command["desktopTarget"])?;
    let id = text(&command, "operationId")?;
    let admission = json!({"action":command["action"],"targetGeneration":command["targetGeneration"],
        "desktopTarget":command["desktopTarget"],"transport":command["transport"]});
    let request = guest_request(&command);
    let input = request.stringify();
    let record = if let Some(saved) = operations.inspect_record(scope, id)? {
        ensure!(
            saved["command"] == OPERATION
                && &saved["scope"] == scope
                && saved["checkpoint"]["version"] == 1
                && saved["checkpoint"]["admission"] == admission,
            "The saved desktop operation belongs to another admission."
        );
        if saved["state"] == "unknown" {
            let (state, receipt, error) = match driver.observe(&command, &request, &input).await {
                Ok(Some(observed)) => (
                    text(&observed, "state")?.to_owned(),
                    observed["receipt"].clone(),
                    observed["error"].clone(),
                ),
                Ok(None) => (
                    "unknown".into(),
                    Value::Null,
                    json!("The guest desktop journal is unavailable. No operation was replayed."),
                ),
                Err(error) => ("unknown".into(), Value::Null, json!(error.to_string())),
            };
            operations.record_observation(&saved, &state, receipt, error)?
        } else {
            saved
        }
    } else if command["mode"] == "execute" {
        operations
            .execute_record(
                scope, id, OPERATION, admission.clone(),
                Some(json!({"version":1,"admission":admission})),
                async |journal| {
                    let guest = driver.run(&["desktop-execute", &input], Some(journal)).await?;
                    let result = guest_outcome(&command, &request, &guest).map_err(|_| {
                        DeliveryUnknown("The desktop returned an unverified outcome; observe its original admission.".into())
                    })?;
                    journal.set_checkpoint(json!({"version":1,"admission":admission,"guest":guest}))?;
                    if result["state"] == "ready" {
                        return Ok(result["receipt"].clone());
                    }
                    let message = result["error"].as_str().unwrap_or("The desktop outcome is uncertain.");
                    if result["state"] == "failed" {
                        bail!("{message}");
                    }
                    Err(DeliveryUnknown(message.into()).into())
                },
            )
            .await?
    } else {
        // The guest journal can recover a retained admission without a local record.
        let Some(observed) = driver.observe(&command, &request, &input).await? else {
            return Ok(Value::Null);
        };
        observed
    };

    let (observation, observation_error) = match driver.current().await {
        Ok(observed) => (observed, Value::Null),
        Err(_) => (
            Value::Null,
            json!(
                "The captured desktop could not be observed. Its saved outcome remains separate."
            ),
        ),
    };
    let (receipt, error) = if record["state"] == "ready" {
        (record["receipt"].clone(), Value::Null)
    } else {
        let error = record["error"]
            .as_js_string()
            .map(|error| JsString::new(error.units()[..error.len().min(4000)].to_vec()));
        (Value::Null, json!(error))
    };
    checked(
        "cantripOsDesktopOperationResultSchema",
        json!({"operationId":id,"action":command["action"],"state":record["state"],
            "startedAt":record["startedAt"],"updatedAt":record["updatedAt"],
            "error":error,"receipt":receipt,
            "observation":observation,"observationError":observation_error}),
    )
}
