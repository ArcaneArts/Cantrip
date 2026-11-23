use super::*;
fn text(value: &Value, maximum: usize) -> bool {
    value
        .as_js_string()
        .is_some_and(|v| !v.is_empty() && v.len() <= maximum)
}
fn member(value: &Value, members: &[&str]) -> Result<bool> {
    let value = wire::coercion::string(value)
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
    Ok(value.as_str().is_some_and(|v| members.contains(&v)))
}
pub(super) fn operation(value: &Value) -> Result<Option<Value>> {
    if !value.is_object() || !text(&value["kind"], 64) {
        return Ok(None);
    }
    let id = text(&value["sessionId"], 200);
    let result=match value["kind"].as_str() {
        Some("renew-session") if id => Some(value.clone()),
        Some("replace-route") if id && member(&value["preferredRoute"], &["local","lan","wan","relay"])? => Some(value.clone()),
        Some("open-peer") if id => wire::parse("workerLinkPeerSessionOpenRequestSchema",value.get("input")).ok().map(|input|json!({"kind":"open-peer","sessionId":value["sessionId"],"input":input})),
        Some("signal-peer") if id => wire::parse("workerLinkPeerSignalEnvelopeSchema",value.get("envelope")).ok().filter(|envelope|envelope["sessionId"]==value["sessionId"]).map(|envelope|json!({"kind":"signal-peer","sessionId":value["sessionId"],"envelope":envelope})),
        Some("read-peer-mailbox") if id && text(&value["peerSessionId"],200) => wire::parse("workerLinkPeerMailboxReadRequestSchema",value.get("input")).ok().map(|input|json!({"kind":"read-peer-mailbox","sessionId":value["sessionId"],"peerSessionId":value["peerSessionId"],"input":input})),
        Some("revoke-peer") if id && text(&value["peerSessionId"],200) => Some(json!({"kind":"revoke-peer","sessionId":value["sessionId"],"peerSessionId":value["peerSessionId"]})),
        Some("issue-grant") if value["input"].is_object() && text(&value["input"]["sessionId"],200) => Some(value.clone()),
        Some("renew-grant") if id && text(&value["grantId"],200) => Some(value.clone()),
        Some("revoke-grant") if id && text(&value["grantId"],200) && member(&value["reason"],&["released","resource-stopped","resource-deleted","lease-expired"])? => Some(value.clone()),
        Some("revoke-session") if id && member(&value["reason"],&["released","account-session-ended","worker-disconnected","worker-generation-changed","lease-expired","server-shutdown"])? => Some(value.clone()),
        _=>None,
    };
    Ok(result)
}
pub(super) fn revoke_scope(value: &Value) -> Option<Value> {
    if !value.is_object() || !text(&value["kind"], 64) {
        return None;
    }
    match value["kind"].as_str() {
        Some("account-session") if text(&value["accountSessionId"], 200) => Some(value.clone()),
        Some("owner") if text(&value["ownerId"], 200) => Some(value.clone()),
        Some(kind @ ("resource" | "attachment"))
            if text(&value["ownerId"], 200)
                && wire::parse("workerLinkResourceKindSchema", value.get("resourceKind"))
                    .is_ok()
                && text(&value["resourceId"], 200)
                && (kind != "attachment" || text(&value["attachmentId"], 200))
                && matches!(
                    value["reason"].as_str(),
                    Some("resource-stopped" | "resource-deleted")
                ) =>
        {
            Some(value.clone())
        }
        _ => None,
    }
}
pub(crate) fn relay_scope(value: &Value) -> Option<Value> {
    if !value.is_object() || !text(&value["kind"], 64) {
        return None;
    }
    let field = match value["kind"].as_str()? {
        "session" => "sessionId",
        "account-session" => "accountSessionId",
        "owner" => "ownerId",
        _ => return None,
    };
    text(&value[field], 200).then(|| value.clone())
}
