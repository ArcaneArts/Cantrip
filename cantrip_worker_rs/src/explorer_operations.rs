//! Protected Explorer/file-document commands. Files remain worker-owned and all
//! private outcomes, including path errors, are sealed before transport reply.
use crate::{
    cantrip_os::product_files::ProductFiles,
    encryption::Service,
    filesystem::{
        Scope, chat_references,
        explorer::{self, binary_write, imports::Imports},
        paths,
    },
    protected_content::{
        SurfaceStreamReplayGuard, open_private_state, open_surface_content_with_input,
        protect_surface_content,
    },
    routing::Registry,
};
use anyhow::{Context, Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct ExplorerOperations {
    replay: Arc<Mutex<SurfaceStreamReplayGuard>>,
    guests: Option<Arc<ProductFiles>>,
    binary_writes: Option<binary_write::Writer>,
    imports: Imports,
}
impl ExplorerOperations {
    pub(crate) async fn close(&self) {
        if let Some(guests) = &self.guests {
            guests.close().await;
        }
    }

    /// All surface consumers in one runtime share admission/replay capacity.
    pub(crate) fn with_replay(
        replay: Arc<Mutex<SurfaceStreamReplayGuard>>,
        directory: &Path,
        guests: Arc<ProductFiles>,
    ) -> Self {
        Self {
            replay,
            guests: Some(guests),
            binary_writes: Some(binary_write::Writer::new(
                directory,
                &directory.join("binary-write-locks"),
            )),
            imports: Imports::default(),
        }
    }
    pub async fn execute(
        &self,
        command: &Value,
        service: &Service,
        registry: &Registry,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        // The public Node wrapper resolves all routing metadata before dispatch.
        let command = registry.resolve(command).await?;
        let (kind, id, schema) = match command["type"].as_str() {
            Some("chat.files.references") => (
                "chat-files",
                &command["chatId"],
                "chatFileReferencesRequestContentSchema",
            ),
            Some("file-document.operation") => (
                "file-document",
                &command["documentId"],
                "explorerOperationRequestContentSchema",
            ),
            _ => (
                "explorer",
                &command["explorerId"],
                "explorerOperationRequestContentSchema",
            ),
        };
        let mut context = json!({"serverId":command["serverId"],"surfaceKind":kind,"surfaceId":id,"operationId":command["operationId"],"direction":"request","sequence":command["sequence"]});
        self.replay.lock().unwrap().reserve(&context)?;
        // Failed opens consume their reservation. Do not roll back sequence or
        // hold replay/key locks across asynchronous filesystem work.
        let (request, input) = open_surface_content_with_input(
            service,
            &context,
            &command["protectedRequest"],
            schema,
        )?;
        let result = async {
            if kind == "file-document" {
                let owner = service.owner_id()?;
                let binding = json!({"serverId":command["serverId"],"resource":"file-document-row","resourceId":command["documentId"],"operationId":Value::Null,"recordKind":"file-document-state"});
                let state = open_private_state(service,&owner,&binding,&command["stateProtection"])?;
                let state = checked("fileDocumentPrivateStateProtectedContentSchema",&state)?;
                if state["projectId"] != command["projectId"] || state["worktreeId"] != command["worktreeId"] || state["workerId"] != command["workerId"]
                    || (!command["root"].is_string() && (command["root"]["scope"]["projectId"] != state["projectId"] || command["root"]["scope"]["worktreeId"] != state["worktreeId"])) {
                    bail!("File document checkout binding does not match.");
                }
                let allowed = matches!(request["type"].as_str(),Some("explorer.binary.write.begin"|"explorer.binary.write.chunk"|"explorer.binary.write.commit"|"explorer.binary.write.status"|"explorer.binary.write.abort"|"explorer.binary.read"|"explorer.file.read"|"explorer.file.preview"|"explorer.file.tail"|"explorer.file.write"|"explorer.media.read"));
                if !allowed || request["path"] != state["path"] {bail!("The operation does not target this file document.");}
            }
            if let Some(root) = command["root"].as_js_string() {
                let result = if kind == "chat-files" {
                    let value = chat_references::resolve(&paths::native(root), &request).await?;
                    json!({"type":"chat.files.references","value":value})
                } else if binary_write::action(&request).is_some() {
                    let writer = self.binary_writes.as_ref().context("This worker does not support streamed binary saves.")?;
                    let material = service.bound_component("surface-private-state", None)?;
                    if material.server_id != context["serverId"] {
                        bail!("Binary write belongs to another server.");
                    }
                    writer.execute(root, &context, &request, json!(material.owner_id), material.component).await?
                } else if matches!(request["type"].as_str(), Some("explorer.file.import"|"explorer.file.import.cancel")) {
                    self.imports.execute(&paths::native(root), &context, &request, scope).await?
                } else {
                    explorer::execute_decoded(&paths::native(root), &request, &input, scope).await?
                };
                let complete = explorer::complete(&result, &request);
                return Ok((json!({"ok":true,"result":result}), complete));
            }
            self.guests.as_ref().context("This worker does not support CantripOS file operations.")?
                .execute(&command["root"], &request, &context, service, scope).await
        }.await;
        let (outcome, complete) = match result {
            Ok(result) => result,
            Err(error) => (explorer::failure(&error), true),
        };
        let reserved = context.clone();
        context["direction"] = json!("response");
        let protected = protect_surface_content(
            service,
            &context,
            &outcome,
            "surfaceOperationOutcomeContentSchema",
        )?;
        self.replay
            .lock()
            .unwrap()
            .accept(&reserved, complete || outcome["ok"] == false)?;
        checked(
            "surfaceStreamWireResponseSchema",
            &json!({"operationId":command["operationId"],"sequence":command["sequence"],"protectedResponse":protected}),
        )
    }
}
