use super::*;
use crate::{
    history::{
        live::{
            capture::Timing,
            identity::ClientApi,
            observation::{Hub, RuntimeHub},
        },
        projector::Resolver,
    },
    metadata::Signal,
};
use anyhow::Result;
use cantrip_history::{
    content::{Encryption, Material},
    projection::Work,
};
use futures::FutureExt;
use std::sync::{
    Barrier,
    atomic::{AtomicUsize, Ordering},
};
struct Keys;
impl Encryption for Keys {
    fn identity(&self) -> Result<(JsString, JsString)> {
        Ok(("owner".into(), "server".into()))
    }
    fn material(&self, _: Option<u64>) -> Result<Material> {
        Ok(Material {
            owner_id: "owner".into(),
            server_id: "server".into(),
            key_revision: 1,
            key: cantrip_crypto::Zeroizing::new(vec![31; 32]),
        })
    }
}
struct Client(AtomicUsize);
impl Resolver for Client {
    fn resolve(&self, _: Value, _: Option<Signal>) -> Work<Value> {
        unreachable!()
    }
}
impl ClientApi for Client {
    fn resolve(&self, input: Value, signal: Option<Signal>) -> Work<Value> {
        Resolver::resolve(self, input, signal)
    }
    fn open(&self, _: Value, _: Option<Signal>) -> Work<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(obj([("id", s("binding"))])) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_views_share_capture_and_repeated_stop_joins_inflight_callback() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let hub = Hub::default();
    hub.replace(Some("generation".into()));
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    let runtime = Arc::new(RuntimeHub {
        hub,
        read: Arc::new(move |thread| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                cantrip_history::native::snapshot(
                    &obj([(
                        "thread",
                        obj([
                            ("id", s(thread.clone())),
                            ("status", obj([("type", s("idle"))])),
                            ("turns", Value::Array(Vec::new())),
                        ]),
                    )]),
                    &thread,
                )
            })
        }),
    });
    let client = Arc::new(Client(AtomicUsize::new(0)));
    let entered = Arc::new(tokio::sync::Notify::new());
    let active = entered.clone();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let permits = release.clone();
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    let reported = errors.clone();
    let sources = sources::Sources::new(sources::Options {
        directory: directory.path().into(),
        worker_id: "worker".into(),
        service: Arc::new(Keys),
        client: client.clone(),
        on_error: Some(Arc::new(move |error, _| {
            let mut errors = reported.lock().unwrap();
            if errors.len() < 2 {
                errors.push(error.to_string());
            }
            Ok(())
        })),
        on_persisted: Some(Arc::new(move |_, _, _| {
            active.notify_one();
            let release = permits.clone();
            cantrip_transport::lifecycle::owned(async move {
                let _permit = release.acquire_owned().await?;
                Ok(())
            })
        })),
        timing: Timing::new(Some(1.), Some(2.), Some(0.))?,
        binding_timeout_ms: None,
    })?;
    let handle = tokio::runtime::Handle::current();
    let barrier = Arc::new(Barrier::new(2));
    let captures = std::thread::scope(|scope| {
        let jobs = (0..2)
            .map(|_| {
                let sources = sources.clone();
                let runtime = runtime.clone();
                let barrier = barrier.clone();
                let handle = handle.clone();
                scope.spawn(move || {
                    let _enter = handle.enter();
                    barrier.wait();
                    sources.bind(sources::Input {
                        chat_id: "chat".into(),
                        thread_id: "thread".into(),
                        runtime,
                        provenance: None,
                    })
                })
            })
            .collect::<Vec<_>>();
        jobs.into_iter()
            .map(|job| job.join().unwrap())
            .collect::<Result<Vec<_>>>()
    })?;
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "{error}: reads={}, opens={}, errors={:?}",
                reads.load(Ordering::SeqCst),
                client.0.load(Ordering::SeqCst),
                errors.lock().unwrap()
            )
        })?;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(client.0.load(Ordering::SeqCst), 1);
    let mut first = sources.stop_and_wait();
    let mut second = sources.stop_and_wait();
    assert!(first.as_mut().now_or_never().is_none());
    assert!(second.as_mut().now_or_never().is_none());
    release.add_permits(1);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), first)
            .await??
            .is_empty()
    );
    assert!(second.await?.is_empty());
    assert!(
        captures
            .iter()
            .all(|capture| capture.signal().check().is_err())
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_child_wakes_share_one_scan_and_stop_abandons_unowned_native_read() -> Result<()>
{
    let directory = tempfile::tempdir()?;
    let keys = Arc::new(Keys);
    let source = cantrip_history::source::Journal::open(
        directory.path().into(),
        cantrip_history::source::scope(
            keys.as_ref(),
            &"worker".into(),
            &"chat".into(),
            &"binding-root".into(),
            &"root".into(),
        )?,
        keys,
    )
    .await?;
    source
        .append(&obj([
            ("kind", s("notification")),
            ("generation", s("generation")),
            ("threadId", s("root")),
            ("sequence", Value::Number(1.)),
            ("receivedAtMs", Value::Number(1.)),
            ("method", s("item/completed")),
            (
                "params",
                obj([
                    ("threadId", s("root")),
                    (
                        "item",
                        obj([
                            ("type", s("subAgentActivity")),
                            ("agentThreadId", s("child")),
                        ]),
                    ),
                ]),
            ),
        ]))
        .await?;
    let hub = Hub::default();
    hub.replace(Some("generation".into()));
    let entered = Arc::new(tokio::sync::Notify::new());
    let active = entered.clone();
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let runtime = Arc::new(RuntimeHub {
        hub,
        read: Arc::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            active.notify_one();
            Box::pin(std::future::pending())
        }),
    });
    let owner = descendants::Descendants::new(descendants::Options {
        client: Arc::new(Client(AtomicUsize::new(0))),
        bind: Arc::new(|_| panic!("unverified child must not bind")),
        on_error: None,
        retry_delay: std::time::Duration::from_millis(1),
    });
    let handle = tokio::runtime::Handle::current();
    let barrier = Arc::new(Barrier::new(2));
    std::thread::scope(|scope| {
        let jobs = (0..2)
            .map(|_| {
                let owner = owner.clone();
                let source = source.clone();
                let runtime = runtime.clone();
                let handle = handle.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    let _entered = handle.enter();
                    barrier.wait();
                    owner.wake(
                        source,
                        Scope {
                            chat_id: "chat".into(),
                            thread_id: "root".into(),
                            binding_id: "binding-root".into(),
                        },
                        runtime,
                    );
                })
            })
            .collect::<Vec<_>>();
        for job in jobs {
            job.join().unwrap();
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified()).await?;
    tokio::time::timeout(std::time::Duration::from_secs(2), owner.stop()).await??;
    owner.flush().await?;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(source.read(0, 512).await?.len(), 1);
    Ok(())
}
