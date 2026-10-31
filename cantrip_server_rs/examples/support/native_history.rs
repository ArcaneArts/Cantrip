use anyhow::{Context, Result};
use cantrip_server::{database::Database, native_history::Repository, wire::Value};
use std::sync::Arc;

pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = input["owner"].as_str().context("History fixture owner")?;
    match input["op"].as_str().context("History fixture operation")? {
        "native-history-publications" => Ok(Value::Array(
            repository
                .pending_publications(
                    input.get("limit").and_then(Value::as_f64).unwrap_or(64.0) as i64
                )
                .await?,
        )),
        "native-history-publication-ack" => Ok(Value::from_serialize(
            &repository.acknowledge_publication(&input["entry"]).await?,
        )),
        "native-history-publication-defer" => {
            let due = chrono::DateTime::parse_from_rfc3339(
                input["at"]
                    .as_str()
                    .context("History publication due time")?,
            )?
            .with_timezone(&chrono::Utc);
            Ok(Value::from_serialize(
                &repository.defer_publication(&input["entry"], due).await?,
            ))
        }
        "native-history-ingest" => repository.ingest(owner, &input["input"]).await,
        "native-history-archive" => repository.archive_items(owner, &input["input"]).await,
        "native-history-archive-turns" => repository.archive_turns(owner, &input["input"]).await,
        "native-history-archive-batches" => {
            repository.archive_batches(owner, &input["input"]).await
        }
        "native-history-reconcile-usage" => {
            let (evidence, totals) = cantrip_server::native_history::reconcile_usage(
                input.get("previous").filter(|v| !v.is_null()),
                &input["input"],
            )?;
            Ok(Value::object([
                ("evidence", evidence),
                ("totals", totals.unwrap_or(Value::Null)),
            ]))
        }
        "native-history-digest" => Ok(Value::from_serialize(
            &cantrip_server::native_history::payload_digest(&input["input"]),
        )),
        "native-history-resolve" => repository.resolve_items(owner, &input["input"]).await,
        "native-history-binding-open" => repository.open_binding(owner, &input["input"]).await,
        "native-history-binding-owned" => {
            repository
                .read_owned_binding(
                    owner,
                    input["worker"].as_str().context("History fixture worker")?,
                    input["chat"].as_str().context("History fixture chat")?,
                    input["binding"]
                        .as_str()
                        .context("History fixture binding")?,
                )
                .await
        }
        _ => anyhow::bail!("Unknown native history fixture operation"),
    }
}
