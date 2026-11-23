use super::*;
use std::{
    any::Any,
    sync::atomic::{AtomicBool, Ordering},
};
struct Memo {
    manager: Weak<Inner>,
    identity: String,
    result: Arc<dyn Any + Send + Sync>,
}
struct SourceInner {
    operation: JsString,
    generation: Mutex<Option<JsString>>,
    abort: Abort,
    signal: Signal,
    closed: AtomicBool,
    released: Promise<()>,
    finish: Complete<()>,
    memo: Mutex<Vec<Memo>>,
}
/// The caller must already own a one-time canonical claim. An operation ID
/// alone is not authorization; native transport binding remains one-time.
#[derive(Clone)]
pub struct Source(Arc<SourceInner>);
#[derive(Clone)]
pub(crate) struct WeakSource(std::sync::Weak<SourceInner>);
impl WeakSource {
    pub(crate) fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }
    pub(crate) fn matches(&self, source: &Source) -> bool {
        self.0.ptr_eq(&Arc::downgrade(&source.0))
    }
}
impl Source {
    pub(crate) fn downgrade(&self) -> WeakSource {
        WeakSource(Arc::downgrade(&self.0))
    }
    pub fn claimed(operation: JsString, parent: Option<Signal>) -> Self {
        let (abort, signal) = Abort::new();
        let signal = Signal::any(parent.into_iter().chain(std::iter::once(signal)).collect());
        let (finish, released) = Promise::pair();
        Self(Arc::new(SourceInner {
            operation,
            generation: Mutex::new(None),
            abort,
            signal,
            closed: AtomicBool::new(false),
            released,
            finish,
            memo: Mutex::new(Vec::new()),
        }))
    }
    pub fn operation_id(&self) -> &JsString {
        &self.0.operation
    }
    pub fn signal(&self) -> Signal {
        self.0.signal.clone()
    }
    pub fn released(&self) -> Work<()> {
        let pending = self.0.released.clone();
        Box::pin(async move {
            match pending.work().await {
                Ok(()) => Ok(()),
                // Observation loss is not explicit canonical source release.
                Err(_) => std::future::pending().await,
            }
        })
    }
    pub fn assert_current(&self) -> Result<()> {
        self.0.signal.check()?;
        if self.0.closed.load(Ordering::Acquire) {
            bail!("The canonical inference claim has ended.");
        }
        Ok(())
    }
    pub fn native_transport_generation(&self) -> Option<JsString> {
        self.0.generation.lock().unwrap().clone()
    }
    pub fn bind_native_transport(&self, generation: JsString) -> Result<()> {
        self.assert_current()?;
        let mut current = self.0.generation.lock().unwrap();
        if generation.is_empty()
            || current
                .as_ref()
                .is_some_and(|current| current != &generation)
        {
            bail!("The inference claim belongs to another native transport.");
        }
        *current = Some(generation);
        Ok(())
    }
    pub fn close(&self) {
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.0
            .abort
            .abort(anyhow!("The canonical inference claim has ended."));
        self.0.finish.finish(Ok(()));
    }
}
#[derive(Clone)]
pub struct DirectRequest {
    pub source: Source,
    pub input: Input,
    pub preparation: Option<PreparationContext>,
    pub yield_after: bool,
}
impl DirectRequest {
    pub fn new(source: Source, provider: JsString) -> Self {
        Self {
            input: Input::new(source.operation_id().clone(), provider),
            source,
            preparation: None,
            yield_after: false,
        }
    }
}
impl Manager {
    pub fn run_direct<T: Clone + Send + Sync + 'static>(
        &self,
        input: DirectRequest,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        if input
            .preparation
            .as_ref()
            .is_some_and(|context| !context.belongs_to(self))
        {
            return Promise::ready(Err(anyhow!(
                "The preparation belongs to another inference owner."
            )))
            .work();
        }
        let identity = json!([
            Value::String(input.source.operation_id().clone()),
            Value::String(input.input.provider_id.clone()),
            json!(input.input.provider_creation_revision),
            json!(
                input
                    .input
                    .purpose
                    .clone()
                    .unwrap_or_else(|| "helper".into())
            ),
            types::nullish(&input.input.chat_id),
            types::nullish(&input.input.project_id),
            json!(
                input
                    .preparation
                    .as_ref()
                    .map(|context| context.id().clone())
            ),
            json!(input.yield_after)
        ])
        .stringify();
        let mut memo = input.source.0.memo.lock().unwrap();
        memo.retain(|entry| entry.manager.strong_count() > 0);
        let owner = Arc::downgrade(&self.0);
        if let Some(previous) = memo
            .iter()
            .find(|entry| Weak::ptr_eq(&entry.manager, &owner))
        {
            if previous.identity != identity {
                return Promise::ready(Err(anyhow!(
                    "A direct inference source cannot change identity during redelivery."
                )))
                .work();
            }
            return match previous.result.downcast_ref::<Promise<T>>() {
                Some(result) => result.work(),
                None => Promise::ready(Err(anyhow!(
                    "A direct inference source cannot change its result type during redelivery."
                )))
                .work(),
            };
        }
        let (complete, pending) = Promise::pair();
        memo.push(Memo {
            manager: owner,
            identity,
            result: Arc::new(pending.clone()),
        });
        drop(memo);
        let manager = self.clone();
        let preparation = input.preparation.clone();
        // Source result ownership is independent from the observing caller.
        let operation = cantrip_transport::lifecycle::owned(async move {
            match preparation {
                Some(context) => context.run(input, execute).await,
                None => manager.execute_direct(input, execute).await,
            }
        });
        tokio::spawn(async move {
            complete.finish(operation.await);
        });
        pending.work()
    }
    pub(super) async fn execute_direct<T: Clone + Send + Sync + 'static>(
        &self,
        input: DirectRequest,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Result<T> {
        input.source.assert_current()?;
        self.prepare_recovery().work().await?;
        input.source.assert_current()?;
        let (abort, signal) = Abort::new();
        let abort = Arc::new(abort);
        let signal = Signal::any(
            std::iter::once(signal)
                .chain(input.input.signal.clone())
                .chain(std::iter::once(input.source.signal()))
                .collect(),
        );
        let (finish, settled) = Promise::pair();
        let cancel = abort.clone();
        let runtime = self.create_owned_runtime(Some(DirectOwner {
            cancel: Arc::new(move |error| cancel.abort(error)),
            settled,
        }))?;
        let lifetime = runtime.create_operation_lifetime(input.source.operation_id().clone())?;
        let source = input.source.clone();
        let ended = Arc::new(AtomicBool::new(false));
        let stopped = ended.clone();
        let cancel = abort.clone();
        let source_listener = tokio::spawn(async move {
            let _ = source.released().await;
            if !stopped.load(Ordering::Acquire) {
                cancel.abort(anyhow!("The canonical direct inference source has ended."));
            }
        });
        let mut lease = None;
        let mut ticket = None;
        let mut outcome = Outcome::Failed;
        let result = async {
            signal.check()?;
            input.source.assert_current()?;
            let mut request = Request {
                lifetime: lifetime.clone(),
                input: input.input.clone(),
            };
            request.input.operation_id = input.source.operation_id().clone();
            request.input.recovery_key = None;
            request.input.recovery = None;
            request.input.initially_suspended = false;
            request.input.signal = Some(signal.clone());
            let requested = runtime.request(request)?;
            ticket = Some(requested.clone());
            let acquired = requested.ready().await?;
            lease = Some(acquired.clone());
            signal.check()?;
            input.source.assert_current()?;
            acquired.start()?;
            let execution_signal = Signal::any(vec![signal.clone(), acquired.signal()]);
            let value = execute(execution_signal.clone()).await?;
            execution_signal.check()?;
            outcome = Outcome::Completed;
            Ok(value)
        }
        .await;
        ended.store(true, Ordering::Release);
        source_listener.abort();
        let cleanup = {
            if let Some(lease) = &lease {
                lease.settle(
                    if signal.check().is_err() || lease.signal().check().is_err() {
                        Outcome::Interrupted
                    } else {
                        outcome
                    },
                )
            } else {
                if let Some(ticket) = &ticket {
                    ticket.cancel(None);
                }
                Ok(())
            }
        };
        lifetime.close();
        finish.finish(Ok(()));
        let retired = runtime.exited().await;
        cleanup?;
        retired?;
        result
    }
    pub(super) async fn execute_borrowed<T: Clone + Send + Sync + 'static>(
        &self,
        id: Id,
        input: DirectRequest,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
        started: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Result<T> {
        input.source.assert_current()?;
        let parent = self.edit(|state, _| {
            let ticket = &state.tickets[&id];
            if ticket.native_execution.is_some()
                || ticket.external_work.is_empty()
                || !matches!(ticket.phase, Phase::Granted | Phase::Running)
                || ticket.input.provider_id != input.input.provider_id
                || ticket.pending_settlement.is_some()
            {
                bail!("The HTTP operation cannot borrow this native reservation.");
            }
            Ok(ticket.signal.clone())
        })?;
        let (abort, own_signal) = Abort::new();
        let abort = Arc::new(abort);
        let signal = Signal::any(
            std::iter::once(parent)
                .chain(std::iter::once(own_signal))
                .chain(input.input.signal.clone())
                .chain(std::iter::once(input.source.signal()))
                .collect(),
        );
        let source = input.source.clone();
        let cancel = abort.clone();
        let listener = tokio::spawn(async move {
            let _ = source.released().await;
            cancel.abort(anyhow!("The canonical direct inference source has ended."));
        });
        let result = async {
            signal.check()?;
            input.source.assert_current()?;
            let granted = self.0.state.lock().unwrap().tickets[&id].phase == Phase::Granted;
            if granted {
                self.start(id)?;
                started()?;
            }
            let value = execute(signal.clone()).await?;
            signal.check()?;
            Ok(value)
        }
        .await;
        listener.abort();
        result
    }
}
