use super::Failure;
use cantrip_history::projection::Work;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use tokio::sync::oneshot;
pub(super) type Reply<T> = std::result::Result<T, Failure>;
pub(super) type Promise<T> = Shared<BoxFuture<'static, Reply<T>>>;
pub(super) fn deferred<T: Clone + Send + Sync + 'static>() -> (oneshot::Sender<Reply<T>>, Promise<T>)
{
    let (send, receive) = oneshot::channel();
    let future = async move {
        receive.await.unwrap_or_else(|_| {
            Err(Failure::new(anyhow::anyhow!(
                "Native history owner stopped."
            )))
        })
    }
    .boxed()
    .shared();
    (send, future)
}
pub(super) fn finish<T: Send + 'static>(send: oneshot::Sender<Reply<T>>, operation: Work<T>) {
    drop(cantrip_transport::lifecycle::owned(async move {
        let _ = send.send(operation.await.map_err(Failure::new));
        Ok(())
    }));
}
pub(super) fn wait<T: Clone + Send + Sync + 'static>(promise: Promise<T>) -> Work<T> {
    cantrip_transport::lifecycle::owned(async move { promise.await.map_err(|e| e.error()) })
}
pub(super) fn settled() -> Promise<()> {
    async { Ok(()) }.boxed().shared()
}
