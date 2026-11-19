//! Transfer the exact native queue source. Core keeps it ineligible until
//! the owning app-server confirms its durable compare-and-delete receipt.
use super::{View, entry_id, observe, prompt, required};
use crate::{
    chat_content::Scope,
    codex::turn::{RPC_TIMEOUT, receipt::crypto_context},
    native_items::{array, concat},
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{open_native_command_request, protect_native_command_request};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
};

pub(super) fn schedule(view: Arc<View>) {
    if view
        .queue_state
        .import_scheduled
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    tokio::spawn(async move {
        let _guard = view.queue_state.sync_import.lock().await;
        view.queue_state
            .import_scheduled
            .store(false, Ordering::Release);
        if let Ok(scope) = Scope::new(view.turns.encryption.clone()) {
            // The next interaction retries any unacknowledged source.
            // No local deletion happens from an unconfirmed import.
            let _ = drain(&view, &scope).await;
        }
    });
}

pub(super) async fn synchronize(view: &View, scope: &Scope) -> Result<()> {
    let _guard = view.queue_state.sync_import.lock().await;
    drain(view, scope).await
}

async fn drain(view: &View, scope: &Scope) -> Result<()> {
    // The prepared runtime's execution gate is already installed. Its
    // producer accepts Goal triggers only, leaving old queue input to Core.
    current(view, scope)?;
    let thread = view.prepared.thread.id();
    let mut session = view.session.clone();
    session["connectionId"] = json!(concat(&[
        "queue-owner:".into(),
        required(&session["runtimeGeneration"], "runtime generation")?,
    ]));
    // Reconcile a committed deletion even after the native queue is empty.
    stage(view, scope, &session, vec![]).await?;
    let sources = read(view, scope).await?;
    for source in sources {
        current(view, scope)?;
        let prompt_id = source_prompt(view, scope, &source["id"]);
        let operation = operation_id(&prompt_id);
        let grant = scope.material(None)?;
        let (protected, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &source,
        )?;
        let mut item = prompt::prepare(view, scope, &json!({
            "threadId":thread, "input":source["input"], "clientUserMessageId":source["clientUserMessageId"],
            "managed":json!({"action":"literal","operationId":operation}),
        }), &operation, &prompt_id, prompt::Preparation::Import).await?;
        item["nativeItemId"] = source["id"].clone();
        item["sourceDigest"] = json!(digest);
        item["protectedSource"] = protected;
        stage(view, scope, &session, vec![item]).await?;
    }
    current(view, scope)
}

fn current(view: &View, scope: &Scope) -> Result<()> {
    view.assert_current()?;
    let (owner, server) = scope.identity()?;
    ensure!(
        owner == view.queue_key.0 && server == view.queue_key.1,
        "The managed queue owner changed."
    );
    Ok(())
}

fn source_prompt(view: &View, scope: &Scope, id: &Value) -> JsString {
    entry_id(&json!((
        &scope.server,
        &scope.owner,
        &view.chat,
        view.prepared.thread.id(),
        id
    )))
}

fn operation_id(prompt: &JsString) -> JsString {
    concat(&["queue-import:".into(), prompt.clone()])
}

async fn read(view: &View, scope: &Scope) -> Result<Vec<Value>> {
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    loop {
        let page = native(
            view,
            scope,
            "thread/queue/list",
            json!({
                "threadId":view.prepared.thread.id(),"cursor":cursor,"limit":100,
            }),
        )
        .await?;
        for raw in array(&page["data"])? {
            // Keep the reference client's field order for the protected digest.
            let value = json!({"id":raw["id"],"input":raw["input"],"clientUserMessageId":raw["clientUserMessageId"]});
            validate_source(&value)?;
            rows.push(value);
        }
        let next = page
            .get("nextCursor")
            .context("The native queue returned no cursor.")?;
        if next.is_null() || next == "" {
            return Ok(rows);
        }
        let next = next
            .as_js_string()
            .context("The native queue returned an invalid cursor.")?;
        ensure!(
            seen.insert(next.clone()),
            "The native queue returned a repeated cursor."
        );
        cursor = json!(next);
    }
}

fn validate_source(source: &Value) -> Result<()> {
    ensure!(
        source.as_object().is_some_and(|fields| fields.len() == 3)
            && source["id"].is_string()
            && array(&source["input"])?.iter().all(Value::is_object)
            && source["clientUserMessageId"].is_string(),
        "Malformed native queue input."
    );
    Ok(())
}

async fn native(view: &View, scope: &Scope, method: &'static str, params: Value) -> Result<Value> {
    current(view, scope)?;
    let reply = view
        .prepared
        .runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?
        .context("The app-server returned no native queue response.")?;
    current(view, scope)?;
    Ok(reply)
}

async fn stage(view: &View, scope: &Scope, session: &Value, items: Vec<Value>) -> Result<()> {
    current(view, scope)?;
    let client = &view.turns.receipts;
    let runner = &view.prepared.runner_generation;
    let staged = client
        .queue(
            scope,
            "import",
            json!({
                "session":session,"runnerGeneration":runner,"items":items,
            }),
            None,
        )
        .await?;
    current(view, scope)?;
    observe(view, &staged);
    for record in array(&staged["imports"])? {
        if !matches!(record["status"].as_str(), Some("pending" | "uncertain")) {
            continue;
        }
        current(view, scope)?;
        let prompt = required(&record["promptId"], "imported prompt ID")?;
        let operation = operation_id(&prompt);
        let envelope = &record["protectedSource"];
        let revision = envelope["keyRevision"]
            .as_u64()
            .context("The native queue source key is missing.")?;
        let grant = scope.material(Some(revision))?;
        let (source, digest) = open_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            envelope,
        )?;
        validate_source(&source)?;
        ensure!(
            source["id"] == record["nativeItemId"]
                && record["sourceDigest"] == digest
                && source_prompt(view, scope, &source["id"]) == prompt,
            "The native queue import source belongs to another item."
        );
        let receipt = native(view, scope, "thread/managedExecution/queueDelete", json!({
            "threadId":session["threadId"],"runnerGeneration":runner,
            "operationId":record["nativeDeleteOperationId"],"queuedSubmissionId":source["id"],
            "expectedInput":source["input"],"expectedClientUserMessageId":source["clientUserMessageId"],
        })).await?;
        let acknowledged = client
            .queue(
                scope,
                "import-ack",
                json!({
                    "session":session,"runnerGeneration":runner,"importId":record["importId"],
                    "sourceDigest":record["sourceDigest"],"receipt":receipt,
                }),
                None,
            )
            .await?;
        current(view, scope)?;
        observe(view, &acknowledged);
    }
    Ok(())
}
