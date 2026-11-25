mod support;

use anyhow::{Context, Result};
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
        service.repository.settings(&id).await?;
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

        let fixtures = support::security_fixtures(&[
            "accountEncryptionProfileInitializeSchema",
            "encryptedChatTurnCreateSchema",
        ])?;
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
        let council_path = "/api/council/agents";
        let bootstrap: Value = serde_json::from_str(
            &request(Method::GET, "/api/bootstrap", first, false)
                .send().await?.error_for_status()?.text().await?,
        )?;
        assert_eq!(bootstrap["capabilities"]["council"], true);
        assert_eq!(
            client.get(origin.clone() + council_path).send().await?.status(),
            StatusCode::UNAUTHORIZED,
        );
        let roster: Value = serde_json::from_str(
            &request(Method::GET, council_path, first, false)
                .send().await?.error_for_status()?.text().await?,
        )?;
        assert_eq!(roster, json!([]));
        let missing = format!("{council_path}/9c50384b-e803-4e6b-8444-9e1811572461");
        assert_eq!(
            request(Method::PATCH, &missing, second, true)
                .header("content-type", "application/json")
                .body(json!({"expectedRevision":1,"primary":true}).to_string())
                .send().await?.status(),
            StatusCode::NOT_FOUND,
        );

        let settings_path = "/api/settings";
        let initial_settings: Value = serde_json::from_str(
            &request(Method::GET, settings_path, first, false)
                .send().await?.error_for_status().context("initial Council settings")?.text().await?,
        )?;
        assert_eq!(
            initial_settings["preferences"].get("defaultCouncilModelId"),
            Some(&Value::Null)
        );
        assert_eq!(initial_settings["preferences"]["defaultCouncilPermissionProfileId"], ":workspace");

        database.query(
            "INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES
                 ('council-provider',$1,'Council provider','ollama','http://127.0.0.1:11434'),
                 ('foreign-provider',$2,'Foreign provider','ollama','http://127.0.0.1:11434')",
            &[&first.0, &second.0],
        ).await?;
        database.query(
            "INSERT INTO model_profiles(id,owner_id,name,operation) VALUES
                 ('council-language',$1,'Council language','language'),
                 ('council-embedding',$1,'Council embedding','embedding'),
                 ('foreign-language',$2,'Foreign language','language')",
            &[&first.0, &second.0],
        ).await?;
        database.query(
            "INSERT INTO model_routes(id,model_id,provider_id,model_name,enabled) VALUES
                 ('council-language-route','council-language','council-provider','text',false),
                 ('council-embedding-route','council-embedding','council-provider','embed',true),
                 ('foreign-language-route','foreign-language','foreign-provider','text',true)",
            &[],
        ).await?;
        let save = |patch: &Value| {
            request(Method::PATCH, settings_path, first, true)
                .header("content-type", "application/json")
                .body(patch.to_string())
        };
        for patch in [
            json!({"defaultCouncilModelId":"foreign-language"}),
            json!({"defaultCouncilModelId":"council-embedding"}),
            json!({"defaultCouncilPermissionProfileId":":custom"}),
        ] {
            assert_eq!(save(&patch).send().await?.status(), StatusCode::BAD_REQUEST);
        }
        let changed: Value = serde_json::from_str(
            &save(&json!({"defaultCouncilModelId":"council-language", "defaultCouncilPermissionProfileId":":read-only"}))
                .send().await?.error_for_status().context("save Council defaults")?.text().await?,
        )?;
        assert_eq!(changed["preferences"]["defaultCouncilModelId"], "council-language");
        assert_eq!(changed["preferences"]["defaultCouncilPermissionProfileId"], ":read-only");
        let unrelated: Value = serde_json::from_str(
            &save(&json!({"theme":"dark"})).send().await?.error_for_status().context("unrelated settings patch")?.text().await?,
        )?;
        assert_eq!(unrelated["preferences"]["defaultCouncilModelId"], "council-language");
        assert_eq!(unrelated["preferences"]["defaultCouncilPermissionProfileId"], ":read-only");
        assert_eq!(unrelated["preferences"]["defaultChatPermissionProfileId"], ":workspace");
        assert_eq!(unrelated["preferences"]["defaultPermissionProfileId"], ":workspace");

        database.query("DELETE FROM model_profiles WHERE id='council-language'", &[]).await?;
        let removed: Value = serde_json::from_str(
            &request(Method::GET, settings_path, first, false)
                .send().await?.error_for_status().context("settings after model deletion")?.text().await?,
        )?;
        assert_eq!(
            removed["preferences"].get("defaultCouncilModelId"),
            Some(&Value::Null)
        );
        assert_eq!(removed["preferences"]["defaultCouncilPermissionProfileId"], ":read-only");

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

        let caps = json!({"scratch":{
            "provision":true,"resolve":true,"archive":true,"restore":true,
            "remove":true,"reconcile":true,"routingHandles":true
        }});
        database.query(
            "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,standalone_chat_capabilities)
             VALUES('offline-council-worker',$1,'Council fixture','linux','x64',now(),now(),$2)",
            &[&first.0, &caps],
        ).await?;
        database.query(
            "INSERT INTO model_profiles(id,owner_id,name,operation) VALUES('offline-council-model',$1,'Council fixture','language')",
            &[&first.0],
        ).await?;
        let agent = "9c50384b-e803-4e6b-8444-9e1811572461";
        let mut turn = fixtures["encryptedChatTurnCreateSchema"][0].clone();
        turn["modelId"] = json!("offline-council-model");
        turn["queuedPrompt"]["modelId"] = turn["modelId"].clone();
        let content = &turn["message"]["protectedContent"];
        let create = cantrip_server::wire::parse(
            "councilAgentCreateSchema",
            Some(&serde_json::from_value(json!({
                "id": agent,
                "titleProtection":{"classification":{"recordKind":"chat"},"protectedLabel":content},
                "protectedRole": content["envelope"],
            }))?),
        ).map_err(|e| anyhow::anyhow!("Council agent fixture: {e:?}"))?;
        // Seed the initial placement. No worker is connected to this HTTP router.
        cantrip_server::chats::Repository::new(database.clone())
            .create_council_agent(&first.0, create, |_| true).await?;
        let conversation = format!("{council_path}/{agent}/chat");
        assert_eq!(request(Method::GET, &conversation, second, false).send().await?.status(), StatusCode::NOT_FOUND);
        let chat: Value = serde_json::from_str(
            &request(Method::GET, &conversation, first, false)
                .send().await?.error_for_status()?.text().await?,
        )?;
        assert_eq!(chat["id"], agent);
        assert_eq!(chat["contextKind"], "standalone");
        assert!(chat.get("protectedRole").is_none());
        let memory_path = format!("{council_path}/{agent}/memory");
        let read_memory = |session| request(Method::GET, &memory_path, session, false);
        let initial_memory: Value = serde_json::from_str(
            &read_memory(first).send().await?.error_for_status()?.text().await?,
        )?;
        assert_eq!(initial_memory, json!({"agentId":agent,"revision":1,"protectedMemory":null}));
        let change = json!({"expectedRevision":1,"protectedMemory":content["envelope"]});
        let write_memory = |session, csrf| request(Method::PUT, &memory_path, session, csrf)
            .header("content-type", "application/json").body(change.to_string());
        assert_eq!(read_memory(second).send().await?.status(), StatusCode::NOT_FOUND);
        assert_eq!(write_memory(second, true).send().await?.status(), StatusCode::NOT_FOUND);
        assert_eq!(write_memory(first, false).send().await?.status(), StatusCode::FORBIDDEN);
        let sealed_memory: Value = serde_json::from_str(
            &write_memory(first, true).send().await?.error_for_status()?.text().await?,
        )?;
        assert_eq!(sealed_memory, json!({"agentId":agent,"revision":2,"protectedMemory":content["envelope"]}));
        assert_eq!(write_memory(first, true).send().await?.status(), StatusCode::CONFLICT);
        assert_eq!(serde_json::from_str::<Value>(&read_memory(first).send().await?.error_for_status()?.text().await?)?, sealed_memory);
        let turns = format!("/api/chats/{agent}/turns");
        let submit = |session| request(Method::POST, &turns, session, true)
            .header("content-type", "application/json").body(turn.to_string());
        assert_eq!(submit(second).send().await?.status(), StatusCode::NOT_FOUND);
        for _ in 0..2 {
            let response = submit(first).send().await?;
            let status = response.status();
            let body = response.text().await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            let retained: Value = serde_json::from_str(&body)?;
            assert_eq!(retained["status"], "queued");
            assert_eq!(retained["prompt"]["id"], turn["queuedPrompt"]["id"]);
        }
        let queue: Value = serde_json::from_str(&request(
            Method::GET, &format!("/api/chats/{agent}/queue"), first, false,
        ).send().await?.error_for_status()?.text().await?)?;
        assert_eq!(queue["items"].as_array().unwrap().len(), 1);
        assert_eq!(queue["items"][0]["state"], "pending");
        assert_eq!(queue["claims"], json!([]));

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
