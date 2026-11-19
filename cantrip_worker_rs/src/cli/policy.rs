//! Route through Core's effective policies and open policy fields locally.
use super::server::{Rejected, Server};
use crate::{
    encryption::Service,
    http::checked,
    protected_content::{open_policy_body, open_policy_summary},
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use hyper::StatusCode;

pub(super) async fn execute(
    server: &Server,
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
    let wire = checked("policyCliWireListResultSchema", &listed["data"])?;
    let records = wire["policies"]
        .as_array()
        .context("Effective policy list")?;
    let views = records
        .iter()
        .map(|record| {
            let summary =
                open_policy_summary(encryption, &record["id"], &record["protectedSummary"])?;
            Ok(json!({
                "key":summary["key"], "name":summary["name"], "summary":summary["summary"],
                "mandatory":record["mandatory"], "sources":record["sources"],
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let opened = checked("policyCliListResultSchema", &json!({"policies":views}))?;
    if request["command"] == "policy.list" {
        let count = records.len();
        let plural = if count == 1 { "policy" } else { "policies" };
        listed["summary"] = json!(format!("Found {count} effective {plural}."));
        listed["data"] = opened;
        return checked("cantripCliCommandResultSchema", &listed);
    }

    let key = checked("policyKeySchema", &request["arguments"]["key"])?;
    let key_text = key.as_str().context("Policy key")?;
    let index = opened["policies"]
        .as_array()
        .context("Opened effective policy list")?
        .iter()
        .position(|view| view["key"] == key)
        .ok_or_else(|| Rejected {
            status: StatusCode::NOT_FOUND,
            code: Some("not-found".into()),
            message: format!("Policy {key_text} is not effective for the current project.").into(),
        })?;
    let policy_id = &records[index]["id"];
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
    let fetched = checked("policyCliWireReadResultSchema", &result["data"])?;
    let policy = &fetched["policy"];
    ensure!(
        &policy["id"] == policy_id,
        "The policy read returned a different policy."
    );
    let content = &policy["content"];
    let summary = open_policy_summary(encryption, policy_id, &content["protectedSummary"])?;
    ensure!(
        summary["key"] == key,
        "The policy key changed while reading its content."
    );
    let body = open_policy_body(encryption, policy_id, &content["protectedBody"])?;
    result["summary"] = json!(format!("Read policy {key_text}."));
    result["data"] = checked(
        "policyCliReadResultSchema",
        &json!({
            "policy":json!({
                "key":summary["key"], "name":summary["name"], "summary":summary["summary"],
                "bodyMarkdown":body["bodyMarkdown"],
            }),
        }),
    )?;
    checked("cantripCliCommandResultSchema", &result)
}

fn call(command: &str, context: &Value, arguments: Value) -> Value {
    json!({"command":command,"context":context,"arguments":arguments})
}
