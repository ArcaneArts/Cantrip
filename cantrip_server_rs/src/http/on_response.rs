//! Observe body completion. Success publications exclude errors; audit completion
//! includes them. Abandoning an unfinished body runs neither callback.
use axum::{
    body::{Body, Bytes, HttpBody},
    response::Response,
};
use http_body::Frame;
use std::{
    pin::Pin,
    task::{Context, Poll},
};

struct CompletedBody {
    inner: Body,
    callback: Option<Box<dyn FnOnce() + Send>>,
    include_errors: bool,
    headers_only: bool,
}
impl CompletedBody {
    fn complete(&mut self) {
        if let Some(callback) = self.callback.take() {
            callback();
        }
    }
}
impl HttpBody for CompletedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let frame = Pin::new(&mut self.inner).poll_frame(cx);
        match &frame {
            Poll::Ready(None) => self.complete(),
            Poll::Ready(Some(Err(_))) if self.include_errors => self.complete(),
            Poll::Ready(Some(Err(_))) => self.callback = None,
            _ => {}
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
impl Drop for CompletedBody {
    fn drop(&mut self) {
        if self.headers_only || self.inner.is_end_stream() {
            self.complete();
        }
    }
}
pub(super) fn completed(response: Response, callback: impl FnOnce() + Send + 'static) -> Response {
    observe(response, callback, false, false)
}

/// Fastify's onResponse also runs after a response error. An unread/abandoned
/// body does not qualify, and successful-mutation publishers keep using completed.
pub(super) fn finished(response: Response, callback: impl FnOnce() + Send + 'static) -> Response {
    observe(response, callback, true, false)
}

/// HEAD's GET body is discarded by the router, while its size hint and headers
/// still describe the GET response. That discard completes the header-only body.
pub(super) fn finished_head(
    response: Response,
    callback: impl FnOnce() + Send + 'static,
) -> Response {
    observe(response, callback, true, true)
}

fn observe(
    mut response: Response,
    callback: impl FnOnce() + Send + 'static,
    include_errors: bool,
    headers_only: bool,
) -> Response {
    let inner = std::mem::replace(response.body_mut(), Body::empty());
    *response.body_mut() = Body::new(CompletedBody {
        inner,
        callback: Some(Box::new(callback)),
        include_errors,
        headers_only,
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{future::poll_fn, stream};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    fn observed(body: Body) -> (Response, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        (
            completed(Response::new(body), move || {
                output.fetch_add(1, Ordering::SeqCst);
            }),
            calls,
        )
    }
    #[tokio::test]
    async fn publishes_once_after_body_is_consumed() {
        let (response, calls) = observed(Body::from("committed"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        axum::body::to_bytes(response.into_body(), 100)
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn unread_response_does_not_publish() {
        let (response, calls) = observed(Body::from("unread"));
        drop(response);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn empty_success_response_completes_without_a_frame() {
        let (response, calls) = observed(Body::empty());
        drop(response);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn partial_or_failed_stream_does_not_publish() {
        for failed in [false, true] {
            let source = Body::from_stream(stream::iter([
                Ok(Bytes::from_static(b"first")),
                Err(std::io::Error::other("failed response")),
            ]));
            let (response, calls) = observed(source);
            let mut body = response.into_body();
            poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
                .await
                .unwrap()
                .unwrap();
            if failed {
                assert!(
                    poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
                        .await
                        .unwrap()
                        .is_err()
                );
            }
            drop(body);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn audit_completion_observes_a_body_error_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let source = Body::from_stream(stream::iter([
            Ok(Bytes::from_static(b"first")),
            Err(std::io::Error::other("failed response")),
        ]));
        let response = finished(Response::new(source), move || {
            output.fetch_add(1, Ordering::SeqCst);
        });
        let mut body = response.into_body();
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        drop(body);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn audit_completion_releases_an_abandoned_body_without_running() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let source = Body::from_stream(stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"first")),
            Ok(Bytes::from_static(b"last")),
        ]));
        let response = finished(Response::new(source), move || {
            output.fetch_add(1, Ordering::SeqCst);
        });
        let mut body = response.into_body();
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .unwrap()
            .unwrap();
        drop(body);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn header_only_audit_completes_when_router_discards_the_get_body() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let response = finished_head(Response::new(Body::from("head body")), move || {
            output.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(response.body().size_hint().exact(), Some(9));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(response);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn audit_completion_handles_empty_and_final_data_without_another_poll() {
        for body in [Body::empty(), Body::from("last")] {
            let calls = Arc::new(AtomicUsize::new(0));
            let output = calls.clone();
            let response = finished(Response::new(body), move || {
                output.fetch_add(1, Ordering::SeqCst);
            });
            let mut body = response.into_body();
            if !body.is_end_stream() {
                poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert!(body.is_end_stream());
            drop(body);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
}
