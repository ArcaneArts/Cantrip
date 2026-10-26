use super::*;

impl Hub {
    pub(super) async fn active(connection: &Arc<Connection>) -> bool {
        match &connection.context.active {
            None => true,
            Some(active) => active().await.unwrap_or(false),
        }
    }
    async fn authorize(connection: &Arc<Connection>, scopes: &[Value]) -> bool {
        join_all(
            scopes
                .iter()
                .map(|scope| (connection.context.authorize)(scope.clone())),
        )
        .await
        .into_iter()
        .all(|r| r.unwrap_or(false))
    }
    pub async fn frame(&self, id: Uuid, frame: Frame) {
        let connection = { self.state.lock().unwrap().connections.get(&id).cloned() };
        let Some(connection) = connection else { return };
        if let Err(_error) = self.handle_frame(&connection, frame).await {
            let mut state = self.state.lock().unwrap();
            let _ = self.error(
                &mut state,
                &connection,
                Value::Null,
                "internal-error",
                "The live server could not process that message.",
                true,
            );
        }
    }
    async fn handle_frame(&self, connection: &Arc<Connection>, frame: Frame) -> Result<()> {
        if connection.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if !Self::active(connection).await {
            Self::close_connection(
                &mut self.state.lock().unwrap(),
                connection,
                1008,
                "Session is no longer active",
            );
            return Ok(());
        }
        connection
            .last_seen
            .store((self.options.now)(), Ordering::Release);
        if let Some(record) = &self.options.record_usage {
            record(&connection.context.owner, true, frame.len(), true)
        }
        let raw = match frame {
            Frame::Binary(_) => {
                let mut state = self.state.lock().unwrap();
                return self.violation(
                    &mut state,
                    connection,
                    Value::Null,
                    "invalid-message",
                    "The application live channel accepts JSON text frames only.",
                );
            }
            Frame::Text(raw) if raw.len() > self.options.max_inbound_bytes => {
                let mut state = self.state.lock().unwrap();
                self.error(
                    &mut state,
                    connection,
                    Value::Null,
                    "payload-too-large",
                    "The application live frame exceeds the configured size limit.",
                    false,
                )?;
                Self::close_connection(&mut state, connection, 1009, "Live frame is too large");
                return Ok(());
            }
            Frame::Text(raw) => raw,
        };
        let raw = match serde_json::from_str::<Value>(&raw) {
            Ok(raw) => raw,
            Err(_) => {
                return self.violation(
                    &mut self.state.lock().unwrap(),
                    connection,
                    Value::Null,
                    "invalid-message",
                    "The application live frame must contain valid JSON.",
                );
            }
        };
        let message = match wire::parse("appLiveClientMessageSchema", Some(&raw)) {
            Ok(message) => message,
            Err(_) => {
                let mut state = self.state.lock().unwrap();
                if raw.is_object()
                    && raw["type"] == "initialize"
                    && raw
                        .get("protocolVersion")
                        .is_some_and(|v| v != &Value::Number(1.0))
                {
                    return self.violation(
                        &mut state,
                        connection,
                        Value::Null,
                        "unsupported-version",
                        "The application live protocol version is not supported.",
                    );
                }
                return self.violation(
                    &mut state,
                    connection,
                    request_id(&raw),
                    "invalid-message",
                    "The application live message does not match the protocol.",
                );
            }
        };
        self.message(connection, message).await
    }
    async fn message(&self, connection: &Arc<Connection>, message: Value) -> Result<()> {
        let kind = message["type"]
            .as_str()
            .context("validated live message type")?;
        if kind == "initialize" {
            let mut state = self.state.lock().unwrap();
            if connection.local.lock().unwrap().initialized {
                return self.violation(
                    &mut state,
                    connection,
                    Value::Null,
                    "already-initialized",
                    "The application live connection is already initialized.",
                );
            }
            let mut local = connection.local.lock().unwrap();
            local.initialized = true;
            local.capabilities = message["client"]["controlCapabilities"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_js_string().unwrap().clone())
                .collect();
            let mut mode = "not-requested";
            if !message["resume"].is_null() {
                state.stats.resume_attempt_count += 1;
                let cursor = message["resume"]["cursor"].as_u64().unwrap();
                let reason = self.resume_reason(
                    &state,
                    &connection.context.owner,
                    message["resume"]["serverEpoch"].as_str().unwrap_or(""),
                    cursor,
                );
                local.resume = Some(Resume { cursor, reason });
                mode = if reason.is_some() {
                    "resync-required"
                } else {
                    "replaying"
                };
            }
            drop(local);
            let cursor = Self::cursor(&state, &connection.context.owner);
            self.send(&mut state,connection,obj(serde_json::json!({"type":"ready","protocolVersion":1,"serverEpoch":self.options.epoch,"connectionId":connection.id.to_string(),"currentCursor":cursor,"heartbeatIntervalMs":self.options.heartbeat_interval_ms,"resume":mode})))?;
            return Ok(());
        }
        if !connection.local.lock().unwrap().initialized {
            return self.violation(
                &mut self.state.lock().unwrap(),
                connection,
                message.get("requestId").cloned().unwrap_or(Value::Null),
                "not-initialized",
                "Initialize the application live connection before using it.",
            );
        }
        if kind == "ping" {
            let mut state = self.state.lock().unwrap();
            state.stats.heartbeat_pong_count += 1;
            let cursor = Self::cursor(&state, &connection.context.owner);
            self.send(
                &mut state,
                connection,
                Value::object([
                    ("type", obj(serde_json::json!("pong"))),
                    ("nonce", message["nonce"].clone()),
                    ("cursor", obj(serde_json::json!(cursor))),
                ]),
            )?;
            return Ok(());
        }
        if kind == "client-control-ack" {
            let mut state = self.state.lock().unwrap();
            let id = message["correlationId"].as_str().unwrap();
            if let Some(pending) = state.controls.get(id)
                && pending.connection.id == connection.id
            {
                let status = if (self.options.now)() >= pending.expires {
                    "expired"
                } else {
                    message["status"].as_str().unwrap()
                };
                Self::settle(&mut state, id, status);
            }
            return Ok(());
        }
        let id = message["requestId"].as_js_string().unwrap();
        let previous = { connection.local.lock().unwrap().history.get(id).cloned() };
        if let Some(previous) = previous {
            self.send(&mut self.state.lock().unwrap(), connection, previous)?;
            return Ok(());
        }
        let scopes = message["scopes"].as_array().unwrap();
        if kind == "unsubscribe" {
            let mut state = self.state.lock().unwrap();
            for scope in scopes {
                Self::remove_subscription(&mut state, connection, &wire::live::scope_key(scope));
            }
            let cursor = Self::cursor(&state, &connection.context.owner);
            self.remember_send(
                &mut state,
                connection,
                Value::object([
                    ("type", obj(serde_json::json!("unsubscribed"))),
                    ("requestId", message["requestId"].clone()),
                    ("scopes", message["scopes"].clone()),
                    ("cursor", obj(serde_json::json!(cursor))),
                ]),
            )?;
            return Ok(());
        }
        if kind == "subscribe" {
            let mut keys = connection
                .local
                .lock()
                .unwrap()
                .scopes
                .keys()
                .cloned()
                .collect::<HashSet<_>>();
            keys.extend(scopes.iter().map(wire::live::scope_key));
            if keys.len() > 128 {
                return self.remember_error(
                    &mut self.state.lock().unwrap(),
                    connection,
                    &message["requestId"],
                    "subscription-limit",
                    "An application live connection may subscribe to at most 128 scopes.",
                );
            }
        }
        if !Self::authorize(connection, scopes).await {
            return self.remember_error(&mut self.state.lock().unwrap(),connection,&message["requestId"],"unauthorized-scope","One or more requested live scopes do not exist or are not owned by the current user.");
        }
        let mut state = self.state.lock().unwrap();
        if kind == "subscribe" {
            for scope in scopes {
                Self::add_subscription(&mut state, connection, scope.clone());
            }
        } else if kind == "resync-ack" {
            let cursor = message["cursor"].as_u64().unwrap();
            let reason = self.resume_reason(
                &state,
                &connection.context.owner,
                &self.options.epoch,
                cursor,
            );
            Self::replace_subscriptions(&mut state, connection, scopes);
            if let Some(reason) = reason {
                let mut local = connection.local.lock().unwrap();
                local.resume = Some(Resume {
                    cursor,
                    reason: Some(reason),
                });
                let scopes = local.scopes.values().cloned().collect::<Vec<_>>();
                drop(local);
                let response = obj(
                    serde_json::json!({"type":"resync-required","cursor":Self::cursor(&state,&connection.context.owner),"reason":reason,"scopes":scopes}),
                );
                Self::remember(connection, id.clone(), response.clone());
                self.resync(&mut state, connection, response)?;
                return Ok(());
            }
        }
        let cursor = Self::cursor(&state, &connection.context.owner);
        self.remember_send(
            &mut state,
            connection,
            Value::object([
                ("type", obj(serde_json::json!("subscribed"))),
                ("requestId", message["requestId"].clone()),
                ("scopes", message["scopes"].clone()),
                ("cursor", obj(serde_json::json!(cursor))),
            ]),
        )?;
        if kind == "subscribe" {
            self.finish_resume(&mut state, connection)?;
        } else {
            self.replay(&mut state, connection, message["cursor"].as_u64().unwrap())?;
        }
        Ok(())
    }
}
