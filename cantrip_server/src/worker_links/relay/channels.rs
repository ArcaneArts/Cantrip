use super::*;
impl Relay {
    pub fn receive_client(self: &Arc<Self>, c: &Arc<Connection>, bytes: Arc<[u8]>, binary: bool) {
        if !binary {
            c.socket
                .close(1003, "WorkerLink relay requires binary frames");
            return;
        }
        let _operation = c.operation.lock().unwrap();
        if c.state.lock().unwrap().closed || !self.current(c) {
            return;
        }
        let Ok(frame) = frame::decode(bytes) else {
            c.socket.close(1003, "WorkerLink frame is invalid");
            return;
        };
        let h = frame.header();
        if h["sessionId"] != c.session["sessionId"]
            || h["routeGeneration"] != c.session["routeGeneration"]
            || h["effectiveRoute"] != "relay"
        {
            c.socket.close(1008, "WorkerLink frame identity is stale");
            return;
        }
        let channel_id = id(&h["channel"], "channelId");
        let channel = if h["kind"] == "open" {
            let mut state = c.state.lock().unwrap();
            if state.channels.contains_key(&channel_id) || state.closing.contains_key(&channel_id) {
                drop(state);
                c.socket.close(1008, "WorkerLink channel was replayed");
                return;
            }
            if self.retain_surface(c, &mut state, h).is_err() {
                drop(state);
                c.socket
                    .close(1013, "WorkerLink Remote Surface relay quota reached");
                return;
            }
            let channel = Arc::new(Mutex::new(Channel {
                bandwidth: bandwidth(h),
                delivered: -1.0,
                client_sequence: h["sequence"].as_f64().unwrap(),
                worker_sequence: -1.0,
                grant: id(&h["grant"]["binding"], "grantId"),
                header: h.clone(),
            }));
            state.channels.insert(channel_id.clone(), channel.clone());
            channel
        } else {
            let channel = c.state.lock().unwrap().channels.get(&channel_id).cloned();
            let Some(channel) = channel else {
                c.socket
                    .close(1008, "WorkerLink channel sequence is invalid");
                return;
            };
            {
                let mut current = channel.lock().unwrap();
                if h["sequence"].as_f64() != Some(current.client_sequence + 1.0) {
                    drop(current);
                    c.socket
                        .close(1008, "WorkerLink channel sequence is invalid");
                    return;
                }
                current.client_sequence = h["sequence"].as_f64().unwrap();
            }
            channel
        };
        let bandwidth = channel.lock().unwrap().bandwidth;
        self.record(c, bandwidth, true, frame.bytes().len());
        if !self.consume(c, frame.payload().len()) {
            return;
        }
        let sequence = h["sequence"].as_f64().unwrap();
        let closing = h["kind"] == "close";
        let bytes = frame.bytes().len();
        if !self
            .bridge
            .send_worker_link_frame(c.session["identity"]["workerId"].as_str().unwrap(), frame)
        {
            c.socket
                .close(1013, "WorkerLink worker route is unavailable");
            return;
        }
        channel.lock().unwrap().delivered = sequence;
        self.record(c, bandwidth, false, bytes);
        if closing {
            self.release(c, &channel_id, true);
        }
    }
    pub(super) fn receive_worker(self: &Arc<Self>, c: &Arc<Connection>, frame: Arc<Frame>) {
        let _operation = c.operation.lock().unwrap();
        let h = frame.header();
        if !self.current(c)
            || h["sessionId"] != c.session["sessionId"]
            || h["routeGeneration"] != c.session["routeGeneration"]
            || h["effectiveRoute"] != "relay"
        {
            return;
        }
        let channel_id = id(&h["channel"], "channelId");
        let (channel, closing) = {
            let state = c.state.lock().unwrap();
            (
                state
                    .channels
                    .get(&channel_id)
                    .or_else(|| state.closing.get(&channel_id))
                    .cloned(),
                state.closing.contains_key(&channel_id),
            )
        };
        let Some(channel) = channel else {
            c.socket
                .close(1008, "WorkerLink worker frame is out of sequence");
            return;
        };
        let bandwidth = {
            let mut channel = channel.lock().unwrap();
            if canonical(&channel.header) != canonical(h)
                || h["sequence"].as_f64() != Some(channel.worker_sequence + 1.0)
                || if channel.worker_sequence < 0.0 {
                    h["kind"] != "accept" && h["kind"] != "reject"
                } else {
                    h["kind"] == "accept" || h["kind"] == "reject"
                }
            {
                drop(channel);
                c.socket
                    .close(1008, "WorkerLink worker frame is out of sequence");
                return;
            }
            channel.worker_sequence = h["sequence"].as_f64().unwrap();
            channel.bandwidth
        };
        if closing {
            if h["kind"] == "close" || h["kind"] == "reject" {
                c.state.lock().unwrap().closing.shift_remove(&channel_id);
            }
            return;
        }
        self.record(c, bandwidth, true, frame.bytes().len());
        if !self.consume(c, frame.payload().len()) {
            return;
        }
        if self.send_or_queue(c, h["lane"].as_str().unwrap(), bandwidth, (*frame).clone())
            && (h["kind"] == "close" || h["kind"] == "reject")
        {
            self.release(c, &channel_id, false);
        }
    }
    fn retain_surface(
        &self,
        c: &Connection,
        state: &mut ConnectionState,
        h: &Value,
    ) -> anyhow::Result<()> {
        let kind = &h["grant"]["binding"]["resource"]["kind"];
        if *kind != "browser" && *kind != "remote-desktop" {
            return Ok(());
        }
        let grant = id(&h["grant"]["binding"], "grantId");
        let channel = id(&h["channel"], "channelId");
        if let Some(surface) = state.surfaces.get_mut(&grant) {
            surface.channels.insert(channel);
            return Ok(());
        }
        let permit = self
            .options
            .acquire_remote_surface
            .as_ref()
            .map(|acquire| {
                acquire(
                    &c.session["identity"]["ownerId"],
                    &c.session["identity"]["workerId"],
                )
            })
            .transpose()?;
        state.surfaces.insert(
            grant,
            Surface {
                channels: HashSet::from([channel]),
                _permit: permit,
            },
        );
        Ok(())
    }
}
