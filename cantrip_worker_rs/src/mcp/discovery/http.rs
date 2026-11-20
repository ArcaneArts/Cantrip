//! Identify running localhost MCP servers through a bounded initialize exchange.
use crate::{browser_services, filesystem::Scope};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use futures::{StreamExt, stream};
use icu_collator::{Collator, options::CollatorOptions};
use reqwest::{Client, StatusCode, Url, header::HeaderValue, redirect::Policy};
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;

const MAX_READ: usize = 128 * 1024;
const MAX_PROBES: usize = 128;
const PROBE_CONCURRENCY: usize = 16;
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(300);

pub(super) async fn discover(scope: &Scope) -> Result<Vec<Value>> {
    let candidates = browser_services::listeners(scope).await?;
    let mut ports = HashSet::new();
    let loopback = candidates
        .into_iter()
        .filter_map(|candidate| {
            let host = candidate.host.parse::<IpAddr>().ok()?;
            let address = match host {
                IpAddr::V4(v4) if v4.is_loopback() => IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6(v6) if v6.is_loopback() => IpAddr::V6(Ipv6Addr::LOCALHOST),
                IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()) => {
                    IpAddr::V4(Ipv4Addr::LOCALHOST)
                }
                _ => return None,
            };
            ports
                .insert(candidate.port)
                .then_some((address, candidate.port))
        })
        .take(MAX_PROBES);
    let client = Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .user_agent("Cantrip-MCP-Discovery/1.0")
        .build()?;
    let mut configurations = stream::iter(loopback)
        .map(|(host, port)| probe(&client, host, port))
        .buffer_unordered(PROBE_CONCURRENCY)
        .filter_map(std::future::ready)
        .collect::<Vec<_>>()
        .await;
    let locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse::<icu_locale_core::Locale>()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| anyhow!("MCP discovery sorting locale: {error}"))?;
    configurations.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            a["name"].as_js_string().unwrap().units(),
            b["name"].as_js_string().unwrap().units(),
        )
    });
    Ok(configurations)
}

async fn probe(client: &Client, host: IpAddr, port: u16) -> Option<Value> {
    let address = std::net::SocketAddr::new(host, port);
    for path in ["/mcp", "/"] {
        let url = Url::parse(&format!("http://{address}{path}")).ok()?;
        let Some((name, version, session)) = initialize(client, &url).await else {
            continue;
        };
        if let Some(session) = session {
            let _ = client
                .delete(url.clone())
                .header("Accept", "application/json, text/event-stream")
                .header("MCP-Protocol-Version", version)
                .header("MCP-Session-Id", session)
                .timeout(CLEANUP_TIMEOUT)
                .send()
                .await;
        }
        return Some(json!({
            "name":configuration_name(&name, port),"enabled":true,"transport":"http",
            "url":url.as_str(),"bearerTokenEnvironmentVariable":Value::Null,
            "headers":json!({}),"environmentHeaders":json!({}),
        }));
    }
    None
}

async fn initialize(client: &Client, url: &Url) -> Option<(JsString, String, Option<HeaderValue>)> {
    let mut response = client
        .post(url.clone())
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .timeout(PROBE_TIMEOUT)
        .body(
            json!({
                "jsonrpc":"2.0","id":1,"method":"initialize",
                "params":json!({
                    "protocolVersion":super::super::rpc::catalog()["protocol"]["latest"],
                    "capabilities":json!({}),
                    "clientInfo":json!({"name":"cantrip-mcp-discovery","version":"1.0.0"}),
                }),
            })
            .stringify(),
        )
        .send()
        .await
        .ok()?;
    if response.status() != StatusCode::OK {
        return None;
    }
    let session = response
        .headers()
        .get("mcp-session-id")
        .filter(|session| !session.is_empty())
        .cloned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_READ {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = cantrip_wire::text::trim(&text);
    let parse = |record: &str| parse_json_text(record).ok().filter(Value::is_object);
    let reply = if text.starts_with('{') {
        parse(text)
    } else {
        text.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(cantrip_wire::text::trim)
            .find_map(parse)
    }?;
    if reply["jsonrpc"] != "2.0" || reply["id"] != json!(1) {
        return None;
    }
    let result = &reply["result"];
    let version = result["protocolVersion"]
        .as_str()
        .filter(|version| !version.is_empty())?
        .to_owned();
    let name = result["serverInfo"]["name"]
        .as_js_string()
        .filter(|name| !name.trim().is_empty())?
        .clone();
    Some((name, version, session))
}

fn configuration_name(name: &JsString, port: u16) -> String {
    let suffix = format!("-{port}");
    let mut base = String::new();
    let mut invalid = false;
    for ch in name
        .lossy()
        .nfkd()
        .filter(|ch| !matches!(ch, '\u{300}'..='\u{36f}'))
    {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            if invalid {
                base.push('-');
                invalid = false;
            }
            base.push(ch);
        } else {
            invalid = true;
        }
    }
    let base = base.trim_matches('-');
    let base = if base.is_empty() { "local-mcp" } else { base };
    format!("{}{suffix}", &base[..base.len().min(100 - suffix.len())])
}
