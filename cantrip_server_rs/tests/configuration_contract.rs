use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::config::{DatabaseMode, Environment, ServerConfig};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

#[test]
fn configuration_matches_actual_node_values_and_errors() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let output=Command::new("node").args(["--import","tsx","scripts/server-rust/config-cases.mjs"]).current_dir(&root).output().context("execute Node configuration oracle (pnpm dependencies and shared packages must be built)")?;
    anyhow::ensure!(
        output.status.success(),
        "configuration oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let baseline: Value = serde_json::from_slice(&output.stdout)?;
    let cwd = PathBuf::from(baseline["cwd"].as_str().unwrap());
    let mut results = Vec::new();
    let mut mismatches = Vec::new();
    for scenario in baseline["results"].as_array().unwrap() {
        let environment: Environment = serde_json::from_value(scenario["environment"].clone())?;
        let actual = match ServerConfig::read(&environment, &cwd) {
            Ok(configuration) => {
                json!({"accepted":true,"configuration":serde_json::to_value(configuration)?})
            }
            Err(error) => {
                json!({"accepted":false,"error":{"name":error.name,"message":error.message}})
            }
        };
        let mut expected = scenario.clone();
        expected.as_object_mut().unwrap().remove("name");
        expected.as_object_mut().unwrap().remove("environment");
        let mut actual_comparison = actual.clone();
        // Zod error strings contain JSON. Compare every issue and field without
        // requiring Rust's JSON formatter to choose the same object key order.
        if expected["error"]["name"] == "ZodError"
            && actual_comparison["error"]["name"] == "ZodError"
        {
            for value in [&mut expected, &mut actual_comparison] {
                value["error"]["message"] =
                    serde_json::from_str(value["error"]["message"].as_str().unwrap())?;
            }
        }
        let matched = expected == actual_comparison;
        results.push(json!({"name":scenario["name"],"passed":matched}));
        if !matched {
            mismatches.push(
                json!({"name":scenario["name"],"expected":expected,"actual":actual_comparison}),
            );
        }
    }
    let directory = root.join(".qa/rust-server");
    std::fs::create_dir_all(&directory)?;
    std::fs::write(
        directory.join("node-configuration-oracle.json"),
        &output.stdout,
    )?;
    std::fs::write(
        directory.join("configuration-contract.json"),
        serde_json::to_vec_pretty(
            &json!({"suite":"configuration","completeReplacement":false,"cases":results,"mismatches":mismatches}),
        )?,
    )?;
    if !mismatches.is_empty() {
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&mismatches.iter().take(8).collect::<Vec<_>>())?
        );
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} configuration scenarios differed; full evidence in .qa/rust-server/configuration-contract.json",
        mismatches.len(),
        results.len()
    );
    println!(
        "{} Node/Rust configuration scenarios matched",
        results.len()
    );
    Ok(())
}

#[test]
fn explicit_storage_selection_preserves_hosted_security() -> Result<()> {
    let cwd = std::env::current_dir()?;
    for deployment in ["local", "hosted"] {
        for backend in ["pglite", "bundled-postgres", "postgres"] {
            let mut environment: Environment = serde_json::from_value(json!({
                "CANTRIP_DEPLOYMENT_MODE":deployment,
                "CANTRIP_BOOTSTRAP_MODE":if deployment=="hosted"{"hosted"}else{"standalone"},
                "CANTRIP_AUTH_MODE":"accounts",
                "CANTRIP_ADMIN_EMAIL":"fixture@example.invalid",
                "CANTRIP_APP_ORIGINS":"https://app.example.invalid",
                "CANTRIP_PUBLIC_ORIGIN":"https://api.example.invalid",
                "CANTRIP_TRUSTED_PROXIES":"loopback",
                "CANTRIP_SECRET_ENCRYPTION_KEYS":json!({"fixture":STANDARD.encode([17;32])}).to_string(),
                "CANTRIP_DATABASE_MODE":backend
            }))?;
            if backend == "postgres" {
                environment.insert(
                    "DATABASE_URL".into(),
                    "postgres://fixture:synthetic@example.invalid/fixture".into(),
                );
            }
            let config = ServerConfig::read(&environment, &cwd)?;
            assert!(match backend {
                "pglite" => matches!(config.database_mode, DatabaseMode::Pglite),
                "bundled-postgres" => matches!(config.database_mode, DatabaseMode::BundledPostgres),
                _ => matches!(config.database_mode, DatabaseMode::Postgres),
            });
            if deployment == "hosted" {
                environment.insert("CANTRIP_AUTH_MODE".into(), "none".into());
                assert!(
                    ServerConfig::read(&environment, &cwd)
                        .err()
                        .unwrap()
                        .message
                        .starts_with("Hosted deployments require CANTRIP_AUTH_MODE=")
                );
                environment.insert("CANTRIP_AUTH_MODE".into(), "accounts".into());
                environment.remove("CANTRIP_TRUSTED_PROXIES");
                assert_eq!(
                    ServerConfig::read(&environment, &cwd)
                        .err()
                        .unwrap()
                        .message,
                    "Hosted deployments require explicit CANTRIP_TRUSTED_PROXIES."
                );
            }
        }
    }
    let environment = Environment::from([(
        "DATABASE_URL".into(),
        "postgres://fixture@example.invalid/db".into(),
    )]);
    assert!(matches!(
        ServerConfig::read(&environment, &cwd)?.database_mode,
        DatabaseMode::Postgres
    ));
    let mut explicit = environment;
    explicit.insert("CANTRIP_DATABASE_MODE".into(), "pglite".into());
    assert!(matches!(
        ServerConfig::read(&explicit, &cwd)?.database_mode,
        DatabaseMode::Pglite
    ));
    Ok(())
}

fn executable() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-server"));
    for (name, _) in std::env::vars() {
        if name.starts_with("CANTRIP_") || ["DATABASE_URL", "REDIS_URL"].contains(&name.as_str()) {
            command.env_remove(name);
        }
    }
    command
}

#[test]
fn executable_applies_configuration_before_storage_and_preserves_cli_overrides() -> Result<()> {
    let root = tempfile::Builder::new()
        .prefix("cantrip configuration ")
        .tempdir()?;
    let rejected = executable()
        .arg("--migrate-only")
        .env("CANTRIP_DATA_DIR", root.path().join("rejected"))
        .env("CANTRIP_DEPLOYMENT_MODE", "hosted")
        .output()?;
    assert!(!rejected.status.success());
    assert!(
        String::from_utf8_lossy(&rejected.stderr)
            .contains("Hosted deployments require CANTRIP_AUTH_MODE=")
    );
    assert!(!root.path().join("rejected").exists());
    let output = executable()
        .args([
            "--migrate-only",
            "--port",
            "0",
            "--host",
            "127.0.0.1",
            "--data-dir",
            "data space",
        ])
        .env("CANTRIP_SERVER_HOST", "0.0.0.0")
        .env("CANTRIP_SERVER_PORT", "bad")
        .env("CANTRIP_DATA_DIR", root.path().join("overridden"))
        .current_dir(root.path())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "CLI override migration failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.path().join("overridden").exists());
    assert!(root.path().join("data space/server-db").is_dir());
    let reopened = executable()
        .arg("--migrate-only")
        .env("CANTRIP_DATA_DIR", "ignored/../data space")
        .current_dir(root.path())
        .output()?;
    anyhow::ensure!(
        reopened.status.success(),
        "relative environment path reopen failed: {}",
        String::from_utf8_lossy(&reopened.stderr)
    );
    Ok(())
}

#[tokio::test]
async fn serving_process_identity_matches_http_and_respects_configuration() -> Result<()> {
    async fn observe(
        directory: &std::path::Path,
        configured: Option<&str>,
    ) -> Result<(String, String)> {
        use std::{process::Stdio, time::Duration};
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut command = tokio::process::Command::from(executable());
        command
            .args([
                "--port",
                "0",
                "--database",
                "pglite",
                "--shutdown-on-stdin-close",
            ])
            .env("CANTRIP_DATA_DIR", directory)
            .env("CANTRIP_SERVER_HOST", "127.0.0.1")
            .env("CANTRIP_DEPLOYMENT_MODE", "local")
            .env("CANTRIP_AUTH_MODE", "none")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        if let Some(id) = configured {
            command.env("CANTRIP_SERVER_INSTANCE_ID", id);
        }
        let mut child = command.spawn()?;
        let mut lines = BufReader::new(child.stdout.take().context("server output")?).lines();
        let origin = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(line) = lines.next_line().await? {
                if let Ok(event) = serde_json::from_str::<Value>(&line)
                    && event["event"] == "server.listening"
                {
                    return Ok::<_, anyhow::Error>(
                        event["origin"]
                            .as_str()
                            .context("listener origin")?
                            .to_owned(),
                    );
                }
            }
            anyhow::bail!("Server exited before announcing its listener");
        })
        .await??;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        async fn get(client: &reqwest::Client, url: String) -> Result<Value> {
            let body = client
                .get(url)
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?;
            Ok(serde_json::from_str(&body)?)
        }
        let health = get(&client, format!("{origin}/api/health")).await?;
        let traffic = get(&client, format!("{origin}/api/account/live-traffic")).await?;
        let bootstrap = get(&client, format!("{origin}/api/bootstrap")).await?;
        assert_eq!(health["operations"]["instanceId"], traffic["instanceId"]);
        let instance = traffic["instanceId"]
            .as_str()
            .context("instance ID")?
            .to_owned();
        let installation = bootstrap["server"]["id"]
            .as_str()
            .context("installation ID")?
            .to_owned();

        drop(child.stdin.take());
        assert!(
            tokio::time::timeout(Duration::from_secs(30), child.wait())
                .await??
                .success()
        );
        Ok((instance, installation))
    }

    let directory = tempfile::tempdir()?;
    let first = observe(directory.path(), None).await?;
    let second = observe(directory.path(), None).await?;
    for id in [&first.0, &second.0] {
        assert_eq!(uuid::Uuid::parse_str(id)?.get_version_num(), 4);
    }
    assert_ne!(first.0, second.0);
    assert_eq!(first.1, second.1);
    let configured = observe(directory.path(), Some("local-configured-server")).await?;
    assert_eq!(configured, ("local-configured-server".into(), first.1));
    Ok(())
}
