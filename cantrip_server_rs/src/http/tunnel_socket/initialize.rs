use super::{Connection, Peer};
use crate::{
    auth::{crypto, service::AuthService},
    live::Socket as _,
    tunnels::{Repository, runtime},
    wire::Value,
};
use anyhow::{Context, Result, bail};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
pub(super) struct InitialFrame {
    pub bytes: Vec<u8>,
    pub binary: bool,
}
pub(super) struct First {
    sender: Mutex<Option<oneshot::Sender<Result<InitialFrame>>>>,
    timer: Mutex<Option<tokio::task::AbortHandle>>,
}
impl First {
    pub fn new() -> (Arc<Self>, oneshot::Receiver<Result<InitialFrame>>) {
        let (send, receive) = oneshot::channel();
        let first = Arc::new(Self {
            sender: Mutex::new(Some(send)),
            timer: Mutex::new(None),
        });
        let (weak, deadline) = (
            Arc::downgrade(&first),
            tokio::time::Instant::now() + Duration::from_secs(10),
        );
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(first) = weak.upgrade() {
                first.finish(Err(anyhow::anyhow!("Tunnel initialization timed out.")));
            }
        });
        *first.timer.lock().unwrap() = Some(task.abort_handle());
        (first, receive)
    }
    pub fn finish(&self, frame: Result<InitialFrame>) -> bool {
        let sender = self.sender.lock().unwrap().take();
        if let Some(sender) = sender {
            if let Some(timer) = self.timer.lock().unwrap().take() {
                timer.abort();
            }
            let _ = sender.send(frame);
            true
        } else {
            false
        }
    }
}
impl Drop for First {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.get_mut().unwrap().take() {
            timer.abort();
        }
    }
}
pub(super) async fn start(
    service: Arc<AuthService>,
    peer: Arc<Peer>,
    connection: Arc<Connection>,
    secret: String,
    id: String,
    first: oneshot::Receiver<Result<InitialFrame>>,
) {
    if !(32..=512).contains(&crate::text::length(&secret)) {
        peer.close(1008, "Attachment authentication failed");
        return;
    }
    let authorization = Repository::new(service.repository.database.clone())
        .authorize_attachment(&id, &crypto::hash_secret(&secret))
        .await;
    let authorization = match authorization {
        Ok(Some(authorization)) => authorization,
        Ok(None) => {
            peer.close(1008, "Attachment authentication failed");
            return;
        }
        Err(_) => {
            peer.terminate();
            return;
        }
    };
    let Some(registration) = service.live.sessions.register(
        peer.clone(),
        authorization["ownerId"].as_str().expect("Tunnel owner"),
        None,
    ) else {
        return;
    };
    connection.register(registration);
    let result: Result<()> = async {
        let first = first.await.context("Tunnel attachment disconnected.")??;
        let owner = authorization["ownerId"].as_str().context("Tunnel owner")?;
        let channel = runtime::channel(&authorization);
        service
            .usage
            .record(owner, channel, true, first.bytes.len(), 1, true);
        if first.binary {
            bail!("Tunnel initialization must be JSON.");
        }
        let value: Value = serde_json::from_slice(&first.bytes)
            .map_err(|_| anyhow::anyhow!("Tunnel initialization is invalid."))?;
        let initialize =
            crate::settings::parse_response("tunnelAttachmentInitializeSchema", Some(&value))?;
        let attachment =
            service
                .tunnel_runtime
                .begin(peer.clone(), authorization.clone(), &initialize)?;
        connection.attach(attachment.handle);
        let ready = attachment
            .ready
            .await
            .context("Tunnel attachment activation ended")??;
        if peer.is_open() {
            let ready =
                crate::settings::parse_response("tunnelAttachmentReadySchema", Some(&ready))?
                    .stringify();
            peer.send(ready.clone().into())?;
            service
                .usage
                .record(owner, channel, false, ready.len(), 1, true);
        }
        Ok(())
    }
    .await;
    if let Err(cause) = result {
        peer.close(1008, &cause.to_string());
    }
}
