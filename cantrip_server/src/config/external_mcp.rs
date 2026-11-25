//! Explicit public issuer and resource configuration for external MCP.
use super::{AuthMode, ConfigError};
use cantrip_protocol::external_mcp::opaque_secret;

#[derive(Clone, Debug)]
pub struct OAuth {
    pub issuer: String,
    pub resource: String,
    pub bridge_key_hash: String,
}

pub(super) fn read(
    environment: &super::Reader<'_>,
    origin: Option<&str>,
    auth: AuthMode,
) -> Result<Option<OAuth>, ConfigError> {
    let resource = environment.nonempty("CANTRIP_EXTERNAL_MCP_PUBLIC_URL");
    let secret = environment.nonempty("CANTRIP_EXTERNAL_MCP_BRIDGE_KEY");
    if resource.is_none() && secret.is_none() {
        return Ok(None);
    }
    let issuer = origin
        .filter(|origin| origin.starts_with("https://") && auth != AuthMode::None)
        .ok_or_else(|| ConfigError::new("External MCP OAuth requires account authentication and an HTTPS CANTRIP_PUBLIC_ORIGIN."))?;
    let resource = resource
        .and_then(|value| url::Url::parse(&value).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.port_or_known_default().is_some_and(|port| port > 0)
                && url.path() == "/mcp"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .ok_or_else(|| {
            ConfigError::new("CANTRIP_EXTERNAL_MCP_PUBLIC_URL must be the HTTPS /mcp endpoint.")
        })?;
    let secret = secret
        .filter(|value| opaque_secret(value, "ctbk_"))
        .ok_or_else(|| {
            ConfigError::new(
                "Set CANTRIP_EXTERNAL_MCP_BRIDGE_KEY to the private Cantrip bridge credential.",
            )
        })?;
    Ok(Some(OAuth {
        issuer: issuer.to_owned(),
        resource: resource.to_string(),
        bridge_key_hash: crate::auth::crypto::hash_secret(&secret),
    }))
}
