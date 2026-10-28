//! Development-only clock observer around the actual executable and router.
//! Including main preserves its CLI, database, initialization and shutdown paths;
//! only the router import is adapted to record independent producer readings.
mod cantrip_server {
    pub use ::cantrip_server::*;

    pub mod http {
        use ::cantrip_server::auth::service::AuthService;
        use axum::{
            Router,
            extract::Request,
            middleware::{self, Next},
            response::Response,
        };
        use std::{sync::Arc, time::Instant};

        async fn observe(request: Request, next: Next) -> Response {
            let before = chrono::Utc::now().timestamp_millis();
            let started = Instant::now();
            let response = next.run(request).await;
            let after = chrono::Utc::now().timestamp_millis();
            let elapsed = started.elapsed().as_nanos().to_string();
            eprintln!(
                "{}",
                serde_json::json!({
                    "event":"fixture.http.clock",
                    "requestId":response.headers().get("x-request-id").and_then(|v| v.to_str().ok()),
                    "operationClock":{"before":before,"after":after,"elapsedNanoseconds":elapsed}
                })
            );
            response
        }

        pub fn router(service: Arc<AuthService>) -> Router {
            ::cantrip_server::http::router(service).layer(middleware::from_fn(observe))
        }
    }
}

include!("../src/main.rs");
