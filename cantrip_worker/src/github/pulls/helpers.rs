use super::{Client, api};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value};
use indexmap::IndexSet;

pub(super) fn strings(value: &Value) -> IndexSet<JsString> {
    super::array(value)
        .iter()
        .map(|value| value.as_js_string().unwrap().clone())
        .collect()
}
pub(super) fn form(method: &str, fields: &[(&str, &Value)]) -> Result<Vec<JsString>> {
    let mut args = vec!["--method".into(), method.into()];
    for (name, value) in fields {
        args.push("-f".into());
        args.push(api::prefix(&format!("{name}="), &api::text(Some(value))?));
    }
    Ok(args)
}
pub(super) fn repeated(
    method: &str,
    name: &str,
    values: impl IntoIterator<Item = JsString>,
) -> Vec<JsString> {
    let mut args = vec!["--method".into(), method.into()];
    for value in values {
        args.push("-f".into());
        args.push(api::prefix(&format!("{name}[]="), &value));
    }
    args
}
pub(super) fn encode_component(value: &JsString) -> Result<String> {
    let text: String = std::char::decode_utf16(value.units().iter().copied())
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| anyhow!("URI malformed"))?;
    let mut result = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(result)
}
pub(super) fn join(values: &[JsString], separator: &str) -> JsString {
    let mut units = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend(value.units());
    }
    JsString::new(units)
}
pub(super) fn warning(prefix: &str, error: &anyhow::Error) -> Value {
    Value::String(api::prefix(prefix, &crate::error::message(error)))
}
impl Client {
    pub(super) async fn pull_context(&self, command: &Value, scope: &Scope) -> Result<Value> {
        super::review::context(
            &super::review::query(
                super::CONTEXT,
                command["repository"].as_js_string().unwrap(),
                &command["number"],
                scope,
            )
            .await?,
        )
    }
    pub(super) async fn pull_graphql(
        &self,
        query: &str,
        variables: &[(&str, &Value)],
        scope: &Scope,
    ) -> Result<Value> {
        let mut args = vec!["-f".into(), api::prefix("query=", &query.into())];
        for (name, value) in variables {
            if value.is_null() {
                continue;
            }
            args.push(if value.is_string() { "-f" } else { "-F" }.into());
            args.push(api::prefix(&format!("{name}="), &api::text(Some(value))?));
        }
        self.api("graphql", &args, scope).await
    }
}
