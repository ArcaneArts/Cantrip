use anyhow::Result;
use std::{path::Path, process::Command};

#[test]
fn embedded_policy_templates_and_limits_match_authoritative_sources() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/policy-assets.mjs")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(&expected, cantrip_server::policies::assets());
    Ok(())
}
