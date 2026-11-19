//! Protected Explorer and document requests routed to the captured workspace.
#[cfg(all(feature = "guest-files", target_os = "linux"))]
pub(crate) mod helper;
mod records;

use super::{
    assert_scope,
    carrier::Transport,
    operations::digest,
    process::{self, Invocation, Limits},
    session::{RpcError, Session},
    text,
};
use crate::{
    encryption::Service,
    filesystem::{Scope, explorer, paths},
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use records::Records;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::Mutex as Queue;
use uuid::Uuid;

const EXECUTABLE: &str = "/usr/lib/cantrip-os-executor/cantrip-os-files";
const CLIENT: &str = "cantrip-product-files";
const LIMITS: Limits = Limits {
    deadline: Duration::from_secs(60),
    output: 8 * 1024 * 1024,
};

pub(crate) struct ProductFiles {
    records: Records,
    queues: Mutex<HashMap<String, Weak<Queue<()>>>>,
}

impl ProductFiles {
    pub fn new(directory: &Path) -> Self {
        Self {
            records: Records::new(directory),
            queues: Mutex::default(),
        }
    }

    fn queue(&self, identity: &str) -> Arc<Queue<()>> {
        let mut queues = self.queues.lock().unwrap();
        if let Some(queue) = queues.get(identity).and_then(Weak::upgrade) {
            return queue;
        }
        queues.retain(|_, queue| queue.strong_count() != 0);
        let queue = Arc::new(Queue::new(()));
        queues.insert(identity.to_owned(), Arc::downgrade(&queue));
        queue
    }

    pub async fn execute(
        &self,
        execution: &Value,
        request: &Value,
        context: &Value,
        service: &Service,
        lifetime: &Scope,
    ) -> Result<(Value, bool)> {
        let execution = checked("cantripOsExecutionSchema", execution)?;
        let scope = &execution["scope"];
        let (owner, server) = service.bound_identity()?;
        ensure!(
            scope["ownerId"].as_js_string() == Some(&owner)
                && scope["workerId"].as_js_string() == Some(service.worker_id())
                && context["serverId"] == server,
            "The OS file operation belongs to another account or server."
        );
        let kind = text(request, "type")?;
        let mutates = mutation(kind)?;
        let transport = Transport::from_value(&execution["transport"])?;
        let identity = digest(json!({"execution":execution, "serverId":server}));
        let queue = self.queue(&identity);
        let _guard = tokio::select! {
            _ = lifetime.stopped() => bail!("OS file operation stopped."),
            queue = queue.lock() => queue,
        };
        assert_scope(&transport, scope, true, lifetime).await?;
        let binding = Session::capture_binding(&transport, scope, lifetime).await?;

        if scope["mode"] == "linked" && kind == "explorer.directory.commits" {
            let linked = scope["linkedWorkerPath"]
                .as_js_string()
                .context("Linux linked path")?;
            let path = request["path"].as_js_string().context("Explorer path")?;
            let value = explorer::directory_commits(&paths::native(linked), path, lifetime).await?;
            return Ok((
                json!({"ok":true,"result":json!({"type":kind,"value":value})}),
                true,
            ));
        }

        self.records
            .retire(&identity, &transport, &binding, lifetime)
            .await?;
        let context = record_context(context);
        let operation_id = &context["operationId"];
        let (mut session, session_id) =
            Session::connect(&transport, binding, CLIENT, None, lifetime).await?;
        let id = Uuid::new_v4().to_string();
        let result = async {
            self.records.start(&identity, &session.binding, &session_id, &id)?;
            let original = json!({"id":operation_id,"request":request,"context":context});
            let frame = if mutates && self.records.observe(&identity, &context, &original)? {
                json!({"action":"observe","id":operation_id,"context":context,"digest":digest(original)})
            } else {
                let mut frame = original;
                frame["action"] = json!("execute");
                frame
            };
            let cwd = text(scope,"guestPath")?;
            let input = frame.stringify() + "\n";
            let output = process::run_owned(
                &mut session, &id,
                Invocation {
                    argv: &[EXECUTABLE, cwd, &identity],
                    cwd,
                    env: json!({"HOME":scope["homeGuestPath"]}),
                    input: Some(input.as_bytes()),
                },
                LIMITS,
            ).await.context("The OS file operation has an unknown outcome. Inspect it before issuing another mutation.")?;
            self.records.finished(&identity)?;
            ensure!(output.successful, "The Linux file helper did not complete.");
            let response = parse_json_text(&output.stdout).map_err(|_| anyhow::anyhow!("Invalid OS file helper receipt."))?;
            ensure!(response["id"] == *operation_id,
                "OS file helper returned an unexpected operation; outcome is unknown.");
            let result = &response["result"];
            let outcome = checked("surfaceOperationOutcomeContentSchema", &result["outcome"])?;
            let complete = result["complete"].as_bool().context("Invalid OS file helper receipt.")?;
            Ok((outcome, complete))
        }.await;
        session.close().await;
        result
    }
}

// Keep the same order as the Node implementation's durable digest. Direction
// authenticates the outer surface frame and is omitted from the guest record.
fn record_context(context: &Value) -> Value {
    json!({
        "serverId":context["serverId"],"surfaceKind":context["surfaceKind"],
        "surfaceId":context["surfaceId"],"operationId":context["operationId"],
        "sequence":context["sequence"],
    })
}

fn mutation(kind: &str) -> Result<bool> {
    match kind {
        "explorer.directory.list"
        | "explorer.files.search"
        | "explorer.directory.commits"
        | "explorer.file.read"
        | "explorer.binary.read"
        | "explorer.file.preview"
        | "explorer.file.tail"
        | "explorer.media.read" => Ok(false),
        "explorer.file.write"
        | "explorer.file.create"
        | "explorer.directory.create"
        | "explorer.entry.rename"
        | "explorer.entry.delete" => Ok(true),
        _ => bail!("This worker does not support this Explorer operation."),
    }
}
