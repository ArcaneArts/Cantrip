//! Shared observations do not own or cancel accepted admission work.
use anyhow::{Result, anyhow};
use cantrip_history::projection::Work;
use std::sync::Arc;
use tokio::sync::watch;
#[derive(Clone, Debug)]
pub struct Failure(pub Arc<anyhow::Error>);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}
impl Failure {
    pub fn new(error: anyhow::Error) -> Self {
        Self(Arc::new(error))
    }
    pub fn message(&self) -> cantrip_wire::JsString {
        crate::error::message(&self.0)
    }
    pub fn error(&self) -> anyhow::Error {
        if let Some(error) = self
            .0
            .downcast_ref::<super::super::withdrawal::Withdrawal>()
        {
            return error.clone().into();
        }
        if let Some(error) = self.0.downcast_ref::<super::AdmissionError>() {
            return error.clone().into();
        }
        if let Some(error) = self.0.downcast_ref::<crate::error::WireError>() {
            return crate::error::WireError(error.0.clone()).into();
        }
        if let Some(error) = self.0.downcast_ref::<crate::metadata::Cancelled>() {
            return error.clone().into();
        }
        self.clone().into()
    }
}
#[derive(Clone)]
pub struct Promise<T: Clone>(watch::Receiver<Option<std::result::Result<T, Failure>>>);
#[derive(Clone)]
pub struct Complete<T: Clone>(watch::Sender<Option<std::result::Result<T, Failure>>>);
impl<T: Clone + Send + Sync + 'static> Promise<T> {
    pub fn same(&self, other: &Self) -> bool {
        self.0.same_channel(&other.0)
    }
    pub fn pair() -> (Complete<T>, Self) {
        let (send, receive) = watch::channel(None);
        (Complete(send), Self(receive))
    }
    pub fn ready(value: Result<T>) -> Self {
        let (complete, pending) = Self::pair();
        complete.finish(value);
        pending
    }
    pub fn spawn(operation: impl std::future::Future<Output = Result<T>> + Send + 'static) -> Self {
        let (complete, pending) = Self::pair();
        // Never inline-poll an operation while its registry mutex is held.
        tokio::spawn(async move {
            complete.finish(operation.await);
        });
        pending
    }
    pub fn work(&self) -> Work<T> {
        let mut receive = self.0.clone();
        Box::pin(async move {
            loop {
                let value = receive.borrow_and_update().clone();
                if let Some(value) = value {
                    return value.map_err(|error| error.error());
                }
                receive
                    .changed()
                    .await
                    .map_err(|_| anyhow!("Inference operation stopped without settlement."))?;
            }
        })
    }
}
impl<T: Clone> Complete<T> {
    pub fn finish(&self, value: Result<T>) {
        let mut value = Some(value.map_err(Failure::new));
        self.0.send_if_modified(|existing| {
            if existing.is_some() {
                return false;
            }
            *existing = value.take();
            true
        });
    }
}
