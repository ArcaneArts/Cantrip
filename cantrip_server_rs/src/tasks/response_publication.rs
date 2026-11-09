//! Reuse only the opaque root response of the receipt's bound physical turn.
use crate::wire::{Value, coercion::truthy};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Assigned,
    NativeRoot,
}

pub(super) fn kind(
    message: &Value,
    publication: &Value,
    result: &Value,
    execution: &Value,
) -> Option<Kind> {
    if message["idempotencyKey"] == publication["idempotencyKey"]
        && (!truthy(publication.get("id")) || message["id"] == publication["id"])
    {
        return Some(Kind::Assigned);
    }
    if execution.is_null()
        || !truthy(result.get("turnId"))
        || result["threadId"] != execution["threadId"]
        || result["turnId"] != execution["turnId"]
    {
        return None;
    }
    let thread = result["threadId"].as_js_string()?;
    let turn = result["turnId"].as_js_string()?;
    let key = message["idempotencyKey"].as_js_string()?.units();
    // Match JavaScript startsWith/length on UTF-16, without lossy conversion.
    let mut scoped: Vec<u16> = "agent-message:".encode_utf16().collect();
    scoped.extend_from_slice(turn.units());
    scoped.push(b':' as u16);
    scoped.extend_from_slice(thread.units());
    scoped.push(b':' as u16);
    scoped.extend_from_slice(turn.units());
    scoped.push(b':' as u16);
    let mut root: Vec<u16> = "agent-message:root:".encode_utf16().collect();
    root.extend_from_slice(turn.units());
    root.push(b':' as u16);
    [scoped, root]
        .iter()
        .any(|prefix| key.starts_with(prefix) && key.len() > prefix.len())
        .then_some(Kind::NativeRoot)
}

/// Once a terminal response is accepted, a second opaque response cannot change
/// its identity or content. Legacy terminals retain their assigned publisher.
pub(super) fn matches_terminal(terminal: &Value, kind: Option<&Kind>, digest: &Value) -> bool {
    terminal.is_null()
        || if truthy(terminal.get("outcomeDigest")) {
            terminal["outcomeDigest"] == *digest
        } else {
            kind != Some(&Kind::NativeRoot)
        }
}

impl super::Repository {
    /// The immediate result and durable notification share the canonical input
    /// transaction before a native publisher is accepted by turn completion.
    pub(crate) async fn accept_turn_response(
        &self,
        owner: &str,
        worker: &str,
        publication: &Value,
        notification: &Value,
    ) -> anyhow::Result<bool> {
        let result = &notification["outcome"]["result"];
        let message = &result["structuredResult"]["message"];
        match kind(message, publication, result, result) {
            Some(Kind::Assigned) => return Ok(true),
            Some(Kind::NativeRoot) if truthy(notification.get("taskInferenceInputOperationId")) => {
            }
            _ => return Ok(false),
        }
        let saved = self
            .apply_goal_input_outcome(owner, worker, notification, true)
            .await?;
        Ok(saved
            .as_ref()
            .is_some_and(|v| v["terminal"]["ok"] == true && v["message"]["id"] == message["id"]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::value::json;

    #[test]
    fn publication_requires_exact_assigned_or_bound_root_identity() {
        let publication = json!({"id":"assigned","idempotencyKey":"assigned-key"});
        let execution = json!({"threadId":"thread","turnId":"turn"});
        let assigned = json!({"id":"assigned","idempotencyKey":"assigned-key"});
        assert_eq!(
            kind(&assigned, &publication, &Value::Null, &Value::Null),
            Some(Kind::Assigned)
        );
        for key in [
            "agent-message:turn:thread:turn:item",
            "agent-message:root:turn:item",
        ] {
            let message = json!({"id":"native","idempotencyKey":key});
            assert_eq!(
                kind(&message, &publication, &execution, &execution),
                Some(Kind::NativeRoot)
            );
            assert_eq!(kind(&message, &publication, &execution, &Value::Null), None);
            assert_eq!(
                kind(
                    &message,
                    &publication,
                    &json!({"threadId":"other","turnId":"turn"}),
                    &execution
                ),
                None
            );
        }
        for key in [
            "assigned-key",
            "agent-message:turn:child:turn:item",
            "agent-message:root:old:item",
            "agent-message:root:turn:",
            "agent-message:turn:thread:turn:",
        ] {
            let message = json!({"id":"other","idempotencyKey":key});
            assert_eq!(kind(&message, &publication, &execution, &execution), None);
        }
    }

    #[test]
    fn root_identity_preserves_unpaired_utf16_units() {
        let execution: Value =
            serde_json::from_str(r#"{"threadId":"t\ud800","turnId":"v\udfff"}"#).unwrap();
        let publication = json!({"idempotencyKey":"assigned"});
        let message: Value = serde_json::from_str(
            r#"{"idempotencyKey":"agent-message:v\udfff:t\ud800:v\udfff:item"}"#,
        )
        .unwrap();
        assert_eq!(
            kind(&message, &publication, &execution, &execution),
            Some(Kind::NativeRoot)
        );
        let wrong: Value = serde_json::from_str(
            r#"{"idempotencyKey":"agent-message:v\ufffd:t\ufffd:v\ufffd:item"}"#,
        )
        .unwrap();
        assert_eq!(kind(&wrong, &publication, &execution, &execution), None);
    }

    #[test]
    fn terminal_pins_content_and_preserves_legacy_publisher() {
        let digest = json!("response-digest");
        assert!(matches_terminal(
            &Value::Null,
            Some(&Kind::NativeRoot),
            &digest
        ));
        let legacy = json!({"ok":true});
        assert!(matches_terminal(&legacy, Some(&Kind::Assigned), &digest));
        assert!(!matches_terminal(&legacy, Some(&Kind::NativeRoot), &digest));
        let pinned = json!({"ok":true,"outcomeDigest":"response-digest"});
        assert!(matches_terminal(&pinned, Some(&Kind::NativeRoot), &digest));
        assert!(!matches_terminal(
            &pinned,
            Some(&Kind::NativeRoot),
            &json!("other-digest")
        ));
        assert!(!matches_terminal(&pinned, None, &Value::Null));
    }
}
