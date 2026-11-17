use super::{ProcessError, Scope};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use regress::Regex;
use std::sync::OnceLock;

pub fn parse_github_origin(origin: &JsString) -> Option<Value> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
        r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,99})/([A-Za-z0-9._-]+?)(?:\.git)?/?$",
        r"^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,99})/([A-Za-z0-9._-]+?)(?:\.git)?$",
        r"^ssh://git@github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,99})/([A-Za-z0-9._-]+?)(?:\.git)?/?$",
    ].iter().map(|pattern|Regex::with_flags(pattern,"iu").unwrap()).collect()
    });
    let origin = origin.trim();
    for pattern in patterns {
        let Some(found) = pattern.find_from_utf16(origin.units(), 0).next() else {
            continue;
        };
        let owner = JsString::new(origin.units()[found.group(1)?].to_vec());
        let repository = JsString::new(origin.units()[found.group(2)?].to_vec());
        if repository == ".".into() || repository == "..".into() {
            return None;
        }
        let name = JsString::new([owner.units(), &[47], repository.units()].concat());
        return Some(
            json!({"nameWithOwner":name,"url":JsString::new([JsString::from("https://github.com/").units(),name.units()].concat())}),
        );
    }
    None
}
fn classification(origin: &Value, kind: &str, diagnostic: Option<&str>, github: Value) -> Value {
    json!({"classification":kind,"diagnosticCode":diagnostic,"github":github,"originUrl":origin})
}
pub async fn classify_origin(
    origin: &Value,
    maximum: usize,
    timeout: u64,
    scope: &Scope,
) -> Result<Value> {
    let origin = origin
        .as_js_string()
        .map(JsString::trim)
        .filter(|s| !s.is_empty());
    let Some(origin) = origin else {
        return Ok(classification(&Value::Null, "local-git", None, Value::Null));
    };
    if origin.units().len() > 32768 {
        return Ok(classification(
            &Value::Null,
            "local-git",
            Some("origin-invalid"),
            Value::Null,
        ));
    }
    let origin = Value::String(origin);
    let Some(expected) = parse_github_origin(origin.as_js_string().unwrap()) else {
        return Ok(classification(&origin, "local-git", None, Value::Null));
    };
    let result = scope
        .run(
            "gh".as_ref(),
            &[
                "api".into(),
                format!(
                    "repos/{}",
                    expected["nameWithOwner"].as_js_string().unwrap().lossy()
                )
                .into(),
            ],
            maximum,
            timeout,
        )
        .await;
    let raw = match result {
        Ok(stdout) => match cantrip_wire::parse_json_text(&stdout) {
            Ok(value) => value,
            Err(_) => {
                return Ok(classification(
                    &origin,
                    "github-unavailable",
                    Some("github-api-unavailable"),
                    Value::Null,
                ));
            }
        },
        Err(error) => {
            scope.check()?;
            let missing = error
                .downcast_ref::<ProcessError>()
                .is_some_and(|e| e.missing);
            return Ok(classification(
                &origin,
                "github-unavailable",
                Some(if missing {
                    "github-cli-unavailable"
                } else {
                    "github-api-unavailable"
                }),
                Value::Null,
            ));
        }
    };
    if !raw.is_object() {
        return Ok(classification(
            &origin,
            "github-unavailable",
            Some("github-api-invalid"),
            Value::Null,
        ));
    }
    let id = match raw.get("id") {
        Some(value) if value.is_string() || value.is_number() => {
            cantrip_wire::coercion::string(value).ok()
        }
        _ => None,
    };
    let repository = crate::http::checked(
        "projectGithubConversionRepositorySchema",
        &json!({"repositoryId":id.unwrap_or_else(||"".into()),"nameWithOwner":raw.get("full_name"),"url":raw.get("html_url")}),
    );
    if let Ok(repository) = repository
        && let Some(api) = repository["url"]
            .as_js_string()
            .and_then(parse_github_origin)
        && repository["nameWithOwner"]
            .as_js_string()
            .unwrap()
            .lowercase()
            == expected["nameWithOwner"]
                .as_js_string()
                .unwrap()
                .lowercase()
        && api["nameWithOwner"].as_js_string().unwrap().lowercase()
            == expected["nameWithOwner"]
                .as_js_string()
                .unwrap()
                .lowercase()
    {
        return Ok(classification(
            &origin,
            "github-accessible",
            None,
            repository,
        ));
    }
    Ok(classification(
        &origin,
        "github-unavailable",
        Some("github-identity-mismatch"),
        Value::Null,
    ))
}
