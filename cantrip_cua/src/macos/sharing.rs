//! A window-only display stream keeps covered applications rendering between
//! observations. Pixels still come from the existing full-window screenshot
//! path. Streams, filters and native delegates live on the main dispatch queue.
use super::{
    NativeCapture, SelectedSource, begin_capture, diagnostic_phase, native_error, pending::Pending,
};
use crate::{
    error::{CuaError, ErrorCode},
    service::{MAX_SESSIONS, SessionState},
    target::{Bounds, TargetKind},
};
use block2::{DynBlock, RcBlock};
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::{
    AnyThread, DefinedClass, Message, define_class, msg_send, rc::Retained, runtime::ProtocolObject,
};
use objc2_core_foundation::CGRect;
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const IDLE: Duration = Duration::from_secs(60);
type Key = (String, u64);

// A native copied block transfers retained, immutable SCK inputs to the main
// queue. They never cross a Rust channel or acquire an unsafe Send wrapper.
unsafe extern "C" {
    fn dispatch_async(queue: &DispatchQueue, block: &DynBlock<dyn Fn()>);
}

#[derive(Default)]
struct OutputState {
    stopped: AtomicBool,
}
define_class!(
    #[unsafe(super = NSObject)]
    #[ivars = OutputState]
    struct Output;
    unsafe impl NSObjectProtocol for Output {}
    unsafe impl SCStreamOutput for Output {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn frame(
            &self,
            _stream: &SCStream,
            _sample: &CMSampleBuffer,
            _kind: SCStreamOutputType,
        ) {
            // Drain the bounded native queue; never retain or encode frames.
        }
    }
    unsafe impl SCStreamDelegate for Output {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stopped(&self, _stream: &SCStream, _error: &NSError) {
            self.ivars().stopped.store(true, Ordering::Release);
            diagnostic_phase("window-sharing-interrupted");
        }
    }
);
#[derive(Clone)]
struct Inputs {
    filter: Retained<SCContentFilter>,
    config: Retained<SCStreamConfiguration>,
    _window: Retained<SCWindow>,
    display: Retained<SCDisplay>,
}
struct Lease {
    stream: Retained<SCStream>,
    output: Retained<Output>,
    inputs: Inputs,
    bounds: Bounds,
    token: Arc<()>,
    last_used: Instant,
    waiting: Option<(SelectedSource, Arc<Pending<NativeCapture>>)>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        stop(
            self.stream.clone(),
            self.output.clone(),
            self.inputs.clone(),
        );
    }
}
fn stop(stream: Retained<SCStream>, output: Retained<Output>, inputs: Inputs) {
    let keepalive = (stream.clone(), output, inputs);
    let completion = RcBlock::new(move |error: *mut NSError| {
        let _ = &keepalive;
        diagnostic_phase(if error.is_null() {
            "window-sharing-stopped"
        } else {
            "window-sharing-stop-error"
        });
    });
    unsafe {
        stream.stopCaptureWithCompletionHandler(Some(&completion));
    }
}
#[derive(Default)]
struct Streams {
    leases: HashMap<Key, Lease>,
    timer: bool,
}
thread_local! { static STREAMS: RefCell<Streams> = RefCell::default(); }

pub(super) fn retain_sessions(sessions: &[SessionState]) {
    let alive: HashSet<Key> = sessions
        .iter()
        .filter_map(|s| s.target.as_ref())
        .map(|t| (t.id.clone(), t.generation))
        .collect();
    DispatchQueue::main().exec_async(move || {
        STREAMS.with_borrow_mut(|state| {
            state.leases.retain(|key, _| alive.contains(key));
        })
    });
}
fn tick() {
    let more = STREAMS.with_borrow_mut(|state| {
        state.leases.retain(|_, lease| {
            lease.last_used.elapsed() < IDLE
                && !lease.output.ivars().stopped.load(Ordering::Acquire)
        });
        state.timer = !state.leases.is_empty();
        state.timer
    });
    if more {
        schedule_tick();
    }
}
fn schedule_tick() {
    let _ = DispatchQueue::main().after(
        DispatchTime::try_from(Duration::from_secs(10)).unwrap(),
        tick,
    );
}

unsafe fn inputs(content: &SCShareableContent, source: &SelectedSource) -> Option<Inputs> {
    let window = source.native.downcast_ref::<SCWindow>()?;
    let frame = unsafe { window.frame() };
    let displays = unsafe { content.displays() };
    let display = (0..displays.count())
        .map(|i| displays.objectAtIndex(i))
        .max_by(|a, b| {
            overlap(unsafe { a.frame() }, frame).total_cmp(&overlap(unsafe { b.frame() }, frame))
        });
    // No display intersection does not make a window uncapturable. Preserve the
    // independent screenshot path rather than introducing an eligibility gate.
    let display = display.filter(|d| overlap(unsafe { d.frame() }, frame) > 0.0)?;
    let windows = NSArray::from_slice(&[window]);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_includingWindows(
            SCContentFilter::alloc(),
            &display,
            &windows,
        )
    };
    let config = unsafe { SCStreamConfiguration::new() };
    let scale = (640.0 / frame.size.width.max(frame.size.height)).min(1.0);
    unsafe {
        config.setWidth((frame.size.width * scale).round().max(1.0) as usize);
        config.setHeight((frame.size.height * scale).round().max(1.0) as usize);
        config.setMinimumFrameInterval(CMTime::new(1, 10));
        config.setQueueDepth(3);
        config.setShowsCursor(false);
        config.setCapturesAudio(false);
        config.setIgnoreShadowsDisplay(true);
        config.setSourceRect(CGRect::new(
            objc2_core_foundation::CGPoint::new(
                frame.origin.x - display.frame().origin.x,
                frame.origin.y - display.frame().origin.y,
            ),
            frame.size,
        ));
    }
    Some(Inputs {
        filter,
        config,
        _window: window.retain(),
        display,
    })
}
fn overlap(a: CGRect, b: CGRect) -> f64 {
    ((a.origin.x + a.size.width).min(b.origin.x + b.size.width) - a.origin.x.max(b.origin.x))
        .max(0.0)
        * ((a.origin.y + a.size.height).min(b.origin.y + b.size.height)
            - a.origin.y.max(b.origin.y))
        .max(0.0)
}

pub(super) unsafe fn capture(
    content: &SCShareableContent,
    source: SelectedSource,
    pending: Arc<Pending<NativeCapture>>,
) {
    if pending.cancelled() {
        return;
    }
    if source.candidate.target.kind != TargetKind::Window {
        unsafe {
            begin_capture(source, pending);
        }
        return;
    }
    let Some(inputs) = (unsafe { inputs(content, &source) }) else {
        unsafe {
            begin_capture(source, pending);
        }
        return;
    };
    let work = RefCell::new(Some((inputs, source, pending)));
    let block = RcBlock::new(move || {
        if let Some((inputs, source, pending)) = work.borrow_mut().take() {
            start_or_reuse(inputs, source, pending);
        }
    });
    unsafe {
        dispatch_async(DispatchQueue::main(), &block);
    }
}

fn start_or_reuse(inputs: Inputs, source: SelectedSource, pending: Arc<Pending<NativeCapture>>) {
    if pending.cancelled() {
        return;
    }
    let target = &source.candidate.target;
    let key = (target.id.clone(), target.generation);
    let reuse = STREAMS.with_borrow_mut(|state| {
        if let Some(lease) = state.leases.get_mut(&key)
            && lease.waiting.is_none()
            && lease.bounds == target.bounds
            && unsafe { lease.inputs.display.displayID() == inputs.display.displayID() }
            && !lease.output.ivars().stopped.load(Ordering::Acquire)
        {
            lease.last_used = Instant::now();
            return true;
        }
        state.leases.remove(&key);
        false
    });
    if reuse {
        diagnostic_phase("window-sharing-reused");
        unsafe {
            begin_capture(source, pending);
        }
        return;
    }
    if STREAMS.with_borrow(|state| state.leases.len() >= MAX_SESSIONS) {
        pending.deliver(Err(CuaError::new(
            ErrorCode::Capacity,
            "Active window sharing limit reached.",
        )));
        return;
    }
    let output: Retained<Output> = unsafe {
        msg_send![
            super(Output::alloc().set_ivars(OutputState::default())),
            init
        ]
    };
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &inputs.filter,
            &inputs.config,
            Some(ProtocolObject::from_ref(&*output)),
        )
    };
    if let Err(error) = unsafe {
        stream.addStreamOutput_type_sampleHandlerQueue_error(
            ProtocolObject::from_ref(&*output),
            SCStreamOutputType::Screen,
            Some(DispatchQueue::main()),
        )
    } {
        pending.deliver(Err(native_error(&error)));
        return;
    }
    let token = Arc::new(());
    let lease = Lease {
        stream: stream.clone(),
        output: output.clone(),
        inputs: inputs.clone(),
        bounds: target.bounds,
        token: token.clone(),
        last_used: Instant::now(),
        waiting: Some((source, pending)),
    };
    STREAMS.with_borrow_mut(|state| {
        state.leases.insert(key.clone(), lease);
        if !state.timer {
            state.timer = true;
            schedule_tick();
        }
    });
    let starting_stream = stream.clone();
    let completion = RcBlock::new(move |error: *mut NSError| {
        let result = unsafe { error.as_ref() }.map(native_error);
        let key = key.clone();
        let token = token.clone();
        // Retain through startup and stop a late success even if detach,
        // cancellation or replacement already removed the lease. Stopping only
        // at removal can race with an asynchronous start and orphan a stream.
        let keepalive = (starting_stream.clone(), output.clone(), inputs.clone());
        let work = RefCell::new(Some((key, token, result, keepalive)));
        let block = RcBlock::new(move || {
            if let Some((key, token, result, (stream, output, inputs))) = work.borrow_mut().take()
                && !finish_start(key, token, result)
            {
                stop(stream, output, inputs);
            }
        });
        unsafe {
            dispatch_async(DispatchQueue::main(), &block);
        }
    });
    unsafe {
        diagnostic_phase("window-sharing-starting");
        stream.startCaptureWithCompletionHandler(Some(&completion));
    }
}
fn finish_start(key: Key, token: Arc<()>, error: Option<CuaError>) -> bool {
    let work = STREAMS.with_borrow_mut(|state| {
        let lease = state.leases.get_mut(&key)?;
        if !Arc::ptr_eq(&lease.token, &token) {
            return None;
        }
        let work = lease.waiting.take()?;
        if error.is_some() || work.1.cancelled() {
            state.leases.remove(&key);
        }
        Some(work)
    });
    if let Some((source, pending)) = work {
        if let Some(error) = error {
            diagnostic_phase("window-sharing-start-error");
            pending.deliver(Err(error));
        } else if !pending.cancelled() {
            diagnostic_phase("window-sharing-started");
            unsafe {
                begin_capture(source, pending);
            }
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::overlap;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    fn rect(x: f64, y: f64, w: f64, h: f64) -> CGRect {
        CGRect::new(CGPoint::new(x, y), CGSize::new(w, h))
    }

    #[test]
    fn spanning_window_prefers_display_with_more_coverage_including_negative_origins() {
        let left = rect(-1920.0, -200.0, 1920.0, 1080.0);
        let right = rect(0.0, 0.0, 1440.0, 900.0);
        let window = rect(-400.0, 100.0, 600.0, 500.0);
        assert_eq!(overlap(left, window), 200_000.0);
        assert_eq!(overlap(right, window), 100_000.0);
    }

    #[test]
    fn touching_or_offscreen_windows_have_no_display_intersection() {
        let display = rect(0.0, 0.0, 1440.0, 900.0);
        assert_eq!(overlap(display, rect(1440.0, 100.0, 600.0, 500.0)), 0.0);
        assert_eq!(overlap(display, rect(-1000.0, -1000.0, 600.0, 500.0)), 0.0);
    }
}
