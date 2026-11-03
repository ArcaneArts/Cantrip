use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::Path, process::Command};

#[test]
fn project_automation_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    let mut differences = 0;
    for schema in [
        "projectAutomationIntervalScheduleSchema",
        "projectAutomationWeeklyScheduleSchema",
        "projectAutomationCronScheduleSchema",
        "projectAutomationScheduleSchema",
        "projectAutomationOpaqueContentSchema",
        "encryptedProjectAutomationCreateSchema",
        "encryptedProjectAutomationUpdateSchema",
        "projectAutomationWireSchema",
        "projectAutomationWireListSchema",
        "projectAutomationDispatchRequestSchema",
        "projectAutomationDispatchResultSchema",
        "projectAutomationProtectedDispatchResultSchema",
    ] {
        let output = Command::new("node")
            .args([
                "scripts/server-rust/security-oracle.mjs",
                "--vectors",
                schema,
            ])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "{schema}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Automation cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(schema, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            let differs = actual != case["outcome"]
                || case.get("errorMessage").is_some_and(|message| {
                    Value::String(actual["issues"].stringify_pretty().into()) != *message
                });
            if differs {
                differences += 1;
                if differences <= 20 {
                    eprintln!(
                        "{schema} case {index}\ninput: {}\nexpected: {}\nactual: {}",
                        case.get("input").unwrap_or(&Value::Null).stringify(),
                        case["outcome"].stringify(),
                        actual.stringify()
                    );
                }
            }
            total += 1;
        }
    }
    assert_eq!(
        differences, 0,
        "{differences} differences across {total} actual Source automation contract cases"
    );
    println!(
        "{total} actual Source automation contracts, transformations and exact validation messages matched"
    );
    Ok(())
}
