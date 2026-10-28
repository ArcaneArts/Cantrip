//! Per-process runtime metadata hydration, independent of the settings screen.
use super::is_provider;
use crate::wire::{JsString, Value};
use anyhow::Result;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, join_all, try_join_all},
};
use indexmap::IndexSet;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub type CatalogLoader = Arc<dyn Fn(JsString) -> BoxFuture<'static, Result<bool>> + Send + Sync>;
pub type HydrationResult = Result<bool, Arc<anyhow::Error>>;
type Pending = Shared<BoxFuture<'static, HydrationResult>>;
struct State {
    hydrated: IndexSet<JsString>,
    active: HashMap<JsString, (u64, Pending)>,
    next_id: u64,
}
pub struct RuntimeHydrator {
    state: Mutex<State>,
}
impl RuntimeHydrator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                hydrated: IndexSet::new(),
                active: HashMap::new(),
                next_id: 0,
            }),
        })
    }
    pub fn invalidate(&self, provider: &JsString) {
        self.state
            .lock()
            .expect("hydration lock")
            .hydrated
            .shift_remove(provider);
    }
    pub fn mark_hydrated(&self, provider: JsString) {
        self.state
            .lock()
            .expect("hydration lock")
            .hydrated
            .insert(provider);
    }
    /// The caller binds its owner before starting shared work. A process-wide
    /// loader must never infer the current owner from a provider identifier.
    pub fn hydrate(
        self: &Arc<Self>,
        runtimes: &[Value],
        loader: CatalogLoader,
    ) -> BoxFuture<'static, HydrationResult> {
        let providers: IndexSet<_> = runtimes
            .iter()
            .filter_map(|runtime| {
                let provider = &runtime["provider"];
                let kind = provider["kind"].as_str()?;
                let base = provider["baseUrl"].as_js_string()?;
                is_provider(kind, &base.lossy()).then(|| {
                    provider["id"]
                        .as_js_string()
                        .expect("validated runtime provider ID")
                        .clone()
                })
            })
            .collect();
        let providers = {
            let state = self.state.lock().expect("hydration lock");
            providers
                .into_iter()
                .filter(|id| !state.hydrated.contains(id))
                .collect::<Vec<_>>()
        };
        // Start every load before awaiting Promise.all, including work that
        // continues after a different provider rejects or a caller disconnects.
        let loads = providers
            .into_iter()
            .map(|provider| self.start(provider, &loader))
            .collect::<Vec<_>>();
        async move { Ok(try_join_all(loads).await?.into_iter().any(|loaded| loaded)) }.boxed()
    }
    fn start(self: &Arc<Self>, provider: JsString, loader: &CatalogLoader) -> Pending {
        let mut state = self.state.lock().expect("hydration lock");
        if let Some((_, pending)) = state.active.get(&provider) {
            return pending.clone();
        }
        state.next_id += 1;
        let id = state.next_id;
        let (send, receive) = tokio::sync::oneshot::channel();
        let pending = async move {
            receive.await.unwrap_or_else(|_| {
                Err(Arc::new(anyhow::anyhow!("Catalog hydration task failed.")))
            })
        }
        .boxed()
        .shared();
        state.active.insert(provider.clone(), (id, pending.clone()));
        drop(state);
        let load = loader(provider.clone());
        let hydrator = Arc::clone(self);
        tokio::spawn(async move {
            let result = load.await.map_err(Arc::new);
            {
                let mut state = hydrator.state.lock().expect("hydration lock");
                if matches!(result, Ok(true)) {
                    state.hydrated.insert(provider.clone());
                }
                if state
                    .active
                    .get(&provider)
                    .is_some_and(|(active, _)| *active == id)
                {
                    state.active.remove(&provider);
                }
            }
            let _ = send.send(result);
        });
        pending
    }
    pub async fn drain(&self) {
        loop {
            let pending = self
                .state
                .lock()
                .expect("hydration lock")
                .active
                .values()
                .map(|(_, pending)| pending.clone())
                .collect::<Vec<_>>();
            if pending.is_empty() {
                return;
            }
            let _ = join_all(pending).await;
        }
    }
}
