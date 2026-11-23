use super::*;
use anyhow::Context;
use std::{path::PathBuf, process::Command};

#[test]
fn helper_parsing_and_utf16_bounds_match_actual_source() -> anyhow::Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/worker-link-authority-parser-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "WorkerLink Source oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let source = wire::parse_json_text(&String::from_utf8(output.stdout)?)
        .map_err(|_| anyhow::anyhow!("Source oracle JSON"))?;
    let cases = source["cases"]
        .as_array()
        .context("Source authority helper cases")?;
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let result: Result<Option<Value>> = match case["kind"].as_str().context("Source helper")? {
            "parseOperation" => parse::operation(input),
            "parseRevokeScope" => Ok(parse::revoke_scope(input)),
            "parseRelayRevokeScope" => Ok(parse::relay_scope(input)),
            "boundedError" => Ok(Some(Value::String(bounded(
                input.as_js_string().context("Bounded string")?,
            )))),
            _ => anyhow::bail!("Unknown authority helper"),
        };
        let actual = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        assert_eq!(
            actual,
            case["result"],
            "authority helper case {index}: {} {}",
            case["kind"].stringify(),
            input.stringify()
        );
    }
    println!(
        "{} actual Source authority parser and UTF16 cases matched",
        cases.len()
    );
    Ok(())
}
