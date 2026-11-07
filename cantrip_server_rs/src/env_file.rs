//! Node 24 dotenv syntax for native distribution launchers. Values are data:
//! no shell evaluation, variable expansion, or command execution occurs.
//! Reference: https://github.com/nodejs/node/blob/v24.22.1/src/node_dotenv.cc
use crate::config::Environment;
use anyhow::{Context, Result};
use std::{collections::BTreeMap, path::Path};

fn trim(input: &str) -> &str {
    input.trim_matches([' ', '\t', '\n'])
}

pub fn parse(input: &str) -> BTreeMap<String, String> {
    let lines = input.replace('\r', "");
    let mut content = trim(&lines);
    // Node applies its std::map in byte-sorted key order. This also determines
    // precedence when distinct raw names share a NUL-terminated OS name.
    let mut values = BTreeMap::new();
    while !content.is_empty() {
        if content.starts_with(['\n', '#']) {
            content = content.split_once('\n').map_or("", |(_, rest)| rest);
            continue;
        }
        let Some(index) = content.find(['=', '\n']) else {
            break;
        };
        if content.as_bytes()[index] == b'\n' {
            content = trim(&content[index + 1..]);
            continue;
        }
        let mut key = trim(&content[..index]);
        content = &content[index + 1..];
        if content.is_empty() || content.starts_with('\n') {
            values.insert(key.to_owned(), String::new());
            continue;
        }
        content = trim(content);
        if key.is_empty() {
            continue;
        }
        if let Some(exported) = key.strip_prefix("export ") {
            key = trim(exported);
        }
        if content.is_empty() {
            values.insert(key.to_owned(), String::new());
            break;
        }
        let quote = content.as_bytes()[0];
        if matches!(quote, b'\'' | b'"' | b'`') {
            if let Some(closing) = content[1..].find(quote as char).map(|at| at + 1) {
                let raw = &content[1..closing];
                let value = if quote == b'"' {
                    raw.replace("\\n", "\n")
                } else {
                    raw.to_owned()
                };
                values.insert(key.to_owned(), value);
                content = content[closing + 1..]
                    .split_once('\n')
                    .map_or("", |(_, rest)| rest);
                continue;
            }
            let (value, rest) = content.split_once('\n').unwrap_or((content, ""));
            values.insert(key.to_owned(), value.to_owned());
            content = trim(rest);
        } else {
            let (value, rest) = content.split_once('\n').unwrap_or((content, ""));
            let value = value.split_once('#').map_or(value, |(value, _)| value);
            values.insert(key.to_owned(), trim(value).to_owned());
            content = trim(rest);
        }
    }
    values
}

fn process_values(input: &str) -> impl Iterator<Item = (String, String)> {
    parse(input).into_iter().filter_map(|(name, value)| {
        // Node's real process environment uses NUL-terminated UTF-8 strings.
        let name = name.split('\0').next().unwrap();
        let value = value.split('\0').next().unwrap();
        if name.is_empty() || name.contains('=') {
            return None;
        }
        Some((name.to_owned(), value.to_owned()))
    })
}

/// Apply parsed values to a case-sensitive configuration map. The executable
/// additionally uses the operating system's own process-variable lookup rules.
pub fn apply_to(environment: &mut Environment, input: &str) {
    for (name, value) in process_values(input) {
        environment.entry(name).or_insert(value);
    }
}

/// Invoke only from the synchronous executable entry, before starting Tokio,
/// database threads, or other readers of the process environment.
///
/// # Safety
/// The caller must ensure no other threads are reading the environment.
pub unsafe fn load_if_exists(path: &Path) -> Result<()> {
    let input = match std::fs::read(path) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("read server environment file"),
    };
    // Apply the sorted entries directly to the OS environment. In particular,
    // Windows case aliases must retain the first sorted value just as Node's
    // real environment store does; iterating a HashMap here would randomize it.
    for (name, value) in process_values(&String::from_utf8_lossy(&input)) {
        if std::env::var_os(&name).is_some() {
            continue;
        }
        // SAFETY: upheld by this function's startup-only caller contract.
        unsafe {
            std::env::set_var(name, value);
        }
    }
    Ok(())
}
