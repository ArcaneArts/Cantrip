//! TURN REST credentials match the existing time-limited HMAC-SHA1 contract.
use crate::{
    config::WebRtcConfig,
    wire::{Value, value::json},
};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
pub fn configuration(config: &WebRtcConfig, owner: &str, now_ms: i64) -> Result<Value> {
    let mut servers = Vec::new();
    if !config.stun_urls.is_empty() {
        servers.push(json!({"urls":config.stun_urls}));
    }
    if let Some(turn) = &config.turn {
        let expires = now_ms.div_euclid(1000) + turn.ttl_seconds as i64;
        let username = format!("{expires}:{owner}");
        let mut mac = Hmac::<sha1::Sha1>::new_from_slice(turn.shared_secret.as_bytes())?;
        mac.update(username.as_bytes());
        servers.push(json!({"urls":turn.urls,"username":username,"credential":STANDARD.encode(mac.finalize().into_bytes())}));
    }
    crate::settings::parse_response(
        "remoteSurfaceWebRtcConfigurationSchema",
        Some(
            &json!({"iceServers":servers,"iceTransportPolicy":config.ice_transport_policy,"negotiationTimeoutMs":config.negotiation_timeout_ms}),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Environment, ServerConfig};
    #[test]
    fn turn_credentials_match_source_across_clock_boundaries_and_unicode() -> Result<()> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let result = std::process::Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/remote-surface-webrtc-oracle.mjs",
            ])
            .current_dir(root)
            .output()?;
        anyhow::ensure!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let cases: Vec<serde_json::Value> = serde_json::from_slice(&result.stdout)?;
        assert_eq!(cases.len(), 30);
        for case in cases {
            let environment: Environment = serde_json::from_value(case["environment"].clone())?;
            let config = ServerConfig::read(&environment, root)?;
            assert_eq!(
                configuration(
                    &config.remote_surface_web_rtc,
                    case["owner"].as_str().unwrap(),
                    case["now"].as_i64().unwrap()
                )?,
                Value::from_serialize(&case["expected"])
            );
        }
        Ok(())
    }
}
