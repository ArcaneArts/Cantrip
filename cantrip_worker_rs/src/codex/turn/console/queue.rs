//! The terminal observes and edits Core's queue through versioned receipts.
mod import;
mod prompt;

use super::{View, gateway::fault};
use crate::{
    chat_content::Scope,
    codex::turn::{
        Key,
        receipt::{QueueHttpError, Unacknowledged},
    },
    metadata::Signal,
    native_items::array,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_history::{content::Encryption, projection::Work};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak, atomic::AtomicBool},
};
use tokio::sync::{Mutex as AsyncMutex, watch};

pub(super) fn manages(method: &Value) -> bool {
    matches!(
        method.as_str(),
        Some(
            "thread/queue/list"
                | "thread/queue/add"
                | "thread/queue/update"
                | "thread/queue/delete"
                | "thread/queue/reorder"
                | "thread/queue/start"
        )
    )
}

pub(super) struct State {
    pub revision: watch::Sender<Option<u64>>,
    sync_import: AsyncMutex<()>,
    import_scheduled: AtomicBool,
}

#[derive(Clone, Default)]
pub(in crate::codex::turn) struct Views(Arc<Mutex<HashMap<Key, Weak<State>>>>);

impl Views {
    pub(super) fn watch(&self, key: Key) -> Arc<State> {
        let mut views = self.0.lock().unwrap();
        if let Some(current) = views.get(&key).and_then(Weak::upgrade) {
            return current;
        }
        views.retain(|_, sender| sender.strong_count() > 0);
        let state = Arc::new(State {
            revision: watch::channel(None).0,
            sync_import: AsyncMutex::new(()),
            import_scheduled: AtomicBool::new(false),
        });
        views.insert(key, Arc::downgrade(&state));
        state
    }

    pub(in crate::codex::turn) fn publish(&self, key: &Key, revision: u64) {
        if let Some(state) = self.0.lock().unwrap().get(key).and_then(Weak::upgrade) {
            publish(&state.revision, revision);
        }
    }
}

fn publish(sender: &watch::Sender<Option<u64>>, revision: u64) {
    sender.send_if_modified(|current| {
        if current.is_some_and(|current| current >= revision) {
            return false;
        }
        *current = Some(revision);
        true
    });
}

pub(super) fn request(
    view: Arc<View>,
    session: Value,
    frame: Value,
    signal: Signal,
) -> Work<(String, Value)> {
    cantrip_transport::lifecycle::owned(async move {
        let request_id = &frame["id"];
        let response = execute(&view, &session, &frame, &signal).await;
        let response = match response {
            Ok(result) => json!({"id":request_id,"result":result}),
            Err(error) => {
                let mut result = fault(request_id, -32001, &error.to_string());
                if let Some(rejected) = error.downcast_ref::<QueueHttpError>() {
                    result["error"]["data"] =
                        json!({"code":rejected.code,"status":rejected.status});
                } else if error.is::<Unacknowledged>() {
                    result["error"]["data"] = json!({"code":"queue-operation-uncertain"});
                }
                result
            }
        };
        Ok((request_id.stringify(), response))
    })
}

pub(super) fn native_changed(view: Arc<View>) {
    import::schedule(view);
}

async fn execute(view: &View, session: &Value, frame: &Value, signal: &Signal) -> Result<Value> {
    signal.check()?;
    view.assert_current()?;
    let scope = Scope::new(view.turns.encryption.clone())?;
    let key = (scope.owner.clone(), scope.server.clone(), view.chat.clone());
    ensure!(
        &key == &view.queue_key,
        "The managed console owner changed."
    );
    let method = frame["method"].as_str().unwrap();
    let params = &frame["params"];
    ensure!(
        params["threadId"] == session["threadId"],
        "Managed queue requests require their exact bound thread ID."
    );
    import::synchronize(view, &scope).await?;
    signal.check()?;
    let client = &view.turns.receipts;
    let admission = if method == "thread/queue/list" {
        None
    } else {
        validate_mutation(params)?;
        let operation = required(&params["managed"]["operationId"], "operation ID")?;
        let activation = view
            .turns
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .and_then(|active| active.root.as_ref())
            .map(|root| root.activation.clone())
            .unwrap_or(Value::Null);
        let admission = client.queue_admission(
            &scope,
            session,
            &view.permission,
            &operation,
            &json!({"method":method,"params":params}),
            activation,
        )?;
        let previous = client
            .queue(
                &scope,
                "lookup",
                json!({"admission":admission}),
                Some(signal.clone()),
            )
            .await?;
        view.assert_current()?;
        if previous["found"] == true {
            return complete(view, &scope, session, &admission, &previous, signal).await;
        }
        Some(admission)
    };
    let snapshot = client
        .queue(
            &scope,
            "read",
            json!({"session":session}),
            Some(signal.clone()),
        )
        .await?;
    view.assert_current()?;
    observe(view, &snapshot);
    let Some(admission) = admission else {
        let list = list(view, &scope, params, &snapshot).await?;
        signal.check()?;
        view.assert_current()?;
        return Ok(list);
    };
    let expected = if params["expectedRevision"].is_null() {
        snapshot["revision"].as_u64().unwrap()
    } else {
        revision(&params["expectedRevision"])?
    };
    let mutation = mutation(view, &scope, method, params, &admission, &snapshot).await?;
    signal.check()?;
    view.assert_current()?;
    let result = client
        .queue(
            &scope,
            "mutate",
            json!({"admission":admission,"expectedRevision":expected,"mutation":mutation}),
            Some(signal.clone()),
        )
        .await?;
    view.assert_current()?;
    complete(view, &scope, session, &admission, &result, signal).await
}

fn validate_mutation(params: &Value) -> Result<()> {
    // These RPCs edit content, ordering or selection only. Overrides belong
    // to the worker's managed settings and preparation commands.
    for key in [
        "cwd",
        "runtimeWorkspaceRoots",
        "path",
        "paths",
        "root",
        "roots",
        "directory",
        "searchDirectory",
        "searchDirectories",
        "sourcePath",
        "destinationPath",
        "environments",
        "config",
        "managedConfig",
        "baseInstructions",
        "developerInstructions",
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
        "sandboxPolicy",
        "permissions",
        "permissionProfile",
        "permissionProfileId",
        "expectedTurnId",
        "turnId",
    ] {
        ensure!(
            params[key].is_null(),
            "Managed queue requests cannot override {key}."
        );
    }
    Ok(())
}

fn observe(view: &View, snapshot: &Value) {
    publish(
        &view.queue_state.revision,
        snapshot["revision"]
            .as_u64()
            .expect("validated queue revision"),
    );
}

pub(super) fn required(raw: &Value, label: &str) -> Result<JsString> {
    raw.as_js_string()
        .filter(|id| !id.is_empty() && id.len() <= 255)
        .cloned()
        .with_context(|| format!("Managed queue {label} is required."))
}

fn revision(raw: &Value) -> Result<u64> {
    raw.as_u64()
        .or_else(|| {
            let raw = raw.as_str()?;
            if raw == "0"
                || (!raw.starts_with('0') && raw.bytes().all(|byte| byte.is_ascii_digit()))
            {
                raw.parse().ok()
            } else {
                None
            }
        })
        .filter(|value| *value <= 9_007_199_254_740_991)
        .context("Invalid canonical queue revision.")
}

async fn list(view: &View, scope: &Scope, params: &Value, snapshot: &Value) -> Result<Value> {
    let items = array(&snapshot["items"])?;
    let offset = if params["cursor"].is_null() {
        0
    } else {
        let cursor = params["cursor"]
            .as_str()
            .context("Invalid canonical queue cursor.")?;
        let decoded = URL_SAFE_NO_PAD
            .decode(cursor)
            .context("Invalid canonical queue cursor.")?;
        let cursor = parse_json_text(&String::from_utf8_lossy(&decoded))
            .map_err(|_| anyhow::anyhow!("Invalid canonical queue cursor."))?;
        ensure!(
            cursor["revision"] == snapshot["revision"]
                && cursor["offset"]
                    .as_u64()
                    .is_some_and(|offset| offset <= 9_007_199_254_740_991),
            "The canonical queue changed; reload its first page."
        );
        usize::try_from(cursor["offset"].as_u64().unwrap()).unwrap_or(usize::MAX)
    };
    let limit = if params["limit"].is_null() {
        items.len().max(1)
    } else {
        params["limit"]
            .as_u64()
            .filter(|limit| (1..=1000).contains(limit))
            .context("Invalid canonical queue page limit.")? as usize
    };
    let mut data = Vec::new();
    for item in items.iter().skip(offset).take(limit) {
        data.push(prompt::open(view, scope, item).await?);
    }
    let next = offset.saturating_add(data.len());
    let cursor = (next < items.len()).then(|| {
        URL_SAFE_NO_PAD.encode(
            json!({
                "revision":snapshot["revision"],"offset":next,
            })
            .stringify()
            .as_bytes(),
        )
    });
    let mut imports = Vec::new();
    for item in array(&snapshot["pendingImports"])? {
        let submission = prompt::open(view, scope, &item["prompt"]).await?;
        imports.push(json!({
            "id":item["importId"],"nativeItemId":item["nativeItemId"],"status":item["status"],"input":submission["input"],
        }));
    }
    Ok(json!({
        "data":data,"nextCursor":cursor,"managedQueue":json!({
            "revision":snapshot["revision"].stringify(),"paused":snapshot["paused"],"pendingImports":imports,
        }),
    }))
}

async fn mutation(
    view: &View,
    scope: &Scope,
    method: &str,
    params: &Value,
    admission: &Value,
    snapshot: &Value,
) -> Result<Value> {
    let operation = required(&admission["operationId"], "operation ID")?;
    match method {
        "thread/queue/add" => {
            required(&params["clientUserMessageId"], "client message ID")?;
            let id = entry_id(&json!((
                &scope.server,
                &scope.owner,
                &view.chat,
                &operation
            )));
            let mut prepared = prompt::prepare(
                view,
                scope,
                params,
                &operation,
                &id,
                prompt::Preparation::Add,
            )
            .await?;
            prepared["kind"] = json!("add");
            Ok(prepared)
        }
        "thread/queue/update" | "thread/queue/delete" => {
            let id = required(&params["queuedSubmissionId"], "item ID")?;
            let existing = array(&snapshot["items"])?
                .iter()
                .find(|item| item["id"].as_js_string() == Some(&id))
                .context("The canonical queue item no longer exists.")?;
            if method == "thread/queue/delete" {
                return Ok(
                    json!({"kind":"delete","id":id,"expectedItemRevision":existing["revision"]}),
                );
            }
            let mut prepared = prompt::prepare(
                view,
                scope,
                params,
                &operation,
                &id,
                prompt::Preparation::Edit(existing),
            )
            .await?;
            prepared["kind"] = json!("update");
            prepared["id"] = json!(id);
            prepared["expectedItemRevision"] = existing["revision"].clone();
            Ok(prepared)
        }
        "thread/queue/reorder" => {
            let ids = params["queuedSubmissionIds"]
                .as_array()
                .context("Managed queue order is required.")?
                .iter()
                .map(|id| required(id, "item ID"))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({"kind":"reorder","ids":ids}))
        }
        "thread/queue/start" => {
            let mut start = json!({"kind":"start"});
            if !params["queuedSubmissionId"].is_null() {
                start["id"] = json!(required(&params["queuedSubmissionId"], "item ID")?);
            }
            Ok(start)
        }
        _ => unreachable!("managed queue mutation"),
    }
}

fn entry_id(seed: &Value) -> JsString {
    let digest = Sha256::digest(seed.stringify().as_bytes());
    let mut bytes: [u8; 16] = digest[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    uuid::Uuid::from_bytes(bytes).to_string().into()
}

async fn complete(
    view: &View,
    scope: &Scope,
    session: &Value,
    admission: &Value,
    result: &Value,
    signal: &Signal,
) -> Result<Value> {
    let receipt = &result["receipt"];
    let method = admission["method"].as_str().unwrap();
    if ["operationId", "payloadDigest", "method"]
        .iter()
        .any(|key| receipt[*key] != admission[*key])
        || ["chatId", "threadId"]
            .iter()
            .any(|key| receipt[*key] != session[*key])
        || receipt["startsExecution"] != false
    {
        return Err(Unacknowledged("queue operation identity".into()).into());
    }
    observe(view, result);
    if receipt["status"] == "rejected" && result["claim"].is_null() {
        bail!("Canonical queue operation is rejected; reconcile this operation before retrying.");
    }
    if receipt["status"] != "applied" {
        return Err(Unacknowledged("queue mutation receipt".into()).into());
    }
    let acknowledgment = match method {
        "thread/queue/add" | "thread/queue/update" => {
            let item = prompt::open(view, scope, &result["acceptedItem"])
                .await
                .map_err(|_| Unacknowledged("queue accepted item".into()))?;
            json!({"queuedSubmission":item})
        }
        "thread/queue/delete" => json!({"deleted":true}),
        "thread/queue/start" => {
            let claim = &result["claim"];
            if claim["requestOperationId"] != admission["operationId"]
                || claim["chatId"] != session["chatId"]
                || !claim["id"].is_string()
            {
                return Err(Unacknowledged("queue start claim".into()).into());
            }
            let client = &view.turns.receipts;
            let result = client
                .queue(
                    scope,
                    "start-receipt",
                    json!({
                        "session":session,"claimId":claim["id"],
                    }),
                    Some(signal.clone()),
                )
                .await?;
            client
                .open_queue_start(scope, session, claim, &result)
                .map_err(|_| Unacknowledged("queue start receipt".into()))?
        }
        _ => json!({}),
    };
    signal.check()?;
    view.assert_current()?;
    scope.identity()?;
    Ok(acknowledgment)
}
