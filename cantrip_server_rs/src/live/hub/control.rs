use super::*;

impl Hub {
    pub async fn request_control(
        self: &Arc<Self>,
        owner: &str,
        command: Value,
        timeout_ms: i64,
    ) -> Result<Value> {
        let correlation = Uuid::new_v4().to_string();
        {
            let state = self.state.lock().unwrap();
            if state.closed || state.controls.len() >= 128 {
                return Ok(obj(
                    serde_json::json!({"correlationId":correlation,"status":"unavailable"}),
                ));
            }
        }
        let bounded = timeout_ms.clamp(1, 10000);
        let issued = (self.options.now)();
        let request=wire::parse("clientControlRequestSchema",Some(&obj(serde_json::json!({"correlationId":correlation,"issuedAt":crate::auth::iso(chrono::DateTime::from_timestamp_millis(issued).context("live control time")?),"expiresAt":crate::auth::iso(chrono::DateTime::from_timestamp_millis(issued+bounded).context("live control expiry")?),"command":command})))).map_err(|_|anyhow::anyhow!("Invalid client-control request"))?;
        let candidates = {
            let state = self.state.lock().unwrap();
            let scope = wire::live::scope_key(&obj(
                serde_json::json!({"kind":"project","projectId":command["projectId"]}),
            ));
            state
                .subscribers
                .get(owner)
                .and_then(|s| s.get(&scope))
                .map(|s| s.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        let candidates = join_all(candidates.into_iter().map(|connection| async move {
            let initialized = connection.local.lock().unwrap().initialized;
            if !initialized
                || connection.closed.load(Ordering::Acquire)
                || !Self::active(&connection).await
            {
                None
            } else {
                Some(connection)
            }
        }))
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(obj(
                serde_json::json!({"correlationId":correlation,"status":"unavailable"}),
            ));
        }
        let compatible = candidates
            .into_iter()
            .filter(|connection| {
                connection
                    .local
                    .lock()
                    .unwrap()
                    .capabilities
                    .contains(command["kind"].as_js_string().unwrap())
            })
            .collect::<Vec<_>>();
        if compatible.is_empty() {
            return Ok(obj(
                serde_json::json!({"correlationId":correlation,"status":"unsupported"}),
            ));
        }
        let chat = (command["kind"] == "show-interaction").then(|| {
            wire::live::scope_key(&obj(
                serde_json::json!({"kind":"chat","chatId":command["chatId"]}),
            ))
        });
        let connection = compatible
            .iter()
            .find(|connection| {
                chat.as_ref()
                    .is_some_and(|chat| connection.local.lock().unwrap().scopes.contains_key(chat))
            })
            .cloned()
            .unwrap_or_else(|| compatible[0].clone());
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.controls.len() >= 128 {
                return Ok(obj(
                    serde_json::json!({"correlationId":correlation,"status":"unavailable"}),
                ));
            }
            let hub = Arc::downgrade(self);
            let id = correlation.clone();
            let task = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(bounded as u64)).await;
                if let Some(hub) = hub.upgrade() {
                    Self::settle(&mut hub.state.lock().unwrap(), &id, "expired");
                }
            });
            state.controls.insert(
                correlation.clone(),
                Pending {
                    connection: connection.clone(),
                    expires: issued + bounded,
                    completion: tx,
                    timer: task.abort_handle(),
                },
            );
            let mut message = request;
            message["type"] = obj(serde_json::json!("client-control-request"));
            if !self.send(&mut state, &connection, message)? {
                Self::settle(&mut state, &correlation, "unavailable");
            }
        }
        rx.await.context("application live control completion")
    }
}
