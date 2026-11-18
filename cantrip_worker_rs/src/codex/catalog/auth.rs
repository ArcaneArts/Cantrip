use super::*;
use crate::{
    codex::{managed::ExternalAuth, provider_errors, session::Session},
    inference::admission::Promise,
};
use cantrip_transport::lifecycle::owned;

#[derive(Clone)]
struct SignedIn {
    revision: u64,
    upstream: JsString,
}

#[derive(Default)]
struct State {
    signed_in: Option<SignedIn>,
    reauthentication: Option<Promise<()>>,
}

#[derive(Clone)]
pub(super) struct Auth {
    account: Account,
    access: Access,
    state: Arc<Mutex<State>>,
}

impl Auth {
    pub fn new(account: Account, access: Access) -> Self {
        Self {
            account,
            access,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    fn signed_in(&self) -> Option<SignedIn> {
        self.state.lock().unwrap().signed_in.clone()
    }

    fn check(&self, lease: &Lease) -> Result<()> {
        let value = lease.value();
        if value["providerKind"] != "chatgpt"
            || value["providerIdentity"]["kind"] != "chatgpt"
            || value["providerId"].as_js_string() != Some(&self.account.provider)
            || value["providerAccountId"].as_js_string() != Some(&self.account.id)
        {
            bail!("Server returned a mismatched ChatGPT access lease.");
        }
        Ok(())
    }

    async fn next(&self, session: &SignedIn, previous: Option<&JsString>) -> Result<Lease> {
        let lease = self
            .access
            .force(self.account.clone(), session.revision)
            .await?;
        self.check(&lease)?;
        if lease.revision() <= session.revision
            || lease.value()["providerIdentity"]["accountId"].as_js_string()
                != Some(&session.upstream)
            || previous.is_some_and(|previous| previous != &session.upstream)
            || self
                .signed_in()
                .is_none_or(|current| current.revision > lease.revision())
        {
            bail!("Refreshed ChatGPT access lease changed account identity.");
        }
        Ok(lease)
    }

    fn advance(&self, revision: u64) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let session = state
            .signed_in
            .as_mut()
            .ok_or_else(|| anyhow!("Portable ChatGPT authentication is not active."))?;
        if session.revision > revision {
            bail!("Refreshed ChatGPT access lease was superseded.");
        }
        session.revision = revision;
        Ok(())
    }

    async fn perform_reauthentication(&self, session: Session) -> Result<()> {
        let current = self.signed_in().ok_or_else(reauth_required)?;
        let lease = self
            .next(&current, Some(&current.upstream))
            .await
            .map_err(|error| {
                if request_error(&error).is_some_and(|error| error.code == Some("reauth-required"))
                {
                    return reauth_required();
                }
                if request_error(&error).is_some() {
                    return anyhow!("Cantrip could not refresh ChatGPT authentication. Try again.");
                }
                error
            })?;
        session.remember_secret(lease.value()["accessToken"].as_js_string().unwrap().clone());
        let result = session
            .request(
                "account/login/start".into(),
                Some(login(&lease)),
                Some(RPC_TIMEOUT),
                None,
            )
            .await
            .map_err(|error| {
                if expired(&error) {
                    reauth_required()
                } else {
                    anyhow!("Codex could not accept refreshed ChatGPT authentication.")
                }
            })?;
        if !result.is_some_and(|result| result["type"] == "chatgptAuthTokens") {
            bail!("Codex rejected refreshed ChatGPT authentication.");
        }
        self.advance(lease.revision())
    }
}

impl ExternalAuth for Auth {
    fn login(&self) -> Work<Option<Value>> {
        let this = self.clone();
        owned(async move {
            let lease = match this.access.get(this.account.clone()).await {
                Ok(lease) => lease,
                Err(error) if request_error(&error).is_some_and(RequestError::legacy_fallback) => {
                    return Ok(None);
                }
                Err(error) if request_error(&error).is_some() => return Err(error),
                Err(_) => {
                    bail!("Portable ChatGPT authentication could not obtain an access lease.")
                }
            };
            this.check(&lease)?;
            let upstream = lease.value()["providerIdentity"]["accountId"]
                .as_js_string()
                .unwrap()
                .clone();
            this.state.lock().unwrap().signed_in = Some(SignedIn {
                revision: lease.revision(),
                upstream,
            });
            Ok(Some(login(&lease)))
        })
    }

    fn refresh(&self, params: Value) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let session = this
                .signed_in()
                .ok_or_else(|| anyhow!("Portable ChatGPT authentication is not active."))?;
            if !params.is_object()
                || params["reason"] != "unauthorized"
                || !(params["previousAccountId"].is_null()
                    || params["previousAccountId"].is_string())
            {
                bail!("Codex sent an invalid ChatGPT refresh request.");
            }
            let lease = this
                .next(&session, params["previousAccountId"].as_js_string())
                .await
                .map_err(|error| {
                    if request_error(&error).is_some() {
                        anyhow!("Cantrip could not refresh the ChatGPT access lease.")
                    } else {
                        error
                    }
                })?;
            this.advance(lease.revision())?;
            Ok(refresh_payload(&lease))
        })
    }

    fn reauthenticate(&self, session: Session) -> Work<()> {
        let (complete, pending) = {
            let mut state = self.state.lock().unwrap();
            if let Some(existing) = &state.reauthentication {
                return existing.work();
            }
            let (complete, pending) = Promise::pair();
            state.reauthentication = Some(pending.clone());
            (complete, pending)
        };
        let this = self.clone();
        let handle = pending.clone();
        tokio::spawn(async move {
            let result = this.perform_reauthentication(session).await;
            let mut state = this.state.lock().unwrap();
            if state
                .reauthentication
                .as_ref()
                .is_some_and(|p| p.same(&handle))
            {
                state.reauthentication = None;
            }
            complete.finish(result);
        });
        pending.work()
    }
}

fn refresh_payload(lease: &Lease) -> Value {
    let value = lease.value();
    json!({"accessToken":value["accessToken"], "chatgptAccountId":value["providerIdentity"]["accountId"], "chatgptPlanType":value["planType"]})
}

fn login(lease: &Lease) -> Value {
    let mut value = refresh_payload(lease);
    value["type"] = json!("chatgptAuthTokens");
    value
}

pub(super) fn expired(error: &anyhow::Error) -> bool {
    provider_errors::token_expired(&crate::error::message(error))
}

pub(super) fn reauth_required() -> anyhow::Error {
    anyhow!("ChatGPT authentication expired. Sign in again to reconnect this provider account.")
}

fn request_error(error: &anyhow::Error) -> Option<&RequestError> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<RequestError>())
}
