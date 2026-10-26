use serde::Serialize;
use serde_json::{Value, json};

use super::{
    ConfigError, Result,
    value::{Reader, length, whitespace},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneLimit {
    pub max_channels: u64,
    pub max_queued_frames: u64,
    pub max_queued_bytes: u64,
    pub max_bytes_per_second: u64,
}

#[derive(Serialize)]
pub struct LaneLimits {
    pub events: LaneLimit,
    pub interactive: LaneLimit,
    pub stream: LaneLimit,
    pub realtime: LaneLimit,
    pub bulk: LaneLimit,
}

#[derive(Serialize)]
pub struct DirectRoutes {
    pub local: bool,
    pub lan: bool,
    pub wan: bool,
}
#[derive(Serialize)]
pub struct InterfacePolicy {
    pub mode: &'static str,
    pub interfaces: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnPolicy {
    pub default_route: &'static str,
    pub lan_allowlist: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConfig {
    pub direct_routes: DirectRoutes,
    pub relay_only: bool,
    pub stun_urls: Vec<String>,
    pub interface_policy: InterfacePolicy,
    pub vpn_policy: VpnPolicy,
    pub negotiation_timeout_ms: u64,
    pub upgrade_probe_timeout_ms: u64,
    pub max_peer_sessions_per_client: u64,
    pub max_peer_sessions_per_worker: u64,
    pub invalid_handshake_rate_per_minute: u64,
    pub lane_limits: LaneLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnConfig {
    pub shared_secret: String,
    pub ttl_seconds: u64,
    pub urls: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebRtcConfig {
    pub ice_transport_policy: String,
    pub negotiation_timeout_ms: u64,
    pub stun_urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnConfig>,
}

fn lane(channels: u64, frames: u64, queue: u64, rate: u64) -> LaneLimit {
    LaneLimit {
        max_channels: channels,
        max_queued_frames: frames,
        max_queued_bytes: queue * 1024 * 1024,
        max_bytes_per_second: rate * 1024 * 1024,
    }
}

fn limits(e: &Reader<'_>) -> Result<LaneLimits> {
    let defaults = LaneLimits {
        events: lane(64, 256, 4, 16),
        interactive: lane(64, 128, 2, 16),
        stream: lane(256, 256, 16, 128),
        realtime: lane(64, 64, 4, 64),
        bulk: lane(32, 128, 16, 64),
    };
    let Some(input) = e.nonempty("CANTRIP_WORKER_LINK_LANE_LIMITS") else {
        return Ok(defaults);
    };
    let parsed: Value = serde_json::from_str(&input)
        .map_err(|_| ConfigError::new("CANTRIP_WORKER_LINK_LANE_LIMITS must be valid JSON."))?;
    let object = parsed.as_object().ok_or_else(|| {
        ConfigError::new("CANTRIP_WORKER_LINK_LANE_LIMITS must be a JSON object.")
    })?;
    let lanes = ["events", "interactive", "stream", "realtime", "bulk"];
    if object.keys().any(|key| !lanes.contains(&key.as_str())) {
        return Err(ConfigError::new(
            "CANTRIP_WORKER_LINK_LANE_LIMITS contains an unknown QoS lane.",
        ));
    }
    let mut merged = serde_json::to_value(&defaults).expect("lane defaults");
    for name in lanes {
        if let Some(override_value) = object.get(name) {
            let overrides = override_value.as_object().ok_or_else(|| {
                ConfigError::new(format!(
                    "CANTRIP_WORKER_LINK_LANE_LIMITS.{name} must be a JSON object."
                ))
            })?;
            if overrides.keys().any(|key| merged[name].get(key).is_none()) {
                return Err(ConfigError::new(format!(
                    "CANTRIP_WORKER_LINK_LANE_LIMITS.{name} contains an unknown field."
                )));
            }
            for (key, value) in overrides {
                merged[name][key] = value.clone();
            }
        }
    }
    let read_lane = |name: &str| -> Result<LaneLimit> {
        let mut values = Vec::new();
        for (field, min, max, exclusive) in [
            ("maxChannels", 0.0, 4096.0, true),
            ("maxQueuedFrames", 0.0, 4096.0, true),
            ("maxQueuedBytes", 65536.0, 67108864.0, false),
            ("maxBytesPerSecond", 65536.0, 1073741824.0, false),
        ] {
            let value = &merged[name][field];
            let message = if let Some(n) = value.as_f64() {
                if n.fract() != 0.0 {
                    Some("Invalid input: expected int, received number".into())
                } else if n.abs() > 9007199254740991.0 {
                    Some(
                        if n < 0.0 {
                            "Too small: expected int to be >=-9007199254740991"
                        } else {
                            "Too big: expected int to be <=9007199254740991"
                        }
                        .into(),
                    )
                } else if n < min || exclusive && n == min {
                    Some(format!(
                        "Too small: expected number to be {}{min}",
                        if exclusive { ">" } else { ">=" }
                    ))
                } else if n > max {
                    Some(format!("Too big: expected number to be <={max}"))
                } else {
                    values.push(n as u64);
                    None
                }
            } else {
                let received = match value {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::String(_) => "string",
                    Value::Array(_) => "array",
                    _ => "object",
                };
                Some(format!(
                    "Invalid input: expected number, received {received}"
                ))
            };
            if let Some(message) = message {
                return Err(ConfigError::new(format!(
                    "Invalid CANTRIP_WORKER_LINK_LANE_LIMITS: {message}"
                )));
            }
        }
        Ok(LaneLimit {
            max_channels: values[0],
            max_queued_frames: values[1],
            max_queued_bytes: values[2],
            max_bytes_per_second: values[3],
        })
    };
    Ok(LaneLimits {
        events: read_lane("events")?,
        interactive: read_lane("interactive")?,
        stream: read_lane("stream")?,
        realtime: read_lane("realtime")?,
        bulk: read_lane("bulk")?,
    })
}

fn array_max(issues: &mut Vec<Value>, path: Vec<Value>, count: usize, maximum: usize) {
    if count > maximum {
        issues.push(json!({"origin":"array","code":"too_big","maximum":maximum,"inclusive":true,"path":path,"message":format!("Too big: expected array to have <={maximum} items")}));
    }
}

fn string_max(issues: &mut Vec<Value>, path: Vec<Value>, text: &str, maximum: usize) {
    if length(text) > maximum {
        issues.push(json!({"origin":"string","code":"too_big","maximum":maximum,"inclusive":true,"path":path,"message":format!("Too big: expected string to have <={maximum} characters")}));
    }
}

fn interface_issues(issues: &mut Vec<Value>, path: &[&str], values: &[String]) {
    for (index, value) in values.iter().enumerate() {
        let mut item_path: Vec<Value> = path.iter().map(|v| json!(v)).collect();
        item_path.push(json!(index));
        string_max(issues, item_path.clone(), value, 200);
        if value.chars().any(|ch| ch <= '\u{001f}' || ch == '\u{007f}') {
            issues.push(json!({"origin":"string","code":"invalid_format","format":"regex","pattern":r"/^[^\u0000-\u001f\u007f]+$/u","path":item_path,"message":r"Invalid string: must match pattern /^[^\u0000-\u001f\u007f]+$/u"}));
        }
    }
    array_max(
        issues,
        path.iter().map(|v| json!(v)).collect(),
        values.len(),
        64,
    );
}

pub(super) fn read(e: &Reader<'_>) -> Result<PeerConfig> {
    let relay_only = e.boolean("CANTRIP_WORKER_LINK_RELAY_ONLY")?;
    let allowlist = e.list("CANTRIP_WORKER_LINK_INTERFACE_ALLOWLIST", &[], true)?;
    let denylist = e.list("CANTRIP_WORKER_LINK_INTERFACE_DENYLIST", &[], true)?;
    if !allowlist.is_empty() && !denylist.is_empty() {
        return Err(ConfigError::new(
            "Configure only one of CANTRIP_WORKER_LINK_INTERFACE_ALLOWLIST or CANTRIP_WORKER_LINK_INTERFACE_DENYLIST.",
        ));
    }
    let wan = !relay_only && e.enabled("CANTRIP_WORKER_LINK_WAN_ENABLED")?;
    let stun_urls = if wan {
        e.list(
            "CANTRIP_WORKER_LINK_STUN_URLS",
            &["stun:stun.cloudflare.com:3478"],
            true,
        )?
    } else {
        Vec::new()
    };
    let config = PeerConfig {
        direct_routes: DirectRoutes {
            local: !relay_only && e.enabled("CANTRIP_WORKER_LINK_LOCAL_ENABLED")?,
            lan: !relay_only && e.enabled("CANTRIP_WORKER_LINK_LAN_ENABLED")?,
            wan,
        },
        relay_only,
        stun_urls,
        interface_policy: if !allowlist.is_empty() {
            InterfacePolicy {
                mode: "allowlist",
                interfaces: allowlist,
            }
        } else if !denylist.is_empty() {
            InterfacePolicy {
                mode: "denylist",
                interfaces: denylist,
            }
        } else {
            InterfacePolicy {
                mode: "default",
                interfaces: Vec::new(),
            }
        },
        vpn_policy: VpnPolicy {
            default_route: "wan",
            lan_allowlist: e.list("CANTRIP_WORKER_LINK_VPN_LAN_ALLOWLIST", &[], true)?,
        },
        negotiation_timeout_ms: e.bounded(
            "CANTRIP_WORKER_LINK_NEGOTIATION_TIMEOUT_MS",
            8000,
            1000,
            30000,
        )?,
        upgrade_probe_timeout_ms: e.bounded(
            "CANTRIP_WORKER_LINK_UPGRADE_PROBE_TIMEOUT_MS",
            15000,
            1000,
            300000,
        )?,
        max_peer_sessions_per_client: e.bounded(
            "CANTRIP_WORKER_LINK_MAX_PEER_SESSIONS_PER_CLIENT",
            4,
            1,
            256,
        )?,
        max_peer_sessions_per_worker: e.bounded(
            "CANTRIP_WORKER_LINK_MAX_PEER_SESSIONS_PER_WORKER",
            32,
            1,
            4096,
        )?,
        invalid_handshake_rate_per_minute: e.bounded(
            "CANTRIP_WORKER_LINK_INVALID_HANDSHAKE_RATE_PER_MINUTE",
            60,
            1,
            10000,
        )?,
        lane_limits: limits(e)?,
    };
    let mut issues = Vec::new();
    for (index, value) in config.stun_urls.iter().enumerate() {
        string_max(
            &mut issues,
            vec![json!("stunUrls"), json!(index)],
            value,
            2048,
        );
        if !(value
            .strip_prefix("stun:")
            .or_else(|| value.strip_prefix("stuns:"))
            .is_some_and(|v| !v.is_empty() && !v.chars().any(whitespace)))
        {
            issues.push(json!({"code":"custom","path":["stunUrls",index],"message":"WorkerLink STUN URLs must use stun: or stuns:."}));
        }
    }
    array_max(
        &mut issues,
        vec![json!("stunUrls")],
        config.stun_urls.len(),
        8,
    );
    interface_issues(
        &mut issues,
        &["interfacePolicy", "interfaces"],
        &config.interface_policy.interfaces,
    );
    interface_issues(
        &mut issues,
        &["vpnPolicy", "lanAllowlist"],
        &config.vpn_policy.lan_allowlist,
    );
    if !issues.is_empty() {
        return Err(ConfigError::zod(issues));
    }
    Ok(config)
}

pub(super) fn web_rtc(e: &Reader<'_>) -> Result<WebRtcConfig> {
    let turn_urls = e.list("CANTRIP_TURN_URLS", &[], false)?;
    let stun_urls = e.list("CANTRIP_STUN_URLS", &[], false)?;
    let shared_secret = e.nonempty("CANTRIP_TURN_SHARED_SECRET");
    if turn_urls.is_empty() == shared_secret.is_some() {
        return Err(ConfigError::new(
            "CANTRIP_TURN_URLS and CANTRIP_TURN_SHARED_SECRET must be configured together.",
        ));
    }
    if turn_urls
        .iter()
        .any(|v| !v.starts_with("turn:") && !v.starts_with("turns:"))
    {
        return Err(ConfigError::new(
            "CANTRIP_TURN_URLS only accepts turn: or turns: URLs.",
        ));
    }
    if stun_urls
        .iter()
        .any(|v| !v.starts_with("stun:") && !v.starts_with("stuns:"))
    {
        return Err(ConfigError::new(
            "CANTRIP_STUN_URLS only accepts stun: or stuns: URLs.",
        ));
    }
    let policy = e.text("CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY", "all");
    let policy = super::value::trim(&policy);
    if !["all", "relay"].contains(&policy) {
        return Err(ConfigError::new(
            "CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY must be all or relay.",
        ));
    }
    if policy == "relay" && turn_urls.is_empty() {
        return Err(ConfigError::new(
            "CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY=relay requires TURN configuration.",
        ));
    }
    Ok(WebRtcConfig {
        ice_transport_policy: policy.into(),
        negotiation_timeout_ms: e.bounded(
            "CANTRIP_WEBRTC_NEGOTIATION_TIMEOUT_MS",
            8000,
            1000,
            30000,
        )?,
        stun_urls,
        turn: if let Some(shared_secret) = shared_secret {
            Some(TurnConfig {
                urls: turn_urls,
                shared_secret,
                ttl_seconds: e.bounded("CANTRIP_TURN_TTL_SECONDS", 600, 60, 3600)?,
            })
        } else {
            None
        },
    })
}
