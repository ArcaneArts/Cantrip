//! Projects native external configuration imports onto the protected Chat API.
mod projection;

use super::{TIMEOUT, Target, entries, nonempty};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

pub(in crate::codex) const DETECT: &str = "externalAgentConfig/detect";
pub(in crate::codex) const IMPORT: &str = "externalAgentConfig/import";
const MAX_IMPORTS: usize = 100;

pub(in crate::codex) fn notification_phase(method: &Value) -> Option<bool> {
    match method.as_str() {
        Some("externalAgentConfig/import/progress") => Some(false),
        Some("externalAgentConfig/import/completed") => Some(true),
        _ => None,
    }
}

#[derive(Default)]
struct State {
    awaiting_reply: usize,
    records: IndexMap<JsString, Record>,
    early: IndexMap<JsString, Value>,
}

struct Record {
    scope: Value,
    status: Value,
}

#[derive(Clone, Default)]
pub(in crate::codex) struct Imports(Arc<Mutex<State>>);

struct AwaitingReply<'a>(&'a Imports);

impl Drop for AwaitingReply<'_> {
    fn drop(&mut self) {
        let mut state = self.0.0.lock().unwrap();
        state.awaiting_reply -= 1;
        if state.awaiting_reply == 0 {
            state.early.clear();
        }
    }
}

fn replace(status: &mut Value, received: Value) {
    if status["status"] != "completed" {
        *status = received;
    }
}

impl Imports {
    fn begin(&self) -> AwaitingReply<'_> {
        self.0.lock().unwrap().awaiting_reply += 1;
        AwaitingReply(self)
    }

    fn register(&self, id: &JsString, scope: &Value) -> Result<Value> {
        let mut state = self.0.lock().unwrap();
        if let Some(record) = state.records.get(id) {
            ensure!(
                record.scope == *scope,
                "Codex returned an existing import identifier."
            );
            return Ok(record.status.clone());
        }
        let status = state.early.shift_remove(id).unwrap_or_else(
            || json!({"importId":id,"status":"pending","results":Vec::<Value>::new()}),
        );
        state.records.insert(
            id.clone(),
            Record {
                scope: scope.clone(),
                status: status.clone(),
            },
        );
        if state.records.len() > MAX_IMPORTS {
            state.records.shift_remove_index(0);
        }
        Ok(status)
    }

    pub(in crate::codex) fn observe(&self, params: &Value, completed: bool) {
        let Some(id) = valid_id(&params["importId"]) else {
            return;
        };
        let mut state = self.0.lock().unwrap();
        if let Some(record) = state.records.get_mut(id) {
            replace(
                &mut record.status,
                projection::status(params, id, completed),
            );
        } else if state.awaiting_reply != 0 {
            let received = projection::status(params, id, completed);
            if let Some(early) = state.early.get_mut(id) {
                replace(early, received);
            } else {
                state.early.insert(id.clone(), received);
                if state.early.len() > MAX_IMPORTS {
                    state.early.shift_remove_index(0);
                }
            }
        }
    }

    fn status(&self, id: &JsString, scope: &Value) -> Value {
        self.0
            .lock()
            .unwrap()
            .records
            .get(id)
            .filter(|record| record.scope == *scope)
            .map(|record| record.status.clone())
            .unwrap_or_else(
                || json!({"importId":id,"status":"unknown","results":Vec::<Value>::new()}),
            )
    }
}

fn valid_id(value: &Value) -> Option<&JsString> {
    nonempty(value).filter(|id| id.len() <= 200)
}

async fn detect(target: &Target<'_>) -> Result<Value> {
    ensure!(
        target.report["methods"][DETECT] == "available",
        "The installed Codex runtime does not support external-agent configuration detection."
    );
    Ok(target
        .runtime
        .request(
            DETECT.into(),
            Some(json!({
                "includeHome":false,"cwds":[target.cwd],"maxSessionAgeDays":30,"maxSessions":50,
            })),
            Some(TIMEOUT),
            None,
        )
        .await?
        .unwrap_or(Value::Null))
}

pub(super) async fn preview(target: &Target<'_>) -> Result<Value> {
    let found = detect(target).await?;
    let items = projection::candidates(&found, target.cwd)?
        .into_values()
        .map(|candidate| candidate.preview)
        .collect::<Vec<_>>();
    Ok(json!({"sourceScope":"project","items":items}))
}

pub(super) async fn apply(target: &Target<'_>, input: &Value) -> Result<Value> {
    ensure!(
        target.report["methods"][DETECT] == "available"
            && target.report["methods"][IMPORT] == "available",
        "The installed Codex runtime does not support validated external configuration imports."
    );
    let selected = entries(input, "itemIds")
        .map(|item| {
            item.as_js_string()
                .context("Invalid external import selection.")
        })
        .collect::<Result<Vec<_>>>()?;
    let found = detect(target).await?;
    let items = projection::select(projection::candidates(&found, target.cwd)?, &selected)?;
    target.operation.assert_current()?;
    let imports = target.runtime.external_imports();
    let _awaiting = imports.begin();
    let receipt = target
        .runtime
        .request(
            IMPORT.into(),
            Some(json!({"migrationItems":items,"source":"cantrip"})),
            Some(TIMEOUT),
            None,
        )
        .await?
        .unwrap_or(Value::Null);
    let id = valid_id(&receipt["importId"])
        .context("Codex returned an invalid external import identifier.")?;
    imports.register(id, &target.operation.scope)
}

pub(super) fn status(target: &Target<'_>, input: &Value) -> Result<Value> {
    let id = valid_id(&input["importId"]).context("Missing external import identifier.")?;
    Ok(target
        .runtime
        .external_imports()
        .status(id, &target.operation.scope))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_early_notifications_require_a_matching_protected_scope() {
        let imports = Imports::default();
        let owner = json!({"projectId":"project-a","chatId":"chat-a"});
        let other = json!({"projectId":"project-b","chatId":"chat-b"});
        let id = JsString::from("native-import");
        let unrelated = JsString::from("unrelated-import");
        let result = json!({
            "importId":id,"itemTypeResults":vec![json!({
                "itemType":"AGENTS_MD","successes":vec![json!({"source":"private path"})],
                "failures":vec![json!({
                    "errorType":"invalid_content","failureStage":"read","message":"private content"
                })],
            })]
        });
        let awaiting = imports.begin();
        imports.observe(&result, true);
        imports.observe(&json!({"importId":unrelated}), true);
        assert_eq!(imports.status(&id, &owner)["status"], "unknown");
        let accepted = imports.register(&id, &owner).unwrap();
        assert_eq!(accepted["status"], "completed");
        imports.observe(&json!({"importId":id}), false);
        assert_eq!(imports.status(&id, &owner), accepted);
        assert_eq!(imports.status(&id, &other)["status"], "unknown");
        assert!(!accepted.stringify().contains("private"));
        drop(awaiting);
        assert_eq!(
            imports.register(&unrelated, &owner).unwrap()["status"],
            "pending"
        );
    }
}
