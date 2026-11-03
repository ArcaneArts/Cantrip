use cantrip_server::{project_automations::schedule, wire::Value};
use std::process::Command;

#[test]
fn automation_occurrences_match_actual_source() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/project-automation-schedule-oracle.mjs",
            "--cases",
        ])
        .current_dir(root)
        .output()
        .expect("Run unchanged Source schedule oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout).unwrap();
    let cases = data["cases"].as_array().unwrap();
    let results = data["results"].as_array().unwrap();
    assert_eq!(cases.len(), results.len());
    for (input, expected) in cases.iter().zip(results) {
        assert_eq!(
            expected["valid"],
            Value::Bool(true),
            "Source fixture validation: {}",
            input.stringify()
        );
        let after = input["afterMs"].as_f64().unwrap() as i64;
        let actual = if input["first"] == Value::Bool(true) {
            schedule::first(&input["schedule"], after)
        } else {
            schedule::next(&input["schedule"], after)
        }
        .unwrap_or_else(|error| panic!("{}: {error}", input.stringify()));
        let expected = expected
            .get("nextMs")
            .expect("Source occurrence result")
            .as_f64()
            .map(|v| v as i64);
        assert_eq!(
            actual,
            expected,
            "{}; Source runtime: {}",
            input.stringify(),
            data["runtime"].stringify(),
        );
    }
    println!(
        "{} actual Source interval, weekly, cron and time-zone occurrences matched; runtime: {}",
        cases.len(),
        data["runtime"].stringify()
    );
}
