//! A latest-only mailbox isolates drawable waits and GPU work from input/AppKit.
use super::{Active, capture::Sample, gpu};
use crate::{
    effects::{
        now_ns,
        uniforms::{FrameTiming, FrameUniform},
    },
    target::Target,
};
use objc2::{
    rc::{Retained, autoreleasepool},
    runtime::ProtocolObject,
};
use objc2_metal::MTLTexture;
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicU64, Ordering},
};

pub(super) struct Job {
    pub source: Arc<Sample>,
    pub active: Arc<Active>,
    pub target: Target,
    pub epoch: u64,
    pub generation: u64,
}
#[derive(Default)]
struct Mailbox {
    pending: Option<Job>,
    stop: bool,
}
#[derive(Default)]
struct Shared {
    mailbox: Mutex<Mailbox>,
    wake: Condvar,
    generation: AtomicU64,
    error: Mutex<Option<String>>,
    completion: Arc<gpu::Completion>,
}
struct RenderLayer(Retained<CAMetalLayer>);
// SAFETY: CAMetalLayer's drawable acquisition/presentation support a rendering
// thread. Only the main queue mutates layer geometry; this worker never calls
// NSView/NSWindow/AppKit. Retention keeps the layer alive until the worker exits.
unsafe impl Send for RenderLayer {}
impl RenderLayer {
    fn drawable(&self) -> Option<Retained<ProtocolObject<dyn CAMetalDrawable>>> {
        self.0.nextDrawable()
    }
}
pub(super) struct Worker {
    shared: Arc<Shared>,
}
impl Worker {
    pub fn new(device: gpu::Device, layer: Retained<CAMetalLayer>) -> Result<Self, String> {
        let shared = Arc::<Shared>::default();
        let worker = shared.clone();
        let layer = RenderLayer(layer);
        std::thread::Builder::new()
            .name("cua-window-render".into())
            .spawn(move || {
                if let Err(error) = run(device, layer, &worker) {
                    *worker.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                }
            })
            .map_err(|e| format!("Could not start window renderer: {e}"))?;
        Ok(Self { shared })
    }
    pub fn submit(&self, job: Job) {
        self.shared
            .generation
            .store(job.generation, Ordering::Release);
        self.shared
            .mailbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending = Some(job);
        self.shared.wake.notify_one();
    }
    pub fn invalidate(&self, generation: u64) {
        self.shared.generation.store(generation, Ordering::Release);
        self.shared
            .mailbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending = None;
    }
    pub fn presented(&self) -> gpu::Presented {
        self.shared.completion.snapshot()
    }
    pub fn error(&self) -> Option<String> {
        if self.shared.completion.failed.load(Ordering::Acquire) {
            return Some("Metal command execution failed".into());
        }
        self.shared
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let mut state = self
            .shared
            .mailbox
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.stop = true;
        state.pending = None;
        self.shared.wake.notify_one(); // Never join a drawable wait on the input/main queue.
    }
}
fn run(device: gpu::Device, layer: RenderLayer, shared: &Shared) -> Result<(), String> {
    let mut gpu = gpu::Gpu::new(device)?;
    gpu.completion = shared.completion.clone();
    let mut source: Option<(Arc<Sample>, Arc<gpu::Frame>)> = None;
    let mut previous = now_ns();
    let mut sequence = 0;
    let mut generation = 0;
    loop {
        let mut state = shared.mailbox.lock().unwrap_or_else(|e| e.into_inner());
        while !state.stop && state.pending.is_none() {
            state = shared.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.stop {
            return Ok(());
        }
        let mut job = state.pending.take().unwrap();
        drop(state);
        autoreleasepool(|_| -> Result<(), String> {
            if gpu.completion.failed.load(Ordering::Acquire) {
                return Err("Metal command execution failed".into());
            }
            if gpu.completion.in_flight.load(Ordering::Acquire) >= 3 {
                let completed = gpu.completion.snapshot().at_ns;
                if now_ns().saturating_sub(completed.max(previous)) > 2_000_000_000 {
                    return Err("Metal presentation stopped completing frames".into());
                }
                return Ok(());
            }
            // May wait for the drawable pool. This never blocks CUA or AppKit.
            let Some(drawable) = layer.drawable() else {
                return Ok(());
            };
            let mut state = shared.mailbox.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop {
                return Ok(());
            }
            // If acquisition waited, use the newest job instead of stale input.
            if let Some(latest) = state.pending.take() {
                job = latest;
            }
            drop(state);
            if job.generation != shared.generation.load(Ordering::Acquire) {
                return Ok(());
            }
            let output = drawable.texture();
            if output.width() != job.target.pixel_width as usize
                || output.height() != job.target.pixel_height as usize
            {
                return Ok(());
            }
            if generation != job.generation {
                gpu.reset_history();
                generation = job.generation;
            }
            if source
                .as_ref()
                .is_none_or(|(s, _)| !Arc::ptr_eq(s, &job.source))
            {
                source = Some((job.source.clone(), gpu.frame(&job.source.buffer)?));
            }
            let frame = &source.as_ref().unwrap().1;
            if frame.texture.width() != output.width() || frame.texture.height() != output.height()
            {
                return Ok(());
            }
            let now = now_ns();
            let agents = crate::effects::live::window(&job.target, now, &job.active.configuration);
            let uniform = FrameUniform::new(
                FrameTiming {
                    epoch_ns: job.epoch,
                    now_ns: now,
                    previous_ns: previous,
                    source_ns: frame.source_ns,
                    frame: sequence,
                },
                [
                    job.target.bounds.width as f32,
                    job.target.bounds.height as f32,
                ],
                [job.target.pixel_width, job.target.pixel_height],
                &job.active.configuration,
                &agents,
            );
            if gpu.render(
                frame.clone(),
                &job.active.pipeline,
                &uniform,
                gpu::Destination {
                    texture: &output,
                    drawable: Some(ProtocolObject::from_ref(&*drawable)),
                    generation: job.generation,
                    source_sequence: job.source.sequence,
                },
            )? {
                previous = now;
                sequence = sequence.wrapping_add(1);
            }
            Ok(())
        })?;
    }
}
