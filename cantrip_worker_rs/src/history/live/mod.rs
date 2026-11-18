//! Live history observation and publication identity. None of these mechanisms
//! admits native input, grants execution, or acknowledges canonical history.
pub mod capture;
mod flight;
pub mod identity;
pub mod mode;
pub mod observation;
use anyhow::Result;
use cantrip_history::projection::Work;
use std::sync::Arc;
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
    pub fn error(&self) -> anyhow::Error {
        if let Some(error) = self.0.downcast_ref::<super::client::ServerRequestError>() {
            return error.clone().into();
        }
        if self.0.is::<crate::metadata::TimedOut>() {
            return crate::metadata::TimedOut.into();
        }
        if let Some(error) = self.0.downcast_ref::<crate::error::WireError>() {
            return crate::error::WireError(error.0.clone()).into();
        }
        if let Some(error) = self.0.downcast_ref::<crate::metadata::Cancelled>() {
            return error.clone().into();
        }
        if self.0.is::<super::turn_context::Pending>() {
            return super::turn_context::Pending.into();
        }
        self.clone().into()
    }
}
pub(super) fn response<T: Send + 'static>(
    receive: tokio::sync::oneshot::Receiver<std::result::Result<T, Failure>>,
) -> Work<T> {
    cantrip_transport::lifecycle::owned(async move {
        receive
            .await
            .map_err(anyhow::Error::from)?
            .map_err(|e| e.error())
    })
}
pub(super) fn ready<T: Send + 'static>(value: Result<T>) -> Work<T> {
    Box::pin(async { value })
}
