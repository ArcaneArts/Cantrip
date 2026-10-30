use anyhow::{Context, Result};
use cantrip_server::{wire::Value, workspace_layouts};
use std::{path::PathBuf, process::Command};

#[test]
fn seed_import_and_receipt_identity_match_the_actual_shared_functions() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/workspace-model-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source model oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    let mut count = 0;
    for case in cases["cases"].as_array().context("Actual model cases")? {
        let result = match case["operation"].as_str().context("Model operation")? {
            "seed" => workspace_layouts::seed(&case["input"]),
            "import" => workspace_layouts::import_legacy_files(
                &case["initial"],
                &case["input"],
                &case["titles"],
            ),
            "apply" => workspace_layouts::apply(&case["initial"], &case["input"]),
            "strict" => {
                let left: Value = serde_json::from_str(case["left"].as_str().unwrap())?;
                let right: Value = serde_json::from_str(case["right"].as_str().unwrap())?;
                Ok(Value::Bool(workspace_layouts::strict_equal(&left, &right)))
            }
            _ => anyhow::bail!("Unknown actual model operation"),
        };
        let outcome = match result {
            Ok(value) => Value::object([("value", value)]),
            Err(error) => {
                let mut fields = vec![
                    ("name", Value::String(error.name.into())),
                    ("message", Value::String(error.message.into())),
                ];
                if let Some(code) = error.code {
                    fields.push(("code", Value::String(code.into())));
                }
                Value::object([("error", Value::object(fields))])
            }
        };
        assert_eq!(
            outcome, case["outcome"],
            "Actual Source model case {}",
            case["name"]
        );
        count += 1;
    }
    println!("{count} actual seed/import/deep-strict-identity cases matched");
    Ok(())
}

#[test]
fn resource_deletion_matches_the_actual_transaction_helper() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/workspace-removal-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source cleanup oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    let cases = cases["cases"].as_array().context("Actual removal cases")?;
    for case in cases {
        let result = cantrip_server::workspaces::remove_views(
            &case["initial"],
            case["project"].as_str().unwrap(),
            case["definition"].as_str().unwrap(),
            case["resource"].as_str().unwrap(),
        );
        let outcome = match result {
            Ok(value) => Value::object([("value", value)]),
            Err(error) => {
                let model = error.downcast_ref::<workspace_layouts::ModelError>();
                let mut fields = vec![
                    (
                        "name",
                        Value::String(model.map_or("Error", |e| e.name).into()),
                    ),
                    ("message", Value::String(error.to_string().into())),
                ];
                if let Some(code) = model.and_then(|e| e.code) {
                    fields.push(("code", Value::String(code.into())));
                }
                Value::object([("error", Value::object(fields))])
            }
        };
        assert_eq!(
            outcome, case["outcome"],
            "Actual Source cleanup {}",
            case["name"]
        );
    }
    println!(
        "{} actual resource deletion ownership cases matched",
        cases.len()
    );
    Ok(())
}
