use super::*;

impl Coordinator {
    pub async fn open_peer(
        self: &Arc<Self>,
        session_id: &str,
        route: Value,
        generation: Value,
    ) -> Result<Value> {
        self.assert_open()?;
        self.sweep_expired().await;
        let current = self.ready(session_id)?;
        let configuration = self
            .options
            .peer_configuration
            .clone()
            .filter(|c| {
                c["relayOnly"] != true
                    && route.as_str().is_some_and(|r| c["directRoutes"][r] == true)
            })
            .ok_or_else(|| unavailable("The requested WorkerLink peer route is disabled."))?;
        let session = current.lock().unwrap().session.clone();
        if generation != session["routeGeneration"] {
            return Err(unavailable(
                "The WorkerLink peer route generation is stale.",
            ));
        }
        {
            let state = current.lock().unwrap();
            for peer in state.peers.values() {
                let peer = peer.lock().unwrap();
                if peer.ready
                    && peer.peer["route"] == route
                    && peer.peer["routeGeneration"] == generation
                {
                    return Ok(peer.peer.clone());
                }
            }
        }
        let round = format!(
            "{session_id}:{}:{}",
            generation.stringify(),
            route.as_str().unwrap()
        );
        let operation = {
            let mut state = self.state.lock().unwrap();
            if let Some((_, opening)) = state.opening_peers.get(&round) {
                opening.clone()
            } else {
                let service = self.clone();
                let marker = uuid::Uuid::new_v4();
                let key = round.clone();
                let operation = async move {
                    let result = service.install_peer(current, route, configuration).await;
                    let mut state = service.state.lock().unwrap();
                    if state
                        .opening_peers
                        .get(&key)
                        .is_some_and(|(id, _)| *id == marker)
                    {
                        state.opening_peers.remove(&key);
                    }
                    result
                }
                .boxed()
                .shared();
                state
                    .opening_peers
                    .insert(round, (marker, operation.clone()));
                tokio::spawn(operation.clone());
                operation
            }
        };
        operation.await
    }
    async fn install_peer(
        self: &Arc<Self>,
        current: Session,
        route: Value,
        config: Value,
    ) -> Result<Value> {
        let (session, peer, state) = self.prepare_peer(&current, route, &config)?;
        let session_id = id(&session, "sessionId");
        let peer_id = id(&peer, "peerSessionId");
        if let Err(error)=self.request(session["identity"]["workerId"].clone(),json!({"type":"worker-link.peer.install","peerSession":peer,"configuration":config}),None).await{
            let mut current=current.lock().unwrap();if current.peers.get(&peer_id).is_some_and(|p|Arc::ptr_eq(p,&state)){current.peers.shift_remove(&peer_id);}return Err(error)
        }
        let accepted = self
            .with_current(&session_id, &current, |_, current| {
                if !current
                    .peers
                    .get(&peer_id)
                    .is_some_and(|p| Arc::ptr_eq(p, &state))
                    || current.session["routeGeneration"] != peer["routeGeneration"]
                {
                    return false;
                }
                state.lock().unwrap().ready = true;
                true
            })
            .unwrap_or(false);
        if !accepted {
            self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.peer.revoke","peerSessionId":peer_id,"sessionId":session_id,"revocation":revocation("route-replaced",self.now())}),session["identity"]["ownerId"].clone()).await;
            return Err(unavailable(
                "The WorkerLink peer session was revoked during installation.",
            ));
        }
        Ok(peer)
    }
    fn prepare_peer(
        &self,
        current: &Session,
        route: Value,
        config: &Value,
    ) -> Result<(Value, Value, Peer)> {
        let root = self.state.lock().unwrap();
        let session = current.lock().unwrap().session.clone();
        if current.lock().unwrap().peers.len() as f64
            >= config["maxPeerSessionsPerClient"].as_f64().unwrap()
        {
            return Err(unavailable(
                "The WorkerLink client peer-session limit has been reached.",
            ));
        }
        let count = root
            .sessions
            .values()
            .map(|s| {
                let s = s.lock().unwrap();
                if s.session["identity"]["workerId"] == session["identity"]["workerId"] {
                    s.peers.len()
                } else {
                    0
                }
            })
            .sum::<usize>();
        if count as f64 >= config["maxPeerSessionsPerWorker"].as_f64().unwrap() {
            return Err(unavailable(
                "The WorkerLink worker peer-session limit has been reached.",
            ));
        }
        let peer = checked(
            "workerLinkPeerSessionSchema",
            json!({"peerSessionId":uuid::Uuid::new_v4().to_string(),"sessionId":session["sessionId"],"identity":session["identity"],"routeGeneration":session["routeGeneration"],"route":route,"lease":json!({"issuedAt":iso(self.now() as f64)?,"expiresAt":session["lease"]["expiresAt"],"absoluteExpiresAt":session["lease"]["absoluteExpiresAt"]})}),
        )?;
        let state = Arc::new(Mutex::new(PeerState {
            ready: false,
            peer: peer.clone(),
            signals: vec![],
            advertisements: vec![],
            last_client: -1.0,
            last_worker: -1.0,
            last_advertisement: -1.0,
            signal_queue: Arc::new(tokio::sync::Mutex::new(())),
        }));
        let peer_id = id(&peer, "peerSessionId");
        current
            .lock()
            .unwrap()
            .peers
            .insert(peer_id.clone(), state.clone());
        Ok((session, peer, state))
    }
    pub async fn signal_peer(self: &Arc<Self>, input: Value) -> Result<()> {
        let envelope = checked("workerLinkPeerSignalEnvelopeSchema", input)?;
        if envelope["sender"] != "client" {
            return Err(unavailable("The WorkerLink peer signal sender is invalid."));
        }
        let session_id = id(&envelope, "sessionId");
        let peer_id = id(&envelope, "peerSessionId");
        let current = self.ready(&session_id)?;
        let peer = current
            .lock()
            .unwrap()
            .peers
            .get(&peer_id)
            .cloned()
            .ok_or_else(|| unavailable("The WorkerLink peer signal authority is unavailable."))?;
        let queue = peer.lock().unwrap().signal_queue.clone();
        let _turn = queue.lock().await;
        let valid = {
            let peer = peer.lock().unwrap();
            peer.ready
                && envelope["routeGeneration"] == peer.peer["routeGeneration"]
                && envelope["route"] == peer.peer["route"]
                && date(&peer.peer["lease"]["expiresAt"]) > self.now() as f64
        };
        if !valid
            || !self.current(&session_id, &current)
            || !current
                .lock()
                .unwrap()
                .peers
                .get(&peer_id)
                .is_some_and(|p| Arc::ptr_eq(p, &peer))
        {
            return Err(unavailable(
                "The WorkerLink peer signal authority is unavailable.",
            ));
        }
        let sequence = envelope["signalSequence"].as_f64().unwrap();
        if sequence != peer.lock().unwrap().last_client + 1.0 {
            return Err(unavailable(
                "The WorkerLink peer signal sequence is invalid.",
            ));
        }
        if sequence >= 256.0 {
            self.revoke_peer(&session_id, &peer_id, "protocol-violation")
                .await;
            return Err(unavailable(
                "The WorkerLink peer signal limit has been reached.",
            ));
        }
        let worker = current.lock().unwrap().session["identity"]["workerId"].clone();
        self.request(
            worker,
            json!({"type":"worker-link.peer.signal","envelope":envelope}),
            None,
        )
        .await?;
        if self.current(&session_id, &current)
            && current
                .lock()
                .unwrap()
                .peers
                .get(&peer_id)
                .is_some_and(|p| Arc::ptr_eq(p, &peer))
        {
            peer.lock().unwrap().last_client = sequence;
        }
        Ok(())
    }
    pub fn read_peer_mailbox(
        &self,
        session_id: &str,
        peer_id: &str,
        input: Value,
    ) -> Result<Value> {
        let request = checked("workerLinkPeerMailboxReadRequestSchema", input)?;
        let current = self.ready(session_id)?;
        let peer = current
            .lock()
            .unwrap()
            .peers
            .get(peer_id)
            .cloned()
            .ok_or_else(|| unavailable("The WorkerLink peer mailbox is unavailable."))?;
        let mut peer = peer.lock().unwrap();
        if !peer.ready || date(&peer.peer["lease"]["expiresAt"]) <= self.now() as f64 {
            return Err(unavailable("The WorkerLink peer mailbox is unavailable."));
        }
        if request["afterSignalSequence"]
            .as_f64()
            .is_some_and(|n| n > peer.last_worker)
            || request["afterAdvertisementSequence"]
                .as_f64()
                .is_some_and(|n| n > peer.last_advertisement)
        {
            return Err(unavailable(
                "The WorkerLink peer mailbox cursor is invalid.",
            ));
        }
        if let Some(after) = request["afterSignalSequence"].as_f64() {
            peer.signals
                .retain(|s| s["signalSequence"].as_f64().unwrap() > after);
        }
        if let Some(after) = request["afterAdvertisementSequence"].as_f64() {
            peer.advertisements
                .retain(|s| s["advertisementSequence"].as_f64().unwrap() > after);
        }
        checked(
            "workerLinkPeerMailboxSchema",
            json!({"peerSessionId":peer_id,"sessionId":session_id,"routeGeneration":peer.peer["routeGeneration"],"route":peer.peer["route"],"signals":peer.signals,"candidateAdvertisements":peer.advertisements}),
        )
    }
    pub async fn revoke_peer(
        self: &Arc<Self>,
        session_id: &str,
        peer_id: &str,
        reason: &str,
    ) -> bool {
        let current = self.state.lock().unwrap().sessions.get(session_id).cloned();
        let Some(current) = current else { return false };
        let session = {
            let mut current = current.lock().unwrap();
            if current.peers.shift_remove(peer_id).is_none() {
                return false;
            }
            current.session.clone()
        };
        self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.peer.revoke","peerSessionId":peer_id,"sessionId":session_id,"revocation":revocation(reason,self.now())}),session["identity"]["ownerId"].clone()).await;
        true
    }
    pub async fn receive_notification(self: &Arc<Self>, worker: Value, notification: Value) {
        let signal = notification["type"] == "worker-link.peer.signal";
        if !signal && notification["type"] != "worker-link.peer.candidates" {
            return;
        }
        let envelope = if signal {
            &notification["envelope"]
        } else {
            &notification["advertisement"]
        };
        let peer_id = id(envelope, "peerSessionId");
        let found = self.state.lock().unwrap().sessions.values().find_map(|s| {
            let state = s.lock().unwrap();
            state
                .peers
                .get(&peer_id)
                .cloned()
                .map(|p| (state.session.clone(), p))
        });
        let Some((session, peer)) = found else { return };
        let session_id = id(&session, "sessionId");
        let revoke = {
            let mut peer = peer.lock().unwrap();
            let authority = &peer.peer;
            if session["identity"]["workerId"] != worker
                || envelope["sessionId"] != authority["sessionId"]
                || envelope["routeGeneration"] != authority["routeGeneration"]
                || envelope["route"] != authority["route"]
                || date(&authority["lease"]["expiresAt"]) <= self.now() as f64
            {
                true
            } else {
                let sequence = envelope[if signal {
                    "signalSequence"
                } else {
                    "advertisementSequence"
                }]
                .as_f64()
                .unwrap();
                let last = if signal {
                    peer.last_worker
                } else {
                    peer.last_advertisement
                };
                let records = if signal {
                    &peer.signals
                } else {
                    &peer.advertisements
                };
                if sequence <= last {
                    records
                        .iter()
                        .find(|s| {
                            s[if signal {
                                "signalSequence"
                            } else {
                                "advertisementSequence"
                            }]
                            .as_f64()
                                == Some(sequence)
                        })
                        .is_some_and(|s| s.stringify() != envelope.stringify())
                } else {
                    let mut signals = peer.signals.clone();
                    let mut advertisements = peer.advertisements.clone();
                    if signal {
                        signals.push(envelope.clone())
                    } else {
                        advertisements.push(envelope.clone())
                    }
                    if sequence != last + 1.0
                        || records.len() >= 256
                        || json!({"signals":signals,"candidateAdvertisements":advertisements})
                            .stringify()
                            .len()
                            > 4 * 1024 * 1024
                    {
                        true
                    } else {
                        if signal {
                            peer.signals.push(envelope.clone());
                            peer.last_worker = sequence;
                        } else {
                            peer.advertisements.push(envelope.clone());
                            peer.last_advertisement = sequence;
                        }
                        false
                    }
                }
            }
        };
        if revoke {
            self.revoke_peer(&session_id, &peer_id, "protocol-violation")
                .await;
        }
    }
}
