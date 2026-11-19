//! Protected Explorer and document requests routed to the captured workspace.
#[cfg(all(feature = "guest-files", target_os = "linux"))]
pub(crate) mod helper;
mod records;
mod stream;

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
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

const EXECUTABLE: &str = "/usr/lib/cantrip-os-executor/cantrip-os-files";
const CLIENT: &str = "cantrip-product-files";
const LIMITS: Limits = Limits {
    deadline: Duration::from_secs(60),
    output: 8 * 1024 * 1024,
};

pub(crate) struct ProductFiles {
    records: Arc<Records>,
    queues: Mutex<HashMap<String, Arc<stream::Placement>>>,
}

impl ProductFiles {
    pub fn new(directory: &Path) -> Self {
        Self {
            records: Arc::new(Records::new(directory)),
            queues: Mutex::default(),
        }
    }

    fn queue(&self, identity: &str) -> Arc<stream::Placement> {
        let mut queues = self.queues.lock().unwrap();
        if let Some(queue) = queues.get(identity) {
            return queue.clone();
        }
        queues.retain(|_, queue| {
            Arc::strong_count(queue) > 1 || queue.try_lock().is_ok_and(|helper| helper.is_some())
        });
        let queue = Arc::new(stream::Placement::new(None));
        queues.insert(identity.to_owned(), queue.clone());
        queue
    }

    pub async fn close(&self) {
        let queues = std::mem::take(&mut *self.queues.lock().unwrap());
        futures::future::join_all(queues.into_iter().map(|(identity, queue)| async move {
            let mut slot = queue.lock().await;
            if let Some(helper) = slot.take() {
                helper.close(&self.records, &identity).await;
            }
        }))
        .await;
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
        let mut slot = tokio::select! {
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

        let context = record_context(context);
        if slot
            .as_ref()
            .is_some_and(|helper| helper.session.binding != binding)
        {
            slot.take().unwrap().close(&self.records, &identity).await;
        }
        if slot.is_none() {
            self.records
                .retire(&identity, &transport, &binding, lifetime)
                .await?;
        }

        if slot.is_some() || is_import(kind) {
            // An admission conflict is detected before delivering bytes. It
            // leaves an already running helper and its other imports intact.
            let prepared = slot
                .is_some()
                .then(|| self.frame(&identity, &context, request, mutates))
                .transpose()?;
            let mut helper = match slot.take() {
                Some(helper) => helper,
                None => {
                    stream::Helper::start(
                        &self.records,
                        &identity,
                        &transport,
                        binding.clone(),
                        scope,
                        lifetime,
                    )
                    .await?
                }
            };
            let result = async {
                let frame = match prepared {
                    Some(frame) => frame,
                    None => self.frame(&identity, &context, request, mutates)?,
                };
                let response = helper.send(&frame).await?;
                let retained = response["retained"]
                    .as_bool()
                    .context("Invalid OS file helper receipt.")?;
                Ok::<_, anyhow::Error>((receipt(&response, &context)?, retained))
            }
            .await;
            return match result {
                Ok((result, true)) => {
                    helper.retain(&queue, self.records.clone(), identity);
                    *slot = Some(helper);
                    Ok(result)
                }
                Ok((result, false)) => {
                    helper.close(&self.records, &identity).await;
                    Ok(result)
                }
                Err(error) => {
                    // Stop the exact retained child through a fresh carrier.
                    // A short write may have left a partial input frame.
                    helper.session.close().await;
                    let _ = self
                        .records
                        .retire(&identity, &transport, &binding, &Scope::default())
                        .await;
                    Err(error.context("The OS file operation has an unknown outcome. Inspect it before issuing another mutation."))
                }
            };
        }

        let (mut session, session_id) =
            Session::connect(&transport, binding, CLIENT, None, lifetime).await?;
        let id = Uuid::new_v4().to_string();
        let result = async {
            self.records.start(&identity, &session.binding, &session_id, &id)?;
            let frame = self.frame(&identity, &context, request, mutates)?;
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
            receipt(&response, &context)
        }.await;
        session.close().await;
        result
    }

    fn frame(
        &self,
        identity: &str,
        context: &Value,
        request: &Value,
        mutates: bool,
    ) -> Result<Value> {
        let id = &context["operationId"];
        let mut frame = json!({"id":id,"request":request,"context":context});
        if mutates && self.records.observe(identity, context, &frame)? {
            return Ok(
                json!({"action":"observe","id":id,"context":context,"digest":digest(frame)}),
            );
        }
        frame["action"] = json!("execute");
        Ok(frame)
    }
}

fn receipt(response: &Value, context: &Value) -> Result<(Value, bool)> {
    ensure!(
        response["id"] == context["operationId"],
        "OS file helper returned an unexpected operation; outcome is unknown."
    );
    let result = &response["result"];
    let outcome = checked("surfaceOperationOutcomeContentSchema", &result["outcome"])?;
    let complete = result["complete"]
        .as_bool()
        .context("Invalid OS file helper receipt.")?;
    Ok((outcome, complete))
}

fn is_import(kind: &str) -> bool {
    matches!(kind, "explorer.file.import" | "explorer.file.import.cancel")
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
        | "chat.files.references"
        | "explorer.files.search"
        | "explorer.directory.commits"
        | "explorer.file.read"
        | "explorer.binary.read"
        | "explorer.file.preview"
        | "explorer.file.tail"
        | "explorer.media.read"
        | "explorer.binary.write.status" => Ok(false),
        "explorer.file.write"
        | "explorer.file.create"
        | "explorer.directory.create"
        | "explorer.entry.rename"
        | "explorer.entry.delete"
        | "explorer.binary.write.begin"
        | "explorer.binary.write.chunk"
        | "explorer.binary.write.commit"
        | "explorer.file.import"
        | "explorer.file.import.cancel"
        | "explorer.binary.write.abort" => Ok(true),
        _ => bail!("This worker does not support this Explorer operation."),
    }
}
