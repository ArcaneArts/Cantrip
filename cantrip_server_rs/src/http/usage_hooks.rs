//! Meter payload bytes as they pass through streams. A terminal operation is
//! counted once on EOF, error or destruction, including partial/cancelled bodies.
use crate::usage::{live_traffic, service::UsageService};
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::Request,
    http::{Method, StatusCode},
    response::Response,
};
use http_body::Frame;
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

#[derive(Clone)]
pub(super) struct EncodedPayload(pub usize);
struct Payload {
    record: Arc<dyn Fn(usize, u64) + Send + Sync>,
}
impl Payload {
    fn new(
        service: Arc<UsageService>,
        owner: String,
        channel: &'static str,
        ingress: bool,
        notify: bool,
    ) -> Self {
        Self {
            record: Arc::new(move |bytes, operations| {
                service.record(&owner, channel, ingress, bytes, operations, notify)
            }),
        }
    }
    fn record(&self, bytes: usize, operations: u64) {
        (self.record)(bytes, operations);
    }
}
struct CompletedRequest {
    service: Arc<UsageService>,
    owner: String,
    route: String,
}
struct MeteredBody {
    inner: Body,
    payload: Option<Payload>,
    completed_request: Option<CompletedRequest>,
}
impl MeteredBody {
    fn complete(&mut self) {
        if let Some(payload) = self.payload.take() {
            payload.record(0, 1);
        }
        if let Some(request) = self.completed_request.take() {
            request
                .service
                .record_http_request(&request.owner, &request.route);
        }
    }
}
impl HttpBody for MeteredBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let frame = Pin::new(&mut self.inner).poll_frame(context);
        match &frame {
            Poll::Ready(Some(Ok(frame))) => {
                if let (Some(data), Some(payload)) = (frame.data_ref(), &self.payload) {
                    payload.record(data.len(), 0);
                }
            }
            Poll::Ready(None | Some(Err(_))) => self.complete(),
            Poll::Pending => {}
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}
impl Drop for MeteredBody {
    fn drop(&mut self) {
        self.complete();
    }
}
fn channel(route: &str) -> &'static str {
    if [
        "/api/chats/:chatId/attachments",
        "/api/attachments/:attachmentId/content",
    ]
    .contains(&route)
    {
        "attachment-transfer"
    } else {
        "http"
    }
}
pub(super) fn request(
    request: &mut Request,
    service: &Arc<UsageService>,
    owner: &str,
    route: &str,
    upgrade: bool,
) {
    if request.method() == Method::OPTIONS || upgrade || route == live_traffic::ROUTE {
        return;
    }
    let inner = std::mem::replace(request.body_mut(), Body::empty());
    *request.body_mut() = Body::new(MeteredBody {
        inner,
        payload: Some(Payload::new(
            service.clone(),
            owner.into(),
            channel(route),
            true,
            !route.starts_with("/api/account/resource-usage"),
        )),
        completed_request: None,
    });
}
pub(super) fn response(
    mut response: Response,
    service: &Arc<UsageService>,
    owner: Option<&str>,
    route: &str,
    method: &str,
    upgrade: bool,
) -> Response {
    let Some(owner) = owner else {
        return response;
    };
    if method == "OPTIONS" || upgrade || route == live_traffic::ROUTE {
        return response;
    }
    let payload = if method == "HEAD"
        || [StatusCode::NO_CONTENT, StatusCode::NOT_MODIFIED].contains(&response.status())
    {
        None
    } else {
        Some(Payload::new(
            service.clone(),
            owner.into(),
            channel(route),
            false,
            !route.starts_with("/api/account/resource-usage"),
        ))
    };
    let payload = if let (Some(encoded), Some(payload)) =
        (response.extensions().get::<EncodedPayload>(), &payload)
    {
        payload.record(encoded.0, 1);
        None
    } else {
        payload
    };
    let inner = std::mem::replace(response.body_mut(), Body::empty());
    *response.body_mut() = Body::new(MeteredBody {
        inner,
        payload,
        completed_request: Some(CompletedRequest {
            service: service.clone(),
            owner: owner.into(),
            route: route.into(),
        }),
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{future::poll_fn, stream};
    use std::{io, sync::Mutex};
    type Records = Arc<Mutex<Vec<(usize, u64)>>>;
    fn metered(inner: Body) -> (Body, Records) {
        let records = Records::default();
        let output = records.clone();
        let body = Body::new(MeteredBody {
            inner,
            payload: Some(Payload {
                record: Arc::new(move |bytes, operations| {
                    output.lock().unwrap().push((bytes, operations))
                }),
            }),
            completed_request: None,
        });
        (body, records)
    }
    #[tokio::test]
    async fn complete_stream_preserves_bytes_and_counts_its_operation_once() {
        let source = Body::from_stream(stream::iter([
            Ok::<_, io::Error>(Bytes::from_static(b"a")),
            Ok(Bytes::from_static("🦀".as_bytes())),
        ]));
        let (body, records) = metered(source);
        assert_eq!(
            axum::body::to_bytes(body, 100).await.unwrap(),
            Bytes::from_static("a🦀".as_bytes())
        );
        assert_eq!(*records.lock().unwrap(), vec![(1, 0), (4, 0), (0, 1)]);
    }
    #[tokio::test]
    async fn dropped_stream_does_not_charge_unread_payload_and_finalizes_once() {
        let source = Body::from_stream(stream::iter([
            Ok::<_, io::Error>(Bytes::from_static(b"read")),
            Ok(Bytes::from_static(b"unread")),
        ]));
        let (mut body, records) = metered(source);
        let first = poll_fn(|context| Pin::new(&mut body).poll_frame(context))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.data_ref().unwrap(), b"read".as_slice());
        drop(body);
        assert_eq!(*records.lock().unwrap(), vec![(4, 0), (0, 1)]);
    }
    #[tokio::test]
    async fn source_error_retains_consumed_bytes_and_finalizes_once() {
        let source = Body::from_stream(stream::iter([
            Ok(Bytes::from_static(b"read")),
            Err(io::Error::other("source error")),
        ]));
        let (body, records) = metered(source);
        assert!(axum::body::to_bytes(body, 100).await.is_err());
        assert_eq!(*records.lock().unwrap(), vec![(4, 0), (0, 1)]);
    }
    #[tokio::test]
    async fn empty_body_still_counts_one_operation() {
        let (body, records) = metered(Body::empty());
        assert!(axum::body::to_bytes(body, 100).await.unwrap().is_empty());
        assert_eq!(*records.lock().unwrap(), vec![(0, 1)]);
    }
}
