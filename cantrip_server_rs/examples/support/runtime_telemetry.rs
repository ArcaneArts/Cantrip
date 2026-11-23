use anyhow::{Context, Result};
use cantrip_server::{chats::runtime_telemetry::RuntimeTelemetry, database::Database, wire::Value};
use std::sync::{Arc, Mutex};
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if input["action"] == "runtime-resume" {
        return Ok(Value::Bool(RuntimeTelemetry::can_resume(
            &input["execution"],
            &input["runtime"],
        )));
    }
    let (publications, warnings) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let telemetry = RuntimeTelemetry::new(
        database,
        {
            let publications = publications.clone();
            Arc::new(move |value| publications.lock().unwrap().push(value))
        },
        {
            let warnings = warnings.clone();
            Arc::new(move |call| {
                warnings.lock().unwrap().push(Value::object([
                    ("message", Value::from_serialize(&call.message)),
                    ("sourceKey", call.context["sourceKey"].clone()),
                    ("error", Value::Bool(!call.context["err"].is_null())),
                ]))
            })
        },
    );
    let source = input["sourceKey"]
        .as_js_string()
        .context("Runtime telemetry source")?;
    let owner = input["owner"].as_str().context("Runtime telemetry owner")?;
    match input["action"].as_str() {
        Some("runtime-usage") => {
            telemetry
                .record_usage(
                    owner,
                    source,
                    &input["execution"],
                    &input["runtime"],
                    input.get("usage"),
                    &input["attribution"],
                )
                .await
        }
        Some("runtime-behavior") => {
            telemetry
                .record_behavior(
                    owner,
                    source,
                    &input["execution"],
                    &input["runtime"],
                    &super::turn_behavior::tracker(input)?.0,
                    &input["attribution"],
                )
                .await
        }
        _ => anyhow::bail!("Unknown runtime telemetry fixture action"),
    }
    Ok(Value::object([
        (
            "publications",
            Value::Array(publications.lock().unwrap().clone()),
        ),
        ("warnings", Value::Array(warnings.lock().unwrap().clone())),
    ]))
}
