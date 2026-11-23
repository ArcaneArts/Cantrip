//! Common GitHub REST/GraphQL subprocess and JavaScript value boundaries.
use super::{Client, process};
use crate::{error::WireError, filesystem::Scope};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, coercion, parse_json_text};

pub(super) fn parse(raw: &str) -> Result<Value> {
    parse_json_text(raw).map_err(|error| WireError(error).into())
}
// JavaScript Array.flat() removes exactly one level here, not arbitrary nesting.
pub(super) fn pages<'a>(value: &'a Value, name: &str) -> Result<Vec<&'a Value>> {
    let values = value.as_array().ok_or_else(|| {
        if value.is_null() {
            anyhow!("Cannot read properties of null (reading 'flat')")
        } else {
            anyhow!("{name}.flat is not a function")
        }
    })?;
    Ok(values
        .iter()
        .flat_map(|value| {
            value
                .as_array()
                .map_or_else(|| vec![value], |values| values.iter().collect())
        })
        .collect())
}
pub(super) fn member<'a>(value: &'a Value, field: &str) -> Result<Option<&'a Value>> {
    if value.is_null() {
        return Err(anyhow!(
            "Cannot read properties of null (reading '{field}')"
        ));
    }
    Ok(value.get(field))
}
pub(super) fn text(value: Option<&Value>) -> Result<JsString> {
    match value {
        Some(value) => {
            coercion::string(value).map_err(|_| anyhow!("Cannot convert object to primitive value"))
        }
        None => Ok("undefined".into()),
    }
}
pub(super) fn string(value: &Value, field: &str) -> Result<Value> {
    text(member(value, field)?).map(Value::String)
}
pub(super) fn number(value: &Value, field: &str) -> Result<Value> {
    coercion::number(member(value, field)?)
        .map(Value::Number)
        .map_err(|_| anyhow!("Cannot convert object to primitive value"))
}
pub(super) fn repository_path(name: &JsString) -> Result<String> {
    let parts = name.units().split(|unit| *unit == 47).collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == [46]
                || *part == [46, 46]
                || part.iter().any(|unit| {
                    *unit >= 128
                        || !((*unit as u8).is_ascii_alphanumeric() || [95, 46, 45].contains(unit))
                })
        })
    {
        return Err(WireError(prefix("Invalid GitHub repository name: ", name)).into());
    }
    Ok(format!("repos/{}", name.lossy()))
}
pub(super) fn prefix(prefix: &str, value: &JsString) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(value.units().iter().copied())
            .collect(),
    )
}
pub async fn repository_for_checkout(cwd: &std::path::Path, scope: &Scope) -> Option<JsString> {
    let args = [
        "-C".into(),
        cwd.as_os_str().to_owned(),
        "config".into(),
        "--get".into(),
        "remote.origin.url".into(),
    ];
    let output = scope
        .run("git".as_ref(), &args, 1024 * 1024, 10_000)
        .await
        .ok()?;
    crate::filesystem::repository::github_repository_from_remote(&output.into())
}
impl Client {
    pub(super) async fn api(&self, path: &str, args: &[JsString], scope: &Scope) -> Result<Value> {
        request(path, args, scope).await
    }
}
pub(super) async fn request(path: &str, args: &[JsString], scope: &Scope) -> Result<Value> {
    let mut arguments = vec!["api".into(), path.into()];
    arguments.extend_from_slice(args);
    parse(&process::run_values(&arguments, 32 * 1024 * 1024, scope).await?)
}
