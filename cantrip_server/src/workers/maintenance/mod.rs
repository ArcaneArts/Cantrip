//! Encryption readiness and reconciliation of persisted terminal services.
mod repository;
mod service;
pub use repository::Repository;
pub use service::Service;

use crate::wire::Value;

pub fn material_fingerprint(status: &Value) -> Value {
    let mut grants = status["grants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|grant| {
            Value::Array(vec![
                grant["component"].clone(),
                grant["keyRevision"].clone(),
            ])
        })
        .collect::<Vec<_>>();
    // Component names are the protocol's fixed lowercase ASCII alternatives.
    // Their ordering matches localeCompare; revisions use numeric comparison.
    grants.sort_by(|a, b| {
        let a = a.as_array().unwrap();
        let b = b.as_array().unwrap();
        a[0].as_js_string()
            .unwrap()
            .units()
            .cmp(b[0].as_js_string().unwrap().units())
            .then_with(|| a[1].as_f64().unwrap().total_cmp(&b[1].as_f64().unwrap()))
    });
    Value::Array(vec![
        status["supported"].clone(),
        status["state"].clone(),
        status["principalId"].clone(),
        status["error"].clone(),
        Value::Array(grants),
    ])
}
pub fn surface_material_changed(component: &Value, before: &Value, after: &Value) -> bool {
    component == "surface-private-state"
        && material_fingerprint(before) != material_fingerprint(after)
}
