use super::*;
impl Runtime {
    pub(super) fn current(&self, active: &Arc<Active>) -> bool {
        active.authorization["attachmentId"]
            .as_str()
            .is_some_and(|id| {
                self.state
                    .lock()
                    .unwrap()
                    .active
                    .get(id)
                    .is_some_and(|v| Arc::ptr_eq(v, active))
            })
    }
    pub(super) fn close_exact(&self, active: &Arc<Active>, reason: &str, code: u16) -> bool {
        let _serial = self.serial.lock();
        let id = active.authorization["attachmentId"]
            .as_str()
            .expect("attachment id");
        {
            let mut s = self.state.lock().unwrap();
            if !s.active.get(id).is_some_and(|v| Arc::ptr_eq(v, active)) {
                return false;
            }
            s.active.shift_remove(id);
        }
        {
            let mut s = active.state.lock().unwrap();
            if let Some(timer) = s.expiry.take() {
                timer.abort();
            }
            if let Some(timer) = s.heartbeat.take() {
                timer.abort();
            }
            s.token = None;
            s.worker.take();
        }
        active.route.close();
        active.endpoint.close(code, reason);
        self.log(
            Event::Closed(reason),
            &active.authorization,
            active.diagnostic.as_ref(),
        );
        true
    }
    pub fn close_active(&self, id: &str, reason: &str, code: u16) {
        let _serial = self.serial.lock();
        let active = self.state.lock().unwrap().active.get(id).cloned();
        if let Some(active) = active {
            self.close_exact(&active, reason, code);
        }
    }
    pub fn close_tunnel(&self, tunnel: &str, reason: &str, code: u16) -> usize {
        let _serial = self.serial.lock();
        let active = self
            .state
            .lock()
            .unwrap()
            .active
            .values()
            .filter(|v| v.authorization["tunnelId"] == tunnel)
            .cloned()
            .collect::<Vec<_>>();
        for active in &active {
            self.close_exact(active, reason, code);
        }
        active.len()
    }
    pub async fn revoke(
        &self,
        owner: &str,
        id: &str,
        preserve: bool,
        expected: Option<StopFence>,
    ) -> Result<bool> {
        let stopped = self
            .repository
            .stop_attachment(owner, id, None, preserve, expected)
            .await?;
        let Some(stopped) = stopped else {
            return Ok(false);
        };
        self.close_active(id, "Attachment revoked", 1008);
        self.broker.revoke_attachment(&json!(id));
        (self.changed)(
            json!({"attachmentId":id,"ownerId":owner,"projectId":stopped["projectId"],"tunnelId":stopped["tunnelId"]}),
        );
        Ok(true)
    }
    pub(super) fn retire(self: &Arc<Self>, active: &Arc<Active>, reason: &str, code: u16) {
        let _serial = self.serial.lock();
        if self.close_exact(active, reason, code) {
            let (runtime, active) = (self.clone(), active.clone());
            self.spawn(async move {
                let _ = runtime.offline(&active).await;
            });
        }
    }
    pub fn stats(&self) -> Value {
        self.broker.stats()
    }
    pub fn close(&self) {
        let _serial = self.serial.lock();
        let active = {
            let mut s = self.state.lock().unwrap();
            if s.closed {
                return;
            }
            s.closed = true;
            if let Some(t) = s.heartbeat.take() {
                t.abort();
            }
            if let Some(t) = s.sweep.take() {
                t.abort();
            }
            s.active.values().cloned().collect::<Vec<_>>()
        };
        let aggregate = self.broker.stats();
        for a in &active {
            self.close_exact(a, "Server is shutting down", 1012);
        }
        self.broker.close();
        (self.options.logger)(LogCall::event(
            "info",
            "Tunnel runtime stopped",
            json!({"event":"tunnel.runtime.stopped","subsystem":"tunnel","operation":"shutdown","status":"completed","counts":json!({"activeAttachments":active.len(),"openedConnections":aggregate["openedConnections"],"closedConnections":aggregate["closedConnections"],"rejectedConnections":aggregate["rejectedConnections"]}),"bytesFromSource":aggregate["bytesFromSource"],"bytesToSource":aggregate["bytesToSource"]}),
        ));
    }
}
