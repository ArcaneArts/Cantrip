use anyhow::{Context, Result};
use cantrip_server::{
    projects::exports,
    relay::RelayQuotas,
    wire::{JsString, Value},
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::future::BoxFuture;
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
fn json(value: serde_json::Value) -> Value {
    Value::from_serialize(&value)
}
struct Delegate {
    fixture: Value,
    trace: Mutex<Vec<Value>>,
}
impl CommandDelegate for Delegate {
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            connected_workers: 1,
            active_requests: 0,
            routed_requests: 0,
            failed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn request(
        self: Arc<Self>,
        _: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        Box::pin(async move {
            self.trace.lock().unwrap().push(Value::object([
                ("worker", json(serde_json::json!(worker))),
                ("command", command.clone()),
                (
                    "deadlineMs",
                    json(serde_json::json!(timeout.map(|t| t.as_millis() as u64))),
                ),
            ]));
            let kind = command["type"].as_str().unwrap();
            if self.fixture["failType"] == kind {
                return Err(CommandError {
                    message: self.fixture["failureMessage"]
                        .as_js_string()
                        .unwrap()
                        .clone(),
                    code: None,
                    unavailable: false,
                    request_id: None,
                    encoding_error: None,
                    inference: None,
                });
            }
            if self.fixture["omit"] == kind {
                return Ok(None);
            }
            if let Some(response) = self.fixture["responses"].get(kind) {
                return Ok(Some(response.clone()));
            }
            Ok(Some(match kind {
                "project.export.chat.begin" => json(serde_json::json!({"status":"upload"})),
                "project.export.chat.chunk" => Value::Null,
                "project.export.chat.complete" => json(
                    serde_json::json!({"chatId":"chat","threadId":"exported-thread","destinationLabel":"Codex home","messageCount":1,"reused":false}),
                ),
                _ => panic!("Unexpected export command"),
            }))
        })
    }
}
#[tokio::test]
async fn export_relay_deadlines_bytes_responses_and_errors_match_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/project-export-service-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source export service oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in data["relays"]
        .as_array()
        .context("Relay cases")?
        .iter()
        .enumerate()
    {
        let fixture = &case["fixture"];
        let delegate = Arc::new(Delegate {
            fixture: fixture.clone(),
            trace: Mutex::new(Vec::new()),
        });
        let bus = LimitedCommandBus::with_parts(
            delegate.clone(),
            RelayQuotas::with_limits(u64::MAX, u64::MAX, u64::MAX, u64::MAX, 100, 100),
            CommandLimits {
                account_concurrency: 100,
                account_rate_per_minute: 10000,
                worker_concurrency: 100,
                worker_rate_per_minute: 10000,
            },
            Arc::new(|_| Box::pin(async { Ok(Some("owner".into())) })),
            Arc::new(|| 0),
        );
        let input = &fixture["input"];
        let outcome = match exports::export(
            &bus,
            exports::Input {
                operation: &input["operationId"],
                target: &input["target"],
                worker: input["workerId"].as_str().unwrap(),
                chat: &input["chatId"],
                cwd: &input["cwd"],
                title: &input["titleProtection"],
                payload: &input["payload"],
            },
        )
        .await
        {
            Ok(value) => Value::object([("value", value)]),
            Err(error) => Value::object([("error", Value::String(exports::message(&error)))]),
        };
        assert_eq!(outcome, case["outcome"], "Relay result {index}");
        assert_eq!(
            Value::Array(delegate.trace.lock().unwrap().clone()),
            case["trace"],
            "Exact commands/deadlines {index}"
        );
        bus.drained().await;
    }
    for (index, case) in data["errors"]
        .as_array()
        .context("Error cases")?
        .iter()
        .enumerate()
    {
        let cause: anyhow::Error =
            cantrip_server::workers::command_bus::CommandFailure::Bridge(CommandError {
                message: case["message"]
                    .as_js_string()
                    .context("Error text")?
                    .clone(),
                code: None,
                unavailable: false,
                request_id: None,
                encoding_error: None,
                inference: None,
            })
            .into();
        assert_eq!(
            exports::failure(&Value::String(JsString::from("chat")), &cause),
            case["outcome"],
            "Source route error {index}"
        );
    }
    let definition = exports::definition::mappings();
    assert_eq!(definition["targetLabel"], data["definition"]["label"]);
    for field in [
        "maxChats",
        "supportedChatExperiences",
        "preserves",
        "flattens",
    ] {
        assert_eq!(
            definition[field], data["definition"][field],
            "Source target mapping {field}"
        );
    }
    println!(
        "{} actual Source relay cases and {} Source route error cases matched",
        data["relays"].as_array().unwrap().len(),
        data["errors"].as_array().unwrap().len()
    );
    Ok(())
}
