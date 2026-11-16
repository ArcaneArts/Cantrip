//! Start the synchronous prefix now, then retain operation ownership even when
//! the caller drops its result future. Closure/error policy belongs to the caller.
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
use std::future::Future;
use tokio::sync::oneshot;
pub fn owned<T: Send + 'static>(
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
