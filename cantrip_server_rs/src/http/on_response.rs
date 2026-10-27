//! Run successful-response side effects after the body completes. Destruction
//! before the last frame or a body error must not publish a success event.
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
        if self.inner.is_end_stream() {
            self.complete();
        }
    }
}
pub(super) fn completed(
    mut response: Response,
    callback: impl FnOnce() + Send + 'static,
) -> Response {
    let inner = std::mem::replace(response.body_mut(), Body::empty());
    *response.body_mut() = Body::new(CompletedBody {
        inner,
        callback: Some(Box::new(callback)),
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
}
