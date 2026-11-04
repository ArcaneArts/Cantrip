use super::{raw, text};
use crate::{
    database::{Executor, Transaction},
    wire::Value,
};
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};

pub fn roots(input: &Value) -> Result<Value> {
    if input["osExecution"].is_null() {
        return Ok(Value::Null);
    }
    crate::settings::parse_response("cantripOsRunRootsSchema", Some(&input["osExecution"]))
}

pub fn key(roots: &Value) -> Result<String> {
    if roots.is_null() {
        return Ok("worker".into());
    }
    let parsed = crate::settings::parse_response("cantripOsRunRootsSchema", Some(roots))?;
    let roots = &parsed;
    let d = &roots["definitions"]["scope"];
    let t = &roots["target"]["scope"];
    let epoch = Value::Array(
        [
            (t, "ownerId"),
            (t, "projectId"),
            (t, "projectSourceId"),
            (t, "workerId"),
            (t, "instanceId"),
            (t, "workspaceId"),
            (d, "bindingId"),
            (d, "bindingGeneration"),
            (t, "bindingId"),
            (t, "bindingGeneration"),
            (t, "attachmentGeneration"),
            (t, "runtimeGeneration"),
        ]
        .map(|(scope, key)| scope[key].clone())
        .into(),
    );
    Ok(format!(
        "cantrip-os:{:x}",
        Sha256::digest(epoch.stringify().as_bytes())
    ))
}

pub async fn capture(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    roots: &Value,
) -> Result<()> {
    if roots.is_null() {
        return Ok(());
    }
    let t = &roots["target"]["scope"];
    ensure!(
        t["ownerId"] == owner
            && t["projectId"] == input["projectId"]
            && t["worktreeId"] == input["worktreeId"]
            && t["workerId"] == input["workerId"],
        "The Linux Run does not match its owned target."
    );
    let ex = Executor::Transaction(tx);
    let definitions = crate::cantrip_os::run::run_primary_with(
        ex,
        owner,
        text(input, "projectId")?,
        text(t, "bindingId")?,
        text(t, "runtimeGeneration")?,
    )
    .await?;
    let selected = crate::cantrip_os::chats::select(
        ex,
        owner,
        text(input, "projectId")?,
        text(t, "bindingId")?,
    )
    .await?;
    let source = &selected["source"];
    let target = crate::cantrip_os::chats::execution_for_source(
        owner,
        source,
        &serde_json::json!({"binding_generation":source["binding"]["bindingGeneration"],"attachment_generation":source["instance"]["attachmentGeneration"],"runtime_generation":source["instance"]["runtimeGeneration"]}),
    )?;
    let actual = serde_json::json!({"definitions":definitions,"target":target});
    ensure!(
        raw(actual.to_string())? == *roots,
        "The Linux Run placement changed before admission; no host fallback was attempted."
    );
    Ok(())
}
