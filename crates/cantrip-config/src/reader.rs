//! Environment readers retain the existing missing, empty, trim, and numeric rules.
use crate::{ConfigError, Result};
use serde_json::json;
use std::collections::HashMap;

pub type Environment = HashMap<String, String>;

use cantrip_wire::text::{trim, whitespace};

pub struct Reader<'a>(pub &'a Environment);

impl Reader<'_> {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
    pub fn text(&self, name: &str, default: &str) -> String {
        self.get(name).unwrap_or(default).into()
    }
    // Keep empty strings where the TypeScript source used ?.trim() without ||.
    pub fn trimmed(&self, name: &str) -> Option<String> {
        self.get(name).map(|value| trim(value).into())
    }
    pub fn nonempty(&self, name: &str) -> Option<String> {
        self.trimmed(name).filter(|value| !value.is_empty())
    }
    pub fn boolean(&self, name: &str) -> Result<bool> {
        match self.get(name) {
            None | Some("false" | "0") => Ok(false),
            Some("true" | "1") => Ok(true),
            _ => Err(ConfigError::new(format!(
                "Invalid {name}: expected true, false, 1, or 0."
            ))),
        }
    }
    pub fn enabled(&self, name: &str) -> Result<bool> {
        Ok(self.get(name).is_none() || self.boolean(name)?)
    }
    pub fn bounded(&self, name: &str, fallback: u64, minimum: u64, maximum: u64) -> Result<u64> {
        let Some(raw) = self.get(name) else {
            return Ok(fallback);
        };
        let input = raw.trim_start_matches(whitespace);
        let (negative, input) = if let Some(rest) = input.strip_prefix('-') {
            (true, rest)
        } else {
            (false, input.strip_prefix('+').unwrap_or(input))
        };
        let digits = &input[..input.bytes().take_while(u8::is_ascii_digit).count()];
        if let Ok(value) = digits.parse::<u64>()
            && (!negative || value == 0)
            && value >= minimum
            && value <= maximum
        {
            return Ok(value);
        }
        Err(ConfigError::new(format!("Invalid {name}: {raw}")))
    }
    pub fn list(&self, name: &str, fallback: &[&str], unique: bool) -> Result<Vec<String>> {
        let values: Vec<_> = match self.get(name) {
            Some(value) => value
                .split(',')
                .map(trim)
                .filter(|v| !v.is_empty())
                .map(String::from)
                .collect(),
            None => fallback.iter().map(|v| String::from(*v)).collect(),
        };
        if unique {
            let mut seen = std::collections::HashSet::new();
            if values.iter().any(|v| !seen.insert(v)) {
                return Err(ConfigError::new(format!("{name} entries must be unique.")));
            }
        }
        Ok(values)
    }
}

pub fn enumeration(
    reader: &Reader<'_>,
    name: &str,
    default: &str,
    choices: &[&str],
) -> Result<String> {
    let value = reader.text(name, default);
    if choices.contains(&value.as_str()) {
        return Ok(value);
    }
    let options = choices
        .iter()
        .map(|v| format!("\"{v}\""))
        .collect::<Vec<_>>()
        .join("|");
    Err(ConfigError::zod(vec![
        json!({"code":"invalid_value", "values":choices, "path":[], "message":format!("Invalid option: expected one of {options}")}),
    ]))
}
