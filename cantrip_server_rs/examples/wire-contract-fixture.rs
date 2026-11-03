// Development-only streaming access to the same native wire parser as HTTP.
use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::io::{self, BufRead, Write};

fn main() -> Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let case: Value = serde_json::from_str(&line?)?;
        let schema = case["schema"].as_str().context("wire schema name")?;
        let outcome = match wire::parse(schema, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        let mut response = Value::object([("outcome", outcome.clone())]);
        if outcome.get("issues").is_some() {
            response["errorMessage"] = Value::String(outcome["issues"].stringify_pretty().into());
        }
        writeln!(output, "{}", response.stringify())?;
        output.flush()?;
    }
    Ok(())
}
