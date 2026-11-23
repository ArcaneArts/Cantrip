use anyhow::{Context, Result};
use cantrip_server::wire;
use serde_json::Value;
use std::{path::PathBuf, process::Command};

pub fn security_fixtures(names: &[&str]) -> Result<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args(["scripts/server-rust/security-oracle.mjs", "--fixtures"])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Security fixture oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Shared transport fixtures include lone UTF-16 surrogates. Decode the
    // complete oracle with the wire parser, then convert only the database
    // inputs requested by this suite without changing any selected values.
    let fixtures: wire::Value = serde_json::from_slice(&output.stdout)?;
    let mut selected = serde_json::Map::new();
    for &name in names {
        let samples = fixtures
            .get(name)
            .with_context(|| format!("Missing {name} fixtures"))?;
        selected.insert(
            name.into(),
            serde_json::from_str(&samples.stringify())
                .with_context(|| format!("Database fixture {name}"))?,
        );
    }
    Ok(Value::Object(selected))
}
