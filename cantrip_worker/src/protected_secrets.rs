//! Actual provider/MCP secret formats from the Node worker. These functions do
//! not log decrypted content or authorize resources from relay metadata.
use crate::encryption::{BoundComponentKey, Service};
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::{
    blind_lookup_tag, checked,
    content::{decrypt_secret, encrypt_secret},
    derive_lookup_key,
};
use cantrip_wire::{JsString, Value, coercion::truthy, value::json};

fn context(
    grant: &BoundComponentKey,
    component: &str,
    table: &str,
    row: &Value,
    field: &str,
    revision: &Value,
) -> Value {
    json!({"ownerId":grant.owner_id,"component":component,"table":table,"rowId":row,"field":field,"keyRevision":revision})
}
fn set(value: &mut Value, field: &str, item: Value) -> Result<()> {
    let Value::Object(fields) = value else {
        bail!("Expected a secret-bearing object.");
    };
    fields.insert(field.into(), item);
    Ok(())
}
pub fn open_runtime_provider(service: &Service, provider: &Value) -> Result<Value> {
    let mut result = provider.clone();
    if !truthy(provider.get("protectedApiKey")) {
        set(&mut result, "apiKey", Value::Null)?;
        return Ok(result);
    }
    let grant = service.bound_component("provider-credential", None)?;
    let encrypted = &provider["protectedApiKey"];
    let aad = context(
        &grant,
        "provider-credential",
        "model_providers",
        &provider["id"],
        "protected_api_key",
        &encrypted["keyRevision"],
    );
    let content = decrypt_secret(
        &grant.component.key,
        &aad,
        encrypted,
        "providerApiKeyProtectedContentSchema",
        Some(16 * 1024),
    )?;
    set(&mut result, "apiKey", content["apiKey"].clone())?;
    Ok(result)
}
pub fn open_mcp_servers(service: &Service, servers: &[Value]) -> Result<Vec<Value>> {
    let enabled: Vec<_> = servers
        .iter()
        .filter(|s| truthy(s.get("enabled")))
        .collect();
    if enabled.is_empty() {
        return Ok(Vec::new());
    }
    // Node starts every Promise.all map prefix before awaiting decryption.
    // Retain a single matching key/account epoch through the native batch.
    let grant = service.bound_component("mcp-secret", None)?;
    enabled
        .into_iter()
        .map(|server| {
            let encrypted = &server["protectedConfiguration"];
            let aad = context(
                &grant,
                "mcp-secret",
                "mcp_servers",
                &server["id"],
                "protected_configuration",
                &encrypted["keyRevision"],
            );
            let mut configuration = decrypt_secret(
                &grant.component.key,
                &aad,
                encrypted,
                "mcpServerConfigurationSchema",
                Some(1024 * 1024),
            )?;
            set(&mut configuration, "enabled", server["enabled"].clone())?;
            checked("mcpServerConfigurationSchema", &configuration)
        })
        .collect()
}
pub(crate) fn is_managed_mcp_name(name: &JsString) -> bool {
    matches!(
        name.trim().lowercase().as_str(),
        Some("codegraph" | "cantrip" | "cantrip_cua")
    )
}

pub fn protect_discovered_mcp(
    service: &Service,
    worker: &Value,
    configuration: &Value,
) -> Result<Value> {
    let configuration = importable_mcp_configuration(configuration)?;
    let grant = service.bound_component("mcp-secret", None)?;
    seal_discovered_mcp(&grant, worker, &configuration)
}

pub(crate) fn protect_discovered_mcp_for_grant(
    grant: &BoundComponentKey,
    worker: &Value,
    configuration: &Value,
) -> Result<Value> {
    let configuration = importable_mcp_configuration(configuration)?;
    seal_discovered_mcp(grant, worker, &configuration)
}

fn importable_mcp_configuration(configuration: &Value) -> Result<Value> {
    let mut configuration = configuration.clone();
    set(&mut configuration, "enabled", json!(true))?;
    let configuration = checked("mcpServerConfigurationSchema", &configuration)?;
    if is_managed_mcp_name(configuration["name"].as_js_string().unwrap()) {
        bail!("Managed MCP server names cannot be imported.");
    }
    Ok(configuration)
}

fn seal_discovered_mcp(
    grant: &BoundComponentKey,
    worker: &Value,
    configuration: &Value,
) -> Result<Value> {
    let id = json!(uuid::Uuid::new_v4().to_string());
    let lookup_context = context(
        grant,
        "mcp-secret",
        "mcp_servers",
        &id,
        "name",
        &json!(grant.component.key_revision),
    );
    let lookup = derive_lookup_key(&grant.component.key, &lookup_context)?;
    let secret_context = context(
        grant,
        "mcp-secret",
        "mcp_servers",
        &id,
        "protected_configuration",
        &json!(grant.component.key_revision),
    );
    let encrypted = encrypt_secret(
        &grant.component.key,
        &secret_context,
        configuration,
        "mcpServerConfigurationSchema",
        Some(1024 * 1024),
    )?;
    checked(
        "encryptedMcpServerCreateSchema",
        &json!({"id":id,"enabled":true,"workerId":worker,"nameBlindIndex":blind_lookup_tag(&lookup,&configuration["name"].as_js_string().unwrap().lowercase())?,"protectedConfiguration":encrypted}),
    )
}
fn subject(credential: &Value) -> Result<JsString> {
    let kind = cantrip_protocol::property(Some(credential), "kind")?;
    let (prefix, field) = if kind == Some(&json!("chatgpt")) {
        ("chatgpt:", "accountId")
    } else {
        ("grok:", "userId")
    };
    let id = match cantrip_protocol::property(Some(credential), field)? {
        Some(value) => cantrip_wire::coercion::string(value)
            .map_err(|_| anyhow!("Cannot convert object to primitive value"))?,
        None => JsString::from("undefined"),
    };
    let mut units: Vec<_> = prefix.encode_utf16().collect();
    units.extend_from_slice(id.units());
    Ok(JsString::new(units))
}
fn subject_tag(grant: &BoundComponentKey, credential: &Value) -> Result<String> {
    let aad = context(
        grant,
        "provider-credential",
        "model_provider_accounts",
        &Value::Null,
        "subject",
        &json!(grant.component.key_revision),
    );
    let lookup = derive_lookup_key(&grant.component.key, &aad)?;
    blind_lookup_tag(&lookup, &subject(credential)?)
}
pub fn protect_provider_credential(
    service: &Service,
    account: &Value,
    credential: &Value,
) -> Result<Value> {
    let credential = checked("providerCredentialProtectedContentSchema", credential)?;
    let grant = service.bound_component("provider-credential", None)?;
    let tag = subject_tag(&grant, &credential)?;
    let aad = context(
        &grant,
        "provider-credential",
        "model_provider_accounts",
        account,
        "protected_credential",
        &json!(grant.component.key_revision),
    );
    let encrypted = encrypt_secret(
        &grant.component.key,
        &aad,
        &credential,
        "providerCredentialProtectedContentSchema",
        None,
    )?;
    let protected = checked(
        "protectedProviderCredentialSchema",
        &json!({"subjectBlindIndex":tag,"protectedCredential":encrypted}),
    )?;
    let expires = if let Some(value) = credential["expiresAt"].as_f64() {
        if value.abs() > 8_640_000_000_000_000.0 {
            bail!("Invalid time value");
        }
        json!(
            cantrip_wire::date::iso_milliseconds(value as i64)
                .ok_or_else(|| anyhow!("Invalid time value"))?
        )
    } else {
        Value::Null
    };
    let metadata = checked(
        "providerCredentialPublicMetadataSchema",
        &json!({"expiresAt":expires}),
    )?;
    Ok(json!({"credential":protected,"metadata":metadata}))
}
pub fn open_provider_credential(
    service: &Service,
    account: &Value,
    protected: &Value,
) -> Result<Value> {
    let grant = service.bound_component("provider-credential", None)?;
    let encrypted = &protected["protectedCredential"];
    let aad = context(
        &grant,
        "provider-credential",
        "model_provider_accounts",
        account,
        "protected_credential",
        &encrypted["keyRevision"],
    );
    let credential = decrypt_secret(
        &grant.component.key,
        &aad,
        encrypted,
        "providerCredentialProtectedContentSchema",
        None,
    )?;
    if json!(subject_tag(&grant, &credential)?) != protected["subjectBlindIndex"] {
        bail!("Provider credential identity binding is invalid.");
    }
    Ok(credential)
}
pub fn provider_subject_blind_index(service: &Service, credential: &Value) -> Result<String> {
    let grant = service.bound_component("provider-credential", None)?;
    subject_tag(&grant, credential)
}
