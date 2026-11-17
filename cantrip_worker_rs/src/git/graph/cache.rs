//! Bounded analyzer caches: accepted commands own pending subprocess work.
use super::*;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, WeakShared},
};
use std::{
    future::Future,
    sync::{Mutex, OnceLock},
};
type Job = BoxFuture<'static, std::result::Result<Value, JsString>>;
type Flight = Shared<Job>;
struct Entry {
    used: i64,
    pending: WeakShared<Job>,
    settled: Option<Flight>,
}
#[derive(Default)]
pub(super) struct Cache(IndexMap<String, Entry>);
pub(super) static SNAPSHOTS: OnceLock<Mutex<Cache>> = OnceLock::new();
pub(super) static METRICS: OnceLock<Mutex<Cache>> = OnceLock::new();
static LATEST: OnceLock<Mutex<IndexMap<String, (i64, Value)>>> = OnceLock::new();
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(super) async fn value(
    cache: &'static OnceLock<Mutex<Cache>>,
    key: String,
    scope: &Scope,
    create: impl Future<Output = Result<Value>> + Send + 'static,
) -> Result<Value> {
    let cache = cache.get_or_init(Mutex::default);
    let flight = {
        let mut cache = cache.lock().unwrap();
        if let Some((entry, flight)) = cache
            .0
            .get_mut(&key)
            .and_then(|entry| entry.pending.upgrade().map(|flight| (entry, flight)))
        {
            entry.used = now();
            flight
        } else {
            cache.0.shift_remove(&key);
            let flight = async move {
                create
                    .await
                    .map_err(|error| super::super::error_message(&error))
            }
            .boxed()
            .shared();
            cache.0.insert(
                key.clone(),
                Entry {
                    used: now(),
                    pending: flight.downgrade().unwrap(),
                    settled: None,
                },
            );
            if cache.0.len() > 16 {
                let oldest = cache
                    .0
                    .iter()
                    .filter(|(candidate, _)| *candidate != &key)
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    cache.0.shift_remove(&oldest);
                }
            }
            flight
        }
    };
    let result = flight.clone().await;
    {
        let mut cache = cache.lock().unwrap();
        if cache
            .0
            .get(&key)
            .and_then(|entry| entry.pending.upgrade())
            .is_some_and(|current| current.ptr_eq(&flight))
        {
            if result.is_ok() {
                cache.0.get_mut(&key).unwrap().settled = Some(flight);
            } else {
                cache.0.shift_remove(&key);
            }
        }
    }
    scope.check()?;
    result.map_err(|error| super::super::GitError(error).into())
}
pub(super) fn latest(key: &str) -> Option<Value> {
    LATEST
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .get(key)
        .map(|(_, value)| value.clone())
}
pub(super) fn publish(key: String, metrics: &Value) {
    let mut cache = LATEST.get_or_init(Mutex::default).lock().unwrap();
    cache.insert(key.clone(), (now(), metrics.clone()));
    if cache.len() > 16 {
        let oldest = cache
            .iter()
            .filter(|(candidate, _)| *candidate != &key)
            .min_by_key(|(_, entry)| entry.0)
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            cache.shift_remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    struct Resource(Arc<AtomicBool>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn pending_cache_never_owns_a_running_resource() {
        let dropped = Arc::new(AtomicBool::new(false));
        let resource = Resource(dropped.clone());
        let flight: Flight = async move {
            let _resource = resource;
            futures::future::pending::<()>().await;
            Ok(Value::Null)
        }
        .boxed()
        .shared();
        let entry = Entry {
            used: 0,
            pending: flight.downgrade().unwrap(),
            settled: None,
        };
        let mut caller = Box::pin(flight.clone());
        assert!(futures::poll!(caller.as_mut()).is_pending());
        drop(flight);
        assert!(!dropped.load(Ordering::SeqCst));
        drop(caller);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(entry.pending.upgrade().is_none());
    }
    #[tokio::test]
    async fn pending_queries_share_results_failures_retry_and_cache_stays_bounded() {
        static TEST: OnceLock<Mutex<Cache>> = OnceLock::new();
        let count = Arc::new(AtomicUsize::new(0));
        let runs = count.clone();
        let scope = Scope::default();
        let (left, right) = tokio::join!(
            value(&TEST, "shared".into(), &scope, async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(json!(42))
            }),
            value(&TEST, "shared".into(), &scope, async { Ok(json!(99)) }),
        );
        assert_eq!(left.unwrap(), json!(42));
        assert_eq!(right.unwrap(), json!(42));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(
            value(&TEST, "retry".into(), &scope, async {
                bail!("owned fixture failure")
            })
            .await
            .is_err()
        );
        assert_eq!(
            value(&TEST, "retry".into(), &scope, async { Ok(json!(true)) })
                .await
                .unwrap(),
            json!(true)
        );
        for i in 0..20 {
            value(
                &TEST,
                format!("entry-{i}"),
                &scope,
                async move { Ok(json!(i)) },
            )
            .await
            .unwrap();
        }
        assert_eq!(TEST.get().unwrap().lock().unwrap().0.len(), 16);
    }
}
