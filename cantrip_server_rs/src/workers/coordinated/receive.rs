use super::*;
impl CoordinatedBridge {
    pub(super) async fn receive(self: &Arc<Self>, message: Value) -> Result<()> {
        match message["kind"].as_str() {
            Some("worker-command-request") => self.receive_command(message).await,
            Some("worker-command-event") => {
                self.receive_event(&message);
                Ok(())
            }
            Some("worker-command-response") => {
                self.receive_response(message);
                Ok(())
            }
            Some("worker-disconnect") => {
                if let Some(w) = message["workerId"].as_str()
                    && self.connection_id(w).as_deref() == message["connectionId"].as_str()
                {
                    self.local.disconnect(
                        w,
                        message["reason"]
                            .as_str()
                            .unwrap_or("Worker credential was revoked"),
                        message["code"].as_u64().unwrap_or(1008) as u16,
                    );
                }
                Ok(())
            }
            Some("worker-frame") => self.receive_frame(message).await,
            Some("worker-notification") => {
                let Ok(notification) =
                    wire::parse("workerNotificationSchema", message.get("notification"))
                else {
                    return Ok(());
                };
                let Some(w) = message["workerId"].as_str() else {
                    return Ok(());
                };
                let p = if notification["type"] == "inference.status" {
                    self.coordinator.find_worker(&w.into()).await?
                } else {
                    self.coordinator.cached_worker(&w.into())
                };
                let Some(p) = p else {
                    return Ok(());
                };
                if p["ownerId"] != message["ownerId"]
                    || message
                        .get("connectionId")
                        .is_some_and(|c| *c != p["connectionId"])
                    || (notification["type"] == "inference.status"
                        && !wire::coercion::truthy(message.get("connectionId")))
                {
                    return Ok(());
                }
                self.dispatch_notification(w, p["ownerId"].as_str().unwrap_or(""), notification);
                Ok(())
            }
            Some("worker-presence") => self.receive_presence(&message).await,
            _ => Ok(()),
        }
    }
    async fn receive_presence(&self, message: &Value) -> Result<()> {
        let Some(w) = message["presence"]["workerId"].as_str() else {
            return Ok(());
        };
        if self.state.lock().unwrap().connections.contains_key(w) {
            return Ok(());
        }
        if message["action"] == "online" {
            let (known, pending) = {
                let s = self.state.lock().unwrap();
                (
                    s.known.get(w).cloned(),
                    s.pending.values().any(|p| p.worker == w),
                )
            };
            let presence = if pending {
                // A restarted Redis owner can reclaim this worker on the same
                // instance. Confirm the claim independently of the notification.
                match self.coordinator.lookup_worker_claim(&w.into()).await {
                    Ok(Some(p)) => p,
                    _ => return Ok(()),
                }
            } else {
                message["presence"].clone()
            };
            {
                let s = self.state.lock().unwrap();
                if s.connections.contains_key(w) || s.known.get(w) != known.as_ref() {
                    return Ok(());
                }
            }
            self.reject_remote(w, presence["connectionId"].as_str());
            if let Some(id) = text(&presence["connectionId"]) {
                self.state.lock().unwrap().known.insert(w.into(), id);
            }
        } else {
            let previous = message["presence"]["connectionId"].as_str();
            if self.state.lock().unwrap().known.get(w).map(String::as_str) != previous
                || self.coordinator.cached_worker(&w.into()).is_some()
            {
                return Ok(());
            }
            let Ok(current) = self.coordinator.find_worker(&w.into()).await else {
                return Ok(());
            };
            {
                let s = self.state.lock().unwrap();
                if s.connections.contains_key(w) || s.known.get(w).map(String::as_str) != previous {
                    return Ok(());
                }
            }
            if let Some(current) = current {
                self.reject_remote(w, current["connectionId"].as_str());
                if let Some(id) = text(&current["connectionId"]) {
                    self.state.lock().unwrap().known.insert(w.into(), id);
                }
                return Ok(());
            }
            self.state.lock().unwrap().known.shift_remove(w);
            self.disconnected.deliver(w);
            self.dispatch_offline(w);
        }
        Ok(())
    }
}
