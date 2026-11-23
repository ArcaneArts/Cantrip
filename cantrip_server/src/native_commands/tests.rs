use super::*;
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
use std::{path::PathBuf, process::Command};

#[test]
fn settings_and_permission_transitions_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/native-settings-state-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Settings state oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let cases = oracle["cases"]
        .as_array()
        .context("Native settings transition cases")?;
    for (index, case) in cases.iter().enumerate() {
        let outcome: Result<Value> = match case["kind"].as_str().context("Settings operation")? {
            "empty" => settings_state::empty(case["chat"].as_str().context("Settings Chat")?),
            "request" => settings_state::request(&case["value"], &case["intent"]),
            "bind" => settings_state::bind(
                &case["value"],
                &case["expected"],
                &case["binding"],
                &case["snapshot"],
            ),
            "observe" => {
                settings_state::observe(&case["value"], &case["bindingId"], &case["snapshot"])
            }
            "settle" => settings_state::settle(
                &case["value"],
                &case["operation"],
                case["outcome"].as_str().context("Settings outcome")?,
            ),
            "resolve-permission" => Ok(permissions::resolve(
                &case["context"],
                &case["selectedId"],
                &case["revision"],
            )),
            "assert-permission" => {
                permissions::assert_transition(&case["context"], &case["value"], &case["input"])
                    .map(|()| Value::Null)
            }
            _ => anyhow::bail!("Unknown native settings oracle operation"),
        };
        let actual = match outcome {
            Ok(value) => json!({"ok":value}),
            Err(error) => {
                let mut result = json!({"error":error.to_string()});
                if let Some(error) = error.downcast_ref::<CommandError>() {
                    result["code"] = json!(error.code);
                    result["status"] = json!(error.status);
                }
                result
            }
        };
        assert_eq!(
            actual,
            case["result"],
            "native settings case {index}: {}",
            case["kind"].stringify()
        );
    }
    println!(
        "{} actual settings and permission transition cases matched",
        cases.len()
    );
    Ok(())
}

#[test]
fn command_policy_matches_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/native-command-policy-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Policy oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let cases = oracle["cases"].as_array().context("Command policy cases")?;
    for (index, case) in cases.iter().enumerate() {
        let mut input = oracle["base"].clone();
        let Value::Object(fields) = &mut input else {
            anyhow::bail!("Policy base must be an object");
        };
        for (key, value) in case["input"].as_object().context("Policy input")? {
            fields.insert(key.clone(), value.clone());
        }
        let actual = match policy::classify_admission(&input) {
            Ok(value) => json!({"ok":Value::from_serialize(&value)}),
            Err(error) => {
                let error = error
                    .downcast_ref::<CommandError>()
                    .context("Typed command rejection")?;
                json!({"error":json!({"code":error.code,"status":error.status,"message":error.message})})
            }
        };
        assert_eq!(
            actual, case["outcome"],
            "Policy case {index}: {:?}",
            case["input"]
        );
    }
    println!("{} actual native command policy cases matched", cases.len());
    Ok(())
}

#[test]
fn receipt_and_context_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/native-command-query-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Command query oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let receipts = oracle["receipts"].as_array().context("Receipt oracle")?;
    for (index, case) in receipts.iter().enumerate() {
        let actual = match receipt::from_row(&case["row"]) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(actual, case["outcome"], "receipt case {index}");
    }
    let placements = oracle["placements"]
        .as_array()
        .context("Placement oracle")?;
    for (index, case) in placements.iter().enumerate() {
        let outcome = |value: Result<bool>| match value {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(
            outcome(context::same_placement(
                case.get("context"),
                &case["worker"],
                case.get("session")
            )),
            case["placement"],
            "placement case {index}"
        );
        assert_eq!(
            outcome(context::same_runtime_route(
                case.get("context"),
                case.get("session")
            )),
            case["route"],
            "route case {index}"
        );
    }
    println!(
        "{} receipt and {} native command context cases matched",
        receipts.len(),
        placements.len()
    );
    for (index, case) in oracle["intents"]
        .as_array()
        .context("Intent identities")?
        .iter()
        .enumerate()
    {
        let actual = match admission::intent_identity(case.get("input")) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(actual, case["outcome"], "intent sort/serialization {index}");
    }
    Ok(())
}
