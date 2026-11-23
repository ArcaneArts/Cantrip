//! The app-server shares one static catalog across all threads of a runtime.
use super::{RPC_TIMEOUT, Runtime};
use crate::provider_access::Access;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

type Models = IndexMap<JsString, Value>;

pub(in crate::codex) struct Seed {
    provider: Value,
    pub(super) native_provider: &'static str,
    explicit: Models,
    access: Access,
}

pub(super) struct Catalog {
    kind: Value,
    explicit: Models,
    inventory: Models,
    revision: u64,
    acknowledged: Vec<Value>,
}

impl Seed {
    pub(in crate::codex) fn new(
        provider: &Value,
        root: &Value,
        child: &Value,
        access: Access,
        native_provider: &'static str,
    ) -> Option<Self> {
        if !root.is_object() {
            return None;
        }
        let mut explicit = Models::new();
        add(&mut explicit, root);
        add(&mut explicit, child);
        Some(Self {
            provider: json!({
                "id":provider["id"], "accountId":provider["accountId"], "kind":provider["kind"],
            }),
            native_provider,
            explicit,
            access,
        })
    }

    pub(super) async fn inventory(&self) -> Value {
        self.access
            .native_model_inventory(&self.provider)
            .await
            .unwrap_or(Value::Null)
    }

    pub(super) async fn publish(self, path: &Path, found: &Value) -> Result<Option<Catalog>> {
        if self.provider["kind"] == "chatgpt" {
            return Ok(None);
        }
        let mut inventory = Models::new();
        for model in found["models"].as_array().into_iter().flatten() {
            add(&mut inventory, model);
        }
        let mut catalog = Catalog {
            kind: self.provider["kind"].clone(),
            explicit: self.explicit,
            inventory,
            revision: 0,
            acknowledged: Vec::new(),
        };
        catalog.acknowledged = catalog.entries();
        let data = json!({"models":catalog.acknowledged}).stringify();
        let destination = path.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut stage = tempfile::NamedTempFile::new_in(
                destination.parent().context("Managed catalog directory")?,
            )?;
            stage.write_all(data.as_bytes())?;
            stage.persist(destination)?;
            Ok(())
        })
        .await??;
        Ok(Some(catalog))
    }
}

impl Catalog {
    fn entries(&self) -> Vec<Value> {
        self.explicit
            .iter()
            .map(|(name, model)| self.inventory.get(name).unwrap_or(model))
            .chain(
                self.inventory
                    .iter()
                    .filter(|(name, _)| !self.explicit.contains_key(*name))
                    .map(|(_, model)| model),
            )
            .enumerate()
            .map(|(priority, model)| entry(model, &self.kind, priority))
            .collect()
    }

    pub(super) async fn synchronize(
        &mut self,
        runtime: &Runtime,
        root: &Value,
        child: &Value,
    ) -> Result<()> {
        let mut selected = Models::new();
        add(&mut selected, root);
        add(&mut selected, child);
        for (name, mut model) in selected {
            if model["catalog"].is_null()
                && let Some(prior) = self.explicit.get(&name)
            {
                model["catalog"] = prior["catalog"].clone();
            }
            self.explicit.insert(name, model);
        }
        let models = self.entries();
        if models == self.acknowledged {
            return Ok(());
        }
        self.revision = self
            .revision
            .checked_add(1)
            .context("Managed catalog revision exhausted")?;
        let revision = self.revision.to_string();
        let response = runtime
            .request(
                "model/managedCatalog/update".into(),
                Some(json!({"revision":revision,"models":models})),
                Some(RPC_TIMEOUT),
                None,
            )
            .await?
            .context("Missing native model catalog acknowledgment")?;
        runtime.assert_live()?;
        ensure!(
            response["revision"] == revision.as_str() && response["changed"].is_boolean(),
            "Codex did not acknowledge the managed catalog revision."
        );
        self.acknowledged = models;
        Ok(())
    }
}

fn add(models: &mut Models, model: &Value) {
    let Some(name) = model["name"].as_js_string() else {
        return;
    };
    let retained = models.entry(name.clone()).or_insert_with(|| model.clone());
    if retained["catalog"].is_null() && !model["catalog"].is_null() {
        retained["catalog"] = model["catalog"].clone();
    }
}

fn entry(model: &Value, provider: &Value, priority: usize) -> Value {
    let catalog = &model["catalog"];
    let zai = provider == "openai-compatible" && catalog["metadataSource"] == "zai";
    let freeform = zai || provider == "ollama" || provider == "chatgpt";
    let mut modalities = catalog["inputModalities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_js_string)
        .map(|mode| mode.trim().lowercase())
        .filter(|mode| matches!(mode.as_str(), Some("text" | "image" | "audio")))
        .collect::<Vec<_>>();
    if catalog.is_null() {
        modalities.push("text".into());
    }
    let name = model["name"].as_js_string().unwrap();
    let grok = name.trim().lowercase();
    let slug = grok.lossy();
    let slug = slug.rsplit('/').next().unwrap_or_default();
    let grok_vision = provider == "grok"
        && catalog["supportsVision"] != false
        && (slug == "grok-4" || slug.starts_with("grok-4.") || slug.starts_with("grok-4-"));
    if (catalog["supportsVision"] == true || grok_vision)
        && !modalities.iter().any(|mode| mode.as_str() == Some("image"))
    {
        modalities.push("image".into());
    }
    let levels = catalog["supportedReasoningEfforts"]
        .as_array()
        .filter(|_| catalog["supportsReasoning"] == true)
        .into_iter()
        .flatten()
        .map(|option| json!({
            "effort":option["effort"],
            "description":option.get("description").filter(|value| !value.is_null()).unwrap_or(&option["effort"]),
        }))
        .collect::<Vec<_>>();
    let identity = json!({
        "slug":name,"contextWindow":catalog["contextWindow"],"inputModalities":modalities,
        "supportsTools":catalog["supportsTools"],"supportsFreeformTools":freeform,
        "supportsParallelTools":catalog["supportsParallelTools"],"supportedReasoningLevels":levels,
    });
    let hash: String = Sha256::digest(identity.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if modalities.is_empty() {
        modalities.push("text".into());
    }
    json!({
        "slug":name, "display_name":catalog.get("displayName").unwrap_or(&model["name"]),
        "description":catalog["description"],
        "base_instructions":"You are Codex, a coding agent. Follow the developer and user instructions. Use the available tools to inspect and modify the repository, run commands, and verify your work. Continue until the user's request is complete.",
        "default_reasoning_level":if zai {catalog["defaultReasoningEffort"].clone()}else{Value::Null},
        "supported_reasoning_levels":levels, "shell_type":if catalog["supportsTools"]==false {"disabled"}else{"shell_command"},
        "visibility":"list","supported_in_api":true,"priority":priority,
        "additional_speed_tiers":[] as [Value;0], "service_tiers":[] as [Value;0],
        "default_service_tier":Value::Null,"availability_nux":Value::Null,"upgrade":Value::Null,"model_messages":Value::Null,
        "include_skills_usage_instructions":false,"include_plugin_usage_instructions":false,"include_apps_usage_instructions":false,
        "supports_reasoning_summary_parameter":false,"default_reasoning_summary":"auto",
        "support_verbosity":false,"default_verbosity":Value::Null,
        "apply_patch_tool_type":if catalog["supportsTools"]==true && freeform {json!("freeform")}else{Value::Null},
        "web_search_tool_type":"text","truncation_policy":json!({"mode":"bytes","limit":10000}),
        "supports_parallel_tool_calls":catalog["supportsParallelTools"]==true,
        "supports_image_detail_original":false,"context_window":catalog["contextWindow"],
        "max_context_window":catalog["contextWindow"],"auto_compact_token_limit":Value::Null,
        "comp_hash":format!("cantrip-{hash}"),"effective_context_window_percent":95,
        "experimental_supported_tools":[] as [Value;0],"input_modalities":modalities,
        "supports_search_tool":false,"use_responses_lite":false,"auto_review_model_override":Value::Null,
        "model_specialty":Value::Null,"tool_mode":Value::Null,"multi_agent_version":Value::Null,
    })
}
