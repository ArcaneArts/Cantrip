use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
// Buffer.from(text,"base64") accepts URL-safe characters, padding omissions
// and nonalphabet separators, terminating at the first padding character.
fn decode(value: &Value) -> Option<Vec<u8>> {
    let value = value.as_js_string()?;
    if value.len() > 16 * 1024 * 1024 {
        return None;
    }
    let mut output = Vec::new();
    let mut bits = 0_u32;
    let mut count = 0;
    for unit in value.units() {
        let n = match *unit {
            65..=90 => unit - 65,
            97..=122 => unit - 97 + 26,
            48..=57 => unit - 48 + 52,
            43 | 45 => 62,
            47 | 95 => 63,
            61 => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(n);
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
        }
    }
    Some(output)
}
impl CoordinatedBridge {
    pub fn send_worker_link_frame(
        self: &Arc<Self>,
        worker: &str,
        frame: crate::worker_links::frame::Frame,
    ) -> bool {
        if self.state.lock().unwrap().connections.contains_key(worker) {
            return self.local.send_worker_link_frame(worker, frame);
        }
        self.send_frame(
            "worker-link",
            worker,
            frame.header().clone(),
            frame.payload(),
        )
    }
    pub fn send_tunnel_frame(
        self: &Arc<Self>,
        worker: &str,
        header: Value,
        payload: &[u8],
    ) -> bool {
        self.send_frame("tunnel", worker, header, payload)
    }
    pub fn send_surface_frame(
        self: &Arc<Self>,
        worker: &str,
        header: Value,
        payload: &[u8],
    ) -> bool {
        self.send_frame("surface", worker, header, payload)
    }
    fn send_frame(
        self: &Arc<Self>,
        transport: &str,
        worker: &str,
        header: Value,
        payload: &[u8],
    ) -> bool {
        if self.state.lock().unwrap().connections.contains_key(worker) {
            return self.send_local(transport, worker, header, payload);
        }
        let Some(p) = self.coordinator.cached_worker(&worker.into()) else {
            return false;
        };
        if let Some(id) = text(&p["connectionId"]) {
            self.state.lock().unwrap().known.insert(worker.into(), id);
        }
        let Some(owner) = p["ownerId"].as_str() else {
            return false;
        };
        self.publish_frame(
            "to-worker",
            transport,
            FrameRoute { owner, worker },
            header,
            payload,
            Some(&p["instanceId"]),
        )
    }
    fn send_local(&self, transport: &str, worker: &str, header: Value, payload: &[u8]) -> bool {
        match transport {
            "surface" => self.local.send_surface_frame(worker, header, payload),
            "tunnel" => self.local.send_tunnel_frame(worker, header, payload),
            "worker-link" => crate::worker_links::frame::create(header, payload)
                .ok()
                .is_some_and(|f| self.local.send_worker_link_frame(worker, f)),
            _ => false,
        }
    }
    pub(super) fn publish_frame(
        self: &Arc<Self>,
        direction: &str,
        transport: &str,
        route: FrameRoute<'_>,
        header: Value,
        payload: &[u8],
        target: Option<&Value>,
    ) -> bool {
        let mut value = json!({"kind":"worker-frame","direction":direction,"transport":transport,"ownerId":route.owner,"workerId":route.worker,"header":header,"payloadBase64":STANDARD.encode(payload)});
        if direction == "to-worker"
            && let Some(target) = target
        {
            value["targetInstanceId"] = target.clone();
        }
        self.publish_bounded(value)
    }
    pub(super) fn dispatch_frame(
        &self,
        transport: &str,
        worker: &str,
        header: Value,
        payload: &[u8],
    ) -> Result<()> {
        let schema = match transport {
            "surface" => "remoteSurfaceFrameHeaderSchema",
            "tunnel" => "tunnelDataPlaneFrameHeaderSchema",
            _ => "workerLinkFrameHeaderSchema",
        };
        let Ok(header) = wire::parse(schema, Some(&header)) else {
            return Ok(());
        };
        match transport {
            "surface" => self.surface.deliver(
                worker,
                crate::remote_surfaces::frame::create(header, payload)?,
            ),
            "tunnel" => self
                .tunnel
                .deliver(worker, crate::tunnels::frame::create(header, payload)?),
            _ => self.link.deliver(
                worker,
                crate::worker_links::frame::create(header, payload).map_err(anyhow::Error::from)?,
            ),
        }
    }
    pub(super) async fn receive_frame(&self, message: Value) -> Result<()> {
        let Some(worker) = message["workerId"].as_str() else {
            return Ok(());
        };
        let Some(p) = self.coordinator.cached_worker(&worker.into()) else {
            return Ok(());
        };
        if p["ownerId"] != message["ownerId"] {
            return Ok(());
        }
        let Some(payload) = decode(&message["payloadBase64"]) else {
            return Ok(());
        };
        let Some(transport) = message["transport"].as_str() else {
            return Ok(());
        };
        if message["direction"] == "from-worker" {
            return self.dispatch_frame(transport, worker, message["header"].clone(), &payload);
        }
        if self
            .state
            .lock()
            .unwrap()
            .connections
            .get(worker)
            .is_none_or(|c| message["ownerId"] != c.owner.as_str())
        {
            return Ok(());
        }
        let schema = match transport {
            "surface" => "remoteSurfaceFrameHeaderSchema",
            "tunnel" => "tunnelDataPlaneFrameHeaderSchema",
            "worker-link" => "workerLinkFrameHeaderSchema",
            _ => return Ok(()),
        };
        if let Ok(header) = wire::parse(schema, Some(&message["header"])) {
            self.send_local(transport, worker, header, &payload);
        }
        Ok(())
    }
    pub(super) fn dispatch_notification(&self, worker: &str, owner: &str, value: Value) {
        if let Some(group) = self.notifications.group(worker) {
            Notifications::deliver(group, owner, value);
        }
    }
}
