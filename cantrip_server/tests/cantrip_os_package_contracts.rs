use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn package_policies_and_ciphertext_bounds_match_source() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/cantrip-os-package-policy-vectors.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in cases
        .as_array()
        .context("Package policy cases")?
        .iter()
        .enumerate()
    {
        let name = case["schema"].as_str().context("Package policy schema")?;
        let actual = match wire::parse(name, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(
            actual, case["outcome"],
            "Package policy/bound {index} {name}"
        );
    }
    println!("7 explicit package policy and ciphertext-bound cases matched source");
    Ok(())
}

#[test]
fn package_contracts_match_source_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "cantripOsPackageArtifactSchema",
        "cantripOsPackageArtifactsSchema",
        "cantripOsPackageManifestSchema",
        "cantripOsPackageExpectedSchema",
        "cantripOsPackageTargetSchema",
        "cantripOsGuestPackageRequestSchema",
        "cantripOsPackageInstalledSchema",
        "cantripOsPackageProbeSchema",
        "cantripOsGuestPackageRecordSchema",
        "cantripOsPackageScopeSchema",
        "cantripOsPackageOperationCommandSchema",
        "cantripOsPackageWorkerCommandSchema",
        "cantripOsPackageCatalogResultSchema",
        "cantripOsPackageCryptoContextSchema",
        "cantripOsPackageProtectedResultSchema",
        "cantripOsPackageOperationResultSchema",
        "cantripOsPackagePrivateResultSchema",
        "cantripOsPackageTargetSummarySchema",
        "cantripOsPackageStatusSchema",
        "cantripOsPackageCreateSchema",
        "cantripOsPackageControlSchema",
        "cantripOsPackageSummarySchema",
        "cantripOsPackageListQuerySchema",
        "cantripOsPackagePageSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Source cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(name, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(actual, case["outcome"], "{name} case {index}");
            count += 1;
        }
    }
    println!("{count} package validation cases matched actual source protocol");
    Ok(())
}
