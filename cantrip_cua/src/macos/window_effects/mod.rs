//! Main-queue window ownership and presentation. Shader compilation runs off
//! the main/executor queues; no capture/presentation error changes CUA input.
mod capture;
mod gpu;
mod panel;
mod render;
use super::overlay::{self, Window};
use crate::{
    effects::{Configuration, EffectId, now_ns},
    service::SessionState,
    target::{Target, TargetKind},
};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::rc::autoreleasepool;
use objc2_foundation::NSError;
use objc2_metal::MTLCreateSystemDefaultDevice;
use objc2_screen_capture_kit::{SCShareableContent, SCWindow};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
    time::Duration,
};
type Key = (String, u64);
struct CompileJob {
    revision: u64,
    configuration: Configuration,
}
struct CompileResult {
    revision: u64,
    configuration: Configuration,
    result: Result<gpu::Pipeline, String>,
}
struct Compiler {
    device: gpu::Device,
    send: SyncSender<CompileJob>,
    receive: Receiver<CompileResult>,
    running: bool,
    queued: Option<CompileJob>,
}
impl Compiler {
    fn new() -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice().ok_or("Metal device is unavailable")?;
        let native = device.clone();
        let (send, jobs) = mpsc::sync_channel::<CompileJob>(1);
        let (results, receive) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("cua-shader-compiler".into())
            .spawn(move || {
                while let Ok(job) = jobs.recv() {
                    let result = autoreleasepool(|_| {
                        gpu::compile(&native, &job.configuration, gpu::BUNDLED)
                    });
                    if results
                        .send(CompileResult {
                            revision: job.revision,
                            configuration: job.configuration,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| format!("Could not start shader compiler: {e}"))?;
        Ok(Self {
            device,
            send,
            receive,
            running: false,
            queued: None,
        })
    }
    fn pump(&mut self) -> Option<CompileResult> {
        let result = match self.receive.try_recv() {
            Ok(result) => {
                self.running = false;
                Some(result)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.running = false;
                self.queued.take().map(|j| CompileResult {
                    revision: j.revision,
                    configuration: j.configuration,
                    result: Err("Shader compiler stopped".into()),
                })
            }
        };
        if !self.running
            && let Some(job) = self.queued.take()
        {
            match self.send.try_send(job) {
                Ok(()) => self.running = true,
                Err(mpsc::TrySendError::Full(job)) => self.queued = Some(job),
                Err(mpsc::TrySendError::Disconnected(job)) => {
                    return Some(CompileResult {
                        revision: job.revision,
                        configuration: job.configuration,
                        result: Err("Shader compiler stopped".into()),
                    });
                }
            }
        }
        result
    }
}
#[derive(Clone)]
pub(super) struct Active {
    pipeline: gpu::Pipeline,
    configuration: Configuration,
}
struct Surface {
    target: Target,
    native_id: u32,
    capture: capture::Capture,
    renderer: render::Worker,
    panel: panel::Panel,
    latest: Option<Arc<capture::Sample>>,
    epoch: u64,
    generation: u64,
    dirty: bool,
}
impl Surface {
    fn new(window: &SCWindow, mut target: Target, device: gpu::Device) -> Result<Self, String> {
        let frame = unsafe { window.frame() };
        target.bounds.x = frame.origin.x;
        target.bounds.y = frame.origin.y;
        target.bounds.width = frame.size.width;
        target.bounds.height = frame.size.height;
        let panel = panel::Panel::new(&device).ok_or("Window-effect panel creation failed")?;
        let renderer = render::Worker::new(device, panel.layer.clone())?;
        let capture = capture::Capture::new(window, &target)?;
        let now = now_ns();
        Ok(Self {
            target,
            native_id: unsafe { window.windowID() },
            capture,
            renderer,
            panel,
            latest: None,
            epoch: now,
            generation: 1,
            dirty: true,
        })
    }
    fn draw(&mut self, native: &Window, active: &Arc<Active>) -> Result<(), String> {
        if let Some(error) = self.capture.error().or_else(|| self.renderer.error()) {
            return Err(error);
        }
        self.panel
            .position(native, [self.target.pixel_width, self.target.pixel_height]);
        let scale = self.panel.scale();
        let pixels = [
            (native.bounds.width * scale).round().max(1.) as u32,
            (native.bounds.height * scale).round().max(1.) as u32,
        ];
        self.target.bounds = native.bounds;
        if pixels != [self.target.pixel_width, self.target.pixel_height] {
            self.target.pixel_width = pixels[0];
            self.target.pixel_height = pixels[1];
            self.target.scale_factor = scale;
            self.capture.resize(pixels);
            self.latest = None;
            self.panel.hide();
            self.generation = self.generation.wrapping_add(1);
            self.renderer.invalidate(self.generation);
            self.dirty = true;
            return Ok(());
        }
        if !self.capture.usable() {
            if self.latest.take().is_some() {
                self.generation = self.generation.wrapping_add(1);
                self.renderer.invalidate(self.generation);
            }
            self.panel.hide();
            return Ok(());
        }
        super::sharing::release_for_effect(&self.target);
        crate::effects::live::geometry(&self.target);
        if let Some(frame) = self.capture.take_latest() {
            self.latest = Some(frame);
            self.dirty = true;
        }
        let Some(frame) = self.latest.as_ref() else {
            self.panel.hide();
            return Ok(());
        };
        let presented = self.renderer.presented();
        let ready = presented.generation == self.generation;
        self.panel.show(native, ready);
        // Retry initial rendering until a completed frame exists. After that,
        // pass-through needs no GPU submission when the source is unchanged.
        if !self.dirty
            && ready
            && presented.source_sequence == frame.sequence
            && !active.configuration.descriptor().continuous
        {
            return Ok(());
        }
        self.renderer.submit(render::Job {
            source: frame.clone(),
            active: active.clone(),
            target: self.target.clone(),
            epoch: self.epoch,
            generation: self.generation,
        });
        self.dirty = false;
        Ok(())
    }
}
#[derive(Default)]
struct State {
    configuration: Configuration,
    targets: BTreeMap<Key, Target>,
    surfaces: BTreeMap<Key, Surface>,
    pending: BTreeMap<Key, u64>,
    failures: BTreeMap<Key, String>,
    compiler: Option<Compiler>,
    active: Option<Arc<Active>>,
    revision: u64,
    compile_error: Option<String>,
    ticking: bool,
}
thread_local! {static STATE:RefCell<State>=RefCell::default();}
fn key(target: &Target) -> Key {
    (target.id.clone(), target.generation)
}
pub(super) fn cursor_anchor(window: u32) -> u32 {
    STATE.with_borrow(|s| {
        s.surfaces
            .values()
            .find(|surface| surface.native_id == window && surface.panel.shown)
            .map_or(window, |surface| surface.panel.id)
    })
}
pub(super) fn capturing(target: &Target) -> bool {
    STATE.with_borrow(|s| {
        s.surfaces
            .get(&key(target))
            .is_some_and(|surface| surface.capture.usable())
    })
}
pub(super) fn configure(configuration: Configuration) -> Value {
    DispatchQueue::main().exec_sync(move || {
        STATE.with_borrow_mut(|s| {
            if s.configuration == configuration
                && s.compile_error.is_none()
                && s.failures.is_empty()
            {
                schedule(s);
                return;
            }
            let same_effect = s.configuration.effect == configuration.effect;
            s.configuration = configuration.clone();
            s.revision = s.revision.wrapping_add(1);
            s.failures.clear();
            s.compile_error = None;
            if configuration.effect == EffectId::Off {
                s.surfaces.clear();
                s.pending.clear();
                s.active = None;
                s.compiler = None;
                s.compile_error = None;
            } else if same_effect
                && s.active
                    .as_ref()
                    .is_some_and(|a| a.configuration.effect == configuration.effect)
            {
                Arc::make_mut(s.active.as_mut().unwrap()).configuration = configuration;
                for surface in s.surfaces.values_mut() {
                    surface.dirty = true;
                    surface.generation = surface.generation.wrapping_add(1);
                    surface.renderer.invalidate(surface.generation);
                }
            } else {
                request_compile(s);
            }
            schedule(s);
        });
    });
    status()
}
fn request_compile(s: &mut State) {
    if s.targets.is_empty() {
        return;
    }
    if s.compiler.is_none() {
        match Compiler::new() {
            Ok(c) => s.compiler = Some(c),
            Err(e) => s.compile_error = Some(e),
        }
    }
    if let Some(c) = &mut s.compiler {
        c.queued = Some(CompileJob {
            revision: s.revision,
            configuration: s.configuration.clone(),
        });
    }
}
pub(super) fn sessions(mut sessions: Vec<SessionState>) {
    DispatchQueue::main().exec_async(move || {
        STATE.with_borrow_mut(|s| {
            let had_targets = !s.targets.is_empty();
            // If several sessions retain different metadata revisions, choose the
            // lexically first session deterministically. Live geometry supersedes it.
            sessions.sort_by(|a, b| a.binding.session_id.cmp(&b.binding.session_id));
            s.targets.clear();
            for target in sessions
                .into_iter()
                .filter_map(|s| s.target)
                .filter(|t| t.kind == TargetKind::Window)
            {
                s.targets.entry(key(&target)).or_insert(target);
            }
            s.surfaces.retain(|k, _| s.targets.contains_key(k));
            s.pending.retain(|k, _| s.targets.contains_key(k));
            s.failures.retain(|k, _| s.targets.contains_key(k));
            if s.targets.is_empty() {
                if had_targets {
                    s.revision = s.revision.wrapping_add(1);
                }
                s.compiler = None;
                s.active = None;
            } else if s.configuration.effect != EffectId::Off
                && s.active.is_none()
                && s.compiler.is_none()
                && s.compile_error.is_none()
            {
                request_compile(s);
            }
            schedule(s);
        })
    });
}
pub(super) fn status() -> Value {
    let mut result = Value::Null;
    DispatchQueue::main().exec_sync(||STATE.with_borrow(|s| {
        result=json!({"supported":true,"contractVersion":crate::effects::CONTRACT_VERSION,"effects":crate::effects::DESCRIPTORS,"configuration":s.configuration,"shaderError":s.compile_error,
            "compiling":s.compiler.as_ref().is_some_and(|c|c.running || c.queued.is_some()),
            "windows":s.targets.iter().map(|(k,t)|json!({"targetId":t.id,"generation":t.generation,
                "phase":if s.failures.contains_key(k) {"failed"} else if s.surfaces.get(k).is_some_and(|w|w.panel.shown) {"presenting"} else if s.configuration.effect==EffectId::Off {"off"} else {"waiting"},
                "error":s.failures.get(k)})).collect::<Vec<_>>()});
    }));
    result
}
fn schedule(state: &mut State) {
    if !state.ticking && state.configuration.effect != EffectId::Off && !state.targets.is_empty() {
        state.ticking = true;
        let _ = DispatchQueue::main().after(
            DispatchTime::try_from(Duration::from_millis(16)).unwrap(),
            tick,
        );
    }
}
fn tick() {
    autoreleasepool(|_| {
        let windows = overlay::windows();
        let starts = STATE.with_borrow_mut(|s| {
            s.ticking = false;
            if s.configuration.effect == EffectId::Off {
                return vec![];
            }
            if let Some(result) = s.compiler.as_mut().and_then(Compiler::pump)
                && result.revision == s.revision
            {
                match result.result {
                    Ok(pipeline) => {
                        s.active = Some(Arc::new(Active {
                            pipeline,
                            configuration: result.configuration,
                        }));
                        s.compile_error = None;
                        for surface in s.surfaces.values_mut() {
                            surface.dirty = true;
                            surface.generation = surface.generation.wrapping_add(1);
                            surface.renderer.invalidate(surface.generation);
                        }
                    }
                    Err(error) => s.compile_error = Some(error),
                }
            }
            let mut starts = vec![];
            for (k, target) in &s.targets {
                let native = windows.iter().find(|w| {
                    format!("macos-window-{}", w.id) == target.id
                        && target.process_id == Some(w.pid)
                });
                let Some(native) = native else {
                    s.surfaces.remove(k);
                    s.pending.remove(k);
                    s.failures.remove(k);
                    continue;
                };
                if let Some(surface) = s.surfaces.get_mut(k) {
                    if let Some(active) = &s.active
                        && let Err(error) = surface.draw(native, active)
                    {
                        surface.panel.hide();
                        s.failures.insert(k.clone(), error);
                    }
                } else if s.active.is_some()
                    && !s.pending.contains_key(k)
                    && !s.failures.contains_key(k)
                {
                    s.pending.insert(k.clone(), s.revision);
                    starts.push((k.clone(), target.clone(), s.revision));
                }
            }
            s.surfaces.retain(|k, _| !s.failures.contains_key(k));
            schedule(s);
            starts
        });
        for (key, target, revision) in starts {
            start(key, target, revision);
        }
        overlay::refresh_with_windows(&windows);
    });
}
fn start(key: Key, target: Target, revision: u64) {
    let callback = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SCK completion has no Rust main-thread guarantee. Marshal native
            // retained values in a copied Objective-C block, as sharing.rs does.
            use objc2::Message;
            let content = unsafe { content.as_ref() }.map(|c| c.retain());
            let error = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            let key = key.clone();
            let target = target.clone();
            let update = RcBlock::new(move || {
                autoreleasepool(|_| {
                    STATE.with_borrow_mut(|s| {
                        if s.pending.get(&key) != Some(&revision)
                            || !s.targets.contains_key(&key)
                            || s.configuration.effect == EffectId::Off
                        {
                            return;
                        }
                        s.pending.remove(&key);
                        let result = (|| {
                            if let Some(error) = &error {
                                return Err(format!("Window-effect discovery failed: {error}"));
                            }
                            let content = content
                                .as_ref()
                                .ok_or("Window-effect discovery returned no content")?;
                            let windows = unsafe { content.windows() };
                            let window = (0..windows.count())
                                .map(|i| windows.objectAtIndex(i))
                                .find(|w| {
                                    format!("macos-window-{}", unsafe { w.windowID() }) == target.id
                                        && unsafe { w.owningApplication() }.is_some_and(|a| {
                                            Some(unsafe { a.processID() } as u32)
                                                == target.process_id
                                        })
                                })
                                .ok_or("Window-effect target is no longer available")?;
                            let device = s
                                .compiler
                                .as_ref()
                                .ok_or("Shader renderer was disabled")?
                                .device
                                .clone();
                            Surface::new(&window, target.clone(), device)
                        })();
                        match result {
                            Ok(surface) => {
                                s.surfaces.insert(key.clone(), surface);
                            }
                            Err(error) => {
                                s.failures.insert(key.clone(), error);
                            }
                        }
                    })
                })
            });
            unsafe extern "C" {
                fn dispatch_async(queue: &DispatchQueue, block: &block2::DynBlock<dyn Fn()>);
            }
            unsafe {
                dispatch_async(DispatchQueue::main(), &update);
            }
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false,false,&callback);
    }
}
