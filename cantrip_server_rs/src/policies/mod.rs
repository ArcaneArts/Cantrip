//! Durable policy metadata and opaque endpoint-encrypted content. The server
//! never decrypts policy summaries, bodies or their blind indexes.
mod query_error;
pub(crate) use query_error::PolicyQueryError;
pub mod repository;
pub mod request;
use serde_json::Value;
use std::sync::OnceLock;

pub fn assets() -> &'static Value {
    static ASSETS: OnceLock<Value> = OnceLock::new();
    ASSETS.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/policies.json"))
            .expect("embedded policy assets")
    })
}
pub fn templates() -> Value {
    Value::Array(
        assets()["templates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|template| {
                let mut summary = template.clone();
                summary.as_object_mut().unwrap().remove("bodyMarkdown");
                summary
            })
            .collect(),
    )
}
pub fn template(key: &str) -> Option<Value> {
    assets()["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|template| template["templateKey"] == key)
        .cloned()
}
