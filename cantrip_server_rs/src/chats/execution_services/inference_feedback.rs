//! Relay worker-owned snapshots; the server never grants inference capacity.
use super::*;

impl Service {
    pub(super) fn inference_status(&self, owner: &str, worker: &str, notification: &Value) {
        let Ok(status) =
            crate::wire::parse("workerInferenceStatusSchema", Some(&notification["status"]))
        else {
            return;
        };
        let Some(generation) = status["workerGeneration"].as_str() else {
            return;
        };
        let Some(revision) = status["revision"].as_u64() else {
            return;
        };
        // Serialize validation/publication so a retired callback cannot publish
        // after the replacement generation's snapshot.
        let mut revisions = self.inference_revisions.lock().unwrap();
        let Some(identity) = self.bridge.connection_identity(worker) else {
            return;
        };
        if !self.bridge.is_connected(worker)
            || identity.owner != owner
            || identity.process_generation != generation
            || status["serverId"].as_str() != Some(self.inference_server_id.as_str())
            || status["ownerId"].as_str() != Some(owner)
            || status["workerId"].as_str() != Some(worker)
        {
            return;
        }
        if revisions
            .get(worker)
            .is_some_and(|(previous, last)| previous == generation && *last >= revision)
        {
            return;
        }
        if revisions.len() >= 4096 && !revisions.contains_key(worker) {
            if let Some(key) = revisions.keys().next().cloned() {
                revisions.remove(&key);
            }
        }
        revisions.insert(worker.into(), (generation.into(), revision));
        let _ = self.inference_live.publish_event(json!({
            "ownerId":owner, "scope":{"kind":"current-user"},
            "resource":"worker-inference", "action":"status",
            "entityId":worker, "revision":revision, "payload":status,
        }));
    }
}
