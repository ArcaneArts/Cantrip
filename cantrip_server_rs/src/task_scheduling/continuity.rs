use super::*;
use unicode_normalization::UnicodeNormalization;
fn normalized(family: &Value) -> Result<Option<Value>> {
    let Some(family) = family.as_str().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let nfkc = family.nfkc().collect::<String>();
    let lower = crate::text::trim(&nfkc).to_lowercase();
    let mut normalized = String::new();
    let mut space = false;
    for ch in lower.chars() {
        if crate::text::whitespace(ch) {
            if !space {
                normalized.push('-');
            }
            space = true;
        } else {
            space = false;
            normalized.push(ch);
        }
    }
    match crate::wire::parse("taskWorkerContinuityFamilySchema", Some(&json!(normalized))) {
        Ok(v) => Ok(Some(v)),
        Err(crate::wire::ValidationError::Invalid(_)) => Ok(None),
        Err(crate::wire::ValidationError::Operation) => {
            anyhow::bail!("Task Worker continuity validation failed")
        }
    }
}
impl Repository {
    pub(super) async fn infer_family(&self, owner: &str, model: &Value) -> Result<Value> {
        let rows=all(Executor::Database(&self.database),"SELECT json_build_object('family',p.family,'metadataSource',p.metadata_source)::text FROM model_routes r JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 JOIN provider_models p ON p.id=r.provider_model_id AND p.provider_id=r.provider_id WHERE r.model_id=$2 AND r.enabled=true",&[&owner,&text(model)?]).await?;
        let mut families = HashSet::<JsString>::new();
        for row in rows {
            if matches!(
                row["metadataSource"].as_str(),
                Some("codex" | "grok" | "ollama" | "zai")
            ) && let Some(family) = normalized(&row["family"])?
            {
                families.insert(family.as_js_string().context("Continuity family")?.clone());
            }
        }
        if families.len() == 1 {
            return Ok(Value::String(families.into_iter().next().unwrap()));
        }
        let mut units = "model:".encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(model.as_js_string().context("Task Worker model")?.units());
        Ok(Value::String(JsString::new(units)))
    }
    pub(super) async fn assert_models(&self, owner: &str, configuration: &Value) -> Result<Value> {
        let root = &configuration["modelId"];
        if !truthy(Some(root)) {
            return conflict(
                "model-unavailable",
                "A Task Worker root model must be selected.",
            );
        }
        let custom = truthy(configuration.get("customSubagentModel"))
            && truthy(configuration.get("subagentModelId"));
        let mut ids = vec![root.clone()];
        if custom && !ids.contains(&configuration["subagentModelId"]) {
            ids.push(configuration["subagentModelId"].clone());
        }
        let ids_wire = Value::Array(
            ids.iter()
                .map(|v| text(v).map(|s| json!(s)))
                .collect::<Result<Vec<_>>>()?,
        )
        .stringify();
        let found=self.database.query("SELECT id FROM model_profiles WHERE owner_id=$1 AND id IN (SELECT jsonb_array_elements_text($2::text::jsonb))",&[&owner,&ids_wire]).await?;
        if found.len() != ids.len() {
            return conflict(
                "model-unavailable",
                "A selected Task Worker model is unavailable.",
            );
        }
        if custom {
            let routes=all(Executor::Database(&self.database),"SELECT json_build_object('modelId',r.model_id,'providerId',r.provider_id)::text FROM model_routes r JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 WHERE r.model_id IN (SELECT jsonb_array_elements_text($2::text::jsonb)) AND r.enabled=true",&[&owner,&ids_wire]).await?;
            let providers = routes
                .iter()
                .filter(|r| r["modelId"] == *root)
                .map(|r| r["providerId"].clone())
                .collect::<Vec<_>>();
            if !routes.iter().any(|r| {
                r["modelId"] == configuration["subagentModelId"]
                    && providers.contains(&r["providerId"])
            }) {
                return conflict(
                    "model-incompatible",
                    "Task Worker root and subagent models must share an enabled provider.",
                );
            }
        }
        Ok(root.clone())
    }
}
