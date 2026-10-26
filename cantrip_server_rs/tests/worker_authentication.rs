mod support;

use anyhow::{Context, Result};
use cantrip_server::{
    auth::service::AuthService,
    config::{Environment, ServerConfig},
    database::Database,
    http,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    workers::{DEFAULT_CREDENTIAL_SCOPES, credentials, repository::EnrollmentInput},
};
use futures::StreamExt;
use serde_json::Value;
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

fn heartbeat() -> Result<Value> {
    let values = support::security_fixtures(&["workerHeartbeatSchema"])?;
    Ok(values["workerHeartbeatSchema"][0].clone())
}

#[tokio::test]
async fn revoked_credential_cannot_attach_after_awaited_owner_lookup() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(
        std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR").context("worker PostgreSQL binaries")?,
    );
    let runtime = ManagedPostgres::start(root.path(), &bin).await?;
    let mut configuration = runtime.configuration().clone();
    configuration.application_name("cantrip-revoked-worker-owner-lookup");
    let database = Arc::new(Database::postgres(&configuration).await?);
    let locker = Arc::new(Database::postgres(runtime.configuration()).await?);
    let observer = Arc::new(Database::postgres(runtime.configuration()).await?);
    migrate(&database).await?;
    let config = ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "none".into()),
            (
                "CANTRIP_WORKER_TOKEN".into(),
                "unused-test-development-bootstrap".into(),
            ),
        ]),
        root.path(),
    )?;
    let service = AuthService::initialize(database.clone(), Arc::new(config)).await?;
    let owner = &service.local_user.as_ref().unwrap().id;
    let (code, code_hash) = credentials::enrollment_code()?;
    service
        .workers
        .repository
        .create_enrollment_code(
            owner,
            None,
            &code_hash,
            None,
            chrono::Utc::now() + chrono::Duration::minutes(10),
        )
        .await?;
    let credential = credentials::credential()?;
    let heartbeat = heartbeat()?;
    let worker = heartbeat["workerId"].as_str().unwrap().to_owned();
    let provision = service
        .workers
        .repository
        .exchange_enrollment_code(EnrollmentInput {
            code_hash: cantrip_server::auth::crypto::hash_secret(&code),
            credential_hash: credential.hash,
            credential_id: credential.id.clone(),
            heartbeat,
            replacement: None,
            scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
        })
        .await?;
    assert_eq!(provision.credential["id"], credential.id);

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let app = http::router(service.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let (held, holding) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let lock = {
        let locker = locker.clone();
        tokio::spawn(async move {
            locker
                .transaction(move |tx| {
                    Box::pin(async move {
                        tx.execute("LOCK TABLE workers IN ACCESS EXCLUSIVE MODE")
                            .await?;
                        let _ = held.send(());
                        let _ = released.await;
                        Ok(())
                    })
                })
                .await
        })
    };
    holding.await?;
    let outcome = async {
        let mut request = format!("ws://{address}/api/internal/workers/connect?workerId={worker}&connectionGeneration={}", uuid::Uuid::new_v4()).into_client_request()?;
        request.headers_mut().insert("authorization", format!("Bearer {}", credential.credential).parse()?);
        request.headers_mut().insert("sec-websocket-protocol", "cantrip-worker-auth-ready-v2".parse()?);
        let (mut socket, response) = connect_async(request).await?;
        assert_eq!(response.status(), 101);
        let pending = tokio::time::timeout(Duration::from_secs(5), socket.next()).await?.unwrap()?;
        let pending: Value = serde_json::from_str(pending.to_text()?)?;
        assert_eq!(pending["state"], "pending");
        // Observe the actual database wait after successful credential auth.
        // A delay or the pending envelope alone cannot establish this boundary.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let blocked = observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cantrip-revoked-worker-owner-lookup' AND wait_event_type='Lock' AND query LIKE '%FROM workers%')", &[]).await?;
                if blocked[0].get::<bool>(0)? { break Ok::<_,anyhow::Error>(()); }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await??;
        // A separate database session commits revocation. Deliver its real
        // post-commit cache/disconnect effects while owner lookup is suspended.
        observer.query("UPDATE worker_credentials SET revoked_at=now(),revoked_reason='test concurrent revocation',updated_at=now() WHERE id=$1", &[&credential.id]).await?;
        service.workers.mark_revoked(&credential.id);
        service.workers.bridge.disconnect(&worker, "Worker credential was revoked", 1008);
        assert!(!service.workers.bridge.is_connected(&worker));
        let _ = release.send(());
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await?.unwrap()?;
        anyhow::ensure!(matches!(&message,Message::Close(Some(frame)) if u16::from(frame.code)==1008 && frame.reason=="Worker credential was revoked"), "Revoked credential became attachable after lookup: {message:?}");
        assert!(!service.workers.bridge.is_connected(&worker));
        Ok::<_,anyhow::Error>(())
    }.await;
    // Dropping release on any earlier error also releases the held transaction.
    lock.await??;
    service.workers.close();
    let _ = stop.send(());
    server.await??;
    observer.close().await?;
    locker.close().await?;
    database.close().await?;
    runtime.close().await?;
    outcome
}
