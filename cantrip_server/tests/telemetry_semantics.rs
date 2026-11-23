use anyhow::{Context, Result};
use cantrip_server::{
    settings::telemetry::{changes, quota, statistics},
    wire::Value,
};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};
struct Oracle(Child);
impl Drop for Oracle {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn scalar(value: &Value) -> f64 {
    match value["number"].as_str() {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        _ => value.as_f64().unwrap_or(f64::NAN),
    }
}
fn runtime_rows(rows: &Value) -> Vec<Value> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| {
            Value::object(row.as_object().unwrap().iter().map(|(key, value)| {
                (
                    key.clone(),
                    if value.get("number").is_some() {
                        Value::Number(scalar(value))
                    } else {
                        value.clone()
                    },
                )
            }))
        })
        .collect()
}
#[test]
fn telemetry_statistics_summaries_and_sampling_match_actual_source() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut oracle = Oracle(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/telemetry-semantics-oracle.mjs",
            ])
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let reader = BufReader::new(oracle.0.stdout.take().context("oracle output")?);
    let mut count = 0;
    let mut receipt = None;
    for line in reader.lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if let Some(done) = case.get("done") {
            receipt = done.as_u64();
            continue;
        }
        anyhow::ensure!(receipt.is_none(), "case after completion");
        let input = &case["input"];
        let actual = match case["op"].as_str().context("oracle operation")? {
            "statistics" => statistics::quota_value_statistics(
                &input["values"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(scalar)
                    .collect::<Vec<_>>(),
            ),
            "summary" => {
                let rows = runtime_rows(&input["rows"]);
                let groups = statistics::group_model_behavior(&rows, |row| {
                    row["key"].as_js_string().unwrap().clone()
                });
                Value::object([
                    ("tokens", statistics::sum_detailed_token_usage(&rows)),
                    ("behavior", statistics::summarize_model_behavior(&rows)),
                    (
                        "groups",
                        Value::Array(
                            groups
                                .into_iter()
                                .map(|(key, value)| Value::Array(vec![Value::String(key), value]))
                                .collect(),
                        ),
                    ),
                ])
            }
            "sample" => Value::Array(statistics::sample_quota_history(
                input["readings"].as_array().unwrap(),
                scalar(&input["maximum"]),
            )?),
            "quota" => quota::derive(
                &runtime_rows(&input["readings"]),
                &runtime_rows(&input["attempts"]),
                scalar(&input["now"]),
            )?,
            "changes" => {
                let mut samples = runtime_rows(&input["quota"]);
                for row in &mut samples {
                    row["tokensPerPercent"]["comparableTokens"] =
                        if row["tokensPerPercent"]["comparableTokens"].is_null() {
                            Value::Null
                        } else {
                            Value::Number(scalar(&row["tokensPerPercent"]["comparableTokens"]))
                        };
                }
                changes::detect(&samples, &runtime_rows(&input["behavior"]))?
            }
            _ => anyhow::bail!("unknown telemetry oracle operation"),
        };
        let actual: Value = serde_json::from_str(&actual.stringify())?;
        assert_eq!(
            actual,
            case["expected"],
            "telemetry case{} {} input{}",
            case["id"],
            case["op"],
            input.stringify()
        );
        count += 1;
    }
    anyhow::ensure!(
        oracle.0.wait()?.success() && receipt == Some(count) && count > 0,
        "incomplete telemetry oracle"
    );
    println!("{count} actual-source telemetry cases matched");
    Ok(())
}
