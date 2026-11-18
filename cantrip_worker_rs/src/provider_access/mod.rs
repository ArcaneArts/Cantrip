//! Opens the server's scoped credentials in the authorized worker. Only a
//! newly sealed replacement can be sent back to the durable credential route.
mod refresh;
pub(crate) use refresh::claims as jwt_claims;

use crate::{
    config::Config,
    encryption::Service,
    http::checked,
    inference::admission::Promise,
    protected_secrets::{open_provider_credential, protect_provider_credential},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(9);
const MAX_BYTES: usize = 2 * 1024 * 1024;
const LEASE: i64 = 5 * 60_000;
const EXPIRY_BUFFER: i64 = 30_000;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Account {
    pub provider: JsString,
    pub id: JsString,
}

#[derive(Clone)]
pub struct Lease(Value);
impl Lease {
    pub fn value(&self) -> &Value {
        &self.0
    }

    pub fn revision(&self) -> u64 {
        self.0["credentialRevision"].as_u64().unwrap()
    }

    fn usable(&self, now: i64, minimum: u64) -> bool {
        millis(&self.0["leaseExpiresAt"]).is_some_and(|expiry| expiry > now + EXPIRY_BUFFER)
            && (self.0["expiresAt"].is_null()
                || millis(&self.0["expiresAt"])
                    .is_some_and(|expiry| expiry > now + minimum as i64 * 1000))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RequestError {
    pub status: u16,
    pub code: Option<&'static str>,
}
impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Cantrip could not obtain a provider access lease (HTTP {}",
            self.status
        )?;
        if let Some(code) = self.code {
            write!(f, ", {code}")?;
        }
        f.write_str(").")
    }
}
impl std::error::Error for RequestError {}
impl RequestError {
    pub fn legacy_fallback(&self) -> bool {
        self.status == 404
            || matches!(
                self.code,
                Some("credential-unavailable" | "migration-needed")
            )
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    binding: (JsString, String),
    account: Account,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct FlightKey {
    key: Key,
    force: Option<u64>,
}

#[derive(Default)]
struct State {
    closed: bool,
    leases: HashMap<Key, Lease>,
    pending: HashMap<FlightKey, Promise<Lease>>,
    paused: HashMap<Account, usize>,
}

struct Inner {
    configuration: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    client: reqwest::Client,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Access(Arc<Inner>);

pub(crate) struct Pause {
    access: Access,
    account: Account,
    pending: Vec<Promise<Lease>>,
}

impl Pause {
    pub(crate) async fn drain(&self) {
        futures::future::join_all(self.pending.iter().map(Promise::work)).await;
    }
}

impl Drop for Pause {
    fn drop(&mut self) {
        let mut state = self.access.0.state.lock().unwrap();
        let count = state.paused.get_mut(&self.account).unwrap();
        *count -= 1;
        if *count == 0 {
            state.paused.remove(&self.account);
        }
    }
}

impl Access {
    pub fn new(
        configuration: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        client: reqwest::Client,
    ) -> Self {
        Self(Arc::new(Inner {
            configuration,
            encryption,
            client,
            state: Mutex::new(State::default()),
        }))
    }

    pub fn get(&self, account: Account) -> Work<Lease> {
        self.read(account, None)
    }
    pub fn force(&self, account: Account, revision: u64) -> Work<Lease> {
        self.read(account, Some(revision))
    }

    fn binding(&self) -> Result<(JsString, String)> {
        let (owner, server) = self.0.encryption.bound_identity()?;
        Ok((owner, server.stringify()))
    }

    fn read(&self, account: Account, force: Option<u64>) -> Work<Lease> {
        let this = self.clone();
        owned(async move {
            let key = Key {
                binding: this.binding()?,
                account,
            };
            let minimum = 120;
            let flight = FlightKey {
                key: key.clone(),
                force,
            };
            let (start, pending) = {
                let mut state = this.0.state.lock().unwrap();
                if state.closed || state.paused.contains_key(&key.account) {
                    return Err(invalidated());
                }
                if force.is_none()
                    && let Some(cached) = state
                        .leases
                        .get(&key)
                        .filter(|lease| lease.usable(now(), minimum))
                {
                    return Ok(cached.clone());
                }
                if let Some(pending) = state.pending.get(&flight) {
                    (None, pending.clone())
                } else {
                    let (complete, pending) = Promise::pair();
                    state.pending.insert(flight.clone(), pending.clone());
                    (Some(complete), pending)
                }
            };
            if let Some(complete) = start {
                let mut result = this.fetch(&key, force, minimum).await;
                let current_binding = this.binding();
                {
                    let mut state = this.0.state.lock().unwrap();
                    let current = state.pending.get(&flight).is_some_and(|p| p.same(&pending));
                    if state.closed
                        || state.paused.contains_key(&key.account)
                        || !current
                        || current_binding.as_ref().ok() != Some(&key.binding)
                    {
                        result = Err(invalidated());
                    }
                    if current {
                        state.pending.remove(&flight);
                    }
                    if let Ok(lease) = &result
                        && state
                            .leases
                            .get(&key)
                            .is_none_or(|old| lease.revision() >= old.revision())
                    {
                        state.leases.insert(key, lease.clone());
                    }
                    complete.finish(result);
                }
            }
            pending.work().await
        })
    }

    async fn fetch(&self, key: &Key, force: Option<u64>, minimum: u64) -> Result<Lease> {
        let account = &key.account;
        let url = self.endpoint(account)?;
        let mut record = self.load(account, url.clone(), None).await?;
        let mut credential = self.open(key, &record)?;
        if force.is_some() || !fresh(&credential, minimum) {
            self.assert_scope(key)?;
            credential = refresh::refresh(&self.0.client, &credential).await?;
            self.assert_scope(key)?;
            let mut replacement =
                protect_provider_credential(&self.0.encryption, &json!(account.id), &credential)?;
            replacement["expectedRevision"] = record["credentialRevision"].clone();
            let replacement = checked("providerCredentialUploadSchema", &replacement)?;
            self.assert_scope(key)?;
            let response = self
                .request(reqwest::Method::PUT, url.clone())
                .header("content-type", "application/json")
                .body(replacement.stringify())
                .send()
                .await
                .map_err(|_| {
                    anyhow!("Cantrip could not upload a refreshed provider credential.")
                })?;
            self.assert_scope(key)?;
            if response.status().as_u16() == 409 {
                let stale = record["credentialRevision"].as_u64().unwrap();
                record = self.load(account, url, Some("refresh-failed")).await?;
                if record["credentialRevision"].as_u64().unwrap() <= stale {
                    return Err(lease_error(409, Some("refresh-failed")));
                }
                credential = self.open(key, &record)?;
                if !fresh(&credential, minimum) {
                    return Err(lease_error(409, Some("refresh-failed")));
                }
            } else if !response.status().is_success() {
                return Err(lease_error(response.status().as_u16(), None));
            } else {
                record = Self::record(account, json_body(response).await?)?;
            }
        }
        self.assert_scope(key)?;
        let observed = now();
        let expires = credential["expiresAt"]
            .as_f64()
            .filter(|time| *time != 0.0)
            .map(|expiry| iso(expiry as i64))
            .transpose()?;
        let mut identity = json!({"kind":credential["kind"],"userId":credential["userId"]});
        if credential["kind"] == "chatgpt" {
            identity["accountId"] = credential["accountId"].clone();
        }
        let lease = checked(
            "workerPortableProviderLeaseSchema",
            &json!({
                "accessToken":credential["accessToken"], "credentialRevision":record["credentialRevision"],
                "expiresAt":expires, "email":credential["email"], "issuedAt":iso(observed)?,
                "leaseExpiresAt":iso(observed + LEASE)?, "planType":credential["planType"],
                "providerAccountId":account.id, "providerId":account.provider, "providerIdentity":identity,
                "providerKind":credential["kind"]
            }),
        )?;
        Ok(Lease(lease))
    }

    fn open(&self, key: &Key, record: &Value) -> Result<Value> {
        self.assert_scope(key)?;
        let credential = open_provider_credential(
            &self.0.encryption,
            &json!(key.account.id),
            &record["credential"],
        )?;
        if credential["kind"] != record["providerKind"] {
            return Err(lease_error(409, Some("identity-conflict")));
        }
        Ok(credential)
    }

    fn assert_scope(&self, key: &Key) -> Result<()> {
        let binding = self.binding()?;
        let state = self.0.state.lock().unwrap();
        if binding != key.binding || state.closed || state.paused.contains_key(&key.account) {
            return Err(invalidated());
        }
        Ok(())
    }

    /// Evict account leases immediately, fence new reads and join reads
    /// accepted before the mutation. Even a delayed HTTP 404 cannot restart
    /// legacy authentication once retirement begins.
    pub(crate) fn pause(&self, account: Account) -> Pause {
        let pending = {
            let mut state = self.0.state.lock().unwrap();
            *state.paused.entry(account.clone()).or_default() += 1;
            state.leases.retain(|key, _| key.account != account);
            state
                .pending
                .iter()
                .filter(|(key, _)| key.key.account == account)
                .map(|(_, work)| work.clone())
                .collect::<Vec<_>>()
        };
        Pause {
            access: self.clone(),
            account,
            pending,
        }
    }

    fn record(account: &Account, raw: Value) -> Result<Value> {
        let record = checked("providerCredentialWireRecordSchema", &raw)?;
        if record["accountId"].as_js_string() != Some(&account.id)
            || record["providerId"].as_js_string() != Some(&account.provider)
        {
            return Err(lease_error(409, Some("identity-conflict")));
        }
        Ok(record)
    }

    async fn load(
        &self,
        account: &Account,
        url: url::Url,
        code: Option<&'static str>,
    ) -> Result<Value> {
        let response = self
            .request(reqwest::Method::GET, url)
            .send()
            .await
            .map_err(|_| anyhow!("Cantrip could not read the protected provider credential."))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let code = if code.is_some() {
                code
            } else {
                json_body(response)
                    .await
                    .ok()
                    .as_ref()
                    .and_then(|body| error_code(&body["code"]))
            };
            return Err(lease_error(status, code));
        }
        Self::record(account, json_body(response).await?)
    }

    fn endpoint(&self, account: &Account) -> Result<url::Url> {
        let config = self.0.configuration.lock().unwrap();
        let mut url =
            url::Url::parse(&config.server_url)?.join("/api/internal/workers/providers/")?;
        let provider = account
            .provider
            .as_str()
            .ok_or_else(|| anyhow!("Invalid provider identity."))?;
        let id = account
            .id
            .as_str()
            .ok_or_else(|| anyhow!("Invalid provider account identity."))?;
        url.path_segments_mut()
            .map_err(|_| anyhow!("Invalid worker server URL."))?
            .pop_if_empty()
            .extend([provider, "accounts", id, "credential"]);
        url.query_pairs_mut()
            .append_pair("workerId", &config.worker_id.lossy());
        Ok(url)
    }

    fn request(&self, method: reqwest::Method, url: url::Url) -> reqwest::RequestBuilder {
        let token = self.0.configuration.lock().unwrap().token.clone();
        self.0
            .client
            .request(method, url)
            .bearer_auth(token)
            .timeout(TIMEOUT)
    }

    pub fn close(&self) -> Work<()> {
        let pending = {
            let mut state = self.0.state.lock().unwrap();
            state.closed = true;
            state.leases.clear();
            state.pending.values().cloned().collect::<Vec<_>>()
        };
        Box::pin(async move {
            futures::future::join_all(pending.iter().map(Promise::work)).await;
            Ok(())
        })
    }
}

pub(super) async fn json_body(mut response: reqwest::Response) -> Result<Value> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("Could not read provider credential data."))?
    {
        if body.len() + chunk.len() > MAX_BYTES {
            bail!("Provider credential response is too large.");
        }
        body.extend_from_slice(&chunk);
    }
    parse_json_text(&String::from_utf8_lossy(&body))
        .map_err(|_| anyhow!("Provider credential response is malformed."))
}
fn error_code(raw: &Value) -> Option<&'static str> {
    Some(match raw.as_str()? {
        "credential-unavailable" => "credential-unavailable",
        "migration-needed" => "migration-needed",
        "reauth-required" => "reauth-required",
        "identity-conflict" => "identity-conflict",
        "refresh-unavailable" => "refresh-unavailable",
        "refresh-failed" => "refresh-failed",
        "refresh-timeout" => "refresh-timeout",
        _ => return None,
    })
}
fn lease_error(status: u16, code: Option<&'static str>) -> anyhow::Error {
    RequestError { status, code }.into()
}
fn invalidated() -> anyhow::Error {
    anyhow!("The provider account access lease was invalidated.")
}
fn fresh(credential: &Value, minimum: u64) -> bool {
    credential["expiresAt"]
        .as_f64()
        .is_none_or(|expiry| expiry > (now() + minimum as i64 * 1000) as f64)
}
fn millis(value: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|v| v.timestamp_millis())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn iso(time: i64) -> Result<String> {
    cantrip_wire::date::iso_milliseconds(time).ok_or_else(|| anyhow!("Invalid time value"))
}
fn nonempty(value: &Value) -> Option<&JsString> {
    value.as_js_string().filter(|string| !string.is_empty())
}
