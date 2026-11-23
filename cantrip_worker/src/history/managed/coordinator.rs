//! One worker history lifetime: capture wakes both canonical delivery and child
//! discovery; flush reaches a fixed point before confirming receipt checkpoints.
use super::{
    Diagnostic, Failure, Retry, canonical, completion,
    descendants::{self, Descendants},
    projection::{self, Pump},
    sources::{self, Input, Sources},
};
use crate::{
    attachments,
    history::{
        adapters,
        client::Client,
        live::{
            capture::{Capture, Timing},
            identity, mode,
        },
    },
    metadata::Signal,
    native_items::s,
};
use anyhow::{Result, anyhow};
use cantrip_history::{content::Encryption, projection::Work};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
pub struct Options {
    pub directory: PathBuf,
    pub worker_id: JsString,
    pub service: Arc<dyn Encryption>,
    /// Separate attachment-content grants, not chat-content key material.
    pub attachment_keys: Arc<dyn attachments::content::Keys>,
    pub client: Client,
    pub attachments: attachments::Store,
    pub on_error: Option<Diagnostic>,
    pub timing: Timing,
    pub retry: Retry,
}
#[derive(Default)]
struct Routing {
    sources: OnceLock<Sources>,
    roots: Mutex<IndexMap<String, Input>>,
}
fn key(chat: &JsString, thread: &JsString) -> String {
    Value::Array(vec![s(chat.clone()), s(thread.clone())]).stringify()
}
impl Routing {
    fn bind(&self, input: Input) -> Result<Capture> {
        let capture = self
            .sources
            .get()
            .expect("history sources installed before discovery starts")
            .bind(input.clone())?;
        self.roots
            .lock()
            .unwrap()
            .insert(key(&input.chat_id, &input.thread_id), input);
        Ok(capture)
    }
}
struct Inner {
    routing: Arc<Routing>,
    descendants: Descendants,
    projection: Pump,
    client: Client,
    on_error: Option<Diagnostic>,
    stopping: Mutex<Option<completion::Promise<Vec<Value>>>>,
}
#[derive(Clone)]
pub struct History(Arc<Inner>);
fn diagnostic(report: &Option<Diagnostic>, phase: &'static str) -> Option<Diagnostic> {
    report.clone().map(|report| {
        Arc::new(move |error, mut context: Value| {
            context["phase"] = s(phase);
            report(error, context)
        }) as Diagnostic
    })
}
impl History {
    pub fn new(options: Options) -> Result<Self> {
        let source_directory = options.directory.join("native-history-sources");
        let canonical_directory = options.directory.join("native-history-canonical");
        let materialized = canonical_directory.join("materialized");
        let keys = options.attachment_keys;
        let files = options.attachments;
        let adapters: canonical::AdapterFactory = Arc::new(move |binding, signal, source| {
            let prepared = adapters::Verified::new(adapters::Options {
                directory: materialized.clone(),
                binding,
                source,
                keys: keys.clone(),
                files: files.clone(),
                signal: Some(signal),
                child_scope: None,
                child_association: None,
                published_attachments: None,
            });
            Box::pin(async move {
                Ok(Arc::new(prepared?) as Arc<dyn crate::history::projector::Adapters>)
            })
        });
        let factory = canonical::Canonical {
            directory: canonical_directory,
            worker_id: options.worker_id.clone(),
            service: options.service.clone(),
            client: options.client.clone(),
            adapters,
        }
        .factory();
        let projection = Pump::new(projection::Options {
            worker_id: options.worker_id.clone(),
            service: options.service.clone(),
            source_directory: Some(source_directory.clone()),
            factory,
            on_error: diagnostic(&options.on_error, "project"),
            on_recovery_error: diagnostic(&options.on_error, "recover"),
            retry: options.retry,
        });
        let routing = Arc::new(Routing::default());
        let bind = Arc::downgrade(&routing);
        let descendants = Descendants::new(descendants::Options {
            client: Arc::new(options.client.clone()),
            bind: Arc::new(move |input| {
                let owner = bind
                    .upgrade()
                    .ok_or_else(|| anyhow!("Native child history discovery stopped."))?;
                let capture = owner.bind(input)?;
                Ok(Some(
                    Arc::new(move || capture.reconcile(None)) as descendants::Reconcile
                ))
            }),
            on_error: diagnostic(&options.on_error, "discover-children"),
            retry_delay: Duration::from_millis(options.retry.initial),
        });
        let project = projection.clone();
        let discover = descendants.clone();
        let sources = Sources::new(sources::Options {
            directory: source_directory,
            worker_id: options.worker_id,
            service: options.service,
            client: Arc::new(options.client.clone()),
            timing: options.timing,
            binding_timeout_ms: None,
            on_error: options.on_error.clone(),
            on_persisted: Some(Arc::new(move |source, scope, runtime| {
                let result = project.wake(source.clone(), scope.clone());
                if result.is_ok() {
                    discover.wake(source, scope, runtime);
                }
                Box::pin(async move { result })
            })),
        })?;
        let _ = routing.sources.set(sources);
        Ok(Self(Arc::new(Inner {
            routing,
            descendants,
            projection,
            client: options.client,
            on_error: options.on_error,
            stopping: Mutex::new(None),
        })))
    }
    pub fn bind(&self, input: Input) -> Result<Capture> {
        self.0.routing.bind(input)
    }
    /// Start capture before dispatch. Binding and projection I/O remain owned
    /// by the History lifetime, independently of live output and Stop.
    pub(crate) fn capture_outputs(&self, input: Input, lifetime: Signal) -> identity::Managed {
        if let Err(error) = self.bind(input.clone())
            && let Some(report) = &self.0.on_error
        {
            let _ = report(
                Failure::new(error),
                json!({
                    "phase": "observe", "chatId": input.chat_id, "threadId": input.thread_id,
                    "generation": input.runtime.generation(),
                }),
            );
        }
        let this = self.clone();
        let runtime = input.runtime.clone();
        let modes = mode::Resolver::scoped(
            Arc::new(move |thread| runtime.read_history(thread)),
            Some(input.runtime.clone()),
            Some(lifetime.clone()),
        );
        identity::Managed::new(identity::Options {
            client: Arc::new(self.0.client.clone()),
            mode: identity::with_mode(modes),
            signal: Some(lifetime),
            scope: Arc::new(move |thread, agent_scope| {
                if thread == input.thread_id {
                    let scope = json!({
                        "chatId": input.chat_id, "threadId": input.thread_id,
                        "provenance": input.provenance,
                    });
                    Box::pin(async move { Ok(Some(scope)) })
                } else if agent_scope.is_some_and(|scope| {
                    scope["rootThreadId"].as_js_string() == Some(&input.thread_id)
                }) {
                    let child = this.output_scope(&input.chat_id, &input.thread_id, thread);
                    Box::pin(async move { child.await.map(Some) })
                } else {
                    Box::pin(async { Ok(None) })
                }
            }),
        })
    }
    pub fn output_scope(&self, chat: &JsString, root: &JsString, thread: JsString) -> Work<Value> {
        let input = self
            .0
            .routing
            .roots
            .lock()
            .unwrap()
            .get(&key(chat, root))
            .cloned();
        match input {
            Some(input) => self.0.descendants.resolve(input, thread),
            None => {
                Box::pin(async { Err(anyhow!("Child native output has no managed history root.")) })
            }
        }
    }
    pub fn flush(&self) -> Work<()> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            loop {
                let revision = this.0.descendants.revision();
                this.0.routing.sources.get().unwrap().flush().await?;
                this.0.descendants.flush().await?;
                if revision == this.0.descendants.revision() {
                    break;
                }
            }
            this.0.projection.flush().await
        })
    }
    pub fn stop(&self) -> Work<Vec<Value>> {
        let mut stopping = self.0.stopping.lock().unwrap();
        if let Some(pending) = stopping.as_ref() {
            return completion::wait(pending.clone());
        }
        let (send, pending) = completion::deferred();
        *stopping = Some(pending.clone());
        drop(stopping);
        let source = self.0.routing.sources.get().unwrap().stop_and_wait();
        let project = self.0.projection.stop();
        let children = self.0.descendants.stop();
        completion::finish(
            send,
            Box::pin(async move {
                let (pending, _, _) = tokio::try_join!(source, project, children)?;
                Ok(pending)
            }),
        );
        completion::wait(pending)
    }
}
