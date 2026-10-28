use super::{
    CatalogCache, CatalogRefresh, CatalogSnapshot, GLOBAL_SCOPE, is_provider, normalize_model,
};
use crate::{
    auth::now,
    settings::{catalog::CatalogUpdate, repository::SettingsRepository},
};
use anyhow::{Context, Result};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, join_all},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Persistence = Shared<BoxFuture<'static, Result<(), Arc<anyhow::Error>>>>;
struct Background {
    next_id: u64,
    active: HashMap<String, (u64, Persistence)>,
    errors: Vec<Arc<anyhow::Error>>,
}
pub struct CatalogService {
    repository: SettingsRepository,
    cache: Arc<CatalogCache>,
    background: Mutex<Background>,
}
impl CatalogService {
    pub fn new(repository: SettingsRepository) -> Result<Arc<Self>> {
        Ok(Self::with_cache(repository, CatalogCache::new()?))
    }
    pub fn with_cache(repository: SettingsRepository, cache: Arc<CatalogCache>) -> Arc<Self> {
        Arc::new(Self {
            repository,
            cache,
            background: Mutex::new(Background {
                next_id: 0,
                active: HashMap::new(),
                errors: vec![],
            }),
        })
    }
    pub fn get_provider_catalog(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        force: bool,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let service = Arc::clone(self);
        let owner = owner.to_owned();
        let provider = provider.to_owned();
        async move {
            let repository=&service.repository;
            let Some(runtime)=repository.get_provider_catalog_runtime(&owner,&provider).await? else{return Ok(None)};
            let base=runtime["baseUrl"].as_str().context("stored catalog URL")?;
            anyhow::ensure!(is_provider(runtime["kind"].as_str().context("stored provider kind")?,base),"Provider is not an OpenRouter-compatible provider.");
            // Source writes this before the refresh catch. A failure here must
            // escape without replacing the existing sync state with 'failed'.
            repository.set_provider_catalog_sync_state(&provider,&json!({"scopeKey":GLOBAL_SCOPE,"status":"refreshing","errorCode":null,"refreshStartedAt":now()})).await?;
            let refresh:Result<bool>=async {
                let key=format!("public:{}",url::Url::parse(base)?.origin().ascii_serialization());
                let read=service.cache.read(base,&key,force).await.map_err(|error|anyhow::Error::new((*error).clone()))?;
                service.persist(&owner,&provider,&read.snapshot).await?;
                let mut state=json!({"scopeKey":GLOBAL_SCOPE,"status":if read.served_stale{"stale"}else{"current"},"errorCode":null,"etag":read.snapshot.etag});
                if !read.served_stale {state["lastSuccessAt"]=json!(now());}
                repository.set_provider_catalog_sync_state(&provider,&state).await?;
                if let Some(background)=read.background_refresh {
                    service.schedule(&owner,&provider,background);
                }
                Ok(read.served_stale)
            }.await;
            match refresh {
                // The source returns this promise without awaiting it inside
                // the catch. Projection failures must not become refresh errors.
                Ok(stale)=>repository.get_provider_model_catalog(&owner,&provider,stale).await,
                Err(error)=>{
                    let existing=repository.get_provider_model_catalog(&owner,&provider,true).await?;
                    let has_models=existing.as_ref().is_some_and(|catalog|catalog["models"].as_array().is_some_and(|models|!models.is_empty()));
                    repository.set_provider_catalog_sync_state(&provider,&json!({"scopeKey":GLOBAL_SCOPE,"status":if has_models{"stale"}else{"failed"},"errorCode":"openrouter-catalog-refresh-failed"})).await?;
                    if has_models {repository.get_provider_model_catalog(&owner,&provider,true).await}else{Err(error)}
                }
            }
        }.boxed()
    }
    async fn persist(&self, owner: &str, provider: &str, snapshot: &CatalogSnapshot) -> Result<()> {
        let models: Vec<_> = snapshot.models.iter().map(normalize_model).collect();
        self.repository
            .reconcile_provider_model_catalog(
                owner,
                provider,
                CatalogUpdate {
                    availability_scope: GLOBAL_SCOPE.into(),
                    available: models
                        .iter()
                        .map(|model| {
                            model["nativeModelId"]
                                .as_js_string()
                                .expect("parsed public model ID")
                                .clone()
                        })
                        .collect(),
                    models,
                    auto_create: false,
                    auto_create_native_ids: None,
                    worker_id: None,
                    account_id: None,
                    default_native_id: None,
                },
            )
            .await?;
        Ok(())
    }
    fn schedule(self: &Arc<Self>, owner: &str, provider: &str, refresh: CatalogRefresh) {
        let mut background = self.background.lock().expect("catalog background lock");
        if background.active.contains_key(provider) {
            return;
        }
        background.next_id += 1;
        let id = background.next_id;
        let (send, receive) = tokio::sync::oneshot::channel();
        let pending = async move {
            receive.await.unwrap_or_else(|_| {
                Err(Arc::new(anyhow::anyhow!(
                    "Catalog persistence task failed."
                )))
            })
        }
        .boxed()
        .shared();
        background.active.insert(provider.into(), (id, pending));
        let service = Arc::clone(self);
        let owner = owner.to_owned();
        let provider = provider.to_owned();
        tokio::spawn(async move {
            let result: Result<()> = async {
                refresh
                    .await
                    .map_err(|error| anyhow::Error::new((*error).clone()))?;
                service
                    .get_provider_catalog(&owner, &provider, false)
                    .await?;
                Ok(())
            }
            .await;
            let result=match result {
                Ok(())=>Ok(()),
                Err(_)=>service.repository.set_provider_catalog_sync_state(&provider,&json!({"scopeKey":GLOBAL_SCOPE,"status":"stale","errorCode":"openrouter-background-refresh-failed"})).await.map_err(Arc::new),
            };
            {
                let mut background = service.background.lock().expect("catalog background lock");
                if let Err(error) = &result {
                    background.errors.push(Arc::clone(error));
                }
                if background
                    .active
                    .get(&provider)
                    .is_some_and(|(active, _)| *active == id)
                {
                    background.active.remove(&provider);
                }
            }
            let _ = send.send(result);
        });
    }
    /// Drain owned public fetches and persistence before closing the database.
    /// Failures updating a background sync state remain visible to the owner.
    pub async fn drain(&self) -> Vec<Arc<anyhow::Error>> {
        loop {
            let pending = self
                .background
                .lock()
                .expect("catalog background lock")
                .active
                .values()
                .map(|(_, pending)| pending.clone())
                .collect::<Vec<_>>();
            if pending.is_empty() {
                break;
            }
            let _ = join_all(pending).await;
        }
        self.cache.drain().await;
        std::mem::take(
            &mut self
                .background
                .lock()
                .expect("catalog background lock")
                .errors,
        )
    }
}
