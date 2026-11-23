//! Attachment counts belong to one server, including multiple browser clients.
use std::{collections::HashMap, sync::Mutex};
#[derive(Default)]
pub struct AttachmentCounts(Mutex<HashMap<String, usize>>);
impl AttachmentCounts {
    pub fn attached(&self, surface: &str) {
        *self.0.lock().unwrap().entry(surface.into()).or_default() += 1;
    }
    pub fn detached(&self, surface: &str) -> usize {
        let mut counts = self.0.lock().unwrap();
        let remaining = counts.get(surface).copied().unwrap_or(1).saturating_sub(1);
        if remaining == 0 {
            counts.remove(surface);
        } else {
            counts.insert(surface.into(), remaining);
        }
        remaining
    }
}
