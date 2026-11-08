//! Actual production logging middleware with controlled, development-only streams.
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use cantrip_server::{config::Environment, http::request_logs, operations::log_runtime};
use futures::stream;
use std::path::PathBuf;
async fn controlled(
    State(root): State<PathBuf>,
    Path((kind, id)): Path<(String, String)>,
) -> Response {
    let body = stream::unfold(
        (0, root.join(id), kind),
        |(step, marker, kind)| async move {
            match step {
                0 => Some((
                    Ok::<_, std::io::Error>(Bytes::from_static(b"first\n")),
                    (1, marker, kind),
                )),
                1 => {
                    while tokio::fs::metadata(&marker).await.is_err() {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    let result = if kind == "failed" {
                        Err(std::io::Error::other("controlled-private-stream-body"))
                    } else {
                        Ok(Bytes::from_static(b"last\n"))
                    };
                    Some((result, (2, marker, kind)))
                }
                _ => None,
            }
        },
    );
    (
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from_stream(body),
    )
        .into_response()
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    anyhow::ensure!(args.next().as_deref() == Some("--data-dir"));
    let root = PathBuf::from(args.next().context("data directory")?);
    let env: Environment = std::env::vars().collect();
    log_runtime::initialize(&root, &env, &std::env::current_dir()?).await;
    let app =
        Router::new()
            .route("/api/log-test/finite/{id}", get(|| async { "complete" }))
            .route(
                "/api/log-test/empty",
                get(|| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/api/log-test/status/{code}",
                get(|Path(code): Path<u16>| async move {
                    (StatusCode::from_u16(code).unwrap(), "status")
                }),
            )
            .route("/api/log-test/{kind}/{id}", get(controlled))
            .layer(axum::middleware::from_fn(request_logs::observe))
            .with_state(root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    println!(
        "{}",
        serde_json::json!({"event":"server.listening","origin":format!("http://{}",listener.local_addr()?)})
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
        let _ = tx.send(());
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = rx.await;
        })
        .await?;
    log_runtime::finish(None).await;
    Ok(())
}
