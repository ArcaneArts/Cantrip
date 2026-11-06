//! User recovery intent commits before worker IPC. It conveys no execution authority.
use super::{
    Repository,
    admit::{reject, text},
    context, suspension,
};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};

impl Repository {
    pub async fn request_suspension_resume(&self, owner: &str, chat: &str) -> Result<Value> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    let row = suspension::chat(tx, &owner, &chat).await?;
                    let Some(mut state) = suspension::read(&row)? else {
                        return reject("suspension-not-resumable");
                    };
                    if state["phase"] == "resuming" {
                        return Ok(state);
                    }
                    if state["action"] == "stop"
                        && !matches!(
                            state["phase"].as_str(),
                            Some("stopped" | "completed" | "failed" | "idle")
                        )
                    {
                        return reject("suspension-stop-pending");
                    }
                    if state["checkpoint"].is_null()
                        || state["action"] == "stop"
                        || !(state["phase"] == "paused"
                            || (state["phase"] == "error" && state["action"] == "resume"))
                    {
                        return reject("suspension-not-resumable");
                    }
                    let current = context::execution(tx, &owner, &chat)
                        .await?
                        .context("Suspension source unavailable")?;
                    if !suspension::same_source(&state, &row, &current) {
                        return reject("suspension-authority-changed");
                    }
                    state["controlId"] = json!(uuid::Uuid::new_v4().to_string());
                    state["actorControlId"] = Value::Null;
                    state["action"] = json!("resume");
                    state["phase"] = json!("resuming");
                    state["error"] = Value::Null;
                    state["requestedAt"] = json!(crate::auth::iso(crate::auth::now()));
                    suspension::save(tx, &owner, &chat, state, true).await?;
                    suspension::read(&suspension::chat(tx, &owner, &chat).await?)?
                        .context("Suspension state unavailable")
                })
            })
            .await
    }

    pub async fn fail_suspension_resume(
        &self,
        owner: &str,
        chat: &str,
        observed: &Value,
        error: &Value,
    ) -> Result<()> {
        let error = crate::settings::parse_response("nativeSuspensionErrorSchema", Some(error))?;
        let (owner, chat, observed) = (owner.to_owned(), chat.to_owned(), observed.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    let row = suspension::chat(tx, &owner, &chat).await?;
                    let Some(mut state) = suspension::read(&row)? else {
                        return reject("suspension-control-stale");
                    };
                    if state["controlId"] != observed["controlId"] {
                        return reject("suspension-control-stale");
                    }
                    if state["actor"] != observed["actor"]
                        || (!state["actorControlId"].is_null()
                            && state["actorControlId"] != state["controlId"])
                    {
                        return reject("suspension-actor-stale");
                    }
                    if state["phase"] != "resuming" && state["phase"] != "error" {
                        return reject("suspension-control-settled");
                    }
                    state["phase"] = json!("error");
                    state["error"] = error;
                    suspension::save(tx, &owner, &text(&row["id"])?, state, true).await
                })
            })
            .await
    }
}
