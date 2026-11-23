//! One ordered Redis command queue, including requests issued while reconnecting.
//! Publication/readiness inspect the actual command connection before enqueueing;
//! directory requests retain their Source offline-queue and caller-drop lifetime.
use futures::{FutureExt, future::BoxFuture};
use redis::{
    Client, Cmd, ErrorKind, Pipeline, RedisError, RedisFuture, RedisResult, Value,
    aio::{ConnectionLike, ConnectionManager, ConnectionManagerConfig, MultiplexedConnection},
};
use std::sync::{Arc, Mutex};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::AbortHandle,
};

type Job = Box<dyn FnOnce(MultiplexedConnection) -> BoxFuture<'static, ()> + Send>;
struct Lifetime {
    closing: watch::Sender<bool>,
    draining: watch::Sender<bool>,
    task: Mutex<Option<AbortHandle>>,
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.closing.send_replace(true);
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }
}
#[derive(Clone)]
pub(super) struct CommandConnection {
    manager: ConnectionManager,
    queue: mpsc::UnboundedSender<Job>,
    lifetime: Arc<Lifetime>,
}
fn closed() -> RedisError {
    (ErrorKind::Client, "Redis coordination is unavailable.").into()
}
impl CommandConnection {
    pub async fn new(client: &Client) -> RedisResult<Self> {
        // Node's command client has no response timeout. A paused Redis write
        // still owns its eventual effect after its HTTP/socket caller leaves.
        let manager = client
            .get_connection_manager_with_config(
                ConnectionManagerConfig::default().set_response_timeout(None),
            )
            .await?;
        let (queue, receiver) = mpsc::unbounded_channel();
        let lifetime = Arc::new(Lifetime {
            closing: watch::channel(false).0,
            draining: watch::channel(false).0,
            task: Mutex::new(None),
        });
        let task = tokio::spawn(Self::run(
            manager.clone(),
            receiver,
            lifetime.closing.subscribe(),
            lifetime.draining.subscribe(),
        ));
        *lifetime.task.lock().unwrap() = Some(task.abort_handle());
        Ok(Self {
            manager,
            queue,
            lifetime,
        })
    }
    pub fn is_ready(&self) -> bool {
        !*self.lifetime.closing.borrow() && self.manager.try_get_connection().is_some()
    }
    pub fn close(&self) {
        self.lifetime.closing.send_replace(true);
    }
    pub fn begin_shutdown(&self) {
        self.lifetime.draining.send_replace(true);
    }
    async fn connected(
        manager: &ConnectionManager,
        closing: &mut watch::Receiver<bool>,
        draining: &mut watch::Receiver<bool>,
    ) -> Option<MultiplexedConnection> {
        loop {
            if *closing.borrow() {
                return None;
            }
            if let Some(connection) = manager.try_get_connection() {
                return Some(connection);
            }
            // Normal directory requests wait through reconnect. Once the
            // server is draining, an unavailable connection must instead
            // settle queued work so services can finish before Redis closes.
            if *draining.borrow() {
                return None;
            }
            tokio::select! {
                biased;
                _ = closing.changed() => return None,
                _ = draining.changed() => {},
                _ = manager.wait_for_connection() => {},
            }
        }
    }
    async fn run(
        manager: ConnectionManager,
        mut queue: mpsc::UnboundedReceiver<Job>,
        mut closing: watch::Receiver<bool>,
        mut draining: watch::Receiver<bool>,
    ) {
        loop {
            if *closing.borrow() {
                return;
            }
            let job = tokio::select! {
                biased;
                _ = closing.changed() => return,
                job = queue.recv() => match job {Some(job)=>job,None=>return},
            };
            let Some(connection) = Self::connected(&manager, &mut closing, &mut draining).await
            else {
                return;
            };
            let mut stop = closing.clone();
            let mut task = Box::pin(async move {
                if *stop.borrow() {
                    return;
                }
                tokio::select! {
                    biased;
                    _ = stop.changed() => {},
                    _ = job(connection) => {},
                }
            });
            // Queue sends start in submission order without waiting for each
            // response. Pending replies remain owned if the original waiter left.
            if task.as_mut().now_or_never().is_none() {
                tokio::spawn(task);
            }
        }
    }
}
impl ConnectionLike for CommandConnection {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        Box::pin(async move {
            if *self.lifetime.closing.borrow() {
                return Err(closed());
            }
            let cmd = cmd.clone();
            let (send, receive) = oneshot::channel();
            self.queue
                .send(Box::new(move |mut connection| {
                    Box::pin(async move {
                        let _ = send.send(connection.send_packed_command(&cmd).await);
                    })
                }))
                .map_err(|_| closed())?;
            receive.await.map_err(|_| closed())?
        })
    }
    fn req_packed_commands<'a>(
        &'a mut self,
        pipeline: &'a Pipeline,
        offset: usize,
        count: usize,
    ) -> RedisFuture<'a, Vec<Value>> {
        Box::pin(async move {
            if *self.lifetime.closing.borrow() {
                return Err(closed());
            }
            let pipeline = pipeline.clone();
            let (send, receive) = oneshot::channel();
            self.queue
                .send(Box::new(move |mut connection| {
                    Box::pin(async move {
                        let _ = send.send(
                            connection
                                .send_packed_commands(&pipeline, offset, count)
                                .await,
                        );
                    })
                }))
                .map_err(|_| closed())?;
            receive.await.map_err(|_| closed())?
        })
    }
    fn get_db(&self) -> i64 {
        self.manager.get_db()
    }
}
