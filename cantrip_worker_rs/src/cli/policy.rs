//! Route through Core's effective policies and open policy fields locally.
use super::server::{Rejected, Relay};
use crate::{
    encryption::Service,
    http::checked,
    protected_content::{EffectivePolicies, open_policy_detail},
};
use anyhow::{Context, Result};
use cantrip_wire::{Value, value::json};
use hyper::StatusCode;

pub(super) async fn execute(
    server: &Relay<'_>,
    encryption: &Service,
    request: &Value,
    id: &str,
) -> Result<Value> {
    let mut listed = server
        .execute(
            call("policy.list", &request["context"], json!({})),
            &format!("{id}:policy-list"),
        )
        .await?;
    let opened = EffectivePolicies::open(encryption, &listed["data"])?;
    if request["command"] == "policy.list" {
        listed["summary"] = json!(opened.summary());
        listed["data"] = opened.into_view();
        return checked("cantripCliCommandResultSchema", &listed);
    }

    let key = checked("policyKeySchema", &request["arguments"]["key"])?;
    let key_text = key.as_str().context("Policy key")?;
    let policy_id = opened.identifier(&key).ok_or_else(|| Rejected {
        status: StatusCode::NOT_FOUND,
        code: Some("not-found".into()),
        message: format!("Policy {key_text} is not effective for the current project.").into(),
    })?;
    let mut result = server
        .execute(
            call(
                "policy.read",
                &request["context"],
                json!({"policyId":policy_id}),
            ),
            &format!("{id}:policy-read"),
        )
        .await?;
    result["summary"] = json!(format!("Read policy {key_text}."));
    result["data"] = open_policy_detail(encryption, policy_id, &key, &result["data"])?;
    checked("cantripCliCommandResultSchema", &result)
}

fn call(command: &str, context: &Value, arguments: Value) -> Value {
    json!({"command":command,"context":context,"arguments":arguments})
}
