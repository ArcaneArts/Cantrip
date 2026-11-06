use super::*;
fn parsed(schema: &str, value: Option<Value>) -> Result<Value> {
    wire::parse(schema, value.as_ref())
        .map_err(|error| crate::settings::response_error(error).into())
}
fn peer_id(peer: &str) -> Result<Value> {
    wire::parse_property(
        "workerLinkPeerSessionSchema",
        "peerSessionId",
        &Value::String(peer.into()),
    )
    .map_err(|error| crate::settings::response_error(error).into())
}
impl Authority {
    pub fn open_session(self: &Arc<Self>, input: Value) -> BoxFuture<'static, Result<Value>> {
        let service = self.clone();
        self.own(async move {
            service.assert_open()?;
            let session = service.local.open_session(input).await?;
            let id = session["sessionId"]
                .as_str()
                .expect("validated session")
                .to_owned();
            service.state.lock().unwrap().sessions.insert(id.clone());
            if let Some(coordinator) = &service.coordination {
                let previous = coordinator
                    .claim_worker_link_session(claim(coordinator.instance_id(), &session))
                    .await?;
                if previous
                    .as_ref()
                    .is_some_and(|claim| claim["authorityInstanceId"] != coordinator.instance_id())
                {
                    service.local.revoke_session(&id, "released").await;
                    service.state.lock().unwrap().sessions.shift_remove(&id);
                    return Err(unavailable(
                        "WorkerLink session authority is already owned by another server.",
                    ));
                }
            }
            Ok(session)
        })
    }
    pub fn session_for_authorization(
        self: &Arc<Self>,
        session: &str,
        owner: Value,
        account: Value,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let (service, session) = (self.clone(), session.to_owned());
        self.own(async move {
            if let Some(local) = service
                .local
                .session_for_authorization(&session, &owner, &account)
            {
                return Ok(Some(local));
            }
            let Some(coordinator) = &service.coordination else {
                return Ok(None);
            };
            let claim = coordinator
                .find_worker_link_session(&session.into())
                .await?;
            Ok(claim
                .filter(|claim| {
                    claim["session"]["identity"]["ownerId"] == owner
                        && claim["session"]["identity"]["accountSessionId"] == account
                        && !claim["expiresAt"].as_f64().is_some_and(|at| at <= now())
                })
                .map(|claim| claim["session"].clone()))
        })
    }
    fn value_operation(
        self: &Arc<Self>,
        session: &str,
        operation: Value,
        schema: &'static str,
    ) -> BoxFuture<'static, Result<Value>> {
        let (service, session) = (self.clone(), JsString::from(session));
        self.own(async move { parsed(schema, service.run_session(session, operation).await?) })
    }
    fn bool_operation(
        self: &Arc<Self>,
        session: &str,
        operation: Value,
    ) -> BoxFuture<'static, Result<bool>> {
        let (service, session) = (self.clone(), JsString::from(session));
        self.own(async move {
            Ok(wire::coercion::truthy(
                service.run_session(session, operation).await?.as_ref(),
            ))
        })
    }
    pub fn renew_session(self: &Arc<Self>, session: &str) -> BoxFuture<'static, Result<Value>> {
        self.value_operation(
            session,
            json!({"kind":"renew-session","sessionId":session}),
            "workerLinkSessionSchema",
        )
    }
    pub fn replace_route(
        self: &Arc<Self>,
        session: &str,
        route: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let (service, id) = (self.clone(), session.to_owned());
        self.own(async move {
            let result = parsed(
                "workerLinkSessionSchema",
                service
                    .run_session(
                        id.clone().into(),
                        json!({"kind":"replace-route","sessionId":id,"preferredRoute":route}),
                    )
                    .await?,
            )?;
            service
                .revoke_relay(json!({"kind":"session","sessionId":id}))
                .await?;
            Ok(result)
        })
    }
    pub fn open_peer(
        self: &Arc<Self>,
        session: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let input = checked("workerLinkPeerSessionOpenRequestSchema", input);
        let (service, id) = (self.clone(), session.to_owned());
        self.own(async move {
            let input = input?;
            parsed(
                "workerLinkPeerSessionDescriptorSchema",
                service
                    .run_session(
                        id.clone().into(),
                        json!({"kind":"open-peer","sessionId":id,"input":input}),
                    )
                    .await?,
            )
        })
    }
    pub fn signal_peer(
        self: &Arc<Self>,
        session: &str,
        envelope: Value,
    ) -> BoxFuture<'static, Result<()>> {
        let envelope = checked("workerLinkPeerSignalEnvelopeSchema", envelope);
        let (service, id) = (self.clone(), session.to_owned());
        self.own(async move {
            let envelope = envelope?;
            if envelope["sessionId"] != id.as_str() {
                return Err(unavailable(
                    "WorkerLink peer signal authority does not match the session.",
                ));
            }
            service
                .run_session(
                    id.clone().into(),
                    json!({"kind":"signal-peer","sessionId":id,"envelope":envelope}),
                )
                .await?;
            Ok(())
        })
    }
    pub fn read_peer_mailbox(
        self: &Arc<Self>,
        session: &str,
        peer: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let peer = peer_id(peer);
        let input = checked("workerLinkPeerMailboxReadRequestSchema", input);
        let (service, id) = (self.clone(), session.to_owned());
        self.own(async move {let peer=peer?;let input=input?;parsed("workerLinkPeerMailboxSchema",service.run_session(id.clone().into(),json!({"kind":"read-peer-mailbox","sessionId":id,"peerSessionId":peer,"input":input})).await?)})
    }
    pub fn revoke_peer(
        self: &Arc<Self>,
        session: &str,
        peer: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        let peer = peer_id(peer);
        let (service, id) = (self.clone(), session.to_owned());
        self.own(async move {
            Ok(wire::coercion::truthy(
                service
                    .run_session(
                        id.clone().into(),
                        json!({"kind":"revoke-peer","sessionId":id,"peerSessionId":peer?}),
                    )
                    .await?
                    .as_ref(),
            ))
        })
    }
    pub fn issue_grant(self: &Arc<Self>, input: Value) -> BoxFuture<'static, Result<Value>> {
        let service = self.clone();
        self.own(async move {
            let id = input["sessionId"]
                .as_js_string()
                .cloned()
                .ok_or_else(|| unavailable("WorkerLink session is unavailable."))?;
            parsed(
                "workerLinkResourceGrantSchema",
                service
                    .run_session(id, json!({"kind":"issue-grant","input":input}))
                    .await?,
            )
        })
    }
    pub fn renew_grant(
        self: &Arc<Self>,
        session: &str,
        grant: &str,
    ) -> BoxFuture<'static, Result<Value>> {
        self.value_operation(
            session,
            json!({"kind":"renew-grant","sessionId":session,"grantId":grant}),
            "workerLinkLeaseSchema",
        )
    }
    pub fn revoke_grant(
        self: &Arc<Self>,
        session: &str,
        grant: &str,
        reason: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        self.bool_operation(
            session,
            json!({"kind":"revoke-grant","sessionId":session,"grantId":grant,"reason":reason}),
        )
    }
    pub fn revoke_session(
        self: &Arc<Self>,
        session: &str,
        reason: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        let (service, id, reason) = (self.clone(), session.to_owned(), reason.to_owned());
        self.own(async move {
            let revoked = wire::coercion::truthy(
                service
                    .run_session(
                        id.clone().into(),
                        json!({"kind":"revoke-session","sessionId":id,"reason":reason}),
                    )
                    .await?
                    .as_ref(),
            );
            if revoked {
                service
                    .revoke_relay(json!({"kind":"session","sessionId":id}))
                    .await?;
            }
            Ok(revoked)
        })
    }
    pub fn revoke_account(self: &Arc<Self>, account: Value) -> BoxFuture<'static, Result<usize>> {
        let service = self.clone();
        self.own(async move {
            let scope = json!({"kind":"account-session","accountSessionId":account});
            let count = service.revoke_everywhere(scope.clone()).await?;
            service.revoke_relay(scope).await?;
            Ok(count)
        })
    }
    pub fn revoke_owner(self: &Arc<Self>, owner: Value) -> BoxFuture<'static, Result<usize>> {
        let service = self.clone();
        self.own(async move {
            let scope = json!({"kind":"owner","ownerId":owner});
            let count = service.revoke_everywhere(scope.clone()).await?;
            service.revoke_relay(scope).await?;
            Ok(count)
        })
    }
    pub fn revoke_resource(
        self: &Arc<Self>,
        owner: Value,
        kind: Value,
        resource: Value,
        reason: Value,
    ) -> BoxFuture<'static, Result<usize>> {
        let service = self.clone();
        self.own(async move {service.revoke_everywhere(json!({"kind":"resource","ownerId":owner,"resourceKind":kind,"resourceId":resource,"reason":reason})).await})
    }
    pub fn revoke_attachment(
        self: &Arc<Self>,
        owner: Value,
        kind: Value,
        resource: Value,
        attachment: Value,
        reason: Value,
    ) -> BoxFuture<'static, Result<usize>> {
        let service = self.clone();
        self.own(async move {service.revoke_everywhere(json!({"kind":"attachment","ownerId":owner,"resourceKind":kind,"resourceId":resource,"attachmentId":attachment,"reason":reason})).await})
    }
}
