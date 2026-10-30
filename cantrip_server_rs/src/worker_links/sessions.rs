use super::*;

impl Coordinator {
    pub async fn open_session(self: &Arc<Self>, input: Value) -> Result<Value> {
        self.assert_open()?;
        self.authorized(&input)?;
        self.sweep_expired().await;
        let resolved = checked(
            "workerLinkIdentityResolveResultSchema",
            (self.workers)(
                input["workerId"].clone(),
                json!({"type":"worker-link.identity.resolve"}),
                Some(input["ownerId"].clone()),
            )
            .await
            .map_err(Error::from)?,
        )?;
        if resolved["serverId"] != self.options.server_id
            || resolved["ownerId"] != input["ownerId"]
            || resolved["workerId"] != input["workerId"]
        {
            return Err(unavailable(
                "WorkerLink identity resolution did not match the authorized worker.",
            ));
        }
        let identity = json!({"serverId":self.options.server_id,"serverGeneration":self.options.server_generation,"ownerId":input["ownerId"],"accountSessionId":input["accountSessionId"],"clientInstanceId":input["clientInstanceId"],"workerId":input["workerId"],"workerProcessGeneration":resolved["workerProcessGeneration"]});
        let identity_key = identity_key(&identity);
        let operation = {
            let mut state = self.state.lock().unwrap();
            if let Some(existing) = state
                .identities
                .get(&identity_key)
                .and_then(|id| state.sessions.get(id))
            {
                let existing = existing.lock().unwrap();
                if existing.ready {
                    return Ok(existing.session.clone());
                }
            }
            if let Some((_, opening)) = state.opening.get(&identity_key) {
                opening.clone()
            } else {
                if state.sessions.len() + state.opening.len() >= self.options.max_active_sessions {
                    return Err(unavailable(
                        "The WorkerLink session limit has been reached.",
                    ));
                }
                let service = self.clone();
                let marker = uuid::Uuid::new_v4();
                let key = identity_key.clone();
                let operation = async move {
                    let result = service.open_new_session(identity, key.clone()).await;
                    let mut state = service.state.lock().unwrap();
                    if state.opening.get(&key).is_some_and(|(id, _)| *id == marker) {
                        state.opening.remove(&key);
                    }
                    result
                }
                .boxed()
                .shared();
                state
                    .opening
                    .insert(identity_key, (marker, operation.clone()));
                tokio::spawn(operation.clone());
                operation
            }
        };
        operation.await
    }
    async fn open_new_session(self: &Arc<Self>, identity: Value, key: Vec<u16>) -> Result<Value> {
        self.revoke_sessions_where(
            |s| {
                s["identity"]["workerId"] == identity["workerId"]
                    && s["identity"]["workerProcessGeneration"]
                        != identity["workerProcessGeneration"]
            },
            "worker-generation-changed",
        )
        .await;
        self.assert_open()?;
        self.authorized(&identity)?;
        let now = self.now() as f64;
        let mut enabled = vec![];
        let config = self.options.peer_configuration.as_ref();
        if config.is_none_or(|c| c["relayOnly"] != true) {
            if config.is_none_or(|c| c["directRoutes"]["local"] != false) {
                enabled.push("local")
            }
            if config.is_some_and(|c| c["directRoutes"]["lan"] == true) {
                enabled.push("lan")
            }
            if config.is_some_and(|c| c["directRoutes"]["wan"] == true) {
                enabled.push("wan")
            }
        }
        enabled.push("relay");
        let absolute = now + self.options.session_lifetime_ms.max(1.0);
        let session = checked(
            "workerLinkSessionSchema",
            json!({"sessionId":uuid::Uuid::new_v4().to_string(),"identity":identity,"lease":json!({"issuedAt":iso(now)?,"expiresAt":iso(absolute.min(now+self.options.session_lease_ms.max(1.0)))?,"absoluteExpiresAt":iso(absolute)?}),"routePolicy":json!({"priority":["local","lan","wan","relay"],"enabled":enabled}),"routeGeneration":1,"preferredRoute":if enabled.contains(&"local"){"local"}else{"relay"}}),
        )?;
        let session_id = id(&session, "sessionId");
        let current = Arc::new(Mutex::new(SessionState {
            ready: false,
            session: session.clone(),
            grants: IndexMap::new(),
            peers: IndexMap::new(),
        }));
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(unavailable("The WorkerLink coordinator is shutting down."));
            }
            if !identity_authorized(&state, &identity) {
                return Err(unavailable(
                    "The WorkerLink account session is no longer authorized.",
                ));
            }
            state.sessions.insert(session_id.clone(), current.clone());
            state.identities.insert(key, session_id.clone());
            self.register_worker(&mut state, &identity["workerId"]);
        }
        if let Err(error) = self
            .request(
                identity["workerId"].clone(),
                json!({"type":"worker-link.session.install","session":session}),
                None,
            )
            .await
        {
            self.remove_session(&session_id, &current);
            return Err(error);
        }
        let accepted = self
            .with_current(&session_id, &current, |state, current| {
                if !identity_authorized(state, &identity) {
                    return false;
                }
                current.ready = true;
                true
            })
            .unwrap_or(false);
        if !accepted {
            self.best_effort(identity["workerId"].clone(),json!({"type":"worker-link.session.revoke","sessionId":session_id,"revocation":revocation("released",self.now())}),identity["ownerId"].clone()).await;
            return Err(unavailable(
                "The WorkerLink session was revoked while it was being installed.",
            ));
        }
        Ok(session)
    }
    pub async fn renew_session(
        self: &Arc<Self>,
        session_id: &str,
        duration: Option<f64>,
    ) -> Result<Value> {
        self.assert_open()?;
        self.sweep_expired().await;
        let state = self.ready(session_id)?;
        let duration = duration.unwrap_or(self.options.session_lease_ms);
        let session = state.lock().unwrap().session.clone();
        let renewed = lease(&session["lease"], duration, self.now(), f64::INFINITY)?;
        self.request(
            session["identity"]["workerId"].clone(),
            json!({"type":"worker-link.session.renew","sessionId":session_id,"lease":renewed}),
            None,
        )
        .await?;
        let peers = self
            .with_current(session_id, &state, |_, state| -> Result<Vec<Peer>> {
                let mut next = state.session.clone();
                next["lease"] = renewed.clone();
                state.session = checked("workerLinkSessionSchema", next)?;
                Ok(state.peers.values().cloned().collect())
            })
            .ok_or_else(|| unavailable("The WorkerLink session was revoked during renewal."))??;
        for peer in peers {
            let value = {
                let peer = peer.lock().unwrap();
                if !peer.ready {
                    continue;
                }
                peer.peer.clone()
            };
            let peer_id = id(&value, "peerSessionId");
            let peer_lease = lease(
                &value["lease"],
                duration,
                self.now(),
                date(&renewed["expiresAt"]),
            )?;
            if self.request(session["identity"]["workerId"].clone(),json!({"type":"worker-link.peer.renew","peerSessionId":peer_id,"sessionId":session_id,"lease":peer_lease}),None).await.is_ok(){
                if state.lock().unwrap().peers.get(&peer_id).is_some_and(|p|Arc::ptr_eq(p,&peer)){
                    let mut peer=peer.lock().unwrap();let mut value=peer.peer.clone();value["lease"]=peer_lease;peer.peer=checked("workerLinkPeerSessionSchema",value)?;
                }
            }else{
                state.lock().unwrap().peers.shift_remove(&peer_id);
                self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.peer.revoke","peerSessionId":peer_id,"sessionId":session_id,"revocation":revocation("lease-expired",self.now())}),session["identity"]["ownerId"].clone()).await;
            }
        }
        Ok(state.lock().unwrap().session.clone())
    }
    pub async fn replace_route(self: &Arc<Self>, session_id: &str, route: Value) -> Result<Value> {
        self.assert_open()?;
        self.sweep_expired().await;
        let state = self.ready(session_id)?;
        let session = state.lock().unwrap().session.clone();
        if session["preferredRoute"] == route {
            return Ok(session);
        }
        if !session["routePolicy"]["enabled"]
            .as_array()
            .unwrap()
            .contains(&route)
        {
            return Err(unavailable(
                "The requested WorkerLink route is not enabled.",
            ));
        }
        let generation = session["routeGeneration"].as_f64().unwrap() + 1.0;
        self.request(session["identity"]["workerId"].clone(),json!({"type":"worker-link.session.route","sessionId":session_id,"routeGeneration":generation,"preferredRoute":route}),None).await?;
        if !self.current(session_id, &state) {
            return Err(unavailable(
                "The WorkerLink session was revoked during route replacement.",
            ));
        }
        let peers = {
            let mut state = state.lock().unwrap();
            let mut next = state.session.clone();
            next["preferredRoute"] = route;
            next["routeGeneration"] = Value::Number(generation);
            state.session = checked("workerLinkSessionSchema", next)?;
            state.peers.keys().cloned().collect::<Vec<_>>()
        };
        futures::future::join_all(
            peers
                .iter()
                .map(|peer| self.revoke_peer(session_id, peer, "route-replaced")),
        )
        .await;
        Ok(state.lock().unwrap().session.clone())
    }
}
