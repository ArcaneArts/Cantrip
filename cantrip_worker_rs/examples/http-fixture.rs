//! Synthetic HTTP oracle driver; never use with a real worker profile.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    config::{self, Host},
    http,
    logging::Logs,
};
use std::{
    io::{self, BufRead},
    path::Path,
};
#[tokio::main]
async fn main() -> Result<()> {
    let line = io::stdin().lock().lines().next().unwrap()?;
    let input = parse_json_text(&line).map_err(|e| anyhow!("{e}"))?;
    let data = Path::new(input["directory"].as_str().unwrap());
    let code = input["code"].as_str().unwrap_or("");
    let mut environment: cantrip_config::Environment = [
        (
            "CANTRIP_WORKER_DATA_DIR".into(),
            data.to_string_lossy().into_owned(),
        ),
        ("CANTRIP_WORKER_ID".into(), "fixture-worker".into()),
        (
            "CANTRIP_SERVER_URL".into(),
            input["serverUrl"].as_str().unwrap().into(),
        ),
        ("NO_COLOR".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    if !code.is_empty() {
        environment.insert("CANTRIP_WORKER_ENROLLMENT_CODE".into(), code.into());
    } else {
        environment.insert(
            "CANTRIP_WORKER_CREDENTIAL".into(),
            format!("ctwk_{}", "a".repeat(43)),
        );
    }
    let mut config = config::read(
        &environment,
        &Host {
            cwd: data,
            worker_root: data,
            platform: "darwin",
            architecture: "arm64",
            hostname: "fixture",
        },
    )?;
    if input["replacement"].is_object() {
        config.replacement = Some(config::Replacement {
            worker_id: input["replacement"]["workerId"].as_str().unwrap().into(),
            credential: input["replacement"]["credential"].as_str().unwrap().into(),
        });
    }
    let logs = Logs::initialize(data, &environment, data).await;
    let client = http::client()?;
    let result = if input["operation"] == "enroll" {
        http::enroll(&client,&mut config,&input["heartbeat"],&logs).await.map(|_|json!({"token":config.token,"tokenSource":config.token_source,"enrollmentCode":config.enrollment_code,"replacement":config.replacement.map(|r|json!({"workerId":r.worker_id,"credential":r.credential}))}))
    } else {
        http::send_heartbeat(
            &client,
            &config.server_url,
            &config.token,
            &input["heartbeat"],
        )
        .await
        .map(|v| v.unwrap_or(Value::Null))
    };
    logs.close().await;
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        }
        .stringify()
    );
    Ok(())
}
