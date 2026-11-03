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
                    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
                }
            }
        }

        pub fn router(service: Arc<AuthService>) -> Router {
            let controls = Router::new()
                .route("/__fixture/sql", post(setup))
                .with_state(service.clone());
            ::cantrip_server::http::router(service).merge(controls)
        }
    }
}

include!("../src/main.rs");
