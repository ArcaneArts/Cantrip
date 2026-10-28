use super::{models_url, parse_payload};
use crate::wire::{JsString, Value};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, join_all},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct CatalogFailure(pub JsString);
impl std::fmt::Display for CatalogFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for CatalogFailure {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub etag: Option<JsString>,
    pub fetched_at: f64,
    pub models: Vec<Value>,
}
pub struct FetchResponse {
    pub status: u16,
    pub status_text: JsString,
    pub etag: Option<JsString>,
    pub body: BoxFuture<'static, Result<Value, CatalogFailure>>,
}
pub trait CatalogFetcher: Send + Sync {
    fn fetch(
        &self,
        url: url::Url,
        etag: Option<JsString>,
    ) -> BoxFuture<'static, Result<FetchResponse, CatalogFailure>>;
}
pub type CatalogRefresh =
    Shared<BoxFuture<'static, Result<Arc<CatalogSnapshot>, Arc<CatalogFailure>>>>;
pub struct CatalogRead {
    pub snapshot: Arc<CatalogSnapshot>,
    pub served_stale: bool,
    pub background_refresh: Option<CatalogRefresh>,
}
struct State {
    snapshots: HashMap<String, Arc<CatalogSnapshot>>,
    in_flight: HashMap<String, (u64, CatalogRefresh)>,
    next_id: u64,
}
pub struct CatalogCache {
    state: Mutex<State>,
    fetcher: Arc<dyn CatalogFetcher>,
    clock: Arc<dyn Fn() -> f64 + Send + Sync>,
    ttl_ms: f64,
}
impl CatalogCache {
    pub fn new() -> anyhow::Result<Arc<Self>> {
        Ok(Self::with_options(
            Arc::new(HttpCatalogFetcher::new()?),
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock before epoch")
                    .as_millis() as f64
            }),
            21_600_000.0,
        ))
    }
    pub fn with_options(
        fetcher: Arc<dyn CatalogFetcher>,
        clock: Arc<dyn Fn() -> f64 + Send + Sync>,
        ttl_ms: f64,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                snapshots: HashMap::new(),
                in_flight: HashMap::new(),
                next_id: 0,
            }),
            fetcher,
            clock,
            ttl_ms,
        })
    }
    pub async fn read(
        self: &Arc<Self>,
        base: &str,
        key: &str,
        force: bool,
    ) -> Result<CatalogRead, Arc<CatalogFailure>> {
        let existing = self
            .state
            .lock()
            .expect("catalog cache lock")
            .snapshots
            .get(key)
            .cloned();
        if !force
            && existing
                .as_ref()
                .is_some_and(|snapshot| (self.clock)() - snapshot.fetched_at < self.ttl_ms)
        {
            return Ok(CatalogRead {
                snapshot: existing.unwrap(),
                served_stale: false,
                background_refresh: None,
            });
        }
        let refresh = self.refresh(base, key, existing.clone());
        if let Some(existing) = existing.filter(|_| !force) {
            return Ok(CatalogRead {
                snapshot: existing,
                served_stale: true,
                background_refresh: Some(refresh),
            });
        }
        Ok(CatalogRead {
            snapshot: refresh.await?,
            served_stale: false,
            background_refresh: None,
        })
    }
    fn refresh(
        self: &Arc<Self>,
        base: &str,
        key: &str,
        existing: Option<Arc<CatalogSnapshot>>,
    ) -> CatalogRefresh {
        let mut state = self.state.lock().expect("catalog cache lock");
        if let Some((_, active)) = state.in_flight.get(key) {
            return active.clone();
        }
        state.next_id += 1;
        let id = state.next_id;
        let (send, receive) = tokio::sync::oneshot::channel();
        let refresh = async move {
            receive.await.unwrap_or_else(|_| {
                Err(Arc::new(CatalogFailure(
                    "Catalog refresh task failed.".into(),
                )))
            })
        }
        .boxed()
        .shared();
        state.in_flight.insert(key.into(), (id, refresh.clone()));
        let cache = Arc::clone(self);
        let base = base.to_owned();
        let key = key.to_owned();
        // Spawn before returning a stale snapshot: JavaScript promises begin
        // work even when the caller does not await backgroundRefresh.
        tokio::spawn(async move {
            let result = cache
                .fetch_snapshot(&base, existing)
                .await
                .map(Arc::new)
                .map_err(Arc::new);
            {
                let mut state = cache.state.lock().expect("catalog cache lock");
                if let Ok(snapshot) = &result {
                    state.snapshots.insert(key.clone(), Arc::clone(snapshot));
                }
                if state
                    .in_flight
                    .get(&key)
                    .is_some_and(|(active, _)| *active == id)
                {
                    state.in_flight.remove(&key);
                }
            }
            let _ = send.send(result);
        });
        refresh
    }
    async fn fetch_snapshot(
        &self,
        base: &str,
        existing: Option<Arc<CatalogSnapshot>>,
    ) -> Result<CatalogSnapshot, CatalogFailure> {
        let etag = existing
            .as_ref()
            .and_then(|s| s.etag.clone())
            .filter(|s| !s.is_empty());
        let response = self.fetcher.fetch(models_url(base)?, etag).await?;
        if response.status == 304
            && let Some(existing) = existing
        {
            return Ok(CatalogSnapshot {
                fetched_at: (self.clock)(),
                ..(*existing).clone()
            });
        }
        if !(200..300).contains(&response.status) {
            let mut message = format!("OpenRouter model catalog returned {} ", response.status)
                .encode_utf16()
                .collect::<Vec<_>>();
            message.extend(response.status_text.units());
            message.push(u16::from(b'.'));
            return Err(CatalogFailure(JsString::new(message)));
        }
        let fetched_at = (self.clock)();
        let models = parse_payload(&response.body.await?)?;
        Ok(CatalogSnapshot {
            etag: response.etag,
            fetched_at,
            models,
        })
    }
    pub async fn drain(&self) {
        loop {
            let pending = self
                .state
                .lock()
                .expect("catalog cache lock")
                .in_flight
                .values()
                .map(|(_, f)| f.clone())
                .collect::<Vec<_>>();
            if pending.is_empty() {
                return;
            }
            let _ = join_all(pending).await;
        }
    }
}

pub struct HttpCatalogFetcher {
    client: reqwest::Client,
}
fn latin1(bytes: &[u8]) -> JsString {
    JsString::new(bytes.iter().map(|byte| u16::from(*byte)).collect())
}
impl HttpCatalogFetcher {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .http1_only()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::limited(20))
                .timeout(Duration::from_secs(30))
                .build()?,
        })
    }
}
impl CatalogFetcher for HttpCatalogFetcher {
    fn fetch(
        &self,
        url: url::Url,
        etag: Option<JsString>,
    ) -> BoxFuture<'static, Result<FetchResponse, CatalogFailure>> {
        let client = self.client.clone();
        async move {
            // Fetch rejects credentials in URLs rather than turning them into
            // an Authorization header, as an ordinary HTTP client might.
            if !url.username().is_empty() || url.password().is_some() {
                return Err(CatalogFailure(
                    format!(
                        "Request cannot be constructed from a URL that includes credentials: {url}"
                    )
                    .into(),
                ));
            }
            let mut request = client.get(url).header("accept", "application/json");
            if let Some(etag) = etag {
                let bytes = etag
                    .units()
                    .iter()
                    .copied()
                    .map(u8::try_from)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| CatalogFailure("Invalid ETag header.".into()))?;
                let value = reqwest::header::HeaderValue::from_bytes(&bytes)
                    .map_err(|_| CatalogFailure("Invalid ETag header.".into()))?;
                request = request.header("if-none-match", value);
            }
            let response = request.send().await.map_err(|error| {
                CatalogFailure(
                    if error.is_timeout() {
                        "The operation was aborted due to timeout"
                    } else {
                        "fetch failed"
                    }
                    .into(),
                )
            })?;
            let status = response.status();
            let status_text = response
                .extensions()
                .get::<hyper::ext::ReasonPhrase>()
                .map(|reason| {
                    String::from_utf8_lossy(reason.as_bytes())
                        .into_owned()
                        .into()
                })
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("").into());
            let etags: Vec<_> = response
                .headers()
                .get_all("etag")
                .iter()
                .map(|value| value.as_bytes())
                .collect();
            let etag = (!etags.is_empty()).then(|| latin1(&etags.join(&b", "[..])));
            Ok(FetchResponse {
                status: status.as_u16(),
                status_text,
                etag,
                body: async move {
                    let bytes = response.bytes().await.map_err(|error| {
                        CatalogFailure(
                            if error.is_timeout() {
                                "The operation was aborted due to timeout"
                            } else {
                                "terminated"
                            }
                            .into(),
                        )
                    })?;
                    let raw = String::from_utf8_lossy(&bytes);
                    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
                    crate::wire::parse_json_text(raw).map_err(CatalogFailure)
                }
                .boxed(),
            })
        }
        .boxed()
    }
}
