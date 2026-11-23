//! Source query diagnostics are attached after a real native read fails.
use crate::{
    database::query_error,
    wire::{JsString, Value, value::json},
};
use anyhow::Result;
use serde::Deserialize;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Deserialize)]
struct Query {
    sql: String,
    params: Vec<Value>,
}
pub(super) struct Identity<'a> {
    pub owner: &'a str,
    pub project: &'a str,
    pub selector: Option<&'a JsString>,
    pub owning: Option<&'a str>,
    pub eligible: &'a [String],
}
fn instantiate(key: &str, identity: &Identity<'_>) -> (String, Vec<Value>) {
    static QUERIES: OnceLock<HashMap<String, Query>> = OnceLock::new();
    let query = &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/cli-target-queries.json"))
            .expect("captured CLI selector queries")
    })[key];
    let mut parameters = Vec::new();
    let mut placeholders = Vec::new();
    for value in &query.params {
        let values = match value.as_str() {
            Some("fixture-owner") => vec![json!(identity.owner)],
            Some("fixture-project") => vec![json!(identity.project)],
            Some("fixture-owning-worker") => vec![json!(identity.owning.unwrap_or(""))],
            Some("fixture-eligible-worker") => identity.eligible.iter().map(|v| json!(v)).collect(),
            Some("Fixture-SELECTOR" | "Fixture-SELECTOR-é") => vec![Value::String(
                identity.selector.expect("selector query identity").clone(),
            )],
            Some("fixture-selector") => vec![Value::String(
                identity
                    .selector
                    .expect("selector query identity")
                    .lowercase(),
            )],
            _ => vec![value.clone()],
        };
        let start = parameters.len();
        parameters.extend(values);
        placeholders.push(
            (start + 1..=parameters.len())
                .map(|n| format!("${n}"))
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    // Expand each captured one-worker IN list and renumber every later bind.
    // Work on SQL bytes: the generated statements contain only ASCII identifiers.
    let mut sql = String::new();
    let bytes = query.sql.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'$' && bytes.get(at + 1).is_some_and(u8::is_ascii_digit) {
            let start = at + 1;
            at = start;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            let index = query.sql[start..at]
                .parse::<usize>()
                .expect("captured SQL parameter");
            sql.push_str(&placeholders[index - 1]);
        } else {
            sql.push(char::from(bytes[at]));
            at += 1;
        }
    }
    (sql, parameters)
}
pub(super) fn context<T>(result: Result<T>, key: &str, identity: Identity<'_>) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    let (sql, parameters) = instantiate(key, &identity);
    query_error::context(result, &sql, &parameters)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_selector_query_diagnostics_match_actual_source_with_variable_worker_lists() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let output = std::process::Command::new("pnpm")
            .args([
                "exec",
                "tsx",
                "scripts/server-rust/cli-target-query-manifest.mjs",
                "--fixtures",
            ])
            .current_dir(root)
            .env("TSX_DISABLE_CACHE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let source: Value = serde_json::from_slice(&output.stdout).unwrap();
        let fixtures = source["fixtures"].as_array().unwrap();
        assert_eq!(fixtures.len(), 24);
        for fixture in fixtures {
            let eligible = fixture["eligible"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let (sql, params) = instantiate(
                fixture["key"].as_str().unwrap(),
                &Identity {
                    owner: fixture["owner"].as_str().unwrap(),
                    project: fixture["project"].as_str().unwrap(),
                    selector: fixture["selector"].as_js_string(),
                    owning: fixture["owning"].as_str(),
                    eligible: &eligible,
                },
            );
            assert_eq!(
                json!({"sql":sql,"params":params}),
                fixture["expected"],
                "{} {:?}",
                fixture["key"],
                fixture["selector"]
            );
        }
    }
}
