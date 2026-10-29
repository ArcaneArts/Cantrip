use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

struct Prepared {
    state: Session,
    session: Value,
    key: Vec<u16>,
    binding: Value,
    token: String,
    grant: Grant,
}
impl Coordinator {
    pub async fn issue_grant(self: &Arc<Self>, input: Value) -> Result<Value> {
        self.assert_open()?;
        self.sweep_expired().await;
        let Prepared {
            state,
            session,
            key,
            binding,
            token,
            grant,
        } = self.prepare_grant(&input)?;
        let session_id = id(&session, "sessionId");
        let grant_id = id(&binding, "grantId");
        let installed = grant.lock().unwrap().clone();
        if let Err(error)=self.request(session["identity"]["workerId"].clone(),json!({"type":"worker-link.grant.install","sessionId":session_id,"grant":installed}),None).await{
            let mut state=state.lock().unwrap();if state.grants.get(&grant_id).is_some_and(|g|Arc::ptr_eq(g,&grant)){state.grants.shift_remove(&grant_id);}return Err(error)
        }
        let accepted = self
            .with_current(&session_id, &state, |root, current| {
                current
                    .grants
                    .get(&grant_id)
                    .is_some_and(|g| Arc::ptr_eq(g, &grant))
                    && !root.resource_fences.contains_key(&key)
            })
            .unwrap_or(false);
        if !accepted {
            self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.grant.revoke","sessionId":session_id,"grantId":grant_id,"grantGeneration":binding["grantGeneration"],"revocation":revocation("released",self.now())}),session["identity"]["ownerId"].clone()).await;
            return Err(unavailable(
                "The WorkerLink grant was revoked while it was being installed.",
            ));
        }
        Ok(json!({"binding":binding,"token":token}))
    }

    fn prepare_grant(&self, input: &Value) -> Result<Prepared> {
        let session_id = id(input, "sessionId");
        let root = self.state.lock().unwrap();
        let state = ready_state(&root, &session_id)?;
        let session = state.lock().unwrap().session.clone();
        let key = resource_key(
            &session["identity"]["ownerId"],
            &input["resourceKind"],
            &input["resourceId"],
        );
        if root.resource_fences.contains_key(&key) {
            return Err(unavailable("The WorkerLink resource is being revoked."));
        }
        if state.lock().unwrap().grants.len() >= 128 {
            return Err(unavailable("The WorkerLink grant limit has been reached."));
        }
        let now = self.now() as f64;
        let requested = input
            .get("absoluteExpiresAt")
            .filter(|v| !v.is_null())
            .map_or(f64::INFINITY, date);
        if !requested.is_finite()
            && input
                .get("absoluteExpiresAt")
                .is_some_and(|v| crate::wire::coercion::truthy(Some(v)))
        {
            return Err(unavailable("The WorkerLink resource lifetime is invalid."));
        }
        let absolute = date(&session["lease"]["absoluteExpiresAt"]).min(requested);
        if absolute <= now {
            return Err(unavailable("The WorkerLink resource lifetime has expired."));
        }
        let expiry = date(&session["lease"]["expiresAt"])
            .min(absolute)
            .min(now + input["leaseMs"].as_f64().unwrap_or(60_000.0).max(1.0));
        let lease = checked(
            "workerLinkLeaseSchema",
            json!({"issuedAt":iso(now)?,"expiresAt":iso(expiry)?,"absoluteExpiresAt":iso(absolute)?}),
        )?;
        let binding = checked(
            "workerLinkGrantBindingSchema",
            json!({"grantId":uuid::Uuid::new_v4().to_string(),"grantGeneration":1,"sessionId":session_id,"identity":session["identity"],"resource":json!({"kind":input["resourceKind"],"resourceId":input["resourceId"],"attachmentId":input["attachmentId"]}),"lanes":input["lanes"],"operations":input["operations"],"maxChannels":input["maxChannels"].as_f64().unwrap_or(4.0).min(64.0),"lease":lease}),
        )?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| Error::from(anyhow::Error::new(e)))?;
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let mut installed =
            json!({"binding":binding,"tokenHash":crate::auth::crypto::hash_secret(&token)});
        if let Some(observation) = input.get("observation") {
            installed["observation"] = observation.clone()
        }
        let installed = checked("installedWorkerLinkGrantSchema", installed)?;
        let grant_id = id(&binding, "grantId");
        let grant = Arc::new(Mutex::new(installed.clone()));
        state
            .lock()
            .unwrap()
            .grants
            .insert(grant_id.clone(), grant.clone());
        Ok(Prepared {
            state,
            session,
            key,
            binding,
            token,
            grant,
        })
    }
    pub async fn renew_grant(
        self: &Arc<Self>,
        session_id: &str,
        grant_id: &str,
        duration: Option<f64>,
    ) -> Result<Value> {
        self.assert_open()?;
        self.sweep_expired().await;
        let state = self.ready(session_id)?;
        let (session, grant) = {
            let state = state.lock().unwrap();
            (
                state.session.clone(),
                state
                    .grants
                    .get(grant_id)
                    .cloned()
                    .ok_or_else(|| unavailable("The WorkerLink grant is missing."))?,
            )
        };
        let current = grant.lock().unwrap().clone();
        let renewed = lease(
            &current["binding"]["lease"],
            duration.unwrap_or(60_000.0),
            self.now(),
            date(&session["lease"]["expiresAt"]),
        )?;
        self.request(session["identity"]["workerId"].clone(),json!({"type":"worker-link.grant.renew","sessionId":session_id,"grantId":grant_id,"grantGeneration":current["binding"]["grantGeneration"],"lease":renewed}),None).await?;
        self.with_current(session_id, &state, |_, state| -> Result<()> {
            if !state
                .grants
                .get(grant_id)
                .is_some_and(|g| Arc::ptr_eq(g, &grant))
            {
                return Err(unavailable(
                    "The WorkerLink grant was revoked during renewal.",
                ));
            }
            let mut current = grant.lock().unwrap();
            let mut updated = current.clone();
            updated["binding"]["lease"] = renewed.clone();
            *current = checked("installedWorkerLinkGrantSchema", updated)?;
            Ok(())
        })
        .ok_or_else(|| unavailable("The WorkerLink grant was revoked during renewal."))??;
        Ok(renewed)
    }
    pub async fn revoke_grant(
        self: &Arc<Self>,
        session_id: &str,
        grant_id: &str,
        reason: &str,
    ) -> bool {
        let state = self.state.lock().unwrap().sessions.get(session_id).cloned();
        let Some(state) = state else { return false };
        let (session, grant) = {
            let mut state = state.lock().unwrap();
            let Some(grant) = state.grants.shift_remove(grant_id) else {
                return false;
            };
            (state.session.clone(), grant)
        };
        let generation = grant.lock().unwrap()["binding"]["grantGeneration"].clone();
        self.best_effort(session["identity"]["workerId"].clone(),json!({"type":"worker-link.grant.revoke","sessionId":session_id,"grantId":grant_id,"grantGeneration":generation,"revocation":revocation(reason,self.now())}),session["identity"]["ownerId"].clone()).await;
        true
    }
}
