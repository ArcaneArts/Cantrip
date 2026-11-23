use anyhow::{Context, Result};
use cantrip_server::{
    auth::{self, UserRole, crypto, service::AuthService},
    config::{Environment, ServerConfig},
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

fn configuration() -> Result<ServerConfig> {
    Ok(ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "accounts".into()),
            ("CANTRIP_LICENSE_WHITELIST_ENABLED".into(), "false".into()),
            ("CANTRIP_COOKIE_SECURE".into(), "true".into()),
            ("CANTRIP_COOKIE_SAME_SITE".into(), "none".into()),
            ("CANTRIP_SESSION_TTL_SECONDS".into(), "3600".into()),
        ]),
        &std::env::current_dir()?,
    )?)
}

async fn exercise(database: Arc<Database>) -> Result<Value> {
    migrate(&database).await?;
    let service = AuthService::initialize(database.clone(), Arc::new(configuration()?)).await?;
    let repo = &service.repository;
    assert_eq!(repo.count_accounts().await?, 0);
    let user = repo
        .create_account(
            "Fixture Owner",
            "Owner@example.invalid",
            "owner@example.invalid",
            crypto::DUMMY_PASSWORD_HASH,
            "owner",
        )
        .await?;
    repo.settings(&user.id).await?;
    assert_eq!(repo.count_accounts().await?, 1);
    let credential = repo
        .credential("owner@example.invalid", false)
        .await?
        .unwrap();
    assert_eq!(credential.0.id, user.id);
    assert_eq!(credential.1, crypto::DUMMY_PASSWORD_HASH);
    assert!(
        repo.credential("missing@example.invalid", false)
            .await?
            .is_none()
    );
    assert!(!repo.whitelisted("owner@example.invalid").await?);
    let workspace=database.query("SELECT w.id,p.kind,w.is_default FROM project_workspaces w JOIN project_workspace_storage_profiles p ON p.workspace_id=w.id WHERE w.owner_id=$1",&[&user.id]).await?;
    assert_eq!(
        workspace[0].get::<String>(0)?,
        format!("workspace:default:{}", user.id)
    );
    assert_eq!(workspace[0].get::<String>(1)?, "system");
    assert!(workspace[0].get::<bool>(2)?);
    assert_eq!(
        database
            .query(
                "SELECT default_permission_profile_id FROM user_settings WHERE user_id=$1",
                &[&user.id]
            )
            .await?[0]
            .get::<String>(0)?,
        ":workspace"
    );
    let (first, cookies) = service
        .create_session(user.clone(), "account-password")
        .await?;
    assert_eq!(cookies.len(), 2);
    let cookie = cookies[0].split(';').next().unwrap();
    let mut resolved = service.resolve(Some(cookie)).await?.unwrap();
    assert_eq!(
        resolved.state().csrf_token.as_ref().unwrap(),
        first["csrfToken"].as_str().unwrap()
    );
    let hashes = database
        .query(
            "SELECT token_hash,csrf_token_hash FROM user_sessions WHERE id=$1",
            &[&resolved.session.id],
        )
        .await?;
    let raw = cookie.split_once('=').unwrap().1;
    assert_eq!(hashes[0].get::<String>(0)?, crypto::hash_secret(raw));
    assert_eq!(
        hashes[0].get::<String>(1)?,
        crypto::hash_secret(first["csrfToken"].as_str().unwrap())
    );
    database
        .query(
            "UPDATE user_sessions SET csrf_token_hash='legacy-csrf' WHERE id=$1",
            &[&resolved.session.id],
        )
        .await?;
    resolved = service.resolve(Some(cookie)).await?.unwrap();
    assert_eq!(
        resolved.session.csrf_token_hash,
        crypto::hash_secret(&resolved.csrf_token)
    );
    let (_, second) = service
        .create_session(user.clone(), "account-password")
        .await?;
    let conflict = format!(
        "{}; {}",
        cookies[0].split(';').next().unwrap(),
        second[1].split(';').next().unwrap()
    );
    assert!(
        service
            .resolve(Some(&conflict))
            .await
            .err()
            .unwrap()
            .is::<auth::service::ConflictingSessionCookies>()
    );
    let generated = crypto::mobile_code()?;
    repo.mobile_grant(
        &user.id,
        &resolved.session.id,
        &generated.code_hash,
        chrono::Utc::now() + chrono::Duration::minutes(2),
    )
    .await?;
    let mut attempts = Vec::new();
    for _ in 0..12 {
        let repo = repo.clone();
        let hash = generated.code_hash.clone();
        attempts.push(tokio::spawn(async move {
            repo.consume_mobile_grant(&hash).await
        }));
    }
    let mut successes = 0;
    for attempt in attempts {
        if attempt.await??.is_some() {
            successes += 1;
        }
    }
    assert_eq!(successes, 1);
    let generated = crypto::mobile_code()?;
    repo.mobile_grant(
        &user.id,
        &resolved.session.id,
        &generated.code_hash,
        chrono::Utc::now() + chrono::Duration::minutes(2),
    )
    .await?;
    let mut revocations = service.revocations.subscribe();
    assert_eq!(
        service
            .revoke(&resolved.session.id, false, "signed-out")
            .await?,
        1
    );
    assert!(
        matches!(revocations.recv().await?,auth::service::Revocation::Session(Some(id)) if id==resolved.session.id)
    );
    assert!(service.resolve(Some(cookie)).await?.is_none());
    assert!(
        repo.consume_mobile_grant(&generated.code_hash)
            .await?
            .is_none()
    );
    assert_eq!(service.revoke(&user.id, true, "signed-out-all").await?, 1);
    let (retained, cookies) = service
        .create_session(user.clone(), "account-password")
        .await?;
    assert!(
        database
            .query("SELECT 'private-sql-sentinel'::integer", &[])
            .await
            .is_err()
    );
    // A configured administrator is synchronized without touching other users.
    let mut config = configuration()?;
    config.admin_email = Some("admin@example.invalid".into());
    config.admin_password = Some("synthetic admin password".into());
    repo.configured_administrator(&config, &service.passwords)
        .await?;
    let admin = repo
        .credential("admin@example.invalid", false)
        .await?
        .unwrap()
        .0;
    assert!(admin.role == UserRole::Admin);
    let (_, admin_cookies) = service.create_session(admin, "account-password").await?;
    let admin_cookie = admin_cookies[0].split(';').next().unwrap();
    repo.configured_administrator(&config, &service.passwords)
        .await?;
    assert!(service.resolve(Some(admin_cookie)).await?.is_some());
    config.admin_password = Some("changed synthetic admin password".into());
    repo.configured_administrator(&config, &service.passwords)
        .await?;
    assert!(service.resolve(Some(admin_cookie)).await?.is_none());
    assert!(
        service
            .resolve(Some(cookies[0].split(';').next().unwrap()))
            .await?
            .is_some()
    );
    Ok(
        json!({"serverId":service.server_id,"ownerId":user.id,"cookie":cookies[0].split(';').next().unwrap(),"csrf":retained["csrfToken"]}),
    )
}

async fn retained(database: Arc<Database>, expected: &Value) -> Result<()> {
    assert_eq!(migrate(&database).await?, 0);
    let service = AuthService::initialize(database.clone(), Arc::new(configuration()?)).await?;
    assert_eq!(service.server_id, expected["serverId"].as_str().unwrap());
    let session = service.resolve(expected["cookie"].as_str()).await?.unwrap();
    assert_eq!(
        session.session.user.id,
        expected["ownerId"].as_str().unwrap()
    );
    assert_eq!(session.csrf_token, expected["csrf"].as_str().unwrap());
    assert_eq!(service.repository.count_accounts().await?, 2);
    database.close().await
}

#[tokio::test]
async fn native_authentication_state_survives_process_restart() -> Result<()> {
    if let Ok(phase) = std::env::var("CANTRIP_AUTH_DATABASE_PHASE") {
        let root = PathBuf::from(std::env::var("CANTRIP_AUTH_DATABASE_ROOT")?);
        let database = Arc::new(Database::pglite(&root.join("database")).await?);
        match phase.as_str() {
            "seed" => {
                let expected = exercise(database.clone()).await?;
                std::fs::write(root.join("retained.json"), serde_json::to_vec(&expected)?)?;
                database.close().await?;
            }
            "reopen" => {
                retained(
                    database,
                    &serde_json::from_slice(&std::fs::read(root.join("retained.json"))?)?,
                )
                .await?
            }
            _ => anyhow::bail!("unexpected auth database phase"),
        }
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    for phase in ["seed", "reopen"] {
        let output = tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "native_authentication_state_survives_process_restart",
                "--nocapture",
            ])
            .env("CANTRIP_AUTH_DATABASE_PHASE", phase)
            .env("CANTRIP_AUTH_DATABASE_ROOT", root.path())
            .kill_on_drop(true)
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "native auth {phase} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-sql-sentinel"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-sql-sentinel"));
    }
    Ok(())
}

#[tokio::test]
async fn postgres_authentication_state_and_administrator_updates() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(
        std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")
            .context("PostgreSQL auth contract binary directory")?,
    );
    let runtime = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    let expected = exercise(database.clone()).await?;
    database.close().await?;
    runtime.close().await?;
    assert!(
        !std::fs::read_to_string(root.path().join("postgres.log"))?
            .contains("private-sql-sentinel")
    );
    let runtime = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    retained(
        Arc::new(Database::postgres(runtime.configuration()).await?),
        &expected,
    )
    .await?;
    runtime.close().await?;
    Ok(())
}
