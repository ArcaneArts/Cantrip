use super::*;
use crate::tunnels::frame::{
    AUTH_TAG_BYTES, MAX_CREDIT_BYTES, MAX_PAYLOAD_BYTES, MAX_PLAINTEXT_BYTES,
};
impl Broker {
    fn reject(&self, route: &Arc<Route>, header: &Value, code: &str) {
        self.state.lock().unwrap().rejected += 1.0;
        let mut rejected = Self::identities(route, &header["connectionId"], 0.0);
        rejected["kind"] = json!("rejected");
        rejected["code"] = json!(code);
        Self::send(route, Side::Source, &rejected, &[]);
    }
    pub(super) fn receive(&self, route: &Arc<Route>, sender: Side, header: &Value, payload: &[u8]) {
        let protected = coercion::truthy(header.get("protection"));
        let payload_valid = if header["kind"] == "data" {
            !payload.is_empty()
                && payload.len() <= MAX_PAYLOAD_BYTES
                && if protected {
                    payload.len() > AUTH_TAG_BYTES
                } else {
                    payload.len() <= MAX_PLAINTEXT_BYTES
                }
        } else {
            payload.is_empty()
        };
        let r = &route.registration;
        if header["tunnelId"] != r.tunnel
            || header["attachmentId"] != r.attachment
            || header["sourceEndpointId"] != r.source
            || header["destinationEndpointId"] != r.destination
        {
            return;
        }
        let key = connection_key(route, &header["connectionId"]);
        let connection = self.state.lock().unwrap().connections.get(&key).cloned();
        let Some(connection) = connection else {
            if sender != Side::Source || header["kind"] != "open" {
                return;
            }
            if header["sequence"] != 0 || !payload_valid {
                self.reject(route, header, "protocol-error");
                return;
            }
            let limit = {
                let s = self.state.lock().unwrap();
                s.connections.len() as f64 >= self.options.max_connections
                    || s.connections
                        .values()
                        .filter(|c| c.lock().unwrap().route.registration.tunnel == r.tunnel)
                        .count() as f64
                        >= self.options.max_connections_per_tunnel
            };
            if limit {
                self.reject(route, header, "limit-exceeded");
                return;
            }
            if !self.activity(route) {
                if self.current_route(route) {
                    self.reject(route, header, "unauthorized");
                }
                return;
            }
            if !self.current_route(route) {
                return;
            }
            let now = (self.options.clock)();
            let connection = Arc::new(Mutex::new(Connection {
                route: route.clone(),
                id: header["connectionId"].clone(),
                created: now,
                last: now,
                window: now,
                bandwidth: 0.0,
                source_sequence: 1.0,
                destination_sequence: 0.0,
                source_credit: 0.0,
                destination_credit: header["initialCreditBytes"].as_f64().unwrap_or(f64::NAN),
                source_half: false,
                destination_half: false,
                open: false,
            }));
            {
                let mut s = self.state.lock().unwrap();
                s.connections.insert(key, connection.clone());
                s.opened += 1.0;
            }
            let mut connect = Self::identities(route, &header["connectionId"], 0.0);
            connect["kind"] = json!("connect");
            connect["target"] = r.target.clone();
            connect["initialCreditBytes"] = header["initialCreditBytes"].clone();
            if let Some(diagnostic) = r.diagnostic.as_ref().filter(|v| coercion::truthy(Some(v))) {
                connect["diagnosticTraceId"] = diagnostic.clone();
            }
            if !Self::send(route, Side::Destination, &connect, &[]) {
                self.terminate(&connection, "congested");
            }
            return;
        };
        if !payload_valid {
            self.terminate(&connection, "protocol-error");
            return;
        }
        let sequence = header["sequence"].as_f64().unwrap_or(f64::NAN);
        {
            let mut c = connection.lock().unwrap();
            let expected = if sender == Side::Source {
                &mut c.source_sequence
            } else {
                &mut c.destination_sequence
            };
            if sequence != *expected {
                drop(c);
                self.terminate(&connection, "protocol-error");
                return;
            }
            *expected += 1.0;
        }
        let now = (self.options.clock)();
        let allowed = {
            let mut c = connection.lock().unwrap();
            c.last = now;
            Self::allowed(sender, &c, header)
        };
        if !allowed {
            self.terminate(&connection, "protocol-error");
            return;
        }
        if !self.activity(route) {
            self.terminate(&connection, "endpoint-disconnected");
            return;
        }
        if !self.current_route(route)
            || !self
                .state
                .lock()
                .unwrap()
                .connections
                .get(&key)
                .is_some_and(|c| Arc::ptr_eq(c, &connection))
        {
            return;
        }
        if header["kind"] == "accepted" {
            {
                let mut c = connection.lock().unwrap();
                c.open = true;
                c.source_credit = header["initialCreditBytes"].as_f64().unwrap_or(f64::NAN);
            }
            self.forward(&connection, Side::Source, header, payload);
            return;
        }
        if header["kind"] == "rejected" {
            self.state.lock().unwrap().rejected += 1.0;
            self.forward(&connection, Side::Source, header, payload);
            self.finish(&connection);
            return;
        }
        if header["kind"] == "data" {
            let flow = payload.len() - if protected { AUTH_TAG_BYTES } else { 0 };
            let now = (self.options.clock)();
            let bandwidth = {
                let mut c = connection.lock().unwrap();
                if now - c.window >= 1000.0 {
                    c.window = now;
                    c.bandwidth = 0.0;
                }
                c.bandwidth += payload.len() as f64;
                c.bandwidth <= self.options.bytes_per_second
            };
            if !bandwidth {
                self.terminate(&connection, "bandwidth-limit");
                return;
            }
            if coercion::truthy(r.owner.as_ref())
                && coercion::truthy(r.worker.as_ref())
                && !(self.options.consume)(
                    r.owner.as_ref().unwrap(),
                    r.worker.as_ref().unwrap(),
                    payload.len(),
                )
            {
                self.terminate(&connection, "bandwidth-limit");
                return;
            }
            {
                let mut c = connection.lock().unwrap();
                let credit = if sender == Side::Source {
                    &mut c.source_credit
                } else {
                    &mut c.destination_credit
                };
                if flow as f64 > *credit {
                    drop(c);
                    self.terminate(&connection, "protocol-error");
                    return;
                }
                *credit -= flow as f64;
            }
            {
                let mut s = self.state.lock().unwrap();
                if sender == Side::Source {
                    s.bytes_from += payload.len() as f64;
                } else {
                    s.bytes_to += payload.len() as f64;
                }
            }
            self.forward(
                &connection,
                if sender == Side::Source {
                    Side::Destination
                } else {
                    Side::Source
                },
                header,
                payload,
            );
            return;
        }
        if header["kind"] == "credit" {
            let bytes = header["bytes"].as_f64().unwrap_or(f64::NAN);
            {
                let mut c = connection.lock().unwrap();
                let credit = if sender == Side::Source {
                    &mut c.destination_credit
                } else {
                    &mut c.source_credit
                };
                if *credit + bytes > MAX_CREDIT_BYTES as f64 {
                    drop(c);
                    self.terminate(&connection, "protocol-error");
                    return;
                }
                *credit += bytes;
            }
            self.forward(
                &connection,
                if sender == Side::Source {
                    Side::Destination
                } else {
                    Side::Source
                },
                header,
                payload,
            );
            return;
        }
        if header["kind"] == "half-close" {
            {
                let mut c = connection.lock().unwrap();
                if sender == Side::Source {
                    c.source_half = true;
                } else {
                    c.destination_half = true;
                }
            }
            self.forward(
                &connection,
                if sender == Side::Source {
                    Side::Destination
                } else {
                    Side::Source
                },
                header,
                payload,
            );
            return;
        }
        if header["kind"] == "close" || header["kind"] == "error" {
            self.forward(
                &connection,
                if sender == Side::Source {
                    Side::Destination
                } else {
                    Side::Source
                },
                header,
                payload,
            );
            self.finish(&connection);
        }
    }
    fn allowed(sender: Side, c: &Connection, h: &Value) -> bool {
        if h["kind"] == "connect" || h["kind"] == "open" {
            return false;
        }
        if sender == Side::Source {
            if h["kind"] == "accepted" || h["kind"] == "rejected" {
                return false;
            }
            if h["kind"] == "data" {
                return c.open && !c.source_half && h["direction"] == "source-to-destination";
            }
            if h["kind"] == "credit" {
                return h["direction"] == "destination-to-source";
            }
            if h["kind"] == "half-close" {
                return !c.source_half && h["direction"] == "source-to-destination";
            }
        } else {
            if h["kind"] == "accepted" || h["kind"] == "rejected" {
                return !c.open;
            }
            if h["kind"] == "data" {
                return c.open && !c.destination_half && h["direction"] == "destination-to-source";
            }
            if h["kind"] == "credit" {
                return h["direction"] == "source-to-destination";
            }
            if h["kind"] == "half-close" {
                return !c.destination_half && h["direction"] == "destination-to-source";
            }
        }
        true
    }
}
