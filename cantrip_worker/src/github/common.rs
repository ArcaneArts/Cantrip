//! GitHub projections retain pre-validation JS values, including NaN, and share
//! the actual Git/gh boundaries rather than introducing checkout heuristics.
use super::{api, process};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_wire::{JsString, Value, coercion};
pub(super) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub(super) fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
pub(super) fn nullable(value: Option<&Value>) -> Value {
    value
        .filter(|v| v.is_string())
        .cloned()
        .unwrap_or(Value::Null)
}
pub(super) fn fallback_string(value: &Value, field: &str, fallback: &str) -> Result<Value> {
    let value = api::member(value, field)?;
    Ok(Value::String(if coercion::truthy(value) {
        api::text(value)?
    } else {
        fallback.into()
    }))
}
pub(super) fn fallback_number(value: &Value, field: &str, fallback: f64) -> Result<Value> {
    let number = api::number(value, field)?;
    Ok(if coercion::truthy(Some(&number)) {
        number
    } else {
        Value::Number(fallback)
    })
}
pub(super) fn crop(value: &JsString, maximum: usize) -> JsString {
    JsString::new(value.units().iter().take(maximum).copied().collect())
}
pub(super) fn join(values: &[JsString], separator: &str) -> JsString {
    let mut result = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            result.extend(separator.encode_utf16());
        }
        result.extend(value.units());
    }
    JsString::new(result)
}
pub(super) fn now() -> Value {
    Value::String(
        chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .into(),
    )
}
pub(super) async fn git(command: &Value, args: &[JsString], scope: &Scope) -> Result<JsString> {
    let mut arguments = vec!["-C".into(), command["cwd"].as_js_string().unwrap().clone()];
    arguments.extend_from_slice(args);
    Ok(process::run_program("git", &arguments, 1024 * 1024, scope)
        .await?
        .into())
}
pub(super) async fn verify(command: &Value, scope: &Scope) -> Result<()> {
    git(command, &["rev-parse".into(), "--git-dir".into()], scope).await?;
    Ok(())
}
pub(super) async fn remote(command: &Value, scope: &Scope) -> Result<Option<JsString>> {
    let output = git(command, &["remote".into()], scope).await?;
    let expected = command["repository"].as_js_string().unwrap().lowercase();
    let mut matches = Vec::new();
    for name in output.units().split(|unit| *unit == 10) {
        let name = JsString::new(name.to_vec()).trim();
        if name.is_empty() {
            continue;
        }
        let url = git(
            command,
            &["remote".into(), "get-url".into(), name.clone()],
            scope,
        )
        .await?;
        if crate::filesystem::repository::github_repository_from_remote(&url).as_ref()
            == Some(&expected)
        {
            matches.push(name);
        }
    }
    Ok(matches
        .iter()
        .find(|name| name.units() == [111, 114, 105, 103, 105, 110])
        .or_else(|| matches.first())
        .cloned())
}
pub(super) fn slug(value: &JsString, maximum: usize) -> String {
    let normalized =
        icu_normalizer::DecomposingNormalizer::new_nfkd().normalize_utf16(value.units());
    let normalized = JsString::new(normalized.into_owned()).lowercase();
    let mut result = String::new();
    let mut invalid = false;
    for &unit in normalized.units() {
        if (97..=122).contains(&unit) || (48..=57).contains(&unit) || [46, 95, 45].contains(&unit) {
            result.push(unit as u8 as char);
            invalid = false;
        } else if !invalid {
            result.push('-');
            invalid = true;
        }
    }
    let mut result = result.trim_matches('-').to_owned();
    result.truncate(maximum);
    result
}
