use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

struct Oracle(Option<Child>);
impl Drop for Oracle {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn preview(value: &Value) -> String {
    value.stringify().chars().take(4096).collect()
}
fn compare(mode: &str) -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut command = Command::new("node");
    command
        .arg("scripts/server-rust/worker-command-oracle.mjs")
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if mode != "mutations" {
        command.arg(format!("--{mode}"));
    }
    let mut oracle = Oracle(Some(command.spawn()?));
    let reader = BufReader::new(
        oracle
            .0
            .as_mut()
            .unwrap()
            .stdout
            .take()
            .context("oracle stdout")?,
    );
    let mut count = 0;
    let mut receipt = None;
    for line in reader.lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if case.get("done").is_some() {
            anyhow::ensure!(receipt.is_none(), "Duplicate oracle completion receipt");
            receipt = Some(case);
            continue;
        }
        anyhow::ensure!(
            receipt.is_none(),
            "Oracle output followed its completion receipt"
        );
        let input = case
            .get("raw")
            .and_then(Value::as_str)
            .map(serde_json::from_str::<Value>)
            .transpose()?;
        let result = match wire::parse("workerRequestEnvelopeSchema", input.as_ref()) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        let actual: Value = serde_json::from_str(&result.stringify())?;
        anyhow::ensure!(
            actual == case["outcome"],
            "Command case {count} {} differed:\nactual {}\nexpected {}",
            case["name"],
            preview(&actual),
            preview(&case["outcome"])
        );
        count += 1;
    }
    let status = oracle.0.as_mut().unwrap().wait()?;
    oracle.0 = None;
    anyhow::ensure!(status.success(), "Command oracle failed: {status}");
    let receipt = receipt.context("missing actual oracle completion receipt")?;
    if mode == "mutations" {
        let executed = receipt["customChecksExecuted"].as_u64();
        let registered = receipt["customChecks"].as_u64();
        anyhow::ensure!(
            registered.is_some_and(|count| count > 0) && executed == registered,
            "Unexercised authoritative command checks: {receipt}"
        );
        for key in [
            "unionSchemas",
            "unionAlternatives",
            "enumSchemas",
            "enumAlternatives",
        ] {
            anyhow::ensure!(
                receipt[key].as_u64().is_some_and(|count| count > 0),
                "Missing actual alternative coverage: {receipt}"
            );
        }
    } else if mode == "smoke" {
        anyhow::ensure!(
            receipt["commandTypes"].as_u64() == Some(count),
            "Incomplete command inventory comparison: {receipt}"
        );
    }
    anyhow::ensure!(
        count > 0 && receipt["done"].as_f64() == Some(count as f64),
        "Incomplete command comparison: {count} cases, receipt {receipt}"
    );
    println!("{count} actual worker request comparisons matched: {receipt}",);
    Ok(())
}
#[test]
fn all_command_fixtures_match_actual_protocol() -> Result<()> {
    compare("smoke")
}
#[test]
fn command_mutations_match_actual_protocol() -> Result<()> {
    compare("mutations")
}
#[test]
fn command_boundaries_match_actual_protocol() -> Result<()> {
    compare("boundaries")
}
