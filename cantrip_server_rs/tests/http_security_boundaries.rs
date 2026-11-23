mod support;

use anyhow::Result;
use cantrip_server::{
    auth::{crypto, service::AuthService},
    config::{Environment, ServerConfig},
    database::Database,
    http,
    migrations::migrate,
};
use futures::FutureExt;
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use std::panic::AssertUnwindSafe;
use std::{net::SocketAddr, sync::Arc};
use tokio::{net::TcpListener, sync::oneshot};

// This test binds the production Rust router and uses actual HTTP requests. Its
// expected status/ownership assertions do not consult the retired Node server.
#[tokio::test]
async fn current_native_http_authority_isolated_from_reference_server() -> Result<()> {
    let root = tempfile::tempdir()?;
    let database = Arc::new(Database::pglite(&root.path().join("database")).await?);
    migrate(&database).await?;
    let config = ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "accounts".into()),
            ("CANTRIP_LICENSE_WHITELIST_ENABLED".into(), "false".into()),
        ]),
        root.path(),
    )?;
    let service = AuthService::initialize(database.clone(), Arc::new(config)).await?;
    let mut sessions = Vec::new();
    for email in ["first@example.invalid", "second@example.invalid"] {
        let user = service
            .repository
            .create_account(email, email, email, crypto::DUMMY_PASSWORD_HASH, "member")
            .await?;
        let id = user.id.clone();
        let (state, cookies) = service.create_session(user, "account-password").await?;
        sessions.push((
            id,
            cookies[0].split(';').next().unwrap().to_owned(),
            state["csrfToken"].as_str().unwrap().to_owned(),
        ));
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let app = http::router(service.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let outcome = AssertUnwindSafe(async {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let first = &sessions[0];
        let second = &sessions[1];
        let protected = origin.clone() + "/api/encryption/profile";
        assert_eq!(
            client.get(&protected).send().await?.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(&protected)
                .header("cookie", &first.1)
                .header("origin", "https://untrusted.example.invalid")
                .send()
                .await?
                .status(),
            StatusCode::FORBIDDEN
        );

        let fixtures = support::security_fixtures(&["accountEncryptionProfileInitializeSchema"])?;
        let initial = &fixtures["accountEncryptionProfileInitializeSchema"][0];
        let request = |method, route: &str, session: &(String, String, String), csrf: bool| {
            let request = client
                .request(method, origin.clone() + route)
                .header("cookie", &session.1)
                .header("origin", "http://127.0.0.1:5173");
            if csrf {
                request.header("x-cantrip-csrf", &session.2)
            } else {
                request
            }
        };
        assert_eq!(
            request(
                Method::POST,
                "/api/encryption/profile/initialize",
                first,
                false
            )
            .header("content-type", "application/json")
            .body(serde_json::to_vec(initial)?)
            .send()
            .await?
            .status(),
            StatusCode::FORBIDDEN
        );
        let initialized = request(
            Method::POST,
            "/api/encryption/profile/initialize",
            first,
            true,
        )
        .header("content-type", "application/json")
        .body(serde_json::to_vec(initial)?)
        .send()
        .await?;
        assert_eq!(initialized.status(), StatusCode::CREATED);
        let accepted: Value = serde_json::from_slice(&initialized.bytes().await?)?;
        assert_eq!(accepted["profile"]["ownerId"], first.0);
        assert_eq!(
            accepted["grant"]["wrappedKey"],
            initial["initialClient"]["wrappedMasterKey"]
        );
        let own_response = request(Method::GET, "/api/encryption/profile", first, false)
            .send()
            .await?
            .error_for_status()?;
        let own: Value = serde_json::from_slice(&own_response.bytes().await?)?;
        assert_eq!(own["profile"]["ownerId"], first.0);
        let other_response = request(Method::GET, "/api/encryption/profile", second, false)
            .send()
            .await?
            .error_for_status()?;
        let other: Value = serde_json::from_slice(&other_response.bytes().await?)?;
        assert_eq!(other["status"], "uninitialized");
        assert!(other["profile"].is_null());
        let mut second_initial = initial.clone();
        let second_client = "55555555-5555-4555-8555-555555555555";
        second_initial["initialClient"]["id"] = json!(second_client);
        second_initial["initialClient"]["wrappedMasterKey"]["clientId"] = json!(second_client);
        let initialized_second = request(
            Method::POST,
            "/api/encryption/profile/initialize",
            second,
            true,
        )
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&second_initial)?)
        .send()
        .await?;
        assert_eq!(initialized_second.status(), StatusCode::CREATED);
        let second_state: Value = serde_json::from_slice(&initialized_second.bytes().await?)?;
        assert_eq!(second_state["profile"]["ownerId"], second.0);
        assert_ne!(second_state["profile"]["ownerId"], first.0);
        let principal = initial["initialClient"]["id"].as_str().unwrap();
        assert_eq!(
            request(
                Method::GET,
                &format!("/api/encryption/principals/{principal}/grants"),
                second,
                false
            )
            .send()
            .await?
            .status(),
            StatusCode::NOT_FOUND
        );
        for denied_id in [principal, "66666666-6666-4666-8666-666666666666"] {
            let denied = request(
                Method::POST,
                &format!("/api/encryption/principals/{denied_id}/approve"),
                second,
                true,
            )
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&json!({"expectedRevision":1}))?)
            .send()
            .await?;
            // Existing mutation contracts use the same conflict for an absent,
            // foreign or changed principal, without revealing another owner.
            assert_eq!(denied.status(), StatusCode::CONFLICT);
            let denied_body: Value = serde_json::from_slice(&denied.bytes().await?)?;
            assert_eq!(
                denied_body,
                json!({"error":"Encryption principal revision or state changed."})
            );
        }
        let retained_grants = request(
            Method::GET,
            &format!("/api/encryption/principals/{principal}/grants"),
            first,
            false,
        )
        .send()
        .await?
        .error_for_status()?;
        let retained_grants: Value = serde_json::from_slice(&retained_grants.bytes().await?)?;
        assert_eq!(
            retained_grants[0]["wrappedKey"],
            initial["initialClient"]["wrappedMasterKey"]
        );
        assert_eq!(
            request(Method::POST, "/api/auth/logout", first, true)
                .send()
                .await?
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request(Method::GET, "/api/encryption/profile", first, false)
                .send()
                .await?
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(Method::GET, "/api/encryption/profile", second, false)
                .send()
                .await?
                .status(),
            StatusCode::OK
        );
        let legacy = request(
            Method::GET,
            "/api/terminals/missing-terminal/connect",
            second,
            false,
        )
        .send()
        .await?;
        assert!(legacy.status().is_client_error());
        assert_eq!(legacy.headers()["deprecation"], "@1787788800");
        assert!(
            legacy.headers()["link"]
                .to_str()?
                .contains("NETWORK.md#legacy-feature-relay-compatibility")
        );
        let metrics = serde_json::to_value(service.operational_metrics.snapshot())?;
        assert_eq!(
            metrics["legacyFeatureTransports"]["requestsByEndpoint"]["terminal-relay"],
            1.0
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let _ = stop.send(());
    server.await??;
    database.close().await?;
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
