use anyhow::Result;
use cantrip_server::{
    wire::{self, Value},
    workers::request,
};
use std::path::PathBuf;

#[test]
fn heartbeat_text_and_dates_match_actual_node_boundaries() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = std::process::Command::new("node")
        .args([
            "scripts/server-rust/worker-oracle.mjs",
            "--heartbeat-boundaries",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Worker boundary oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let parsed = wire::parse("workerHeartbeatSchema", case.get("input"));
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "Heartbeat validation case {index}"
        );
        if let Ok(parsed) = parsed {
            assert_eq!(
                Value::from_serialize(&request::heartbeat(parsed)?),
                case["stored"],
                "Heartbeat conversion case {index}"
            );
        }
    }
    Ok(())
}
