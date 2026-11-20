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

pub(super) async fn host_inputs(
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

async fn list(
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
    let expected = paths::resolve(&paths::native(cwd))?;
    let group = response["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| {
            row["cwd"]
                .as_js_string()
                .and_then(|cwd| paths::resolve(&paths::native(cwd)).ok())
                .is_some_and(|cwd| paths::equal(&cwd, &expected))
        });
    let entries = |key| {
        group
            .and_then(|row| row[key].as_array())
            .cloned()
            .unwrap_or_default()
    };
    Ok((entries("skills"), entries("errors")))
}
