//! Bytes stay reserved while queued or being flushed by the transport writer.
//! Dropping an abandoned write releases the same reservation as a completed one.
use std::{
    ops::Deref,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Default)]
pub(crate) struct Buffered(Arc<AtomicUsize>);
pub(crate) fn framed_size(payload: usize) -> usize {
    payload
        + if payload < 126 {
            2
        } else if payload <= u16::MAX as usize {
            4
        } else {
            10
        }
}
pub struct Queued<T> {
    value: Option<T>,
    buffered: Arc<AtomicUsize>,
    bytes: usize,
}
impl<T> Queued<T> {
    pub fn take(&mut self) -> T {
        self.value.take().expect("outgoing value consumed once")
    }
}
impl<T> Deref for Queued<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.value
            .as_ref()
            .expect("outgoing value remains available")
    }
}
impl<T> Drop for Queued<T> {
    fn drop(&mut self) {
        self.buffered.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
impl Buffered {
    pub(crate) fn bytes(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
    pub(crate) fn reserve<T>(&self, value: T, bytes: usize) -> Queued<T> {
        self.0.fetch_add(bytes, Ordering::AcqRel);
        Queued {
            value: Some(value),
            buffered: self.0.clone(),
            bytes,
        }
    }
    pub(super) fn bounded<T>(&self, value: T, bytes: usize, limit: usize) -> Option<Queued<T>> {
        // Match ws.bufferedAmount > limit: the crossing frame is admitted;
        // subsequent sends fail until actual writes release their bytes.
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used <= limit).then(|| used + bytes)
            })
            .ok()?;
        Some(Queued {
            value: Some(value),
            buffered: self.0.clone(),
            bytes,
        })
    }
}
