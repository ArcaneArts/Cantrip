use super::*;
fn session_id(operation: &Value) -> &Value {
    if operation["kind"] == "issue-grant" {
        &operation["input"]["sessionId"]
    } else {
        &operation["sessionId"]
    }
}
impl Authority {
    pub(super) async fn run_session(
        self: &Arc<Self>,
        session: JsString,
        operation: Value,
    ) -> Outcome {
        self.assert_open()?;
        let Some(coordinator) = &self.coordination else {
            return self.run_local(operation).await;
        };
        let claim = coordinator
            .find_worker_link_session(&session)
            .await?
            .ok_or_else(|| unavailable("WorkerLink session is unavailable."))?;
        if claim["authorityInstanceId"] == coordinator.instance_id() {
            return self.run_local(operation).await;
        }
        let request = Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        let weak = Arc::downgrade(self);
        let key = request.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if let Some(service) = weak.upgrade() {
                let pending = service.state.lock().unwrap().pending.shift_remove(&key);
                if let Some(pending) = pending {
                    let _ = pending.send.send(Err(unavailable(
                        "WorkerLink authority did not answer in time.",
                    )));
                }
            }
        });
        self.state.lock().unwrap().pending.insert(
            request.clone(),
            Pending {
                send,
                timer: timer.abort_handle(),
            },
        );
        if let Err(error)=coordinator.publish(json!({"kind":"worker-link-operation-request","targetInstanceId":claim["authorityInstanceId"],"requestId":request,"operation":operation}),None).await {
            let pending=self.state.lock().unwrap().pending.shift_remove(&request);
            if let Some(pending)=pending {pending.timer.abort();let _=pending.send.send(Err(error.into()));}
        }
        receive
            .await
            .unwrap_or_else(|_| Err(unavailable("WorkerLink service closed.")))
    }
    async fn refresh_claim(&self, session: &Value) -> Result<()> {
        let Some(coordinator) = &self.coordination else {
            return Ok(());
        };
        let value = claim(coordinator.instance_id(), session);
        if !coordinator
            .refresh_worker_link_session(value.clone())
            .await?
        {
            let previous = coordinator.claim_worker_link_session(value).await?;
            if previous.as_ref().is_some_and(|claim| {
                claim.get("authorityInstanceId").is_some()
                    && claim["authorityInstanceId"] != coordinator.instance_id()
            }) {
                return Err(unavailable(
                    "WorkerLink session authority was lost during the operation.",
                ));
            }
        }
        Ok(())
    }
    async fn run_local(&self, operation: Value) -> Outcome {
        if operation["kind"] == "issue-grant" {
            return self
                .local
                .issue_grant(operation["input"].clone())
                .await
                .map(Some);
        }
        let session = session_id(&operation)
            .as_str()
            .ok_or_else(|| unavailable("The WorkerLink session is unavailable."))?;
        let value = match operation["kind"].as_str() {
            Some("renew-session") => {
                let value = self.local.renew_session(session, None).await?;
                self.refresh_claim(&value).await?;
                value
            }
            Some("replace-route") => {
                let value = self
                    .local
                    .replace_route(session, operation["preferredRoute"].clone())
                    .await?;
                self.refresh_claim(&value).await?;
                value
            }
            Some("open-peer") => {
                let peer = self
                    .local
                    .open_peer(
                        session,
                        operation["input"]["route"].clone(),
                        operation["input"]["routeGeneration"].clone(),
                    )
                    .await?;
                json!({"peerSession":peer,"configuration":self.local.peer_configuration()?})
            }
            Some("signal-peer") => {
                self.local
                    .signal_peer(operation["envelope"].clone())
                    .await?;
                return Ok(None);
            }
            Some("read-peer-mailbox") => self.local.read_peer_mailbox(
                session,
                operation["peerSessionId"].as_str().unwrap_or(""),
                operation["input"].clone(),
            )?,
            Some("revoke-peer") => json!(
                self.local
                    .revoke_peer(
                        session,
                        operation["peerSessionId"].as_str().unwrap_or(""),
                        "released"
                    )
                    .await
            ),
            Some("renew-grant") => {
                self.local
                    .renew_grant(session, operation["grantId"].as_str().unwrap_or(""), None)
                    .await?
            }
            Some("revoke-grant") => json!(
                self.local
                    .revoke_grant_value(
                        session,
                        operation["grantId"].as_str().unwrap_or(""),
                        operation["reason"].clone()
                    )
                    .await
            ),
            Some("revoke-session") => {
                let revoked = self
                    .local
                    .revoke_session_value(session, operation["reason"].clone())
                    .await;
                if revoked {
                    self.state.lock().unwrap().sessions.shift_remove(session);
                    if let Some(coordinator) = &self.coordination {
                        coordinator
                            .release_worker_link_session(
                                &session.into(),
                                &coordinator.instance_id().into(),
                            )
                            .await?;
                    }
                }
                json!(revoked)
            }
            _ => return Ok(None),
        };
        Ok(Some(value))
    }
    pub(super) async fn apply_scope(&self, scope: &Value) -> usize {
        match scope["kind"].as_str() {
            Some("owner") => {
                self.local
                    .revoke_scope(
                        RevocationScope::Owner(scope["ownerId"].clone()),
                        "account-session-ended",
                    )
                    .await
            }
            Some("account-session") => {
                self.local
                    .revoke_scope(
                        RevocationScope::AccountSession(scope["accountSessionId"].clone()),
                        "account-session-ended",
                    )
                    .await
            }
            Some("resource" | "attachment") => {
                self.local
                    .revoke_scope_value(
                        RevocationScope::Resource(Box::new(ResourceScope {
                            owner: scope["ownerId"].clone(),
                            kind: scope["resourceKind"].clone(),
                            resource: scope["resourceId"].clone(),
                            attachment: (scope["kind"] == "attachment")
                                .then(|| scope["attachmentId"].clone()),
                        })),
                        scope["reason"].clone(),
                    )
                    .await
            }
            _ => 0,
        }
    }
    pub(super) async fn revoke_everywhere(&self, scope: Value) -> Result<usize> {
        self.assert_open()?;
        let count = self.apply_scope(&scope).await;
        if let Some(coordinator) = &self.coordination {
            coordinator
                .publish(json!({"kind":"worker-link-revoke","scope":scope}), None)
                .await?;
        }
        Ok(count)
    }
    pub(super) async fn receive(self: &Arc<Self>, message: Value) -> Result<()> {
        if self.state.lock().unwrap().closed {
            return Ok(());
        }
        match message["kind"].as_str() {
            Some("worker-link-operation-response") => {
                let Some(id) = message["requestId"].as_str() else {
                    return Ok(());
                };
                let pending = self.state.lock().unwrap().pending.shift_remove(id);
                let Some(pending) = pending else {
                    return Ok(());
                };
                pending.timer.abort();
                let result = if wire::coercion::truthy(message.get("ok")) {
                    Ok(message.get("result").cloned())
                } else {
                    let text = match message.get("error") {
                        None | Some(Value::Null) => {
                            "WorkerLink authority rejected the operation.".into()
                        }
                        Some(Value::String(value)) => value.clone(),
                        _ => {
                            let _ = pending.send.send(Err(unavailable(
                                "WorkerLink authority rejected the operation.",
                            )));
                            return Err(anyhow::anyhow!("value.slice is not a function").into());
                        }
                    };
                    Err(Error::Unavailable(bounded(&text)))
                };
                let _ = pending.send.send(result);
                Ok(())
            }
            Some("worker-link-revoke") => {
                if let Some(scope) = parse::revoke_scope(&message["scope"]) {
                    self.apply_scope(&scope).await;
                }
                Ok(())
            }
            Some("worker-link-relay-revoke") => {
                if let Some(scope) = parse::relay_scope(&message["scope"]) {
                    self.notify_relay(scope)?;
                }
                Ok(())
            }
            Some("worker-link-operation-request") => {
                let Some(operation) = parse::operation(&message["operation"])? else {
                    return Ok(());
                };
                let Some(coordinator) = &self.coordination else {
                    return Ok(());
                };
                let result: Outcome = async {
                    let session = session_id(&operation)
                        .as_js_string()
                        .expect("parsed session identity");
                    let current = coordinator.find_worker_link_session(session).await?;
                    if current.as_ref().is_none_or(|claim| {
                        claim["authorityInstanceId"] != coordinator.instance_id()
                    }) {
                        return Err(unavailable(
                            "This server no longer owns WorkerLink authority.",
                        ));
                    }
                    self.run_local(operation).await
                }
                .await;
                let mut payload = json!({"kind":"worker-link-operation-response","targetInstanceId":message["sourceInstanceId"],"ok":result.is_ok()});
                if let Some(request) = message.get("requestId") {
                    payload["requestId"] = request.clone();
                }
                match result {
                    Ok(Some(value)) => payload["result"] = value,
                    Ok(None) => {}
                    Err(error) => payload["error"] = Value::String(bounded(&error_message(&error))),
                }
                coordinator.publish(payload, None).await?;
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
