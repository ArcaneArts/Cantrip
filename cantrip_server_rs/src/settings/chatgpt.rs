pub use super::account_catalog::AccountCatalogRequest;
use super::repository::SettingsRepository;
use crate::{wire::Value, workers::command_bus::LimitedCommandBus};
use anyhow::Result;
use serde_json::{Value as Json, json};
use std::sync::Arc;

pub fn normalize_model(model: &Value) -> Value {
    let efforts: Vec<_> = model["supportedReasoningEfforts"]
        .as_array()
        .expect("validated ChatGPT efforts")
        .iter()
        .map(|effort| {
            Value::object([
                ("effort", effort["reasoningEffort"].clone()),
                (
                    "description",
                    if effort["description"]
                        .as_js_string()
                        .expect("validated effort description")
                        .is_empty()
                    {
                        Value::Null
                    } else {
                        effort["description"].clone()
                    },
                ),
            ])
        })
        .collect();
    let modalities = model["inputModalities"]
        .as_array()
        .expect("validated ChatGPT modalities");
    let mut output = Value::object([
        ("nativeModelId", model["model"].clone()),
        ("canonicalModelId", model["model"].clone()),
        ("displayName", model["displayName"].clone()),
        (
            "description",
            if model["description"]
                .as_js_string()
                .expect("validated model description")
                .is_empty()
            {
                Value::Null
            } else {
                model["description"].clone()
            },
        ),
        ("contextWindow", Value::Null),
        ("maxOutputTokens", Value::Null),
        (
            "inputModalities",
            if modalities.is_empty() {
                Value::from_serialize(&json!(["text"]))
            } else {
                model["inputModalities"].clone()
            },
        ),
        ("outputModalities", Value::from_serialize(&json!(["text"]))),
        ("supportsTools", Value::Null),
        ("supportsParallelTools", Value::Null),
        ("supportsStructuredOutput", Value::Null),
        (
            "supportsVision",
            Value::Bool(modalities.iter().any(|value| value == "image")),
        ),
        ("supportsReasoning", Value::Bool(!efforts.is_empty())),
        ("supportedReasoningEfforts", Value::Array(efforts)),
        (
            "defaultReasoningEffort",
            model["defaultReasoningEffort"].clone(),
        ),
        ("reasoningMandatory", Value::Null),
        ("family", model["modelSpecialty"].clone()),
        ("parameterSize", Value::Null),
        ("quantization", Value::Null),
        ("digest", Value::Null),
        ("metadataSource", Value::String("codex".into())),
        ("matchConfidenceBasisPoints", Value::Number(10_000.0)),
        ("hidden", model["hidden"].clone()),
        ("isDefault", model["isDefault"].clone()),
    ]);
    output["rawMetadata"] = Value::object([
        ("catalogId", model["id"].clone()),
        ("upgrade", model["upgrade"].clone()),
        ("upgradeInfo", model["upgradeInfo"].clone()),
        ("availabilityNux", model["availabilityNux"].clone()),
        ("supportsPersonality", model["supportsPersonality"].clone()),
        (
            "additionalSpeedTiers",
            model["additionalSpeedTiers"].clone(),
        ),
        ("serviceTiers", model["serviceTiers"].clone()),
        ("defaultServiceTier", model["defaultServiceTier"].clone()),
    ]);
    output
}
impl SettingsRepository {
    pub async fn mark_chatgpt_account_unavailable(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        self.mark_account_catalog_unavailable(
            super::account_catalog::Family::ChatGpt,
            owner,
            provider,
            account,
        )
        .await
    }
    pub async fn get_chatgpt_provider_catalog(
        &self,
        request: &AccountCatalogRequest<'_>,
        commands: &Arc<LimitedCommandBus>,
    ) -> Result<Option<Json>> {
        self.get_account_provider_catalog(
            request,
            commands,
            super::account_catalog::Family::ChatGpt,
            None,
        )
        .await
    }
}
