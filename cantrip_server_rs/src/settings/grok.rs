use super::{
    account_catalog::{AccountCatalogRequest, Family},
    openrouter::CatalogCache,
    repository::SettingsRepository,
};
use crate::wire::{JsString, Value};
use crate::workers::command_bus::LimitedCommandBus;
use anyhow::Result;
use indexmap::IndexSet;
use serde_json::Value as Json;
use std::sync::Arc;

/// The same rate-limited operational log call used by the source service.
/// The server's diagnostics owner supplies formatting, redaction and archival.
pub trait CatalogDiagnostics: Send + Sync {
    fn rate_limited(&self, warning: CatalogWarning) -> Result<()>;
    fn event(&self, _level: &'static str, _context: Value, _message: &'static str) -> Result<()> {
        Ok(())
    }
}
pub struct CatalogWarning {
    pub key: String,
    pub level: &'static str,
    pub message: &'static str,
    pub context: Value,
    pub summary_every: u64,
    pub window_ms: u64,
}
pub struct CatalogService {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    cache: Arc<CatalogCache>,
    diagnostics: Arc<dyn CatalogDiagnostics>,
}
impl CatalogService {
    pub fn new(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        diagnostics: Arc<dyn CatalogDiagnostics>,
    ) -> Result<Arc<Self>> {
        Ok(Self::with_cache(
            repository,
            commands,
            CatalogCache::new()?,
            diagnostics,
        ))
    }
    pub fn with_cache(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        cache: Arc<CatalogCache>,
        diagnostics: Arc<dyn CatalogDiagnostics>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository,
            commands,
            cache,
            diagnostics,
        })
    }
    pub async fn get_provider_catalog(
        &self,
        request: &AccountCatalogRequest<'_>,
    ) -> Result<Option<Json>> {
        self.repository
            .get_account_provider_catalog(
                request,
                &self.commands,
                Family::Grok,
                Some((&self.cache, self.diagnostics.as_ref())),
            )
            .await
    }
    pub async fn mark_account_unavailable(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        self.repository
            .mark_grok_account_unavailable(owner, provider, account)
            .await
    }
    pub async fn drain(&self) {
        self.cache.drain().await;
    }
}
impl SettingsRepository {
    pub async fn mark_grok_account_unavailable(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        self.mark_account_catalog_unavailable(Family::Grok, owner, provider, account)
            .await
    }
}
pub(super) async fn public_models(
    cache: &Arc<CatalogCache>,
    diagnostics: &dyn CatalogDiagnostics,
    force: bool,
) -> Result<Vec<Value>> {
    match cache
        .read(
            "https://openrouter.ai/api/v1",
            "public:https://openrouter.ai",
            force,
        )
        .await
    {
        Ok(read) => Ok(read
            .snapshot
            .models
            .iter()
            .map(super::openrouter::normalize_model)
            .collect()),
        Err(error) => {
            diagnostics.rate_limited(CatalogWarning {
                key: "grok-catalog-openrouter-metadata-unavailable".into(),
                level: "warn",
                message: "Grok catalog capability enrichment is temporarily unavailable",
                context: Value::object([
                    (
                        "event",
                        Value::String("provider.grok.catalog_enrichment_unavailable".into()),
                    ),
                    ("subsystem", Value::String("provider-catalog".into())),
                    ("operation", Value::String("enrich-grok-catalog".into())),
                    ("status", Value::String("degraded".into())),
                    (
                        "reasonCode",
                        Value::String("openrouter_public_catalog_unavailable".into()),
                    ),
                    ("error", Value::String(error.0.clone())),
                ]),
                summary_every: 10,
                window_ms: 60_000,
            })?;
            Ok(vec![])
        }
    }
}

pub fn normalize_model(model: &Value) -> Value {
    let vision = model["inputModalities"]
        .as_array()
        .expect("validated Grok modalities")
        .iter()
        .any(|value| value == "image");
    Value::object([
        ("nativeModelId", model["id"].clone()),
        ("canonicalModelId", model["id"].clone()),
        ("displayName", model["displayName"].clone()),
        ("description", model["description"].clone()),
        ("contextWindow", model["contextWindow"].clone()),
        ("maxOutputTokens", model["maxOutputTokens"].clone()),
        ("inputModalities", model["inputModalities"].clone()),
        ("outputModalities", model["outputModalities"].clone()),
        ("supportsTools", Value::Bool(true)),
        ("supportsParallelTools", Value::Bool(true)),
        ("supportsStructuredOutput", Value::Null),
        (
            "supportsVision",
            if vision {
                Value::Bool(true)
            } else {
                Value::Null
            },
        ),
        ("supportsReasoning", model["supportsReasoning"].clone()),
        (
            "supportedReasoningEfforts",
            model["supportedReasoningEfforts"].clone(),
        ),
        (
            "defaultReasoningEffort",
            model["defaultReasoningEffort"].clone(),
        ),
        ("reasoningMandatory", Value::Null),
        ("family", Value::String("grok".into())),
        ("parameterSize", Value::Null),
        ("quantization", Value::Null),
        ("digest", Value::Null),
        ("metadataSource", Value::String("grok".into())),
        ("matchConfidenceBasisPoints", Value::Number(10_000.0)),
        ("hidden", model["hidden"].clone()),
        ("isDefault", model["isDefault"].clone()),
        ("rawMetadata", model["rawMetadata"].clone()),
    ])
}
fn identity(value: &Value) -> Option<JsString> {
    value
        .as_js_string()
        .map(|value| value.trim().lowercase())
        .filter(|value| !value.is_empty())
}
pub fn enrich_vision(models: &[Value], candidates: &[Value]) -> Vec<Value> {
    models
        .iter()
        .map(|model| {
            if !model["supportsVision"].is_null() {
                return model.clone();
            }
            let Some(native) = identity(&model["nativeModelId"]) else {
                return model.clone();
            };
            let mut prefixed: Vec<_> = "x-ai/".encode_utf16().collect();
            prefixed.extend(native.units());
            let prefixed = JsString::new(prefixed);
            let mut matches = candidates.iter().filter(|candidate| {
                ["nativeModelId", "canonicalModelId"]
                    .iter()
                    .filter_map(|key| identity(&candidate[key]))
                    .any(|id| id == native || id == prefixed)
            });
            let Some(candidate) = matches.next() else {
                return model.clone();
            };
            if matches.next().is_some() || candidate["supportsVision"] != true {
                return model.clone();
            }
            let modalities: IndexSet<_> = model["inputModalities"]
                .as_array()
                .expect("catalog modalities")
                .iter()
                .chain(
                    candidate["inputModalities"]
                        .as_array()
                        .expect("metadata modalities"),
                )
                .map(|value| value.as_js_string().expect("modality").clone())
                .collect();
            let mut enriched = model.clone();
            enriched["inputModalities"] =
                Value::Array(modalities.into_iter().map(Value::String).collect());
            enriched["supportsVision"] = Value::Bool(true);
            enriched
        })
        .collect()
}
