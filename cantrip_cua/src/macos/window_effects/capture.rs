//! One bounded, original-window-only stream. No image encoding or CPU readback.
use crate::target::Target;
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamFrameInfoStatus,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};
use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    ptr::NonNull,
    sync::{Arc, Mutex},
};

type Ref = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
}
#[derive(Default)]
struct State {
    // SCK invokes frame only on the supplied main queue. Error/start callbacks
    // only access the separately synchronized error slot.
    latest: RefCell<Option<CFRetained<CMSampleBuffer>>>,
    sequence: Cell<u64>,
    usable: Cell<bool>,
    error: Arc<Mutex<Option<String>>>,
}
define_class!(
    #[unsafe(super = NSObject)]
    #[ivars = State]
    struct Output;
    unsafe impl NSObjectProtocol for Output {}
    unsafe impl SCStreamOutput for Output {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn frame(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            let state = self.ivars();
            let status = unsafe { status(sample) };
            match status {
                Some(0) => {
                    *state.latest.borrow_mut() =
                        Some(unsafe { CFRetained::retain(NonNull::from(sample)) });
                    state.sequence.set(state.sequence.get().wrapping_add(1));
                    state.usable.set(true);
                }
                // An idle frame has no changed pixels. Keep the last image while
                // effect/cursor animation continues independently.
                Some(1) => {}
                _ => {
                    state.usable.set(false);
                    state.latest.borrow_mut().take();
                }
            }
        }
    }
    unsafe impl SCStreamDelegate for Output {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stopped(&self, _stream: &SCStream, error: &NSError) {
            *self.ivars().error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!(
                "Window-effect capture stopped: {}",
                error.localizedDescription()
            ));
        }
    }
);
unsafe fn status(sample: &CMSampleBuffer) -> Option<isize> {
    if !unsafe { sample.is_valid() } {
        return None;
    }
    let attachments = unsafe { sample.sample_attachments_array(false) }?;
    unsafe {
        let array = NonNull::from(&*attachments).as_ptr().cast();
        if CFArrayGetCount(array) < 1 {
            return None;
        }
        let dictionary = CFArrayGetValueAtIndex(array, 0);
        let value = CFDictionaryGetValue(
            dictionary,
            NonNull::from(SCStreamFrameInfoStatus).as_ptr().cast(),
        );
        let number = (value as *const AnyObject).as_ref()?;
        Some(msg_send![number, integerValue])
    }
}
pub(super) struct Sample {
    pub buffer: CFRetained<CMSampleBuffer>,
    pub sequence: u64,
}
// SAFETY: sample buffers are retained, immutable SCK output. Only the render
// worker reads their image/timing; no thread mutates attachments or pixel data.
unsafe impl Send for Sample {}
unsafe impl Sync for Sample {}
pub(super) struct Capture {
    stream: Retained<SCStream>,
    output: Retained<Output>,
    _filter: Retained<SCContentFilter>,
    config: Retained<SCStreamConfiguration>,
    seen: u64,
}
impl Capture {
    pub fn new(window: &SCWindow, target: &Target) -> Result<Self, String> {
        let filter = unsafe {
            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), window)
        };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(target.pixel_width as usize);
            config.setHeight(target.pixel_height as usize);
            config.setPixelFormat(0x42475241); // BGRA: CoreVideo texture import matches Metal BGRA8Unorm.
            config.setMinimumFrameInterval(CMTime::new(1, 60));
            config.setQueueDepth(3);
            config.setShowsCursor(false);
            config.setCapturesAudio(false);
            config.setIgnoreShadowsSingleWindow(true);
            config.setIgnoreGlobalClipSingleWindow(true);
            config.setScalesToFit(true);
            config.setColorSpaceName(objc2_core_graphics::kCGColorSpaceSRGB);
        }
        let allocated = Output::alloc().set_ivars(State::default());
        let output: Retained<Output> = unsafe { msg_send![super(allocated), init] };
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(ProtocolObject::from_ref(&*output)),
            )
        };
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*output),
                SCStreamOutputType::Screen,
                Some(DispatchQueue::main()),
            )
        }
        .map_err(|e| {
            format!(
                "Window-effect stream registration failed: {}",
                e.localizedDescription()
            )
        })?;
        let errors = output.ivars().error.clone();
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                *errors.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!(
                    "Window-effect capture failed to start: {}",
                    error.localizedDescription()
                ));
            }
        });
        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&completion));
        }
        Ok(Self {
            stream,
            output,
            _filter: filter,
            config,
            seen: 0,
        })
    }
    pub fn error(&self) -> Option<String> {
        self.output
            .ivars()
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn usable(&self) -> bool {
        self.output.ivars().usable.get() && self.error().is_none()
    }
    pub fn take_latest(&mut self) -> Option<Arc<Sample>> {
        let state = self.output.ivars();
        if state.sequence.get() == self.seen {
            return None;
        }
        self.seen = state.sequence.get();
        state.latest.borrow_mut().take().map(|buffer| {
            Arc::new(Sample {
                buffer,
                sequence: state.sequence.get(),
            })
        })
    }
    pub fn resize(&mut self, pixels: [u32; 2]) {
        unsafe {
            self.config.setWidth(pixels[0] as usize);
            self.config.setHeight(pixels[1] as usize);
        }
        self.output.ivars().usable.set(false);
        self.output.ivars().latest.borrow_mut().take();
        let errors = self.output.ivars().error.clone();
        let callback = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                *errors.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!(
                    "Window-effect capture resize failed: {}",
                    error.localizedDescription()
                ));
            }
        });
        unsafe {
            self.stream
                .updateConfiguration_completionHandler(&self.config, Some(&callback));
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        // Keep delegate/filter alive until native stop completes. No wait on the
        // executor/main queue, and no capture resources escape into agent output.
        let retained = Mutex::new(Some((
            self.stream.clone(),
            self.output.clone(),
            self._filter.clone(),
            self.config.clone(),
        )));
        let callback = RcBlock::new(move |_error: *mut NSError| {
            retained.lock().unwrap_or_else(|e| e.into_inner()).take();
        });
        unsafe {
            self.stream
                .stopCaptureWithCompletionHandler(Some(&callback));
        }
    }
}
