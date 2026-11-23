//! Production worker adapter: history and attachment grants retain their own
//! domains while authentication follows the current rotated worker credential.
use super::{
    Diagnostic, Retry,
    coordinator::{History, Options},
};
use crate::{
    attachments,
    config::Config,
    encryption::Service,
    history::{EncryptionService, client},
    logging::{self, Logs},
};
use anyhow::Result;
use cantrip_wire::value::json;
use std::sync::{Arc, Mutex};
pub fn open(
    configuration: Arc<Mutex<Config>>,
    service: Arc<Service>,
    logs: Arc<Logs>,
) -> Result<History> {
    let config = configuration.lock().unwrap();
    let credentials = configuration.clone();
    let client = client::Client::new(client::Options {
        server_url: config.server_url.clone(),
        worker_id: config.worker_id.clone(),
        token: Arc::new(move || Ok(credentials.lock().unwrap().token.clone())),
        metadata_signal: None,
    })?;
    let report: Diagnostic = Arc::new(move |error, context| {
        logs.event("warn","Native history synchronization remains pending",json!({"event":"codex.history.synchronization-pending","subsystem":"codex","operation":context["phase"],"chatId":context["chatId"],"threadId":context["threadId"],"runtimeGeneration":context["generation"],"error":logging::error(&error.error())}));
        Ok(())
    });
    History::new(Options {
        directory: config.data_directory.clone(),
        worker_id: config.worker_id.clone(),
        service: Arc::new(EncryptionService(service.clone())),
        attachment_keys: Arc::new(attachments::content::ServiceKeys(service)),
        client,
        attachments: attachments::Store::new(&config.data_directory, None)?,
        on_error: Some(report),
        timing: Default::default(),
        retry: Retry::default(),
    })
}
