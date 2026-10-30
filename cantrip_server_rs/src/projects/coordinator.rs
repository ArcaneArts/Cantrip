//! FIFO project mutation admission, shared by protected Git and worktree operations.
use anyhow::Result;
use futures::future::BoxFuture;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};
use tokio::sync::{Mutex as Gate, Notify, OwnedMutexGuard};

type ProjectChanged = dyn Fn(&str, &str) + Send + Sync;

pub struct Coordinator {
    gates: Mutex<HashMap<String, Weak<Gate<()>>>>,
    changed: Arc<ProjectChanged>,
    active: AtomicUsize,
    drained: Notify,
}
struct Task(Arc<Coordinator>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
struct Reservation {
    coordinator: Weak<Coordinator>,
    project: String,
    gate: Arc<Gate<()>>,
    lock: Option<OwnedMutexGuard<()>>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.lock.take();
        if let Some(coordinator) = self.coordinator.upgrade() {
            let mut gates = coordinator.gates.lock().unwrap();
            if Arc::strong_count(&self.gate) == 1
                && gates
                    .get(&self.project)
                    .is_some_and(|gate| Weak::ptr_eq(gate, &Arc::downgrade(&self.gate)))
            {
                gates.remove(&self.project);
            }
        }
    }
}
impl Coordinator {
    pub fn new(changed: Arc<ProjectChanged>) -> Arc<Self> {
        Arc::new(Self {
            gates: Mutex::new(HashMap::new()),
            changed,
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }

    /// Enqueue synchronously like Source's promise chain, before Tokio can
    /// reorder spawned tasks. A failed operation still releases its successor.
    /// Owner identity belongs to this admission, not the shared project gate.
    /// Source carries it through async context; Rust carries it explicitly.
    pub fn serialize<T: Send + 'static>(
        self: &Arc<Self>,
        owner: &str,
        project: &str,
        notify: bool,
        operation: impl FnOnce() -> BoxFuture<'static, Result<T>> + Send + 'static,
    ) -> BoxFuture<'static, Result<T>> {
        let mut gates = self.gates.lock().unwrap();
        let gate = gates
            .get(project)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let gate = Arc::new(Gate::new(()));
                gates.insert(project.to_owned(), Arc::downgrade(&gate));
                gate
            });
        let mut acquire = Box::pin(gate.clone().lock_owned());
        let lock = match acquire
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(lock) => Some(lock),
            Poll::Pending => None,
        };
        let reservation = Reservation {
            coordinator: Arc::downgrade(self),
            project: project.to_owned(),
            gate,
            lock,
        };
        drop(gates);
        let coordinator = self.clone();
        let owner = owner.to_owned();
        // Source promise chains keep running when the HTTP caller goes away.
        // Detach execution from the response future for the same guarantee.
        self.own(async move {
            // Release the project gate before signaling that service work drained.
            let mut reservation = reservation;
            if reservation.lock.is_none() {
                reservation.lock = Some(acquire.as_mut().await);
            }
            drop(acquire);
            let value = operation().await?;
            if notify {
                (coordinator.changed)(&owner, &reservation.project);
            }
            Ok(value)
        })
    }

    /// Retain an admitted request through result parsing and usage persistence,
    /// even when its caller disconnects after the worker has started writing.
    pub fn own<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl Future<Output = Result<T>> + Send + 'static,
    ) -> BoxFuture<'static, Result<T>> {
        self.active.fetch_add(1, Ordering::AcqRel);
        let lifetime = Task(self.clone());
        let task = tokio::spawn(async move {
            let _lifetime = lifetime;
            operation.await
        });
        Box::pin(async move { task.await? })
    }

    /// Call after stopping admission, before closing worker/database services.
    /// Includes operations whose HTTP response futures have been dropped.
    pub async fn drain(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    #[tokio::test]
    async fn admission_order_failure_recovery_and_independent_projects() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = changes.clone();
        let coordinator = Coordinator::new(Arc::new(move |owner, id| {
            observed
                .lock()
                .unwrap()
                .push((owner.to_owned(), id.to_owned()))
        }));
        let first = coordinator.serialize("owner", "same", true, || {
            Box::pin(async { anyhow::bail!("worker failed") })
        });
        let mut second = coordinator.serialize("owner", "same", true, || Box::pin(async { Ok(2) }));
        assert!(second.as_mut().now_or_never().is_none());
        assert_eq!(
            coordinator
                .serialize("other-owner", "other", false, || Box::pin(async { Ok(3) }))
                .await
                .unwrap(),
            3
        );
        let result: Result<()> = first.await;
        assert!(result.is_err());
        assert_eq!(second.await.unwrap(), 2);
        assert_eq!(
            *changes.lock().unwrap(),
            vec![("owner".to_owned(), "same".to_owned())]
        );
        assert!(coordinator.gates.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn queued_notifications_retain_each_admissions_owner() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = changes.clone();
        let coordinator = Coordinator::new(Arc::new(move |owner, project| {
            observed
                .lock()
                .unwrap()
                .push((owner.to_owned(), project.to_owned()));
        }));
        // A project gate can outlive one caller. Publication must never use
        // the first caller's identity cached on that shared gate.
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let first = coordinator.serialize("first-owner", "shared", true, || {
            Box::pin(async move {
                wait.await?;
                Ok(())
            })
        });
        let mut second = coordinator.serialize("second-owner", "shared", true, || {
            Box::pin(async { Ok(()) })
        });
        assert!(second.as_mut().now_or_never().is_none());
        coordinator
            .serialize("third-owner", "independent", true, || {
                Box::pin(async { Ok(()) })
            })
            .await
            .unwrap();
        release.send(()).unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(
            *changes.lock().unwrap(),
            vec![
                ("third-owner".to_owned(), "independent".to_owned()),
                ("first-owner".to_owned(), "shared".to_owned()),
                ("second-owner".to_owned(), "shared".to_owned()),
            ]
        );
    }
    #[tokio::test]
    async fn drain_keeps_result_finalization_alive_after_dispatch() {
        let coordinator = Coordinator::new(Arc::new(|_, _| {}));
        let nested = coordinator.clone();
        let (dispatched, dispatch_done) = tokio::sync::oneshot::channel();
        let (release, finalize) = tokio::sync::oneshot::channel::<()>();
        let finalized = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = finalized.clone();
        let response = coordinator.own(async move {
            nested
                .serialize("owner", "project", true, || Box::pin(async { Ok(()) }))
                .await?;
            dispatched.send(()).unwrap();
            finalize.await?;
            observed.store(true, Ordering::Release);
            Ok(())
        });
        dispatch_done.await.unwrap();
        drop(response);
        let mut drained = Box::pin(coordinator.drain());
        assert!(drained.as_mut().now_or_never().is_none());
        assert!(!finalized.load(Ordering::Acquire));
        release.send(()).unwrap();
        drained.await;
        assert!(finalized.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn drain_waits_for_disconnected_callers_and_failure_cleanup() {
        let coordinator = Coordinator::new(Arc::new(|_, _| {}));
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let response = coordinator.serialize("owner", "project", false, || {
            Box::pin(async move {
                wait.await?;
                anyhow::bail!("worker failed")
            })
        });
        let response: BoxFuture<'static, Result<()>> = response;
        drop(response);
        let mut drain = Box::pin(coordinator.drain());
        assert!(drain.as_mut().now_or_never().is_none());
        release.send(()).unwrap();
        drain.await;
        assert_eq!(coordinator.active.load(Ordering::Acquire), 0);
        assert!(coordinator.gates.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn dropping_responses_does_not_cancel_admitted_mutations() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = changes.clone();
        let coordinator = Coordinator::new(Arc::new(move |_, project| {
            observed.lock().unwrap().push(project.to_owned());
        }));
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let first = coordinator.serialize("owner", "project", true, || {
            Box::pin(async move {
                wait.await?;
                Ok(1)
            })
        });
        let operations = Arc::new(Mutex::new(Vec::new()));
        let observed = operations.clone();
        let abandoned = coordinator.serialize("owner", "project", true, move || {
            Box::pin(async move {
                observed.lock().unwrap().push(2);
                Ok(2)
            })
        });
        let observed = operations.clone();
        let mut last = coordinator.serialize("owner", "project", false, move || {
            Box::pin(async move {
                observed.lock().unwrap().push(3);
                Ok(3)
            })
        });
        drop(first);
        drop(abandoned);
        assert!(last.as_mut().now_or_never().is_none());
        assert!(operations.lock().unwrap().is_empty());
        release.send(()).unwrap();
        assert_eq!(last.await.unwrap(), 3);
        assert_eq!(*operations.lock().unwrap(), vec![2, 3]);
        assert_eq!(*changes.lock().unwrap(), vec!["project", "project"]);
        assert!(coordinator.gates.lock().unwrap().is_empty());
    }
}
