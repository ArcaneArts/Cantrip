use super::*;
use crate::codex::revocation::{Resource, Target};

impl Router {
    pub(in crate::codex) fn bind_resource(&self, thread: &JsString, resource: &Arc<Resource>) {
        self.0
            .resources
            .lock()
            .unwrap()
            .insert(thread.clone(), resource.clone());
    }

    pub(super) fn resource(&self, thread: &JsString) -> Option<Arc<Resource>> {
        self.0.resources.lock().unwrap().get(thread).cloned()
    }

    pub(in crate::codex) fn revoke_resources(&self, target: &Target) -> Result<()> {
        let threads = {
            let resources = self.0.resources.lock().unwrap();
            resources
                .iter()
                .filter(|(_, resource)| resource.matches(target))
                .map(|(thread, resource)| {
                    resource.revoke();
                    thread.clone()
                })
                .collect::<Vec<_>>()
        };
        for thread in threads {
            // Retain the revoked signal for this native thread. An old runner
            // cannot regain authority by issuing a late or delegated request.
            self.remove_goal_producer(&thread);
            self.0.task_goals.lock().unwrap().remove(&thread);
            self.set_task_root(&thread, None);
        }
        self.0.adapter.revoke(target)
    }
}
