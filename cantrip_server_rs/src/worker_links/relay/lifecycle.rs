use super::*;
impl Relay {
    pub fn attach(
        self: &Arc<Self>,
        session: Value,
        socket: Arc<dyn Socket>,
    ) -> Option<Arc<Connection>> {
        let _attachment = self.attachment.lock().unwrap();
        if self.state.lock().unwrap().closed
            || !socket.is_open()
            || !session["routePolicy"]["enabled"]
                .as_array()
                .unwrap()
                .contains(&json!("relay"))
        {
            socket.close(1013, "WorkerLink relay is unavailable");
            return None;
        }
        let session_id = id(&session, "sessionId");
        let previous = self
            .state
            .lock()
            .unwrap()
            .connections
            .get(&session_id)
            .cloned();
        if let Some(previous) = previous {
            previous.socket.close(1012, "WorkerLink relay was replaced");
        }
        let connection = Arc::new(Connection {
            session,
            socket,
            operation: Mutex::new(()),
            state: Mutex::new(ConnectionState {
                closed: false,
                channels: IndexMap::new(),
                closing: IndexMap::new(),
                lanes: LANES
                    .into_iter()
                    .map(|lane| (lane, Lane::default()))
                    .collect(),
                surfaces: IndexMap::new(),
                bytes: 0,
                frames: 0,
                stalled_at: None,
                drain_scheduled: false,
                timer: None,
                bindings: None,
            }),
        });
        self.state
            .lock()
            .unwrap()
            .connections
            .insert(session_id, connection.clone());
        let worker = id(&connection.session["identity"], "workerId");
        let (weak, current) = (Arc::downgrade(self), Arc::downgrade(&connection));
        let frames = self.bridge.subscribe_worker_link_frames(
            &worker,
            Arc::new(move |frame| {
                if let (Some(relay), Some(connection)) = (weak.upgrade(), current.upgrade()) {
                    relay.receive_worker(&connection, frame);
                }
                Ok(())
            }),
        );
        let current = Arc::downgrade(&connection);
        let offline = self.bridge.subscribe_worker_offline(
            &worker,
            Arc::new(move || {
                if let Some(c) = current.upgrade() {
                    c.socket.close(1013, "Worker is offline");
                }
            }),
        );
        connection.state.lock().unwrap().bindings = Some(Bindings {
            _frames: frames,
            _offline: offline,
        });
        Some(connection)
    }
    pub fn revoke_session(&self, id: &str, reason: &str) {
        let c = self.state.lock().unwrap().connections.get(id).cloned();
        if let Some(c) = c {
            c.socket.close(1008, reason);
        }
    }
    pub fn revoke_account(&self, account: &Value) {
        let connections = self
            .state
            .lock()
            .unwrap()
            .connections
            .values()
            .filter(|c| c.session["identity"]["accountSessionId"] == *account)
            .cloned()
            .collect::<Vec<_>>();
        for c in connections {
            c.socket.close(1008, "Account session ended");
        }
    }
    pub fn revoke_owner(&self, owner: &Value) {
        let connections = self
            .state
            .lock()
            .unwrap()
            .connections
            .values()
            .filter(|c| c.session["identity"]["ownerId"] == *owner)
            .cloned()
            .collect::<Vec<_>>();
        for c in connections {
            c.socket.close(1008, "Account sessions ended");
        }
    }
    pub fn close(self: &Arc<Self>) {
        let _attachment = self.attachment.lock().unwrap();
        let connections = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            state.connections.values().cloned().collect::<Vec<_>>()
        };
        for c in connections {
            c.socket.close(1001, "Server is shutting down");
            self.retire(&c);
        }
    }
    pub fn retire(&self, c: &Arc<Connection>) {
        let (channels, bindings, timer, surfaces) = {
            let mut state = c.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            state.closing.clear();
            for lane in state.lanes.values_mut() {
                lane.frames.clear();
                lane.bytes = 0;
            }
            state.bytes = 0;
            state.frames = 0;
            state.drain_scheduled = false;
            (
                std::mem::take(&mut state.channels),
                state.bindings.take(),
                state.timer.take(),
                std::mem::take(&mut state.surfaces),
            )
        };
        {
            let mut state = self.state.lock().unwrap();
            let id = c.session["sessionId"].as_str().unwrap();
            if state
                .connections
                .get(id)
                .is_some_and(|current| Arc::ptr_eq(current, c))
            {
                state.connections.shift_remove(id);
            }
        }
        drop(bindings);
        if let Some(timer) = timer {
            timer.abort();
        }
        drop(surfaces);
        for channel in channels.values() {
            let channel = channel.lock().unwrap();
            if channel.delivered < 0.0 {
                continue;
            }
            let h = &channel.header;
            let header = json!({"protocolVersion":h["protocolVersion"],"sessionId":h["sessionId"],"routeGeneration":h["routeGeneration"],"effectiveRoute":h["effectiveRoute"],"channel":h["channel"],"lane":h["lane"],"sequence":channel.delivered+1.0,"kind":"close","code":"endpoint-disconnected"});
            match frame::create(header,&[]){Ok(frame)=>{self.bridge.send_worker_link_frame(c.session["identity"]["workerId"].as_str().unwrap(),frame);},Err(_)=>eprintln!("{}",json!({"event":"worker-link.relay.retirement-failed","subsystem":"worker-link","reasonCode":"invalid-close-sequence"}).stringify())}
        }
    }
    pub(super) fn release(&self, c: &Connection, id: &str, await_close: bool) {
        let mut state = c.state.lock().unwrap();
        let Some(channel) = state.channels.shift_remove(id) else {
            return;
        };
        if await_close {
            state.closing.insert(id.into(), channel.clone());
            if state.closing.len() > 1024 {
                state.closing.shift_remove_index(0);
            }
        }
        let grant = channel.lock().unwrap().grant.clone();
        let Some(surface) = state.surfaces.get_mut(&grant) else {
            return;
        };
        surface.channels.remove(id);
        if surface.channels.is_empty() {
            state.surfaces.shift_remove(&grant);
        }
    }
}
