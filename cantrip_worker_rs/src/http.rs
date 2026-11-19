//! Enrollment and heartbeat use the existing generated contracts and wire JSON.
use crate::{
    config::Config,
    credentials::{self, Credential},
    logging::{self, Logs},
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{Value, parse_json_text, value::json};

pub fn checked(schema: &str, value: &Value) -> Result<Value> {
    cantrip_protocol::parse(schema, Some(value)).map_err(cantrip_protocol::response::response_error)
}
pub fn heartbeat(
    config: &Config,
    platform: &str,
    architecture: &str,
    started_at: &str,
) -> Result<Value> {
    // Schema defaults advertise unavailable facilities during incremental native
    // implementation. Each real subsystem supplies its capabilities when added.
    checked(
        "workerHeartbeatSchema",
        &json!({
            "workerId": config.worker_id,
            "name": config.name,
            "platform": platform,
            "architecture": architecture,
            "codexVersion": Value::Null,
            "startedAt": started_at,
            "managedFolders": json!({
                "create":true,"remove":true,"attachExisting":true,"workspaceScopedRoots":true,
                "attachWorkspaceRoot":true,"discoverWorkspaceRepositories":true,
            }),
            "standaloneChat": json!({
                "protocolVersion": 1,
                "scratch": json!({
                    "provision":true,"resolve":true,"archive":true,"restore":true,
                    "remove":true,"reconcile":true,"routingHandles":true,
                }),
                "files": json!({
                    "list":false,"read":false,"write":false,"remove":false,"download":false,
                    "archive":false,"networkShare":false,
                }),
            }),
        }),
    )
}
pub fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(20))
        .timeout(std::time::Duration::from_secs(15))
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .build()?)
}
pub async fn enroll(
    client: &reqwest::Client,
    config: &mut Config,
    heartbeat: &Value,
    logs: &Logs,
) -> Result<()> {
    let Some(code) = config.enrollment_code.as_ref() else {
        logs.event("debug","Existing worker credential selected",json!({"event":"worker.enrollment.not-required","workerId":config.worker_id,"credentialState":config.token_source}));
        return Ok(());
    };
    let began = std::time::Instant::now();
    logs.event("info","Worker enrollment started",json!({"event":"worker.enrollment.started","subsystem":"worker-auth","operation":"enroll","status":"started","workerId":config.worker_id,"serverOrigin":url::Url::parse(&config.server_url)?.origin().ascii_serialization()}));
    let replacement = config
        .replacement
        .as_ref()
        .map(|r| json!({"workerId":r.worker_id,"credential":r.credential}));
    let body = checked(
        "workerEnrollmentExchangeSchema",
        &json!({"code":code,"heartbeat":heartbeat,"replacement":replacement}),
    )?;
    let response = match client
        .post(format!("{}/api/internal/workers/enroll", config.server_url))
        .header("content-type", "application/json")
        .body(body.stringify())
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let error = anyhow!(error);
            logs.event("error","Worker enrollment request failed",json!({"event":"worker.enrollment.failed","workerId":config.worker_id,"error":logging::error(&error)}));
            return Err(error);
        }
    };
    let status = response.status();
    let payload = response
        .bytes()
        .await
        .ok()
        .and_then(|bytes| {
            let text = String::from_utf8_lossy(&bytes);
            parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
        })
        .unwrap_or(Value::Null);
    if !status.is_success() {
        logs.event("warn","Worker enrollment was rejected",json!({"event":"worker.enrollment.rejected","workerId":config.worker_id,"httpStatus":status.as_u16()}));
        bail!(
            "{}",
            payload["error"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!(
                    "Cantrip Server rejected worker enrollment with HTTP {}.",
                    status.as_u16()
                ))
        );
    }
    let enrolled = checked("workerEnrollmentResultSchema", &payload)?;
    if enrolled["worker"]["workerId"] != json!(config.worker_id) {
        bail!("Cantrip Server returned a mismatched worker identity.");
    }
    let credential = enrolled["credential"]
        .as_str()
        .ok_or_else(|| anyhow!("Missing enrolled credential"))?
        .to_owned();
    credentials::save(
        &config.data_directory,
        &Credential {
            credential: credential.clone(),
            server_url: config.server_url.clone(),
            worker_id: config.worker_id.clone(),
        },
    )?;
    config.token = credential;
    config.token_source = "persisted";
    config.enrollment_code = None;
    config.replacement = None;
    logs.event("info","Worker enrollment completed",json!({"event":"worker.enrollment.completed","subsystem":"worker-auth","operation":"enroll","status":"completed","durationMs":began.elapsed().as_millis() as u64,"workerId":config.worker_id,"credentialState":"persisted"}));
    Ok(())
}
pub async fn send_heartbeat(
    client: &reqwest::Client,
    server_url: &str,
    token: &str,
    heartbeat: &Value,
) -> Result<Option<Value>> {
    let mut response = client
        .post(format!("{server_url}/api/internal/workers/heartbeat"))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(heartbeat.stringify())
        .send()
        .await?;
    if !response.status().is_success() {
        bail!(
            "Cantrip Server rejected heartbeat with HTTP {}.",
            response.status().as_u16()
        );
    }
    if matches!(response.status().as_u16(), 204 | 205) {
        bail!("Cantrip MCP response body is missing.");
    }
    const MAX: usize = 256 * 1024;
    if response.content_length().is_some_and(|v| v > MAX as u64) {
        bail!("Cantrip MCP response is too large.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX {
            bail!("Cantrip MCP response is too large.");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        bail!("Cantrip MCP response body is empty.");
    }
    let value = parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(|e| anyhow!("{e}"))?;
    value
        .get("computerUseEffects")
        .map(|v| checked("cuaEffectPreferencesSchema", v))
        .transpose()
}
