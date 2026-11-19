//! Transfer the exact native queue source. Core keeps it ineligible until
//! the owning app-server confirms its durable compare-and-delete receipt.
use super::{State, Views, entry_id, observe, prompt, required};
use crate::{
    attachments::Store,
    chat_content::Scope,
    codex::{
        managed::{QueueObserver, Runtime, WeakRuntime},
        preparation::{
            command::{Prepared, native_session},
            native::LoadedThread,
        },
        turn::{
            Key, RPC_TIMEOUT, Turns,
            receipt::{Client, crypto_context},
        },
    },
    encryption::Service,
    native_items::array,
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{open_native_command_request, protect_native_command_request};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone)]
pub(in crate::codex) struct Factory {
    encryption: Arc<Service>,
    receipts: Client,
    attachments: Store,
    views: Views,
}

impl Turns {
    pub(crate) fn configure_queue_imports(&self) -> Result<()> {
        self.preparation.configure_queue_imports(Factory {
            encryption: self.encryption.clone(),
            receipts: self.receipts.clone(),
            attachments: self.attachments.clone(),
            views: self.console_queues.clone(),
        })
    }
}

/// The selected thread owns the observation. Console views and pending
/// imports can retain its data but cannot extend its authority.
pub(in crate::codex) struct Binding {
    pub import: Arc<Import>,
    _selected: Arc<()>,
    _observer: QueueObserver,
}

impl Factory {
    pub(in crate::codex) fn bind(
        &self,
        prepared: &Prepared,
        command: &Value,
        previous: Option<&Arc<Binding>>,
    ) -> Result<Arc<Binding>> {
        let thread = &prepared.thread;
        let runtime = &prepared.runtime;
        let mut session = native_session(command, runtime, thread.id());
        session["connectionId"] = json!(format!("queue-owner:{}", runtime.generation()));
        let chat = required(&session["chatId"], "chat ID")?;
        let key = (
            prepared.bound.0.clone(),
            required(&prepared.bound.1, "logical server ID")?,
            chat.clone(),
        );
        let input = prompt::Input {
            chat,
            directory: if prepared.environment.is_some() {
                prepared.codex_home.clone()
            } else {
                crate::filesystem::paths::native(
                    command["cwd"]
                        .as_js_string()
                        .context("Managed queue working directory")?,
                )
            },
            model: command["model"].clone(),
            plan_mode: command["planMode"].clone(),
            subagent_model: command["subagentDefaults"]["model"].clone(),
            worktree: command["session"]["worktreeId"].clone(),
        };
        if let Some(binding) = previous
            && binding.import.key == key
            && binding.import.thread == *thread
            && binding.import.session == session
            && binding.import.runner == prepared.runner_generation
        {
            *binding.import.input.lock().unwrap() = input;
            return Ok(binding.clone());
        }

        let selected = Arc::new(());
        let import = Arc::new(Import {
            selected: Arc::downgrade(&selected),
            runtime: runtime.downgrade(),
            thread: thread.clone(),
            runner: prepared.runner_generation.clone(),
            session,
            input: Mutex::new(input),
            state: self.views.watch(key.clone()),
            key,
            client: self.clone(),
            schedule: Mutex::new(Schedule::Idle),
            reconciled: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&import);
        let observer: QueueObserver = Arc::new(move || {
            if let Some(import) = weak.upgrade() {
                import.schedule();
            }
        });
        runtime.observe_queue(thread.id().clone(), &observer);
        Ok(Arc::new(Binding {
            import,
            _selected: selected,
            _observer: observer,
        }))
    }
}

pub(in crate::codex) struct Import {
    selected: Weak<()>,
    runtime: WeakRuntime,
    thread: LoadedThread,
    runner: JsString,
    session: Value,
    input: Mutex<prompt::Input>,
    pub(in crate::codex::turn::console) state: Arc<State>,
    key: Key,
    client: Factory,
    schedule: Mutex<Schedule>,
    reconciled: AtomicBool,
}

#[derive(PartialEq, Eq)]
enum Schedule {
    Idle,
    InFlight,
    Changed,
}

impl Import {
    pub(super) fn input(&self) -> prompt::Input {
        self.input.lock().unwrap().clone()
    }

    pub(in crate::codex) fn reconcile_on_prepare(self: &Arc<Self>) {
        if !self.reconciled.load(Ordering::Acquire) {
            self.schedule();
        }
    }

    fn schedule(self: &Arc<Self>) {
        {
            let mut state = self.schedule.lock().unwrap();
            if *state != Schedule::Idle {
                *state = Schedule::Changed;
                return;
            }
            *state = Schedule::InFlight;
        }
        let import = self.clone();
        tokio::spawn(async move {
            let _guard = import.state.sync_import.lock().await;
            let mut retried = false;
            loop {
                let reconciled = match Scope::new(import.client.encryption.clone()) {
                    Ok(scope) => import.drain(&scope).await.is_ok(),
                    Err(_) => false,
                };
                import.reconciled.store(reconciled, Ordering::Release);
                let mut state = import.schedule.lock().unwrap();
                // A committed deletion itself emits a queue change. Recover
                // one lost acknowledgment without spinning on repeated failures.
                if *state == Schedule::Changed && (reconciled || !retried) {
                    *state = Schedule::InFlight;
                    retried = !reconciled;
                } else {
                    *state = Schedule::Idle;
                    break;
                }
            }
        });
    }

    pub(in crate::codex::turn::console) async fn synchronize(&self, scope: &Scope) -> Result<()> {
        let _guard = self.state.sync_import.lock().await;
        let result = self.drain(scope).await;
        self.reconciled.store(result.is_ok(), Ordering::Release);
        result
    }

    fn current(&self, scope: &Scope) -> Result<Runtime> {
        ensure!(
            self.selected.strong_count() > 0,
            "The managed queue owner was replaced."
        );
        let (owner, server) = scope.identity()?;
        ensure!(
            owner == self.key.0 && server == self.key.1,
            "The managed queue owner changed."
        );
        let runtime = self
            .runtime
            .upgrade()
            .context("The managed queue runtime closed.")?;
        self.thread.assert_current(&runtime)?;
        Ok(runtime)
    }

    async fn drain(&self, scope: &Scope) -> Result<()> {
        // The runner's execution gate keeps legacy queue input from starting
        // autonomously while Core acquires it.
        self.current(scope)?;
        // Reconcile a committed deletion even after the native queue is empty.
        self.stage(scope, vec![]).await?;
        for source in self.read(scope).await? {
            self.current(scope)?;
            let prompt_id = self.source_prompt(scope, &source["id"]);
            let operation = operation_id(&prompt_id);
            let grant = scope.material(None)?;
            let (protected, digest) = protect_native_command_request(
                &grant.key,
                &crypto_context(&grant, &self.session["chatId"], &operation),
                &source,
            )?;
            let input = self.input();
            let mut item = prompt::prepare(&input, &self.client.attachments, scope, &json!({
                "threadId":self.thread.id(),"input":source["input"],"clientUserMessageId":source["clientUserMessageId"],
                "managed":json!({"action":"literal","operationId":operation}),
            }), &operation, &prompt_id, prompt::Preparation::Import).await?;
            item["nativeItemId"] = source["id"].clone();
            item["sourceDigest"] = json!(digest);
            item["protectedSource"] = protected;
            self.stage(scope, vec![item]).await?;
        }
        self.current(scope)?;
        Ok(())
    }

    fn source_prompt(&self, scope: &Scope, id: &Value) -> JsString {
        entry_id(&json!((
            &scope.server,
            &scope.owner,
            &self.key.2,
            self.thread.id(),
            id
        )))
    }

    async fn read(&self, scope: &Scope) -> Result<Vec<Value>> {
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        loop {
            let page = self
                .native(
                    scope,
                    "thread/queue/list",
                    json!({
                        "threadId":self.thread.id(),"cursor":cursor,"limit":100,
                    }),
                )
                .await?;
            for raw in array(&page["data"])? {
                // Keep the reference client's field order for the protected digest.
                let value = json!({"id":raw["id"],"input":raw["input"],"clientUserMessageId":raw["clientUserMessageId"]});
                validate_source(&value)?;
                rows.push(value);
            }
            let next = page
                .get("nextCursor")
                .context("The native queue returned no cursor.")?;
            if next.is_null() || next == "" {
                return Ok(rows);
            }
            let next = next
                .as_js_string()
                .context("The native queue returned an invalid cursor.")?;
            ensure!(
                seen.insert(next.clone()),
                "The native queue returned a repeated cursor."
            );
            cursor = json!(next);
        }
    }

    async fn native(&self, scope: &Scope, method: &'static str, params: Value) -> Result<Value> {
        let reply = self
            .current(scope)?
            .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
            .await?
            .context("The app-server returned no native queue response.")?;
        self.current(scope)?;
        Ok(reply)
    }

    async fn stage(&self, scope: &Scope, items: Vec<Value>) -> Result<()> {
        self.current(scope)?;
        let client = &self.client.receipts;
        let runner = &self.runner;
        let session = &self.session;
        let staged = client
            .queue(
                scope,
                "import",
                json!({
                    "session":session,"runnerGeneration":runner,"items":items,
                }),
                None,
            )
            .await?;
        self.current(scope)?;
        observe(&self.state, &staged);
        for record in array(&staged["imports"])? {
            if !matches!(record["status"].as_str(), Some("pending" | "uncertain")) {
                continue;
            }
            self.current(scope)?;
            let prompt = required(&record["promptId"], "imported prompt ID")?;
            let operation = operation_id(&prompt);
            let envelope = &record["protectedSource"];
            let revision = envelope["keyRevision"]
                .as_u64()
                .context("The native queue source key is missing.")?;
            let grant = scope.material(Some(revision))?;
            let (source, digest) = open_native_command_request(
                &grant.key,
                &crypto_context(&grant, &session["chatId"], &operation),
                envelope,
            )?;
            validate_source(&source)?;
            ensure!(
                source["id"] == record["nativeItemId"]
                    && record["sourceDigest"] == digest
                    && self.source_prompt(scope, &source["id"]) == prompt,
                "The native queue import source belongs to another item."
            );
            let receipt = self.native(scope, "thread/managedExecution/queueDelete", json!({
                "threadId":session["threadId"],"runnerGeneration":runner,
                "operationId":record["nativeDeleteOperationId"],"queuedSubmissionId":source["id"],
                "expectedInput":source["input"],"expectedClientUserMessageId":source["clientUserMessageId"],
            })).await?;
            let acknowledged = client
                .queue(
                    scope,
                    "import-ack",
                    json!({
                        "session":session,"runnerGeneration":runner,"importId":record["importId"],
                        "sourceDigest":record["sourceDigest"],"receipt":receipt,
                    }),
                    None,
                )
                .await?;
            self.current(scope)?;
            observe(&self.state, &acknowledged);
        }
        Ok(())
    }
}

fn operation_id(prompt: &JsString) -> JsString {
    crate::native_items::concat(&["queue-import:".into(), prompt.clone()])
}

fn validate_source(source: &Value) -> Result<()> {
    ensure!(
        source.as_object().is_some_and(|fields| fields.len() == 3)
            && source["id"].is_string()
            && array(&source["input"])?.iter().all(Value::is_object)
            && source["clientUserMessageId"].is_string(),
        "Malformed native queue input."
    );
    Ok(())
}
