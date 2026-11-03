//! The updater observes the same nine independent reads as the reference server.
use crate::{
    database::{Database, query_error},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use postgres_types::ToSql;
use std::sync::{Arc, OnceLock};

pub(crate) const COUNTS: [&str; 9] = [
    "activeChats",
    "queuedPrompts",
    "terminalServices",
    "projectReplicaJobs",
    "chatRelocationJobs",
    "chatImportJobs",
    "projectAutomationRuns",
    "gitOperations",
    "runConfigurationRuntimes",
];

pub(crate) async fn count(
    database: Arc<Database>,
    owner: String,
    name: &'static str,
) -> Result<f64> {
    static MANIFEST: OnceLock<serde_json::Value> = OnceLock::new();
    let query = &MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/desktop-update-queries.json"))
            .expect("Source desktop count manifest")
    })["queries"][name];
    let sql = query["sql"].as_str().context("Source desktop count SQL")?;
    let params = query["params"]
        .as_array()
        .context("Source count parameters")?
        .iter()
        .map(|v| {
            if v == "owner" {
                serde_json::Value::String(owner.clone())
            } else {
                v.clone()
            }
        })
        .collect::<Vec<_>>();
    let bindings = params
        .iter()
        .map(|v| -> Result<Box<dyn ToSql + Sync + Send>> {
            Ok(if let Some(v) = v.as_bool() {
                Box::new(v)
            } else {
                Box::new(
                    v.as_str()
                        .context("Source count string parameter")?
                        .to_owned(),
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let refs = bindings
        .iter()
        .map(|v| v.as_ref() as &(dyn ToSql + Sync))
        .collect::<Vec<_>>();
    let diagnostic = params.iter().map(Value::from_serialize).collect::<Vec<_>>();
    let rows = query_error::context(database.query(sql, &refs).await, sql, &diagnostic)?;
    Ok(f64::from(
        rows.first()
            .map(|r| r.get::<i32>(0))
            .transpose()?
            .unwrap_or(0),
    )
    .min(4_294_967_295.0))
}

pub(crate) fn summary(counts: [f64; 9]) -> Value {
    json!({"activeChats":counts[0],"queuedPrompts":counts[1],"terminalServices":counts[2],
        "backgroundJobs":counts[3..].iter().sum::<f64>().min(4_294_967_295.0)})
}
