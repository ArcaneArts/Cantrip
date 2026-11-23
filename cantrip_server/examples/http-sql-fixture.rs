//! Development-only live SQL setup using the actual server's open database.
//! The production executable never imports these routes. Keeping main intact
//! preserves real startup maintenance, periodic work and shutdown ownership.
mod cantrip_server {
    pub use ::cantrip_server::*;

    pub mod http {
        use ::cantrip_server::auth::service::AuthService;
        use anyhow::Context;
        use axum::{
            Json, Router,
            extract::State,
            http::StatusCode,
            response::{IntoResponse, Response},
            routing::post,
        };
        use serde::Deserialize;
        use std::sync::Arc;

        #[derive(Deserialize)]
        struct Setup {
            statements: Vec<String>,
            #[serde(default)]
            queries: Vec<String>,
        }
        #[derive(Deserialize)]
        struct LivePublications {
            publications: Vec<::cantrip_server::wire::Value>,
            #[serde(default)]
            confirmed: bool,
        }
        async fn publish_live(
            State(service): State<Arc<AuthService>>,
            Json(input): Json<LivePublications>,
        ) -> Response {
            let result: anyhow::Result<Vec<::cantrip_server::wire::Value>> = if input.confirmed {
                let mut events = Vec::new();
                let mut failure = None;
                for publication in input.publications {
                    match service.live.hub.publish_confirmed(publication).await {
                        Ok(event) => events.push(event),
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
                failure.map_or_else(|| Ok(events), Err)
            } else {
                service.live.hub.publish_group(input.publications)
            };
            match result {
                Ok(events) => Json(serde_json::json!({"events":events})).into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")).into_response()
                }
            }
        }

        async fn setup(
            State(service): State<Arc<AuthService>>,
            Json(input): Json<Setup>,
        ) -> Response {
            let result = service
                .repository
                .database
                .transaction(|tx| {
                    Box::pin(async move {
                        for statement in input.statements {
                            tx.execute(&statement).await?;
                        }
                        let mut values: Vec<serde_json::Value> = Vec::new();
                        for query in input.queries {
                            let rows = tx.query(&query, &[]).await?;
                            let value: String = rows.first().context("Fixture JSON row")?.get(0)?;
                            values.push(serde_json::from_str(&value)?);
                        }
                        Ok(values)
                    })
                })
                .await;
            match result {
                Ok(values) => Json(if values.is_empty() {
                    serde_json::json!({ "ok": true })
                } else {
                    serde_json::json!({ "ok": true, "values": values })
                })
                .into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")).into_response()
                }
            }
        }

        async fn close_database(State(service): State<Arc<AuthService>>) -> Response {
            match service.repository.database.close().await {
                Ok(()) => Json(serde_json::json!({"closed":true})).into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")).into_response()
                }
            }
        }

        pub fn router(service: Arc<AuthService>) -> Router {
            let controls = Router::new()
                .route("/__fixture/sql", post(setup))
                .route("/__fixture/live", post(publish_live))
                .route("/__fixture/close-database", post(close_database))
                .layer(axum::middleware::from_fn_with_state(
                    service.clone(),
                    ::cantrip_server::http::observe_operations,
                ))
                .with_state(service.clone());
            ::cantrip_server::http::router(service).merge(controls)
        }
    }
}

include!("../src/main.rs");
