//! Retain the original error when multiple callers join an owned operation.
use std::{error::Error as StdError, fmt, sync::Arc};

#[derive(Debug)]
struct SharedFailure(Arc<anyhow::Error>);
impl fmt::Display for SharedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}
impl StdError for SharedFailure {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}
pub fn owned(error: Arc<anyhow::Error>) -> anyhow::Error {
    Arc::try_unwrap(error).unwrap_or_else(|error| SharedFailure(error).into())
}
pub fn downcast_ref<T: fmt::Display + fmt::Debug + Send + Sync + 'static>(
    error: &anyhow::Error,
) -> Option<&T> {
    error.downcast_ref::<T>().or_else(|| {
        error
            .downcast_ref::<SharedFailure>()
            .and_then(|shared| downcast_ref(shared.0.as_ref()))
    })
}
