use super::field;
use crate::{
    codex::{
        catalog::{PROVIDER_CONFIG, auth::Auth},
        managed::{GrokAccount, Launch, Profile},
        private_inference::{Context, Hooks},
    },
    provider_access::{Access, Account},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, value::json};
use std::sync::Arc;
use url::Url;

pub(in crate::codex) fn launch(
    mut profile: Profile,
    provider: Value,
    access: Access,
) -> Result<Launch> {
    let portable = configure(&mut profile, &provider)?;
    Ok(Launch {
        profile,
        private_inference: Hooks {
            overlay: Arc::new(|_| Context::default()),
            provider: Arc::new(move || Some(provider.clone())),
            before_inference: None,
        },
        on_revoked: None,
        prepare_home: None,
        external_auth: portable.map(|account| Arc::new(Auth::new(account, access)) as _),
        observe: Arc::new(|_| Ok(())),
    })
}

pub(in crate::codex) fn model_provider(provider: &Value) -> &'static str {
    match provider["kind"].as_str() {
        Some("chatgpt") => "openai",
        Some("ollama")
            if provider["apiKey"]
                .as_js_string()
                .is_none_or(|key| key.is_empty()) =>
        {
            "ollama"
        }
        _ => "cantrip_runtime",
    }
}

fn configure(profile: &mut Profile, provider: &Value) -> Result<Option<Account>> {
    let kind = provider["kind"].as_str().unwrap_or_default();
    let account = provider["accountId"].as_js_string().map(|id| Account {
        provider: provider["id"]
            .as_js_string()
            .expect("validated provider ID")
            .clone(),
        id: id.clone(),
    });
    let api_key = provider["apiKey"]
        .as_js_string()
        .filter(|value| !value.is_empty());
    profile.diagnostic_policy.secrets.extend(api_key.cloned());
    profile.diagnostic_policy.endpoint = !matches!(kind, "chatgpt" | "grok");
    if kind == "chatgpt" {
        profile.provider_arguments = PROVIDER_CONFIG
            .iter()
            .map(|value| (*value).into())
            .collect();
        profile.account_scope = account
            .as_ref()
            .map(|account| (account.provider.clone(), account.id.clone()));
        return Ok(account);
    }
    if let ("grok", Some(account), Some(key)) =
        (kind, account, provider["credentialHomeKey"].as_js_string())
    {
        profile.grok = Some(GrokAccount {
            account,
            credential_home_key: key.clone(),
            provider_name: field(provider, "name")?.clone(),
        });
        return Ok(None);
    }

    let base = normalize_base_url(&field(provider, "baseUrl")?.lossy())?;
    profile.provider_arguments.extend([
        "web_search=\"disabled\"".into(),
        "features.fast_mode=false".into(),
        "agents.enabled=true".into(),
        "features.multi_agent=true".into(),
    ]);
    if kind == "ollama" && api_key.is_none() {
        profile
            .provider_arguments
            .push("model_provider=\"ollama\"".into());
        profile.provider_environment.insert(
            "CODEX_OSS_BASE_URL".into(),
            base.as_str().trim_end_matches('/').into(),
        );
        return Ok(None);
    }

    let zai = kind == "openai-compatible"
        && base.scheme() == "https"
        && base.host_str() == Some("api.z.ai")
        && base.path() == "/api/v1";
    profile.diagnostic_policy.zai = zai;
    let name = if zai {
        json!("Z.ai Coding Plan")
    } else {
        provider["name"].clone()
    };
    profile.provider_arguments.extend([
        "model_provider=\"cantrip_runtime\"".into(),
        format!("model_providers.cantrip_runtime.name={}", name.stringify()),
        format!(
            "model_providers.cantrip_runtime.base_url={}",
            json!(base.as_str().trim_end_matches('/')).stringify()
        ),
        "model_providers.cantrip_runtime.wire_api=\"responses\"".into(),
    ]);
    // This read-only bootstrap never submits inference. The MLX-LM Responses
    // adapter belongs to the execution path.
    if let Some(key) = api_key {
        profile
            .provider_arguments
            .push("model_providers.cantrip_runtime.env_key=\"CANTRIP_PROVIDER_API_KEY\"".into());
        profile
            .provider_environment
            .insert("CANTRIP_PROVIDER_API_KEY".into(), key.lossy().into_owned());
    }
    Ok(None)
}

pub(in crate::codex) fn normalize_base_url(value: &str) -> Result<Url> {
    let mut url = Url::parse(value).map_err(|_| anyhow!("Invalid provider base URL."))?;
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    let lower = path.to_ascii_lowercase();
    let trimmed = ["/chat/completions", "/chat", "/responses"]
        .iter()
        .find_map(|suffix| lower.strip_suffix(suffix))
        .map_or(path, |prefix| &path[..prefix.len()]);
    if !url.cannot_be_a_base() && trimmed != url.path() {
        let path = trimmed.to_owned();
        url.set_path(&path);
    }
    if url.host_str() == Some("openrouter.ai") && url.path() == "/" {
        url.set_path("/api/v1");
    }
    Ok(url)
}
