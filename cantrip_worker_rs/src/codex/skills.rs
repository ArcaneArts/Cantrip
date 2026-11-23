use super::managed::Runtime;
use crate::filesystem::paths;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use regress::Regex;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};

mod library;
pub(crate) mod settings;
pub(super) mod standalone;

pub(super) fn mentions(text: &JsString) -> Vec<JsString> {
    static MENTION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::with_flags(r"(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)", "u").unwrap()
    });
    let mut seen = HashSet::new();
    MENTION
        .find_from_utf16(text.units(), 0)
        .map(|found| JsString::new(text.units()[found.group(1).unwrap()].to_vec()))
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

pub(super) async fn turn_inputs(
    runtime: &Runtime,
    cwd: &JsString,
    requested: &[JsString],
    timeout: Duration,
) -> Result<Vec<Value>> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let (skills, _) = list(runtime, cwd, false, timeout).await?;
    let mut available = HashMap::new();
    for skill in &skills {
        if skill["enabled"] != false
            && let Some(name) = skill["name"].as_js_string().map(JsString::trim)
            && !name.is_empty()
        {
            available
                .entry(name)
                .or_insert_with(|| skill["path"].as_js_string().filter(|path| !path.is_empty()));
        }
    }
    Ok(requested
        .iter()
        .filter_map(|name| {
            let path = available.get(name).copied().flatten()?;
            Some(json!({"type": "skill", "name": name, "path": path}))
        })
        .collect())
}

pub(super) async fn retain_guest_inputs(
    runtime: &Runtime,
    cwd: &JsString,
    input: &mut Vec<Value>,
    timeout: Duration,
) -> Result<()> {
    if !input.iter().any(|item| guest_skill_path(item).is_some()) {
        return Ok(());
    }
    let (skills, _) = list(runtime, cwd, true, timeout).await?;
    let enabled = skills
        .iter()
        .filter(|skill| skill["enabled"] != false)
        .filter_map(|skill| skill["path"].as_str())
        .collect::<HashSet<_>>();
    input.retain(|item| guest_skill_path(item).is_none_or(|path| enabled.contains(path)));
    Ok(())
}

fn guest_skill_path(input: &Value) -> Option<&str> {
    let path = input["path"].as_str()?;
    let qualified = path.strip_prefix("skill://");
    match input["type"].as_str() {
        Some("skill") => Some(qualified.unwrap_or(path)),
        Some("mention") => qualified.or_else(|| {
            path.rsplit(['/', '\\'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
                .then_some(path)
        }),
        _ => None,
    }
}

pub(super) async fn list(
    runtime: &Runtime,
    cwd: &JsString,
    force_reload: bool,
    timeout: Duration,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let response = runtime
        .request(
            "skills/list".into(),
            Some(json!({"cwds": [cwd], "forceReload": force_reload})),
            Some(timeout),
            None,
        )
        .await?
        .unwrap_or(Value::Null);
    let group = group_for_cwd(&response, cwd)?;
    let entries = |key| {
        group
            .and_then(|row| row[key].as_array())
            .cloned()
            .unwrap_or_default()
    };
    Ok((entries("skills"), entries("errors")))
}

pub(super) fn group_for_cwd<'a>(response: &'a Value, cwd: &JsString) -> Result<Option<&'a Value>> {
    let expected = paths::resolve(&paths::native(cwd))?;
    Ok(response["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| {
            row["cwd"]
                .as_js_string()
                .and_then(|cwd| paths::resolve(&paths::native(cwd)).ok())
                .is_some_and(|cwd| paths::equal(&cwd, &expected))
        }))
}
