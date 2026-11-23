use super::*;
impl CoordinatedBridge {
    pub async fn attach(
        self: &Arc<Self>,
        worker: &str,
        peer: Arc<Peer>,
        owner: Option<String>,
        ready: Option<String>,
    ) -> Result<bool> {
        if self.state.lock().unwrap().closed {
            peer.close(1012, "Server is shutting down");
            return Ok(false);
        }
        if !peer.is_open() {
            return Ok(false);
        }
        let generation = Uuid::new_v4();
        self.state
            .lock()
            .unwrap()
            .attachments
            .insert(worker.into(), generation);
        let owner = match owner {
            Some(owner) => Some(owner),
            None => (self.resolve_owner)(worker.into()).await?,
        };
        if !self.current(worker, generation) || !peer.is_open() {
            peer.close(1012, "Worker connection was superseded");
            return Ok(false);
        }
        let Some(owner) = owner.filter(|s| !s.is_empty()) else {
            self.log(
                "warn",
                "Worker relay attachment rejected",
                "coordination.worker.attach-rejected",
                "attach-worker",
                "rejected",
                json!({"reasonCode":"owner-unavailable","workerId":worker}),
            );
            peer.close(1008, "Worker owner is unavailable");
            return Ok(false);
        };
        if peer.continuity.as_ref().is_some_and(|c| c.owner != owner) {
            peer.close(1008, "Worker continuity identity does not match owner");
            return Ok(false);
        }
        let existing = self.state.lock().unwrap().connections.get(worker).cloned();
        let matches = existing
            .as_ref()
            .is_some_and(|c| c.owner == owner && c.continuity == peer.continuity);
        if let Some(existing) = &existing
            && matches
        {
            let retained = self
                .coordinator
                .refresh_worker(&worker.into(), &existing.id.clone().into())
                .await?;
            if !self.current(worker, generation)
                || !self.same_connection(worker, existing)
                || !peer.is_open()
            {
                peer.close(1012, "Worker connection was superseded");
                return Ok(false);
            }
            if retained {
                let accepted = self.local.attach(worker, peer, ready);
                if accepted {
                    self.log(
                        "info",
                        "Worker relay attachment recovered",
                        "coordination.worker.recovered",
                        "attach-worker",
                        "online",
                        json!({"workerId":worker}),
                    );
                }
                return Ok(accepted);
            }
        }
        if !peer.is_open() {
            return Ok(false);
        }
        if let Some(existing) = existing {
            self.local.disconnect(
                worker,
                if matches {
                    "Worker relay claim was lost"
                } else if existing.owner == owner {
                    "Worker continuity identity changed"
                } else {
                    "Worker owner changed"
                },
                if matches { 1012 } else { 1008 },
            );
        }
        let id = Uuid::new_v4().to_string();
        let mut claim = json!({"connectionId":id,"ownerId":owner,"workerId":worker});
        if let Some(c) = &peer.continuity {
            claim["continuityIdentity"] = json!({"ownerId":c.owner,"credentialId":c.credential,"workerProcessGeneration":c.process_generation});
        }
        let previous = self.coordinator.claim_worker(claim).await?;
        if !self.current(worker, generation) || !peer.is_open() {
            self.discard(worker, &id, &peer).await;
            return Ok(false);
        }
        if let Some(previous) = &previous
            && (previous["instanceId"] != self.coordinator.instance_id()
                || previous["connectionId"] != id.as_str())
        {
            self.coordinator.publish(json!({"kind":"worker-disconnect","targetInstanceId":previous["instanceId"],"workerId":worker,
                "connectionId":previous["connectionId"],"code":1012,"reason":"Worker connected to another server instance"}),None).await?;
            if !self.current(worker, generation) || !peer.is_open() {
                self.discard(worker, &id, &peer).await;
                return Ok(false);
            }
        }
        if !peer.is_open() {
            self.discard(worker, &id, &peer).await;
            return Ok(false);
        }
        let connection = Arc::new(Connection {
            id: id.clone(),
            owner: owner.clone(),
            continuity: peer.continuity.clone(),
            subscriptions: Mutex::new(None),
        });
        {
            let mut s = self.state.lock().unwrap();
            s.connections.insert(worker.into(), connection.clone());
            s.known.shift_remove(worker);
        }
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let disconnect = self.local.subscribe_worker_disconnect(
            worker,
            Arc::new(move || {
                if let Some(b) = weak.upgrade()
                    && b.connection_id(&w).as_deref() == Some(&cid)
                {
                    b.disconnected.deliver(&w);
                }
            }),
        );
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let offline = self.local.subscribe_worker_offline(
            worker,
            Arc::new(move || {
                if let Some(b) = weak.upgrade() {
                    let w = w.clone();
                    let cid = cid.clone();
                    run(async move {
                        b.local_offline(&w, &cid).await;
                    });
                }
            }),
        );
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let owner_link = owner.clone();
        let link = self.local.subscribe_worker_link_frames(
            worker,
            Arc::new(move |frame| {
                let Some(b) = weak
                    .upgrade()
                    .filter(|b| b.connection_id(&w).as_deref() == Some(&cid))
                else {
                    return Ok(());
                };
                b.link.deliver(&w, (*frame).clone())?;
                b.publish_frame(
                    "from-worker",
                    "worker-link",
                    FrameRoute {
                        owner: &owner_link,
                        worker: &w,
                    },
                    frame.header().clone(),
                    frame.payload(),
                    None,
                );
                Ok(())
            }),
        );
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let owner_tunnel = owner.clone();
        let tunnel = self.local.subscribe_tunnel_frames(
            worker,
            Arc::new(move |frame| {
                let Some(b) = weak
                    .upgrade()
                    .filter(|b| b.connection_id(&w).as_deref() == Some(&cid))
                else {
                    return Ok(());
                };
                b.dispatch_frame("tunnel", &w, frame.header().clone(), frame.payload())?;
                b.publish_frame(
                    "from-worker",
                    "tunnel",
                    FrameRoute {
                        owner: &owner_tunnel,
                        worker: &w,
                    },
                    frame.header().clone(),
                    frame.payload(),
                    None,
                );
                Ok(())
            }),
        );
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let owner_surface = owner.clone();
        let surface = self.local.subscribe_surface_frames(
            worker,
            Arc::new(move |frame| {
                let Some(b) = weak
                    .upgrade()
                    .filter(|b| b.connection_id(&w).as_deref() == Some(&cid))
                else {
                    return Ok(());
                };
                b.dispatch_frame("surface", &w, frame.header().clone(), frame.payload())?;
                b.publish_frame(
                    "from-worker",
                    "surface",
                    FrameRoute {
                        owner: &owner_surface,
                        worker: &w,
                    },
                    frame.header().clone(),
                    frame.payload(),
                    None,
                );
                Ok(())
            }),
        );
        let weak = Arc::downgrade(self);
        let w = worker.to_owned();
        let cid = id.clone();
        let owner_notification = owner.clone();
        let notification=self.local.subscribe_notifications(worker,Arc::new(move|value|{
            if let Some(b)=weak.upgrade().filter(|b|b.connection_id(&w).as_deref()==Some(&cid)){
                b.dispatch_notification(&w,&owner_notification,(*value).clone());
                    b.publish_bounded(json!({"kind":"worker-notification","connectionId":cid,"ownerId":owner_notification,"workerId":w,"notification":value.as_ref()}));
            }
            Box::pin(async{Ok(())})
        }));
        *connection.subscriptions.lock().unwrap() = Some(Subscriptions {
            _disconnect: disconnect,
            _offline: offline,
            _link: link,
            _tunnel: tunnel,
            _surface: surface,
            _notification: notification,
        });
        if !self.local.attach(worker, peer.clone(), ready) {
            if self.same_connection(worker, &connection) {
                self.state.lock().unwrap().connections.shift_remove(worker);
                connection.subscriptions.lock().unwrap().take();
            }
            self.discard(worker, &id, &peer).await;
            return Ok(false);
        }
        self.reject_remote(worker, Some(&id));
        self.log(
            "info",
            "Worker attached to relay instance",
            "coordination.worker.attached",
            "attach-worker",
            "online",
            json!({"workerId":worker,"replacedRemoteClaim":previous.is_some()}),
        );
        Ok(true)
    }
    pub(super) fn connection_id(&self, worker: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .connections
            .get(worker)
            .map(|c| c.id.clone())
    }
    async fn discard(&self, worker: &str, id: &str, peer: &Peer) {
        let _ = self
            .coordinator
            .release_worker(&worker.into(), &id.into())
            .await;
        peer.close(1012, "Worker connection was superseded");
    }
    async fn local_offline(self: Arc<Self>, worker: &str, id: &str) {
        let c = {
            let mut s = self.state.lock().unwrap();
            if s.connections.get(worker).is_none_or(|c| c.id != id) {
                return;
            }
            s.connections.shift_remove(worker).unwrap()
        };
        c.subscriptions.lock().unwrap().take();
        self.dispatch_offline(worker);
        if self
            .coordinator
            .release_worker(&worker.into(), &id.into())
            .await
            .is_err()
        {
            self.repeat(format!("coordination-worker-release-failed:{worker}"),"warn","Worker relay ownership could not be released",
            json!({"event":"coordination.worker.release-failed","subsystem":"relay-coordination","operation":"release-worker","reasonCode":"coordination-unavailable","status":"degraded","workerId":worker}));
        }
    }
    pub fn disconnect(self: &Arc<Self>, worker: &str, reason: Option<String>, code: Option<u16>) {
        let generation = Uuid::new_v4();
        self.state
            .lock()
            .unwrap()
            .attachments
            .insert(worker.into(), generation);
        if self.state.lock().unwrap().connections.contains_key(worker) {
            self.local.disconnect(
                worker,
                reason.as_deref().unwrap_or("Worker credential was revoked"),
                code.unwrap_or(1008),
            );
            return;
        }
        if let Some(p) = self.coordinator.cached_worker(&worker.into()) {
            self.remote_disconnect(worker, &p, reason, code);
            return;
        }
        let b = self.clone();
        let w = worker.to_owned();
        run(async move {
            if let Ok(Some(p)) = b.coordinator.find_worker(&w.clone().into()).await
                && b.current(&w, generation)
            {
                b.remote_disconnect(&w, &p, reason, code);
            }
        });
    }
    fn remote_disconnect(
        self: &Arc<Self>,
        worker: &str,
        p: &Value,
        reason: Option<String>,
        code: Option<u16>,
    ) {
        if let Some(id) = text(&p["connectionId"]) {
            self.state.lock().unwrap().known.insert(worker.into(), id);
        }
        self.publish_bounded(json!({"kind":"worker-disconnect","targetInstanceId":p["instanceId"],"workerId":worker,"connectionId":p["connectionId"],"code":code.unwrap_or(1008),"reason":reason.unwrap_or_else(||"Worker credential was revoked".into())}));
    }
    pub(super) async fn refresh_presence(self: &Arc<Self>) {
        let connections = self
            .state
            .lock()
            .unwrap()
            .connections
            .iter()
            .map(|(w, c)| (w.clone(), c.clone()))
            .collect::<Vec<_>>();
        for (w, c) in connections {
            let Ok(retained) = self
                .coordinator
                .refresh_worker(&w.clone().into(), &c.id.clone().into())
                .await
            else {
                continue;
            };
            if !retained && self.connection_id(&w).as_deref() == Some(&c.id) {
                self.log(
                    "warn",
                    "Worker relay claim was lost",
                    "coordination.worker.claim-lost",
                    "refresh-worker",
                    "reconnecting",
                    json!({"reasonCode":"claim-replaced","workerId":w}),
                );
                self.local.disconnect(
                    &w,
                    "Worker connection was claimed by another server instance",
                    1012,
                );
            }
        }
        let mut observed = self
            .state
            .lock()
            .unwrap()
            .known
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        observed.extend(self.surface.workers());
        observed.extend(self.tunnel.workers());
        observed.extend(self.notifications.workers());
        observed.extend(self.disconnected.workers());
        observed.extend(self.offline.workers());
        for w in observed {
            let (known, pending) = {
                let s = self.state.lock().unwrap();
                if s.connections.contains_key(&w) {
                    continue;
                }
                (
                    s.known.get(&w).cloned(),
                    s.pending.values().any(|p| p.worker == w),
                )
            };
            let worker = w.clone().into();
            let presence = if pending {
                self.coordinator.lookup_worker_claim(&worker).await
            } else {
                self.coordinator.find_worker(&worker).await
            };
            let Ok(presence) = presence else {
                continue;
            };
            {
                let s = self.state.lock().unwrap();
                if s.connections.contains_key(&w) || s.known.get(&w) != known.as_ref() {
                    continue;
                }
            }
            if let Some(p) = presence {
                self.reject_remote(&w, p["connectionId"].as_str());
                if let Some(id) = text(&p["connectionId"]) {
                    self.state.lock().unwrap().known.insert(w, id);
                }
            } else {
                let removed = self.state.lock().unwrap().known.shift_remove(&w).is_some();
                if removed {
                    self.disconnected.deliver(&w);
                    self.dispatch_offline(&w);
                }
            }
        }
    }
}
