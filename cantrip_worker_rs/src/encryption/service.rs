//! Shared refresh results with worker-owned jobs and explicit close/join.
use super::{
    Identity, ServiceError,
    state::{ComponentKey, State},
};
use cantrip_wire::{JsString, Value, parse_json_text};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::sync::{Arc, Mutex};
use tokio::{
    sync::{oneshot, watch},
    task::JoinSet,
};

type Reply = Result<Value, ServiceError>;
type SharedReply = Shared<BoxFuture<'static, Reply>>;
pub(super) struct Flight {
    generation: u64,
    credential: String,
    result: SharedReply,
}
#[derive(Clone)]
pub struct RequestedGrant {
    pub component: String,
    pub key_revision: u64,
}
impl RequestedGrant {
    fn present(&self, status: &Value) -> bool {
        status["state"] == "ready"
            && status["grants"].as_array().is_some_and(|grants| {
                grants.iter().any(|g| {
                    g["component"] == self.component.as_str()
                        && g["keyRevision"].as_u64() == Some(self.key_revision)
                })
            })
    }
}
/// Own one service per worker runtime; close joins all admitted refresh work.
/// A dropped result does not revoke the request or its authorization result.
pub struct Service {
    state: Arc<Mutex<State>>,
    client: reqwest::Client,
    endpoint: String,
    worker_id: JsString,
    jobs: Mutex<JoinSet<()>>,
    stop: watch::Sender<bool>,
    close_guard: tokio::sync::Mutex<()>,
}
impl Service {
    pub fn new(
        identity: Identity,
        server_url: &str,
        client: reqwest::Client,
    ) -> anyhow::Result<Arc<Self>> {
        let worker_id = identity.worker_id().clone();
        let server_url = super::identity::canonical_url(server_url, false)?;
        let (stop, _) = watch::channel(false);
        Ok(Arc::new(Self {
            state: Arc::new(Mutex::new(State::new(identity, worker_id.clone()))),
            client,
            endpoint: format!("{server_url}/api/internal/workers/encryption/bootstrap"),
            worker_id,
            jobs: Mutex::new(JoinSet::new()),
            stop,
            close_guard: tokio::sync::Mutex::new(()),
        }))
    }
    pub fn status(&self) -> Value {
        self.state.lock().unwrap().status()
    }
    pub fn registration(&self) -> Value {
        self.state.lock().unwrap().identity.registration()
    }
    pub fn owner_id(&self) -> Result<JsString, ServiceError> {
        self.state.lock().unwrap().owner_id()
    }
    pub fn server_identity(&self) -> Result<Value, ServiceError> {
        self.state.lock().unwrap().server_identity()
    }
    pub fn component_key(
        &self,
        component: &str,
        revision: Option<u64>,
    ) -> Result<ComponentKey, ServiceError> {
        self.state
            .lock()
            .unwrap()
            .component_key(component, revision)
    }
    /// Call only with authorization from the authenticated bootstrap endpoint.
    pub fn accept_bootstrap(&self, payload: &Value) -> Reply {
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err(ServiceError::stopped());
        }
        state.generation += 1;
        let generation = state.generation;
        state.accept(payload, generation)
    }
    pub fn lock(&self) {
        self.state.lock().unwrap().lock();
    }
    pub fn refresh(
        self: &Arc<Self>,
        credential: String,
        requested: Option<RequestedGrant>,
    ) -> BoxFuture<'static, Reply> {
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return futures::future::ready(Err(ServiceError::stopped())).boxed();
        }
        if let Some(existing) = &state.flight
            && existing.generation == state.generation
            && existing.credential == credential
        {
            let result = existing.result.clone();
            let generation = existing.generation;
            let Some(requested) = requested else {
                return result.boxed();
            };
            let service = self.clone();
            return self.own(
                async move {
                    let status = result.await?;
                    if requested.present(&status) {
                        return Ok(status);
                    }
                    let next = {
                        let state = service.state.lock().unwrap();
                        if generation == state.generation {
                            None
                        } else {
                            let current = state
                                .flight
                                .as_ref()
                                .filter(|f| {
                                    f.generation == state.generation && f.credential == credential
                                })
                                .map(|f| f.result.clone());
                            Some((current, state.status()))
                        }
                    };
                    if let Some((current, status)) = next {
                        return match current {
                            Some(current) => current.await,
                            None => Ok(status),
                        };
                    }
                    service.refresh(credential, None).await
                }
                .boxed(),
            );
        }
        state.generation += 1;
        let generation = state.generation;
        let registration = state.identity.registration();
        let (send, receive) = oneshot::channel::<Reply>();
        let weak = Arc::downgrade(&self.state);
        let result = async move {
            match receive.await {
                Ok(result) => result,
                Err(_) => {
                    if let Some(state) = weak.upgrade() {
                        let mut state = state.lock().unwrap();
                        if state
                            .flight
                            .as_ref()
                            .is_some_and(|f| f.generation == generation)
                        {
                            state.flight = None;
                            state.reject(
                                &JsString::from("Worker encryption refresh stopped."),
                                true,
                            );
                        }
                    }
                    Err(ServiceError::stopped())
                }
            }
        }
        .boxed()
        .shared();
        state.flight = Some(Flight {
            generation,
            credential: credential.clone(),
            result: result.clone(),
        });
        let state = self.state.clone();
        let client = self.client.clone();
        let endpoint = self.endpoint.clone();
        let worker = self.worker_id.clone();
        let mut stop = self.stop.subscribe();
        let mut jobs = self.jobs.lock().unwrap();
        while jobs.try_join_next().is_some() {}
        jobs.spawn(async move {
            let response = if *stop.borrow() {
                None
            } else {
                tokio::select! {
                    _ = stop.changed() => None,
                    response = fetch(&client, &endpoint, &worker, &credential, &registration) => Some(response),
                }
            };
            let mut state = state.lock().unwrap();
            let reply = match response {
                None => Err(ServiceError::stopped()),
                Some(Response::Network(message)) => {
                    if generation == state.generation {
                        state.reject(&message, false);
                    }
                    Err(ServiceError::new("server-unavailable", "Could not refresh worker encryption grants."))
                }
                Some(Response::Http(status, payload)) if !(200..300).contains(&status) => {
                    let message = payload["error"].as_js_string().cloned().unwrap_or_else(|| {
                        format!("Cantrip Server rejected worker encryption bootstrap with HTTP {status}.").into()
                    });
                    if generation == state.generation {
                        state.reject(&message, (400..500).contains(&status));
                    }
                    Err(ServiceError::new("server-unavailable", message))
                }
                Some(Response::Http(_, payload)) => state.accept(&payload, generation),
            };
            if state.flight.as_ref().is_some_and(|f| f.generation == generation) {
                state.flight = None;
            }
            let _ = send.send(reply);
        });
        result.boxed()
    }
    // Promise continuations are eager in the reference implementation too:
    // retargeting a coalesced refresh survives an abandoned result future.
    fn own(&self, operation: BoxFuture<'static, Reply>) -> BoxFuture<'static, Reply> {
        let (send, receive) = oneshot::channel();
        let mut jobs = self.jobs.lock().unwrap();
        while jobs.try_join_next().is_some() {}
        jobs.spawn(async move {
            let _ = send.send(operation.await);
        });
        async move {
            receive
                .await
                .unwrap_or_else(|_| Err(ServiceError::stopped()))
        }
        .boxed()
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        let _closing = self.close_guard.lock().await;
        {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                return Ok(());
            }
            state.closing = true;
            state.lock();
            state.flight = None;
            self.stop.send_replace(true);
        }
        let mut jobs = std::mem::take(&mut *self.jobs.lock().unwrap());
        let mut failure = None;
        while let Some(result) = jobs.join_next().await {
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(anyhow::anyhow!(
                "Worker encryption refresh task failed: {error}"
            )),
            None => Ok(()),
        }
    }
}
enum Response {
    Network(JsString),
    Http(u16, Value),
}
async fn fetch(
    client: &reqwest::Client,
    endpoint: &str,
    worker: &JsString,
    credential: &str,
    registration: &Value,
) -> Response {
    let response = match client
        .post(endpoint)
        .timeout(std::time::Duration::from_secs(15))
        .bearer_auth(credential)
        .header("content-type", "application/json")
        .header("x-cantrip-worker-id", worker.lossy().as_ref())
        .body(registration.stringify())
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return Response::Network(
                if error.is_timeout() {
                    "The operation was aborted due to timeout"
                } else {
                    "fetch failed"
                }
                .into(),
            );
        }
    };
    let status = response.status().as_u16();
    let payload = response
        .bytes()
        .await
        .ok()
        .and_then(|bytes| {
            let text = String::from_utf8_lossy(&bytes);
            parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
        })
        .unwrap_or(Value::Null);
    Response::Http(status, payload)
}
