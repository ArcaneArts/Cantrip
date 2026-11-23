use super::*;
impl Relay {
    pub(super) fn send_or_queue(
        self: &Arc<Self>,
        c: &Arc<Connection>,
        lane: &str,
        bandwidth: &'static str,
        frame: Frame,
    ) -> bool {
        if !c.socket.is_open() {
            return false;
        }
        let queued = {
            let mut state = c.state.lock().unwrap();
            let queue = state.lanes.get_mut(lane).unwrap();
            if !queue.frames.is_empty() || c.socket.buffered_amount() > MAX_BUFFERED {
                let limit = &self.options.lane_limits[lane];
                let bytes = frame.bytes().len();
                if queue.frames.len() as f64 >= limit["maxQueuedFrames"].as_f64().unwrap()
                    || (queue.bytes + bytes) as f64 > limit["maxQueuedBytes"].as_f64().unwrap()
                {
                    None
                } else {
                    queue.frames.push_back(Queued {
                        bandwidth,
                        frame: frame.clone(),
                    });
                    queue.bytes += bytes;
                    state.bytes += bytes;
                    state.frames += 1;
                    state.stalled_at.get_or_insert_with(|| (self.options.now)());
                    self.schedule(c, &mut state);
                    Some(true)
                }
            } else {
                Some(false)
            }
        };
        match queued {
            None => {
                c.socket.close(1013, "WorkerLink relay lane is congested");
                false
            }
            Some(true) => true,
            Some(false) => self.send_now(c, bandwidth, frame),
        }
    }
    fn send_now(&self, c: &Connection, bandwidth: &'static str, frame: Frame) -> bool {
        let bytes = frame.bytes().len();
        if c.socket.send(frame).is_ok() {
            self.record(c, bandwidth, false, bytes);
            true
        } else {
            c.socket.close(1011, "WorkerLink relay send failed");
            false
        }
    }
    fn schedule(self: &Arc<Self>, c: &Arc<Connection>, state: &mut ConnectionState) {
        if state.closed || state.drain_scheduled {
            return;
        }
        state.drain_scheduled = true;
        if !self.options.auto_drain {
            return;
        }
        let (weak, current) = (Arc::downgrade(self), Arc::downgrade(c));
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(5);
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let (Some(relay), Some(connection)) = (weak.upgrade(), current.upgrade()) {
                relay.drain(&connection);
            }
        });
        state.timer = Some(task.abort_handle());
    }
    pub fn drain(self: &Arc<Self>, c: &Arc<Connection>) {
        let _operation = c.operation.lock().unwrap();
        if !self.current(c) || c.state.lock().unwrap().closed {
            return;
        }
        {
            let mut state = c.state.lock().unwrap();
            state.drain_scheduled = false;
            state.timer.take();
        }
        if !c.socket.is_open() {
            self.retire(c);
            return;
        }
        if c.socket.buffered_amount() > MAX_BUFFERED {
            let stalled = c
                .state
                .lock()
                .unwrap()
                .stalled_at
                .is_some_and(|at| (self.options.now)() - at >= 5000);
            if stalled {
                c.socket.close(1013, "WorkerLink relay client is too slow");
            } else {
                self.schedule(c, &mut c.state.lock().unwrap());
            }
            return;
        }
        while c.socket.buffered_amount() <= MAX_BUFFERED {
            let mut sent = false;
            for lane in LANES {
                let next = {
                    let mut state = c.state.lock().unwrap();
                    let queue = state.lanes.get_mut(lane).unwrap();
                    let next = queue.frames.pop_front();
                    if let Some(next) = &next {
                        let bytes = next.frame.bytes().len();
                        queue.bytes -= bytes;
                        state.bytes -= bytes;
                        state.frames -= 1;
                    }
                    next
                };
                let Some(next) = next else { continue };
                if !self.send_now(c, next.bandwidth, next.frame) {
                    return;
                }
                c.state.lock().unwrap().stalled_at = Some((self.options.now)());
                sent = true;
                if c.socket.buffered_amount() > MAX_BUFFERED {
                    break;
                }
            }
            if !sent {
                break;
            }
        }
        let mut state = c.state.lock().unwrap();
        if state.frames == 0 {
            state.stalled_at = None;
        } else {
            self.schedule(c, &mut state);
        }
    }
}
