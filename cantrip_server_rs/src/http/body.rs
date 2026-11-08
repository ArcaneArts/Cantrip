use super::{json_response, middleware::value};
use crate::wire::{JsString, Value as JsValue};
use axum::{
    body::BodyDataStream,
    extract::Request,
    http::{StatusCode, header},
    response::Response,
};
use futures::StreamExt;
use serde_json::json;
use std::time::Duration;

// Keep the read half alive long enough to deliver an early rejection while
// discarding in-flight upload frames. A peer that stops sending without closing
// must not retain a rejected connection indefinitely.
const REJECTED_UPLOAD_DRAIN: Duration = Duration::from_secs(5);

fn reject(mut body: BodyDataStream, mut response: Response) -> Response {
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        response.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
    }
    tokio::spawn(async move {
        let _ = tokio::time::timeout(REJECTED_UPLOAD_DRAIN, async {
            while let Some(Ok(_)) = body.next().await {}
        })
        .await;
    });
    response
}

fn too_large() -> Response {
    parser_error(
        413,
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "Request body is too large",
    )
}

fn parser_error(code: u16, key: &str, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(code).unwrap(),
        json!({"statusCode":code,"code":key,"error":if code==415{"Unsupported Media Type"}else if code==413{"Payload Too Large"}else{"Bad Request"},"message":message}),
    )
}
fn invalid_json() -> Response {
    parser_error(
        400,
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "Body is not valid JSON but content-type is set to 'application/json'",
    )
}
fn poisoned(value: &JsValue) -> bool {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            JsValue::Object(object) => {
                if object.contains_key("__proto__")
                    || object
                        .get("constructor")
                        .is_some_and(|v| v.as_object().is_some_and(|o| o.contains_key("prototype")))
                {
                    return true;
                }
                pending.extend(object.values());
            }
            JsValue::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    false
}

pub(super) async fn parse_js(request: Request, limit: u64) -> Result<Option<JsValue>, Response> {
    parse_body(request, limit, None, BinaryMode::Ignore).await
}

enum BinaryMode {
    Ignore,
    Enumerate,
    Own,
    Json,
}

/// Attachment uploads explicitly JSON.parse the registered Buffer body. Other
/// media types still run their ordinary parser before the route rejects them.
pub(super) async fn parse_attachment(
    request: Request,
    json_limit: u64,
    binary_limit: u64,
) -> Result<Option<JsValue>, Response> {
    let binary = value(request.headers(), "content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/octet-stream")
    });
    let parsed = parse_body(request, json_limit, Some(binary_limit), BinaryMode::Json).await?;
    Ok(if binary { parsed } else { None })
}

/// Automation contracts read named data properties and enumerate unknown keys.
/// Include Buffer's inherited enumerable keys in Source order so strict-object
/// diagnostics and refinement aborts match, including an empty Buffer. Values
/// for those unused prototype keys are immaterial to these contracts.
pub(super) async fn parse_js_buffer(
    request: Request,
    json_limit: u64,
    binary_limit: u64,
) -> Result<Option<JsValue>, Response> {
    parse_body(
        request,
        json_limit,
        Some(binary_limit),
        BinaryMode::Enumerate,
    )
    .await
}

/// Object.keys(Buffer) exposes its byte indices, without inherited methods.
pub(super) async fn parse_js_own_buffer(
    request: Request,
    json_limit: u64,
    binary_limit: u64,
) -> Result<Option<JsValue>, Response> {
    parse_body(request, json_limit, Some(binary_limit), BinaryMode::Own).await
}

/// Routes which ignore their parsed input still use Fastify's registered
/// binary parser and its distinct upload limit, without projecting a Buffer.
pub(super) async fn parse_ignored(
    request: Request,
    json_limit: u64,
    binary_limit: u64,
) -> Result<(), Response> {
    parse_body(request, json_limit, Some(binary_limit), BinaryMode::Ignore)
        .await
        .map(|_| ())
}

pub(super) async fn parse_fallback(
    request: Request,
    json_limit: u64,
    binary_limit: u64,
) -> Result<(), Response> {
    if request.method().as_str() == "QUERY" {
        if !request.headers().contains_key(header::CONTENT_TYPE) {
            return Err(parser_error(
                400,
                "FST_ERR_ROUTE_MISSING_CONTENT_TYPE",
                "Method 'QUERY' must provide a 'Content-Type' header.",
            ));
        }
        if !request.headers().contains_key(header::TRANSFER_ENCODING)
            && value(request.headers(), "content-length").is_none_or(|v| v == "0")
        {
            return Err(parser_error(
                400,
                "FST_ERR_ROUTE_MISSING_CONTENT",
                "Method 'QUERY' must provide a request body.",
            ));
        }
    }
    let content_type = value(request.headers(), "content-type");
    let kind = if let Some(raw) = content_type {
        let media = raw.split(';').next().unwrap_or("");
        let invalid = || {
            parser_error(
                415,
                "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                "Unsupported Media Type",
            )
        };
        let Some((kind, subtype)) = media.split_once('/') else {
            return Err(invalid());
        };
        let kind = kind
            .trim_start_matches(crate::text::whitespace)
            .to_lowercase();
        let subtype = subtype
            .trim_end_matches(crate::text::whitespace)
            .to_lowercase();
        let token = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_!#$%&'*+.^`|~-".contains(&byte))
        };
        if !token(&kind) || !token(&subtype) {
            return Err(invalid());
        }
        format!("{kind}/{subtype}")
    } else {
        String::new()
    };
    // Fastify's content-type parser deliberately calls the 404 handler when
    // no registered parser exists. Known parsers still validate their input.
    if !matches!(
        kind.as_str(),
        "application/json" | "text/plain" | "application/octet-stream"
    ) {
        return Ok(());
    }
    parse_ignored(request, json_limit, binary_limit).await
}

async fn parse_body(
    request: Request,
    limit: u64,
    ignored_binary_limit: Option<u64>,
    binary_mode: BinaryMode,
) -> Result<Option<JsValue>, Response> {
    let content_type = value(request.headers(), "content-type");
    let kind = content_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let limit = if kind == "application/octet-stream" {
        ignored_binary_limit.unwrap_or(limit)
    } else {
        limit
    };
    if value(request.headers(), "content-length")
        .and_then(|length| length.trim().parse::<u64>().ok())
        .is_some_and(|length| length > limit)
    {
        // Fastify selects its registered parser before rejecting the advertised
        // length, without waiting for any body bytes. The actual streamed body
        // remains bounded below when no oversized length was advertised.
        return Err(reject(
            request.into_body().into_data_stream(),
            if matches!(
                kind.as_str(),
                "application/json" | "text/plain" | "application/octet-stream"
            ) {
                too_large()
            } else {
                parser_error(
                    415,
                    "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                    "Unsupported Media Type",
                )
            },
        ));
    }
    let mut body = request.into_body().into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        let Ok(chunk) = chunk else {
            return Err(reject(body, too_large()));
        };
        if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
            // Do not collect beyond the limit or drop the unread HTTP body.
            // Dropping it makes Hyper close with unread TCP data, which can
            // reset a Windows connection before the client sees the 413.
            return Err(reject(body, too_large()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if kind == "application/json" {
        if bytes.is_empty() {
            return Err(parser_error(
                400,
                "FST_ERR_CTP_EMPTY_JSON_BODY",
                "Body cannot be empty when content-type is set to 'application/json'",
            ));
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let value: JsValue = serde_json::from_str(text).map_err(|_| invalid_json())?;
        if poisoned(&value) {
            return Err(invalid_json());
        }
        Ok(Some(value))
    } else if kind == "text/plain" {
        Ok(Some(JsValue::String(JsString::from(
            String::from_utf8_lossy(&bytes).into_owned(),
        ))))
    } else if kind == "application/octet-stream" && matches!(binary_mode, BinaryMode::Json) {
        // Unlike the application/json parser, Buffer JSON.parse does not
        // remove a BOM or reject prototype-named data properties.
        Ok(serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok())
    } else if kind == "application/octet-stream"
        && matches!(binary_mode, BinaryMode::Enumerate | BinaryMode::Own)
    {
        let mut value = JsValue::object(
            bytes
                .into_iter()
                .enumerate()
                .map(|(index, byte)| (index.to_string(), JsValue::Number(f64::from(byte)))),
        );
        if matches!(binary_mode, BinaryMode::Enumerate) {
            let inherited: Vec<String> =
                serde_json::from_str(include_str!("../../contracts/js-buffer-keys.json"))
                    .expect("Source Buffer enumerable keys");
            for key in inherited {
                value[key.as_str()] = JsValue::Null;
            }
        }
        Ok(Some(value))
    } else if (kind.is_empty() && bytes.is_empty())
        || (kind == "application/octet-stream" && ignored_binary_limit.is_some())
    {
        Ok(None)
    } else {
        Err(parser_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, Bytes};
    use futures::{FutureExt, stream};
    use std::convert::Infallible;
    use tokio::sync::mpsc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    fn upload() -> (mpsc::Sender<Bytes>, Body) {
        let (sender, receiver) = mpsc::channel(1);
        let body = Body::from_stream(stream::unfold(receiver, |mut receiver| async {
            receiver
                .recv()
                .await
                .map(|chunk| (Ok::<_, Infallible>(chunk), receiver))
        }));
        (sender, body)
    }

    #[tokio::test]
    async fn ignored_binary_bodies_keep_the_registered_parser_limit() {
        let request = |kind: &str, bytes: Vec<u8>| {
            Request::builder()
                .header(header::CONTENT_TYPE, kind)
                .body(Body::from(bytes))
                .unwrap()
        };
        // Binary input is opaque and can exceed the ordinary JSON limit.
        assert!(
            parse_ignored(request("application/octet-stream", vec![0xff; 8]), 4, 8)
                .await
                .is_ok()
        );
        assert_eq!(
            parse_ignored(request("application/octet-stream", vec![0xff; 9]), 4, 8)
                .await
                .unwrap_err()
                .status(),
            413
        );
        assert_eq!(
            parse_ignored(request("application/json", b"false".to_vec()), 4, 8)
                .await
                .unwrap_err()
                .status(),
            413
        );
    }

    #[tokio::test]
    async fn streamed_limit_replies_before_eof_and_keeps_consuming_upload() {
        let (sender, body) = upload();
        sender.send(Bytes::from_static(b"12345")).await.unwrap();
        let request = Request::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let response = parse_js(request, 4).await.unwrap_err();
        assert_eq!(response.status(), 413);
        assert_eq!(response.headers()[header::CONNECTION], "close");
        assert!(sender.closed().now_or_never().is_none());
        // Two real sends require the receiver to consume the first pending
        // chunk; merely retaining an unpolled body would leave this blocked.
        sender.send(Bytes::from_static(b"discarded")).await.unwrap();
        sender
            .send(Bytes::from_static(b"also discarded"))
            .await
            .unwrap();
        drop(sender);
        let value: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["code"], "FST_ERR_CTP_BODY_TOO_LARGE");
    }

    #[tokio::test(start_paused = true)]
    async fn advertised_limit_replies_without_body_and_bounds_stalled_drain() {
        let (sender, body) = upload();
        let request = Request::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONTENT_LENGTH, "5")
            .body(body)
            .unwrap();
        assert_eq!(parse_js(request, 4).await.unwrap_err().status(), 413);
        tokio::task::yield_now().await;
        assert!(sender.closed().now_or_never().is_none());
        tokio::time::advance(REJECTED_UPLOAD_DRAIN).await;
        sender.closed().await;
    }

    #[tokio::test]
    async fn actual_http_rejection_is_complete_before_upload_finishes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/",
                    axum::routing::post(|request: Request| async {
                        parse_js(request, 1024).await.unwrap_err()
                    }),
                ),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket.write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n401\r\n").await.unwrap();
        socket.write_all(&vec![b'x'; 1025]).await.unwrap();
        socket.write_all(b"\r\n").await.unwrap();
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut buffer = [0; 1024];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0, "connection closed before the complete rejection");
                received.extend_from_slice(&buffer[..count]);
                if let Some(end) = received.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&received[..end]).unwrap();
                    assert!(headers.starts_with("HTTP/1.1 413 "));
                    assert!(headers.contains("connection: close"));
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if received.len() == end + 4 + length {
                        let value: serde_json::Value =
                            serde_json::from_slice(&received[end + 4..]).unwrap();
                        assert_eq!(value["code"], "FST_ERR_CTP_BODY_TOO_LARGE");
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        // The rejection has arrived even though this request has not ended.
        // Bytes already in flight must still be read without resetting TCP.
        socket.write_all(b"4\r\ntail\r\n0\r\n\r\n").await.unwrap();
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut rest))
            .await
            .unwrap()
            .unwrap();
        assert!(rest.is_empty());
        drop(socket);
        stop.send(()).unwrap();
        server.await.unwrap();
    }
}
