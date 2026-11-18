use super::{Diagnostic, Failure, ManagedRuntime, Scope, completion};
use crate::{
    history::live::{
        capture::{self, Capture, Timing},
        identity::ClientApi,
    },
    metadata::{Abort, Guard, Signal},
    native_items::{obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_history::{content::Encryption, projection::Work, source::Journal};
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
pub type Persisted = Arc<dyn Fn(Journal, Scope, Arc<dyn ManagedRuntime>) -> Work<()> + Send + Sync>;
pub struct Options {
    pub directory: PathBuf,
    pub worker_id: JsString,
    pub service: Arc<dyn Encryption>,
    pub client: Arc<dyn ClientApi>,
    pub on_error: Option<Diagnostic>,
    pub on_persisted: Option<Persisted>,
    pub timing: Timing,
    pub binding_timeout_ms: Option<f64>,
}
pub struct Input {
    pub chat_id: JsString,
    pub thread_id: JsString,
    pub runtime: Arc<dyn ManagedRuntime>,
    pub provenance: Option<Value>,
}
struct Entry {
    id: u64,
    chat: JsString,
    thread: JsString,
    runtime: Arc<dyn ManagedRuntime>,
    generation: OnceLock<JsString>,
    abort: Abort,
    signal: Signal,
    data: Mutex<Data>,
    closing: Mutex<Option<completion::Promise<()>>>,
}
#[derive(Clone)]
struct Handle {
    entry: Arc<Entry>,
    capture: Capture,
}
impl std::ops::Deref for Handle {
    type Target = Entry;
    fn deref(&self) -> &Entry {
        &self.entry
    }
}
struct Data {
    provenance: Value,
    binding: Option<Value>,
    journal: Option<Journal>,
}
struct State {
    next: u64,
    current: IndexMap<String, Handle>,
    entries: IndexMap<u64, Handle>,
    stopped: bool,
    stopping: completion::Promise<()>,
}
struct Inner {
    options: Arc<Options>,
    timeout: Duration,
    state: Mutex<State>,
    binding: Mutex<()>,
}
#[derive(Clone)]
pub struct Sources(Arc<Inner>);
impl Sources {
    pub fn new(options: Options) -> Result<Self> {
        let timeout = options.binding_timeout_ms.unwrap_or(30_000.);
        if !timeout.is_finite() || timeout.fract() != 0. || !(1. ..=2147483647.).contains(&timeout)
        {
            bail!("Invalid native history binding request timeout.");
        }
        Ok(Self(Arc::new(Inner {
            options: Arc::new(options),
            timeout: Duration::from_millis(timeout as u64),
            state: Mutex::new(State {
                next: 0,
                current: IndexMap::new(),
                entries: IndexMap::new(),
                stopped: false,
                stopping: completion::settled(),
            }),
            binding: Mutex::new(()),
        })))
    }
    pub fn bind(&self, input: Input) -> Result<Capture> {
        let _binding = self.0.binding.lock().unwrap();
        if self.0.state.lock().unwrap().stopped {
            bail!("Managed history capture has been stopped.");
        }
        let (owner, server) = self.0.options.service.identity()?;
        let key = Value::Array(vec![
            s(server),
            s(owner),
            s(self.0.options.worker_id.clone()),
            s(input.chat_id.clone()),
            s(input.thread_id.clone()),
        ])
        .stringify();
        let previous = self.0.state.lock().unwrap().current.get(&key).cloned();
        if let Some(previous) = &previous {
            let capture = &previous.capture;
            if Arc::ptr_eq(&previous.runtime, &input.runtime)
                && Some(capture.generation()) == input.runtime.generation()
                && capture.signal().check().is_ok()
            {
                if let Some(provenance) = input.provenance {
                    previous.data.lock().unwrap().provenance = provenance;
                }
                return Ok(capture.clone());
            }
        }
        if let Some(previous) = previous {
            drop(self.retire(previous));
        }
        let (abort, signal) = Abort::new();
        let id = {
            let mut state = self.0.state.lock().unwrap();
            state.next += 1;
            state.next
        };
        let entry = Arc::new(Entry {
            id,
            chat: input.chat_id,
            thread: input.thread_id,
            runtime: input.runtime,
            generation: OnceLock::new(),
            abort,
            signal,
            data: Mutex::new(Data {
                provenance: input
                    .provenance
                    .unwrap_or_else(|| obj([("kind", s("current"))])),
                binding: None,
                journal: None,
            }),
            closing: Mutex::new(None),
        });
        let append = entry.clone();
        let options = self.0.options.clone();
        let timeout = self.0.timeout;
        let persisted = entry.clone();
        let callbacks = self.0.options.on_persisted.clone();
        let errors = Arc::downgrade(&entry);
        let report = self.0.options.on_error.clone();
        let capture = Capture::deferred(capture::Options {
            runtime: entry.runtime.clone(),
            thread_id: entry.thread.clone(),
            timing: self.0.options.timing,
            append: Arc::new(move |frame| {
                Self::append(options.clone(), timeout, append.clone(), frame)
            }),
            on_persisted: callbacks.map(|callback| {
                Arc::new(move |_| {
                    let data = persisted.data.lock().unwrap();
                    let journal = data.journal.clone().unwrap();
                    let binding = text(data.binding.as_ref().unwrap()).unwrap().clone();
                    drop(data);
                    callback(
                        journal,
                        Scope {
                            chat_id: persisted.chat.clone(),
                            thread_id: persisted.thread.clone(),
                            binding_id: binding,
                        },
                        persisted.runtime.clone(),
                    )
                }) as capture::Persisted
            }),
            on_error: report.map(|report| {
                Arc::new(move |error, phase: capture::Phase| {
                    if let Some(entry) = errors.upgrade() {
                        report(
                            error,
                            obj([
                                ("chatId", s(entry.chat.clone())),
                                ("threadId", s(entry.thread.clone())),
                                (
                                    "generation",
                                    s(entry.generation.get().cloned().unwrap_or_else(|| "".into())),
                                ),
                                ("phase", s(phase.as_str())),
                            ]),
                        )?;
                    }
                    Ok(())
                }) as capture::Diagnostic
            }),
        })?;
        let _ = entry.generation.set(capture.generation());
        let handle = Handle {
            entry: entry.clone(),
            capture: capture.clone(),
        };
        {
            let mut state = self.0.state.lock().unwrap();
            state.entries.insert(id, handle.clone());
            state.current.insert(key.clone(), handle);
        }
        let weak = Arc::downgrade(&self.0);
        let retired = Arc::downgrade(&entry);
        capture.on_retired(Arc::new(move |_| {
            if let (Some(inner), Some(entry)) = (weak.upgrade(), retired.upgrade()) {
                let this = Self(inner);
                {
                    let mut state = this.0.state.lock().unwrap();
                    if state
                        .current
                        .get(&key)
                        .is_some_and(|current| current.id == entry.id)
                    {
                        state.current.shift_remove(&key);
                    }
                }
                let handle = this.0.state.lock().unwrap().entries.get(&entry.id).cloned();
                if let Some(handle) = handle {
                    drop(this.retire(handle));
                }
            }
        }));
        capture.activate();
        Ok(capture)
    }
    fn append(
        options: Arc<Options>,
        timeout: Duration,
        entry: Arc<Entry>,
        frame: Value,
    ) -> Work<Value> {
        cantrip_transport::lifecycle::owned(async move {
            entry.signal.check()?;
            if entry.data.lock().unwrap().binding.is_none() {
                let provenance = entry.data.lock().unwrap().provenance.clone();
                let input = obj([
                    ("chatId", s(entry.chat.clone())),
                    ("threadId", s(entry.thread.clone())),
                    ("provenance", provenance),
                ]);
                let (abort, signal) = Abort::new();
                let outcome = Guard::metadata_timeout(Some(entry.signal.clone()), None, timeout)
                    .run(options.client.open(input, Some(signal)))
                    .await;
                let binding = match outcome {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = Failure::new(error);
                        abort.abort(failure.error());
                        return Err(failure.error());
                    }
                };
                entry.signal.check()?;
                entry.data.lock().unwrap().binding = Some(binding["id"].clone());
            }
            if entry.data.lock().unwrap().journal.is_none() {
                let binding = entry.data.lock().unwrap().binding.clone().unwrap();
                let scope = cantrip_history::source::scope(
                    options.service.as_ref(),
                    &options.worker_id,
                    &entry.chat,
                    text(&binding)?,
                    &entry.thread,
                )?;
                let journal =
                    Journal::open(options.directory.clone(), scope, options.service.clone())
                        .await?;
                entry.data.lock().unwrap().journal = Some(journal);
            }
            entry.signal.check()?;
            let journal = entry.data.lock().unwrap().journal.clone().unwrap();
            journal.append(&frame).await
        })
    }
    fn retire(&self, entry: Handle) -> Work<()> {
        let mut closing = entry.closing.lock().unwrap();
        if let Some(closing) = closing.as_ref() {
            return completion::wait(closing.clone());
        }
        let (send, finished) = completion::deferred();
        *closing = Some(finished.clone());
        drop(closing);
        let weak = Arc::downgrade(&self.0);
        let pending = entry.capture.close();
        completion::finish(
            send,
            Box::pin(async move {
                let result = pending.await;
                entry
                    .abort
                    .abort(anyhow::anyhow!("This operation was aborted"));
                if let Some(inner) = weak.upgrade() {
                    inner.state.lock().unwrap().entries.shift_remove(&entry.id);
                }
                result
            }),
        );
        completion::wait(finished)
    }
    pub fn flush(&self) -> Work<()> {
        let entries = self
            .0
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let work = entries
            .iter()
            .map(|entry| entry.capture.flush())
            .collect::<Vec<_>>();
        cantrip_transport::lifecycle::owned(async move {
            futures::future::try_join_all(work).await?;
            Ok(())
        })
    }
    pub fn close(&self) -> Work<()> {
        let entries = {
            let _binding = self.0.binding.lock().unwrap();
            let mut state = self.0.state.lock().unwrap();
            state.stopped = true;
            state.current.clear();
            state.entries.values().cloned().collect::<Vec<_>>()
        };
        let work = entries
            .into_iter()
            .map(|entry| self.retire(entry))
            .collect::<Vec<_>>();
        cantrip_transport::lifecycle::owned(async move {
            futures::future::try_join_all(work).await?;
            Ok(())
        })
    }
    fn pending(entries: &[Handle]) -> Vec<Value> {
        entries
            .iter()
            .filter_map(|entry| {
                let count = entry.capture.pending_records();
                (count > 0).then(|| {
                    obj([
                        ("chatId", s(entry.chat.clone())),
                        ("threadId", s(entry.thread.clone())),
                        ("pendingRecords", Value::Number(count as f64)),
                    ])
                })
            })
            .collect()
    }
    pub fn stop(&self) -> Vec<Value> {
        self.stop_entries().0
    }
    fn stop_entries(&self) -> (Vec<Value>, Vec<Handle>) {
        let (send, stopping) = completion::deferred();
        let (entries, previous) = {
            let _binding = self.0.binding.lock().unwrap();
            let mut state = self.0.state.lock().unwrap();
            state.stopped = true;
            let entries = state.entries.values().cloned().collect::<Vec<_>>();
            let previous = state.stopping.clone();
            state.current.clear();
            state.entries.clear();
            state.stopping = stopping;
            (entries, previous)
        };
        let pending = Self::pending(&entries);
        for entry in &entries {
            entry.capture.stop();
            entry
                .abort
                .abort(anyhow::anyhow!("This operation was aborted"));
        }
        let work = entries
            .iter()
            .map(|entry| entry.capture.when_stopped())
            .collect::<Vec<_>>();
        completion::finish(
            send,
            Box::pin(async move {
                completion::wait(previous).await?;
                futures::future::try_join_all(work).await?;
                Ok(())
            }),
        );
        (pending, entries)
    }
    pub fn when_stopped(&self) -> Work<()> {
        let state = self.0.state.lock().unwrap();
        if !state.stopped {
            return super::super::live::ready(Err(anyhow::anyhow!(
                "Managed native history has not stopped."
            )));
        }
        completion::wait(state.stopping.clone())
    }
    pub fn stop_and_wait(&self) -> Work<Vec<Value>> {
        let (_, entries) = self.stop_entries();
        let stopped = self.when_stopped();
        cantrip_transport::lifecycle::owned(async move {
            stopped.await?;
            Ok(Self::pending(&entries))
        })
    }
}
