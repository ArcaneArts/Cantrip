//! Runtime services depend on worker transport, independent of socket location.
//! Socket parsing and correlation stay with the concrete local bridge.
use super::{
    bridge::{
        FrameHandler, FrameSubscription, NotificationHandler, NotificationSubscription,
        OfflineHandler, OfflineSubscription, OwnedNotificationHandler, Peer, SurfaceFrameHandler,
        SurfaceFrameSubscription, TunnelFrameHandler, TunnelFrameSubscription, WorkerBridge,
    },
    command_bus::CommandDelegate,
    coordinated::CoordinatedBridge,
};
use crate::{wire::Value, worker_links::frame::Frame};
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
use std::{future::Future, sync::Arc};
use tokio::sync::oneshot;

pub trait WorkerTransport: CommandDelegate {
    fn local(&self) -> &WorkerBridge;
    fn local_arc(self: Arc<Self>) -> Arc<WorkerBridge>;
    /// Begin attachment immediately, including its generation fence. The HTTP
    /// caller can start it under the credential-revocation lock and release the
    /// lock before awaiting actual Redis/owner IO.
    fn attach_worker(
        &self,
        worker: String,
        peer: Arc<Peer>,
        owner: Option<String>,
        ready: Option<String>,
    ) -> BoxFuture<'static, Result<bool>>;
    fn disconnect(&self, worker: &str, reason: &str, code: u16);
    fn subscribe_worker_disconnect(
        &self,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription;
    fn subscribe_worker_offline(
        &self,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription;
    fn subscribe_notifications(
        &self,
        worker: &str,
        handler: NotificationHandler,
    ) -> NotificationSubscription;
    fn subscribe_owned_notifications(
        &self,
        worker: &str,
        handler: OwnedNotificationHandler,
    ) -> NotificationSubscription;
    fn subscribe_worker_link_frames(
        &self,
        worker: &str,
        handler: FrameHandler,
    ) -> FrameSubscription;
    fn subscribe_tunnel_frames(
        &self,
        worker: &str,
        handler: TunnelFrameHandler,
    ) -> TunnelFrameSubscription;
    fn subscribe_surface_frames(
        &self,
        worker: &str,
        handler: SurfaceFrameHandler,
    ) -> SurfaceFrameSubscription;
    fn send_worker_link_frame(&self, worker: &str, frame: Frame) -> bool;
    fn send_tunnel_frame(&self, worker: &str, header: Value, payload: &[u8]) -> bool;
    fn send_surface_frame(&self, worker: &str, header: Value, payload: &[u8]) -> bool;
    /// Start closure synchronously, then await owned claim cleanup.
    fn shutdown(&self) -> BoxFuture<'static, Result<()>>;
}

fn owned<T: Send + 'static>(
    operation: impl Future<Output = Result<T>> + Send + 'static,
) -> BoxFuture<'static, Result<T>> {
    let (send, receive) = oneshot::channel();
    let mut running = Box::pin(async move {
        let _ = send.send(operation.await);
    });
    if running.as_mut().now_or_never().is_none() {
        tokio::spawn(running);
    }
    Box::pin(async move {
        receive
            .await
            .map_err(|_| anyhow::anyhow!("Worker transport operation stopped."))?
    })
}

impl WorkerTransport for WorkerBridge {
    fn local(&self) -> &WorkerBridge {
        self
    }
    fn local_arc(self: Arc<Self>) -> Arc<WorkerBridge> {
        self
    }
    fn attach_worker(
        &self,
        worker: String,
        peer: Arc<Peer>,
        _owner: Option<String>,
        ready: Option<String>,
    ) -> BoxFuture<'static, Result<bool>> {
        let accepted = self.attach(&worker, peer, ready);
        Box::pin(async move { Ok(accepted) })
    }
    fn disconnect(&self, worker: &str, reason: &str, code: u16) {
        WorkerBridge::disconnect(self, worker, reason, code);
    }
    fn subscribe_worker_disconnect(&self, w: &str, h: OfflineHandler) -> OfflineSubscription {
        WorkerBridge::subscribe_worker_disconnect(self, w, h)
    }
    fn subscribe_worker_offline(&self, w: &str, h: OfflineHandler) -> OfflineSubscription {
        WorkerBridge::subscribe_worker_offline(self, w, h)
    }
    fn subscribe_notifications(&self, w: &str, h: NotificationHandler) -> NotificationSubscription {
        WorkerBridge::subscribe_notifications(self, w, h)
    }
    fn subscribe_owned_notifications(
        &self,
        w: &str,
        h: OwnedNotificationHandler,
    ) -> NotificationSubscription {
        WorkerBridge::subscribe_owned_notifications(self, w, h)
    }
    fn subscribe_worker_link_frames(&self, w: &str, h: FrameHandler) -> FrameSubscription {
        WorkerBridge::subscribe_worker_link_frames(self, w, h)
    }
    fn subscribe_tunnel_frames(&self, w: &str, h: TunnelFrameHandler) -> TunnelFrameSubscription {
        WorkerBridge::subscribe_tunnel_frames(self, w, h)
    }
    fn subscribe_surface_frames(
        &self,
        w: &str,
        h: SurfaceFrameHandler,
    ) -> SurfaceFrameSubscription {
        WorkerBridge::subscribe_surface_frames(self, w, h)
    }
    fn send_worker_link_frame(&self, w: &str, frame: Frame) -> bool {
        WorkerBridge::send_worker_link_frame(self, w, frame)
    }
    fn send_tunnel_frame(&self, w: &str, header: Value, payload: &[u8]) -> bool {
        WorkerBridge::send_tunnel_frame(self, w, header, payload)
    }
    fn send_surface_frame(&self, w: &str, header: Value, payload: &[u8]) -> bool {
        WorkerBridge::send_surface_frame(self, w, header, payload)
    }
    fn shutdown(&self) -> BoxFuture<'static, Result<()>> {
        self.close();
        Box::pin(async { Ok(()) })
    }
}

/// Owns the shared bridge so synchronous transport methods can start its
/// lifetime-owned async work without requiring callers to know its location.
pub struct CoordinatedTransport(Arc<CoordinatedBridge>);
impl CoordinatedTransport {
    pub fn new(bridge: Arc<CoordinatedBridge>) -> Arc<Self> {
        Arc::new(Self(bridge))
    }
}
impl CommandDelegate for CoordinatedTransport {
    fn stats(&self) -> super::bridge::BridgeStats {
        self.0.stats()
    }
    fn is_connected(&self, worker: &str) -> bool {
        self.0.is_connected(worker)
    }
    fn connection_identity(&self, worker: &str) -> Option<super::bridge::Continuity> {
        self.0.connection_identity(worker)
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<std::time::Duration>,
        on_event: Option<super::bridge::EventHandler>,
    ) -> BoxFuture<'static, super::command_bus::CommandOutcome> {
        CommandDelegate::request(self.0.clone(), owner, worker, command, timeout, on_event)
    }
}
impl WorkerTransport for CoordinatedTransport {
    fn local(&self) -> &WorkerBridge {
        &self.0.local
    }
    fn local_arc(self: Arc<Self>) -> Arc<WorkerBridge> {
        self.0.local.clone()
    }
    fn attach_worker(
        &self,
        worker: String,
        peer: Arc<Peer>,
        owner: Option<String>,
        ready: Option<String>,
    ) -> BoxFuture<'static, Result<bool>> {
        let bridge = self.0.clone();
        owned(async move { bridge.attach(&worker, peer, owner, ready).await })
    }
    fn disconnect(&self, w: &str, reason: &str, code: u16) {
        self.0.disconnect(w, Some(reason.into()), Some(code));
    }
    fn subscribe_worker_disconnect(&self, w: &str, h: OfflineHandler) -> OfflineSubscription {
        self.0.subscribe_worker_disconnect(w, h)
    }
    fn subscribe_worker_offline(&self, w: &str, h: OfflineHandler) -> OfflineSubscription {
        self.0.subscribe_worker_offline(w, h)
    }
    fn subscribe_notifications(&self, w: &str, h: NotificationHandler) -> NotificationSubscription {
        self.0.subscribe_notifications(w, h)
    }
    fn subscribe_owned_notifications(
        &self,
        w: &str,
        h: OwnedNotificationHandler,
    ) -> NotificationSubscription {
        self.0.subscribe_owned_notifications(w, h)
    }
    fn subscribe_worker_link_frames(&self, w: &str, h: FrameHandler) -> FrameSubscription {
        self.0.subscribe_worker_link_frames(w, h)
    }
    fn subscribe_tunnel_frames(&self, w: &str, h: TunnelFrameHandler) -> TunnelFrameSubscription {
        self.0.subscribe_tunnel_frames(w, h)
    }
    fn subscribe_surface_frames(
        &self,
        w: &str,
        h: SurfaceFrameHandler,
    ) -> SurfaceFrameSubscription {
        self.0.subscribe_surface_frames(w, h)
    }
    fn send_worker_link_frame(&self, w: &str, frame: Frame) -> bool {
        self.0.send_worker_link_frame(w, frame)
    }
    fn send_tunnel_frame(&self, w: &str, header: Value, payload: &[u8]) -> bool {
        self.0.send_tunnel_frame(w, header, payload)
    }
    fn send_surface_frame(&self, w: &str, header: Value, payload: &[u8]) -> bool {
        self.0.send_surface_frame(w, header, payload)
    }
    fn shutdown(&self) -> BoxFuture<'static, Result<()>> {
        let bridge = self.0.clone();
        owned(async move {
            bridge.close().await;
            Ok(())
        })
    }
}
