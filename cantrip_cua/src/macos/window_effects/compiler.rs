//! One bounded compiler/watch lane shared by all effect windows. Dropping the
//! owner wakes the thread; compilation never blocks AppKit or input dispatch.
use super::gpu;
use crate::effects::{
    Configuration,
    source::{DEVELOPMENT_SHADER_ENV, ShaderSource},
};
use objc2::rc::autoreleasepool;
use objc2_metal::MTLCreateSystemDefaultDevice;
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub(super) struct Job {
    pub revision: u64,
    pub configuration: Configuration,
}
pub(super) struct ResultMessage {
    pub revision: u64,
    pub configuration: Configuration,
    pub result: Result<gpu::Pipeline, String>,
}
#[derive(Default)]
struct Mailbox {
    stop: bool,
    pending: Option<Job>,
    result: Option<ResultMessage>,
    running: bool,
}
pub(super) struct Compiler {
    pub device: gpu::Device,
    mailbox: Arc<(Mutex<Mailbox>, Condvar)>,
}
impl Compiler {
    pub fn new() -> Result<Self, String> {
        let path = std::env::var_os(DEVELOPMENT_SHADER_ENV)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        Self::with_path(path)
    }
    fn with_path(path: Option<PathBuf>) -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice().ok_or("Metal device is unavailable")?;
        let mailbox = Arc::new((Mutex::new(Mailbox::default()), Condvar::new()));
        let shared = mailbox.clone();
        let native = device.clone();
        std::thread::Builder::new()
            .name("cua-shader-compiler".into())
            .spawn(move || run(native, shared, path))
            .map_err(|error| format!("Could not start shader compiler: {error}"))?;
        Ok(Self { device, mailbox })
    }
    pub fn request(&self, job: Job) {
        let (lock, wake) = &*self.mailbox;
        let mut mailbox = lock.lock().unwrap_or_else(|e| e.into_inner());
        mailbox.pending = Some(job); // newest configuration wins
        wake.notify_one();
    }
    pub fn pump(&self) -> Option<ResultMessage> {
        self.mailbox
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .result
            .take()
    }
    pub fn busy(&self) -> bool {
        let mailbox = self.mailbox.0.lock().unwrap_or_else(|e| e.into_inner());
        mailbox.running || mailbox.pending.is_some()
    }
}
impl Drop for Compiler {
    fn drop(&mut self) {
        let (lock, wake) = &*self.mailbox;
        let mut mailbox = lock.lock().unwrap_or_else(|e| e.into_inner());
        mailbox.stop = true;
        mailbox.pending = None;
        mailbox.result = None;
        wake.notify_one();
    }
}
fn run(device: gpu::Device, shared: Arc<(Mutex<Mailbox>, Condvar)>, path: Option<PathBuf>) {
    let (lock, wake) = &*shared;
    let mut current: Option<Job> = None;
    let mut previous: Option<Result<ShaderSource, String>> = None;
    let mut compiled: Option<Result<gpu::Pipeline, String>> = None;
    loop {
        let mut mailbox = lock.lock().unwrap_or_else(|e| e.into_inner());
        if mailbox.pending.is_none() && !mailbox.stop {
            mailbox = if path.is_some() && current.is_some() {
                wake.wait_timeout(mailbox, Duration::from_millis(250))
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            } else {
                wake.wait(mailbox).unwrap_or_else(|e| e.into_inner())
            };
        }
        if mailbox.stop {
            return;
        }
        let new_job = mailbox.pending.take();
        let changed_configuration = new_job.is_some();
        if let Some(job) = new_job {
            current = Some(job);
        }
        drop(mailbox);
        let Some(job) = &current else {
            continue;
        };
        let source = path.as_ref().map_or_else(
            || Ok(ShaderSource::bundled(&job.configuration, gpu::BUNDLED)),
            |path| ShaderSource::read(path, &job.configuration),
        );
        let changed_source = previous.as_ref() != Some(&source);
        if !changed_source && !changed_configuration {
            continue;
        }
        {
            let mut mailbox = lock.lock().unwrap_or_else(|e| e.into_inner());
            if mailbox.stop {
                return;
            }
            if mailbox.pending.is_some() {
                continue;
            }
            mailbox.running = true;
        }
        if changed_source {
            compiled = Some(match &source {
                Ok(source) => autoreleasepool(|_| gpu::compile_source(&device, source)),
                Err(error) => Err(error.clone()),
            });
            previous = Some(source);
        }
        let result = compiled.as_ref().unwrap().clone();
        let mut mailbox = lock.lock().unwrap_or_else(|e| e.into_inner());
        mailbox.running = false;
        if mailbox.stop {
            return;
        }
        // Skip obsolete output if a newer configuration arrived during compile.
        if mailbox.pending.is_none() {
            mailbox.result = Some(ResultMessage {
                revision: job.revision,
                configuration: job.configuration.clone(),
                result,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{EffectId, now_ns};
    use std::time::Instant;
    fn next(compiler: &Compiler) -> ResultMessage {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(result) = compiler.pump() {
                return result;
            }
            assert!(Instant::now() < deadline, "shader compiler did not respond");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn reloads_real_local_fragment_edits_and_recovers_after_compile_error() {
        // Metal compiler only: no native windows, capture, or desktop input.
        let path = std::env::temp_dir().join(format!(
            "cantrip-reload-{}-{}.metal",
            std::process::id(),
            now_ns()
        ));
        let source = "// cantrip-effect: {\"fragment\":\"custom_fragment\",\"history\":true,\"continuous\":true}\nfragment float4 custom_fragment() { return float4(1); }";
        std::fs::write(&path, source).unwrap();
        let compiler = Compiler::with_path(Some(path.clone())).unwrap();
        let configuration = Configuration {
            effect: EffectId::DebugGradient,
            ..Default::default()
        };
        compiler.request(Job {
            revision: 1,
            configuration: configuration.clone(),
        });
        let first = next(&compiler).result.unwrap();
        assert!(first.history && first.continuous);
        assert_eq!(first.source, path.to_string_lossy());
        std::fs::write(&path, "\n\nTHIS_IS_NOT_METAL").unwrap();
        let error = next(&compiler).result.err().unwrap();
        assert!(error.contains(&path.to_string_lossy().to_string()));
        assert!(error.contains(":3:"), "{error}");
        std::fs::write(&path, source).unwrap();
        assert!(next(&compiler).result.is_ok());
        compiler.request(Job {
            revision: 2,
            configuration,
        });
        assert_eq!(next(&compiler).revision, 2);
        drop(compiler);
        std::fs::remove_file(path).unwrap();
    }
}
