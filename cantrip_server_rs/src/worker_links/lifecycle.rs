use super::*;

pub enum Scope {
    Owner(Value),
    AccountSession(Value),
    Resource(Box<ResourceScope>),
}
pub struct ResourceScope {
    pub owner: Value,
    pub kind: Value,
    pub resource: Value,
    pub attachment: Option<Value>,
}
struct Fence {
    service: Arc<Coordinator>,
    scope: Scope,
}
impl Drop for Fence {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        fn release<K: Eq + std::hash::Hash>(map: &mut HashMap<K, usize>, key: &K) {
            if let Some(count) = map.get_mut(key) {
                *count -= 1;
                if *count == 0 {
                    map.remove(key);
                }
            }
        }
        match &self.scope {
            Scope::Owner(owner) => release(&mut state.owner_fences, owner.as_js_string().unwrap()),
            Scope::AccountSession(account) => {
                release(&mut state.account_fences, account.as_js_string().unwrap())
            }
            Scope::Resource(scope) => release(
                &mut state.resource_fences,
                &resource_key(&scope.owner, &scope.kind, &scope.resource),
            ),
        }
    }
}
impl Coordinator {
    fn fence(self: &Arc<Self>, scope: Scope) -> Fence {
        let mut state = self.state.lock().unwrap();
        let count = match &scope {
            Scope::Owner(owner) => state
                .owner_fences
                .entry(owner.as_js_string().unwrap().clone())
                .or_default(),
            Scope::AccountSession(account) => state
                .account_fences
                .entry(account.as_js_string().unwrap().clone())
                .or_default(),
            Scope::Resource(scope) => state
                .resource_fences
                .entry(resource_key(&scope.owner, &scope.kind, &scope.resource))
                .or_default(),
        };
        *count += 1;
        Fence {
            service: self.clone(),
            scope,
        }
    }
    pub(super) fn remove_session(&self, id: &str, expected: &Session) {
        let mut state = self.state.lock().unwrap();
        if !state
            .sessions
            .get(id)
            .is_some_and(|s| Arc::ptr_eq(s, expected))
        {
            return;
        }
        state.sessions.shift_remove(id);
        let mut session = expected.lock().unwrap();
        let key = identity_key(&session.session["identity"]);
        if state.identities.get(&key).is_some_and(|s| s == id) {
            state.identities.remove(&key);
        }
        session.grants.clear();
        session.peers.clear();
        let worker = session.session["identity"]["workerId"].clone();
        drop(session);
        if !state
            .sessions
            .values()
            .any(|s| s.lock().unwrap().session["identity"]["workerId"] == worker)
            && let Some(worker) = worker.as_str()
        {
            state.native_workers.remove(worker);
        }
    }
    pub async fn revoke_session(self: &Arc<Self>, id: &str, reason: &str) -> bool {
        let state = self.state.lock().unwrap().sessions.get(id).cloned();
        let Some(state) = state else { return false };
        let session = state.lock().unwrap().session.clone();
        self.remove_session(id, &state);
        self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.session.revoke","sessionId":id,"revocation":revocation(reason,self.now())}),session["identity"]["ownerId"].clone()).await;
        true
    }
    pub(super) async fn revoke_sessions_where(
        self: &Arc<Self>,
        predicate: impl Fn(&Value) -> bool,
        reason: &str,
    ) -> usize {
        let ids = self
            .state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter_map(|(id, s)| predicate(&s.lock().unwrap().session).then_some(id.clone()))
            .collect::<Vec<_>>();
        futures::future::join_all(ids.iter().map(|id| self.revoke_session(id, reason)))
            .await
            .into_iter()
            .filter(|v| *v)
            .count()
    }
    pub async fn revoke_scope(self: &Arc<Self>, scope: Scope, reason: &str) -> usize {
        let fence = self.fence(scope);
        match &fence.scope {
            Scope::Owner(owner) => {
                self.revoke_sessions_where(
                    |s| s["identity"]["ownerId"] == *owner,
                    "account-session-ended",
                )
                .await
            }
            Scope::AccountSession(account) => {
                self.revoke_sessions_where(
                    |s| s["identity"]["accountSessionId"] == *account,
                    "account-session-ended",
                )
                .await
            }
            Scope::Resource(scope) => {
                let ResourceScope {
                    owner,
                    kind,
                    resource,
                    attachment,
                } = scope.as_ref();
                let mut matches = Vec::new();
                {
                    let state = self.state.lock().unwrap();
                    for (session_id, current) in &state.sessions {
                        let current = current.lock().unwrap();
                        if current.session["identity"]["ownerId"] != *owner {
                            continue;
                        }
                        for (grant_id, grant) in &current.grants {
                            let grant = grant.lock().unwrap();
                            let bound = &grant["binding"]["resource"];
                            if bound["kind"] == *kind
                                && bound["resourceId"] == *resource
                                && attachment
                                    .as_ref()
                                    .is_none_or(|a| bound["attachmentId"] == *a)
                            {
                                matches.push((session_id.clone(), grant_id.clone()));
                            }
                        }
                    }
                }
                futures::future::join_all(
                    matches.iter().map(|(s, g)| self.revoke_grant(s, g, reason)),
                )
                .await
                .into_iter()
                .filter(|v| *v)
                .count()
            }
        }
    }
    pub async fn revoke_worker(
        self: &Arc<Self>,
        worker: &Value,
        generation: Option<&Value>,
        reason: &str,
    ) -> usize {
        self.revoke_sessions_where(
            |s| {
                s["identity"]["workerId"] == *worker
                    && generation.is_none_or(|g| s["identity"]["workerProcessGeneration"] == *g)
            },
            reason,
        )
        .await
    }
    pub async fn sweep_expired(self: &Arc<Self>) -> usize {
        let now = self.now() as f64;
        let mut sessions = vec![];
        let mut grants = vec![];
        let mut peers = vec![];
        {
            let state = self.state.lock().unwrap();
            for (session_id, current) in &state.sessions {
                let current = current.lock().unwrap();
                if date(&current.session["lease"]["expiresAt"]) <= now {
                    sessions.push(session_id.clone());
                    continue;
                }
                for (id, grant) in &current.grants {
                    if date(&grant.lock().unwrap()["binding"]["lease"]["expiresAt"]) <= now {
                        grants.push((session_id.clone(), id.clone()));
                    }
                }
                for (id, peer) in &current.peers {
                    if date(&peer.lock().unwrap().peer["lease"]["expiresAt"]) <= now {
                        peers.push((session_id.clone(), id.clone()));
                    }
                }
            }
        }
        let mut count = 0;
        for (session, peer) in peers {
            count += usize::from(self.revoke_peer(&session, &peer, "lease-expired").await);
        }
        for (session, grant) in grants {
            count += usize::from(self.revoke_grant(&session, &grant, "lease-expired").await);
        }
        for session in sessions {
            count += usize::from(self.revoke_session(&session, "lease-expired").await);
        }
        count
    }
    pub async fn close(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            state.stopping = true;
            if let Some(sweeper) = state.sweeper.take() {
                sweeper.abort();
            }
        }
        self.revoke_sessions_where(|_| true, "server-shutdown")
            .await;
        self.state.lock().unwrap().native_workers.clear();
    }
}

pub use Scope as RevocationScope;
