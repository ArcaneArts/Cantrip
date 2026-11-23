//! Existing bundled-manifest integrity contract. Artifacts are read through the
//! actual filesystem; this does not substitute a guessed capability check.
use super::Installation;
use crate::filesystem::{explorer::io_error, paths};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, parse_json_text};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
fn hexadecimal(value: &Value, length: usize) -> bool {
    value.as_js_string().is_some_and(|v| {
        v.units().len() == length && v.units().iter().all(|c| matches!(*c,48..=57|97..=102))
    })
}
fn relative(value: &Value) -> bool {
    value.as_js_string().is_some_and(|value| {
        !value.is_empty()
            && !paths::absolute(&paths::native(value))
            && !value
                .units()
                .split(|u| matches!(*u, 47 | 92))
                .any(|part| part == [46, 46])
    })
}
pub fn parse(value: Value) -> Result<Value> {
    let artifacts = value["artifacts"].as_array();
    let mut seen = HashSet::<JsString>::new();
    let artifacts_valid = artifacts.is_some_and(|artifacts| {
        !artifacts.is_empty()
            && artifacts.iter().all(|artifact| {
                relative(&artifact["path"])
                    && seen.insert(artifact["path"].as_js_string().unwrap().clone())
            })
            && artifacts.iter().any(|v| v["path"] == value["entrypoint"])
    });
    let recipe = value["buildRecipeVersion"].as_u64();
    if value["schemaVersion"] != cantrip_wire::value::json!(1)
        || value["component"] != "codex-cli"
        || value["profile"] != "release"
        || !value["version"].is_string()
        || !value["target"].is_string()
        || !relative(&value["entrypoint"])
        || !artifacts_valid
        || recipe.is_none_or(|v| !(1..=6).contains(&v))
        || recipe.is_some_and(|v| v >= 5) && !hexadecimal(&value["skillTemplatesSha256"], 64)
        || !value["upstream"]["repository"].is_string()
        || !value["upstream"]["ref"].is_string()
        || !hexadecimal(&value["upstream"]["commit"], 40)
    {
        bail!("Bundled Codex manifest is invalid.");
    }
    Ok(value)
}
pub async fn verify(
    installation: &Installation,
    platform: &str,
    architecture: &str,
    cwd: &Path,
) -> Result<Option<Value>> {
    let Some(manifest_path) = &installation.manifest_path else {
        return Ok(None);
    };
    let read = async {
        let bytes = tokio::fs::read(manifest_path)
            .await
            .map_err(|error| io_error("open", manifest_path, error))?;
        let value =
            parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(crate::error::WireError)?;
        parse(value)
    }
    .await;
    let manifest = read.map_err(|error| {
        anyhow::anyhow!(
            "Could not validate bundled Codex manifest {}: {}",
            manifest_path.display(),
            crate::error::message(&error)
        )
    })?;
    let expected = format!("{platform}-{architecture}");
    if manifest["target"] != cantrip_wire::Value::String(expected.clone().into()) {
        bail!(
            "Bundled Codex targets {}; worker requires {expected}.",
            manifest["target"].as_js_string().unwrap().lossy()
        );
    }
    let directory = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let resolve = |path: PathBuf| cantrip_config::resolve(cwd, &path);
    let entrypoint = resolve(directory.join(paths::native(
        manifest["entrypoint"].as_js_string().unwrap(),
    )));
    if resolve(installation.binary.clone()) != entrypoint {
        bail!(
            "Bundled Codex entrypoint {} does not match {}.",
            entrypoint.display(),
            installation.binary.display()
        );
    }
    for artifact in manifest["artifacts"].as_array().unwrap() {
        let path = resolve(directory.join(paths::native(artifact["path"].as_js_string().unwrap())));
        let result = tokio::fs::metadata(&path)
            .await
            .map_err(|error| io_error("stat", &path, error));
        match result {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => bail!(
                "Could not read bundled Codex artifact {}: artifact is not a file",
                path.display()
            ),
            Err(error) => bail!(
                "Could not read bundled Codex artifact {}: {}",
                path.display(),
                crate::error::message(&error)
            ),
        }
    }
    Ok(Some(manifest))
}
