use anyhow::{Context, Result};
use cantrip_server::wire::Value;
use std::process::Command;

#[test]
fn lowercase_matches_node_for_every_code_point_and_utf16_surrogates() -> Result<()> {
    let output = Command::new("node").args(["--input-type=module", "-e", r#"
        const cases = [];
        for (let start = 0; start <= 0x10ffff; start += 2048) {
            let text = '';
            for (let cp = start; cp <= Math.min(start + 2047, 0x10ffff); cp++)
                text += String.fromCodePoint(cp) + '|';
            cases.push([text, text.toLowerCase()]);
        }
        for (const text of ['ΟΣ', 'ΟΣΑ', 'ΟΣ́', 'ΟΣ\ud800Α', '\ud800ΟΣ', 'İ', 'ÁΣ', 'Σ\u0345', 'Ο\u0345Σ'])
            cases.push([text, text.toLowerCase()]);
        console.log(JSON.stringify(cases));
    "#]).output()?;
    anyhow::ensure!(
        output.status.success(),
        "Node lowercase oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    let cases = cases.as_array().context("lowercase cases")?;
    for (index, case) in cases.iter().enumerate() {
        let case = case.as_array().context("lowercase pair")?;
        let input = case[0].as_js_string().context("case input")?;
        let expected = case[1].as_js_string().context("expected lowercase")?;
        let actual = input.lowercase();
        if &actual != expected {
            let at = actual
                .units()
                .iter()
                .zip(expected.units())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| actual.len().min(expected.len()));
            anyhow::bail!(
                "Lowercase batch {index}, unit {at}: actual {:?}, expected {:?}",
                &actual.units()[at.saturating_sub(8)..(at + 8).min(actual.len())],
                &expected.units()[at.saturating_sub(8)..(at + 8).min(expected.len())]
            );
        }
    }
    println!(
        "Every Unicode code point, unpaired UTF-16 unit and {} contextual cases matched actual Node lowercase",
        cases.len() - 544
    );
    Ok(())
}
