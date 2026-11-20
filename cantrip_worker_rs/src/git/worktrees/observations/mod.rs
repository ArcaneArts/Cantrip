//! Worker-owned Git/file observations. The emitter receives full notifications;
//! each transport adapter applies its own established privacy boundary.
pub mod activity;
pub mod notification;
use super::{Manager, text};
use crate::{
    filesystem::{Scope, paths, source_path},
    git::{conflicts, managed, status},
    routing::Registry,
};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::{StreamExt, stream};
use indexmap::{IndexMap, IndexSet};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex as Queue, Notify, watch},
    task::{JoinHandle, JoinSet},
    time::{Instant, MissedTickBehavior},
};
pub type Emitter = dyn Fn(Value) -> bool + Send + Sync;
struct Snapshot {
    worktree: Option<Value>,
    status: Option<String>,
    operation: Option<Value>,
    head: Option<Value>,
    due: Option<Instant>,
    filesystem: bool,
}
struct Target {
    value: Value,
    activity: Arc<activity::Activity>,
    snapshot: Mutex<Snapshot>,
    watchers: Mutex<Vec<RecommendedWatcher>>,
    watcher_failed: AtomicBool,
    reading: Queue<()>,
}
#[derive(Default)]
struct State {
    targets: IndexMap<JsString, Arc<Target>>,
    inventories: IndexMap<JsString, String>,
}
struct Inner {
    manager: Arc<Manager>,
    state: Mutex<State>,
    emitter: Arc<Emitter>,
    wake: Notify,
    refresh: AtomicU8,
    source_running: AtomicBool,
    head_running: AtomicBool,
    closed: AtomicBool,
    scope: Scope,
}
pub struct Observations {
    inner: Arc<Inner>,
    stop: watch::Sender<bool>,
    task: Queue<Option<JoinHandle<()>>>,
}
fn key(target: &Value) -> JsString {
    JsString::new(
        [
            target["sourcePath"].as_js_string().unwrap().units(),
            &[0],
            target["worktreePath"].as_js_string().unwrap().units(),
        ]
        .concat(),
    )
}
impl Observations {
    pub fn new(manager: Arc<Manager>, emitter: Arc<Emitter>) -> Self {
        let (stop, receiver) = watch::channel(false);
        let inner = Arc::new(Inner {
            manager,
            state: Mutex::default(),
            emitter,
            wake: Notify::new(),
            refresh: AtomicU8::new(0),
            source_running: AtomicBool::new(false),
            head_running: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            scope: Scope::with_stop(receiver.clone()),
        });
        let task = tokio::spawn(run(inner.clone(), receiver));
        Self {
            inner,
            stop,
            task: Queue::new(Some(task)),
        }
    }
    pub fn configure(&self, targets: &[Value]) {
        let mut state = self.inner.state.lock().unwrap();
        if self.inner.closed.load(Ordering::Acquire) {
            return;
        }
        let mut next = IndexMap::new();
        let mut changed = false;
        for value in targets {
            let key = key(value);
            if let Some(previous) = state.targets.get(&key)
                && previous.value == *value
            {
                if !value["operation"].is_null() {
                    previous.snapshot.lock().unwrap().operation = None;
                }
                next.insert(key, previous.clone());
                continue;
            }
            changed = true;
            let target = Arc::new(Target {
                value: value.clone(),
                activity: Arc::new(activity::Activity::new(paths::native(
                    value["worktreePath"].as_js_string().unwrap(),
                ))),
                snapshot: Mutex::new(Snapshot {
                    worktree: None,
                    status: None,
                    operation: None,
                    head: None,
                    due: None,
                    filesystem: false,
                }),
                watchers: Mutex::default(),
                watcher_failed: AtomicBool::new(false),
                reading: Queue::new(()),
            });
            next.insert(key, target);
        }
        changed |= next.len() != state.targets.len();
        let mut retired = Vec::new();
        for (key, previous) in &state.targets {
            if next
                .get(key)
                .is_none_or(|target| !Arc::ptr_eq(previous, target))
            {
                retired.extend(std::mem::take(&mut *previous.watchers.lock().unwrap()));
            }
        }
        state.targets = next;
        drop(state);
        drop(retired);
        self.inner
            .refresh
            .fetch_max(if changed { 2 } else { 1 }, Ordering::AcqRel);
        self.inner.wake.notify_one();
    }
    pub async fn execute_routed(
        &self,
        command: &Value,
        registry: &Registry,
    ) -> Result<(Value, Vec<Value>)> {
        let kind = "worktree.observation.configure";
        let result=async {
            let command=registry.resolve(command).await?;
            let (targets, mut paths)=reconcile(command["targets"].as_array().unwrap()).await;
            let codegraph=command.get("codegraphTargets").and_then(Value::as_array).cloned().unwrap_or_else(|| command["targets"].as_array().unwrap().iter().map(|target| {
                json!({"projectId":target["projectId"],"worktreeId":target["worktreeId"],"rootKind":"git-worktree","sourcePath":target["sourcePath"],"worktreePath":target["worktreePath"]})
            }).collect());
            let (codegraph,codegraph_paths)=reconcile(&codegraph).await;
            paths.extend(codegraph_paths);
            let paths:IndexMap<_,_>=paths.into_iter().map(|path| {
                let key=JsString::new([path["projectId"].as_js_string().unwrap().units(),&[0],path["worktreeId"].as_js_string().unwrap().units()].concat());
                (key,path)
            }).collect();
            self.configure(&targets);
            let receipt = registry.protect_result(kind,&json!({"accepted":true,"paths":paths.into_values().collect::<Vec<_>>()})).await?;
            Ok((receipt, codegraph))
        }.await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }
    pub async fn close(&self) {
        let retired = {
            let mut state = self.inner.state.lock().unwrap();
            self.inner.closed.store(true, Ordering::Release);
            self.stop.send_replace(true);
            let retired = state
                .targets
                .values()
                .flat_map(|target| std::mem::take(&mut *target.watchers.lock().unwrap()))
                .collect::<Vec<_>>();
            state.targets.clear();
            retired
        };
        drop(retired);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Observations {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::Release);
        self.stop.send_replace(true);
        let retired = self
            .inner
            .state
            .lock()
            .unwrap()
            .targets
            .values()
            .flat_map(|target| std::mem::take(&mut *target.watchers.lock().unwrap()))
            .collect::<Vec<_>>();
        drop(retired);
    }
}
pub async fn reconcile(targets: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let reconciled=stream::iter(targets.iter().cloned()).map(|mut target| async move {
        if target["projectId"].as_js_string().is_none() || target["worktreeId"].as_js_string().is_none() {return (target,None);}
        let resolve=async {
            let source=source_path::canonical(target["sourcePath"].as_js_string().unwrap()).await?;
            let worktree=if target["sourcePath"]==target["worktreePath"] {source.clone()}
                else {source_path::canonical(target["worktreePath"].as_js_string().unwrap()).await?};
            Ok::<_,anyhow::Error>((source,worktree))
        }.await;
        if let Ok((source,worktree))=resolve {
            target["sourcePath"]=json!(paths::text(&source));target["worktreePath"]=json!(paths::text(&worktree));
            let path=json!({"projectId":target["projectId"],"worktreeId":target["worktreeId"],"sourcePath":target["sourcePath"],"worktreePath":target["worktreePath"]});
            (target,Some(path))
        } else {(target,None)}
    }).buffered(128).collect::<Vec<_>>().await;
    let mut result = Vec::new();
    let mut paths = Vec::new();
    for (target, path) in reconciled {
        result.push(target);
        paths.extend(path);
    }
    (result, paths)
}
impl Inner {
    fn targets(&self) -> Vec<(JsString, Arc<Target>)> {
        self.state
            .lock()
            .unwrap()
            .targets
            .iter()
            .map(|(key, target)| (key.clone(), target.clone()))
            .collect()
    }
    fn current(&self, key: &JsString, target: &Arc<Target>) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self
                .state
                .lock()
                .unwrap()
                .targets
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, target))
    }
    fn emit(&self, notification: Value) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        checked("workerNotificationSchema", &notification)
            .is_ok_and(|notification| (self.emitter)(notification))
    }
    fn emit_target(&self, key: &JsString, target: &Arc<Target>, notification: Value) -> bool {
        // Configuration and a synchronous publication have the same atomic
        // ordering as the source event loop, even on a multithreaded runtime.
        let state = self.state.lock().unwrap();
        state
            .targets
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, target))
            && self.emit(notification)
    }
    fn schedule(&self, target: &Target, filesystem: bool) {
        let mut snapshot = target.snapshot.lock().unwrap();
        snapshot.filesystem |= filesystem;
        snapshot.due = Some(Instant::now() + Duration::from_millis(500));
        self.wake.notify_one();
    }
    async fn watch(self: &Arc<Self>, key: &JsString, target: &Arc<Target>) {
        if target.watcher_failed.swap(false, Ordering::AcqRel) {
            let retired = std::mem::take(&mut *target.watchers.lock().unwrap());
            drop(retired);
        }
        if !target.watchers.lock().unwrap().is_empty() {
            return;
        }
        target.activity.initialize(&self.scope).await;
        if !self.current(key, target) {
            return;
        }
        let root = paths::native(target.value["worktreePath"].as_js_string().unwrap());
        let mut directories = IndexMap::from([(root.clone(), true)]);
        for flag in ["--git-dir", "--git-common-dir"] {
            if let Ok(directory) = text(
                &root,
                &["rev-parse", "--path-format=absolute", flag],
                &self.scope,
            )
            .await
                && let Ok(directory) = paths::resolve(&PathBuf::from(directory))
                && directory != root
            {
                directories.insert(directory, false);
            }
        }
        let weak = Arc::downgrade(self);
        let weak_target = Arc::downgrade(target);
        let key_for_watch = key.clone();
        let installed = tokio::task::spawn_blocking(move || {
            let mut watchers = Vec::new();
            for (directory, reports_files) in directories {
                let weak = weak.clone();
                let weak_target = weak_target.clone();
                let key = key_for_watch.clone();
                let watched = directory.clone();
                let watcher = RecommendedWatcher::new(
                    move |event: notify::Result<Event>| {
                        let (Some(inner), Some(target)) = (weak.upgrade(), weak_target.upgrade())
                        else {
                            return;
                        };
                        if !inner.current(&key, &target) {
                            return;
                        }
                        match event {
                            Ok(event) => {
                                if matches!(event.kind, notify::EventKind::Access(_)) {
                                    return;
                                }
                                let mut filesystem = reports_files && event.paths.is_empty();
                                for path in event.paths {
                                    if let Ok(relative) = path.strip_prefix(&watched) {
                                        let file = paths::text(relative);
                                        if reports_files {
                                            target.activity.record(&file);
                                            filesystem |= notification::touches_files(Some(&file));
                                        }
                                    }
                                }
                                inner.schedule(&target, filesystem);
                            }
                            Err(_) => {
                                // A source sweep recreates lost watchers. Error callbacks
                                // cannot drop/join their own platform watcher thread.
                                target.watcher_failed.store(true, Ordering::Release);
                                inner.refresh.fetch_max(1, Ordering::AcqRel);
                                inner.wake.notify_one();
                            }
                        }
                    },
                    Config::default().with_follow_symlinks(false),
                );
                if let Ok(mut watcher) = watcher
                    && watcher.watch(&directory, RecursiveMode::Recursive).is_ok()
                {
                    watchers.push(watcher);
                }
            }
            watchers
        })
        .await
        .unwrap_or_default();
        let retired = {
            let state = self.state.lock().unwrap();
            if !self.closed.load(Ordering::Acquire)
                && state
                    .targets
                    .get(key)
                    .is_some_and(|current| Arc::ptr_eq(current, target))
            {
                std::mem::replace(&mut *target.watchers.lock().unwrap(), installed)
            } else {
                installed
            }
        };
        drop(retired);
    }
    async fn sources(self: Arc<Self>, force: bool) {
        let sources: IndexSet<_> = self
            .targets()
            .iter()
            .map(|(_, target)| target.value["sourcePath"].as_js_string().unwrap().clone())
            .collect();
        stream::iter(sources)
            .for_each_concurrent(2, |source| self.source(source, force))
            .await;
        self.source_running.store(false, Ordering::Release);
    }
    async fn source(self: &Arc<Self>, source: JsString, force: bool) {
        let Ok(inventory) = self
            .manager
            .list(&paths::native(&source), &self.scope)
            .await
        else {
            return;
        };
        let targets: Vec<_> = self
            .targets()
            .into_iter()
            .filter(|(_, target)| target.value["sourcePath"].as_js_string() == Some(&source))
            .collect();
        if targets.is_empty() || self.closed.load(Ordering::Acquire) {
            return;
        }
        let projects: IndexSet<_> = targets
            .iter()
            .map(|(_, target)| target.value["projectId"].as_js_string().cloned())
            .collect();
        let fingerprint = inventory.stringify();
        let previous = self.state.lock().unwrap().inventories.get(&source).cloned();
        let mut notice =
            json!({"type":"worktree.inventory.observed","sourcePath":source,"inventory":inventory});
        if projects.len() == 1
            && let Some(project) = projects.into_iter().next().unwrap()
        {
            notice["projectId"] = json!(project);
        }
        let delivered = if force || previous.as_ref() != Some(&fingerprint) {
            let state = self.state.lock().unwrap();
            targets.iter().all(|(key, target)| {
                state
                    .targets
                    .get(key)
                    .is_some_and(|current| Arc::ptr_eq(current, target))
            }) && self.emit(notice)
        } else {
            false
        };
        if delivered {
            self.state
                .lock()
                .unwrap()
                .inventories
                .insert(source, fingerprint);
        }
        for (key, target) in &targets {
            if !self.current(key, target) {
                continue;
            }
            let worktree = inventory["worktrees"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tree| tree["path"] == target.value["worktreePath"])
                .cloned();
            let watch = worktree
                .as_ref()
                .is_some_and(|tree| tree["missing"] != true);
            target.snapshot.lock().unwrap().worktree = worktree;
            if watch {
                self.watch(key, target).await;
            }
        }
        stream::iter(targets)
            .for_each_concurrent(4, |(key, target)| async move {
                let _ = self.status(&key, &target, force).await;
            })
            .await;
    }
    async fn status(&self, key: &JsString, target: &Arc<Target>, force: bool) -> Result<()> {
        let _reading = target.reading.lock().await;
        let worktree = target.snapshot.lock().unwrap().worktree.clone();
        let Some(worktree) = worktree.filter(|tree| tree["missing"] != true) else {
            return Ok(());
        };
        let root = paths::native(worktree["path"].as_js_string().unwrap());
        let result = checked(
            "worktreeStatusResultSchema",
            &json!({"worktree":worktree,"status":status::status(&root,&self.scope).await?}),
        )?;
        if !self.current(key, target) {
            return Ok(());
        }
        target.snapshot.lock().unwrap().head = Some(result["status"]["head"].clone());
        let changes = target
            .activity
            .observe_head(&result["status"]["head"], &self.scope)
            .await;
        if !self.current(key, target) {
            return Ok(());
        }
        if !changes.is_empty() {
            self.emit_target(
                key,
                target,
                notification::filesystem(&target.value, changes),
            );
        }
        let fingerprint = result.stringify();
        let previous = target.snapshot.lock().unwrap().status.clone();
        let mut notice = target.value.clone();
        notice["type"] = json!("worktree.status.observed");
        notice["result"] = result;
        if (force || previous.as_ref() != Some(&fingerprint))
            && self.emit_target(key, target, notice)
        {
            target.snapshot.lock().unwrap().status = Some(fingerprint);
        }
        let operation = async {
            if target.value["operation"].is_null()
                || target.value["projectId"].is_null()
                || target.value["worktreeId"].is_null()
            {
                return Ok::<_, anyhow::Error>(());
            }
            let output = JsString::from("");
            let (state, conflicts) = tokio::join!(
                managed::inspect(
                    &root,
                    &target.value["operation"]["context"],
                    &output,
                    None,
                    &self.scope
                ),
                conflicts::list(&root, &self.scope)
            );
            let notice = notification::operation(
                &target.value,
                &state?,
                &conflicts?,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            );
            if !self.current(key, target) {
                return Ok(());
            }
            if !force
                && target.snapshot.lock().unwrap().operation.as_ref()
                    == Some(&notice["fingerprint"])
            {
                return Ok(());
            }
            let fingerprint = notice["fingerprint"].clone();
            if self.emit_target(key, target, notice) {
                target.snapshot.lock().unwrap().operation = Some(fingerprint);
            } else {
                self.schedule(target, false);
            }
            Ok(())
        }
        .await;
        let _ = operation;
        Ok(())
    }
    async fn heads(self: Arc<Self>) {
        let this = &self;
        stream::iter(self.targets())
            .for_each_concurrent(4, |(key, target)| async move {
                if target
                    .snapshot
                    .lock()
                    .unwrap()
                    .worktree
                    .as_ref()
                    .is_none_or(|tree| tree["missing"] == true)
                {
                    return;
                }
                let root = paths::native(target.value["worktreePath"].as_js_string().unwrap());
                let head = json!(
                    text(&root, &["rev-parse", "--verify", "HEAD"], &this.scope)
                        .await
                        .ok()
                );
                if !this.current(&key, &target) {
                    return;
                }
                let previous = target.snapshot.lock().unwrap().head.replace(head.clone());
                if previous.is_some_and(|previous| previous != head) {
                    this.schedule(&target, false);
                }
            })
            .await;
        self.head_running.store(false, Ordering::Release);
    }
    async fn flush(self: Arc<Self>, key: JsString, target: Arc<Target>, filesystem: bool) {
        if filesystem {
            let changes = target.activity.flush().await;
            if self.current(&key, &target) {
                self.emit_target(
                    &key,
                    &target,
                    notification::filesystem(&target.value, changes),
                );
            }
        }
        if self.current(&key, &target) {
            if target
                .snapshot
                .lock()
                .unwrap()
                .worktree
                .as_ref()
                .is_none_or(|tree| tree["missing"] == true)
            {
                self.source(
                    target.value["sourcePath"].as_js_string().unwrap().clone(),
                    false,
                )
                .await;
            } else {
                let _ = self.status(&key, &target, false).await;
            }
        }
    }
}
async fn run(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) {
    let mut tasks = JoinSet::new();
    let mut sources = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    let mut heads = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(2),
        Duration::from_secs(2),
    );
    sources.set_missed_tick_behavior(MissedTickBehavior::Skip);
    heads.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let due = inner
            .targets()
            .iter()
            .filter_map(|(_, target)| target.snapshot.lock().unwrap().due)
            .min();
        tokio::select! {
            biased;
            _=stop.changed()=>break,
            _=inner.wake.notified()=>{},
            _=sources.tick()=>{inner.refresh.fetch_max(1,Ordering::AcqRel);},
            _=heads.tick()=>{if !inner.head_running.swap(true,Ordering::AcqRel){tasks.spawn(inner.clone().heads());}},
            _=async{if let Some(due)=due{tokio::time::sleep_until(due).await;}else{std::future::pending::<()>().await;}}=>{},
            _=tasks.join_next(),if !tasks.is_empty()=>{},
        }
        if *stop.borrow() {
            break;
        }
        let force = inner.refresh.swap(0, Ordering::AcqRel);
        if force > 0 && !inner.source_running.swap(true, Ordering::AcqRel) {
            tasks.spawn(inner.clone().sources(force == 2));
        }
        for (key, target) in inner.targets() {
            let filesystem = {
                let mut snapshot = target.snapshot.lock().unwrap();
                if snapshot.due.is_some_and(|due| due <= Instant::now()) {
                    snapshot.due = None;
                    Some(std::mem::take(&mut snapshot.filesystem))
                } else {
                    None
                }
            };
            if let Some(filesystem) = filesystem {
                tasks.spawn(inner.clone().flush(key, target, filesystem));
            }
        }
    }
    while tasks.join_next().await.is_some() {}
}
