//! Target-only AppKit input preparation. This sends one activation notification,
//! not a mouse event, a WindowServer front-process request, or a raise operation.
//! Record layout: trycua/cua platform-macos input/skylight.rs and yabai's
//! window_manager_focus_window_without_raise. Unlike those full sequences, we
//! never send a deactivation notification to the human's foreground process.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
};
use std::{
    ffi::{c_char, c_int, c_void},
    sync::OnceLock,
};

#[repr(C)]
#[derive(Default)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}
type ProcessForPid = unsafe extern "C" fn(i32, *mut ProcessSerialNumber) -> i32;
type PostRecord = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
unsafe extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}
#[derive(Clone, Copy)]
struct Api {
    process: ProcessForPid,
    post: PostRecord,
}
impl Api {
    fn load() -> Result<Self> {
        static API: OnceLock<Option<Api>> = OnceLock::new();
        API.get_or_init(|| unsafe {
            // The handle is retained for the helper lifetime.
            let handle = dlopen(c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(), 2);
            if handle.is_null() { return None; }
            let post = dlsym(handle, c"SLPSPostEventRecordTo".as_ptr());
            let process = dlsym((-2_isize) as *mut c_void, c"GetProcessForPID".as_ptr());
            if post.is_null() || process.is_null() { return None; }
            Some(Api {
                process: std::mem::transmute::<*mut c_void, ProcessForPid>(process),
                post: std::mem::transmute::<*mut c_void, PostRecord>(post),
            })
        }).ok_or_else(|| CuaError::new(ErrorCode::Unsupported,
            "Window input preparation is unavailable. No activation record or mouse input was sent."))
    }
}
fn activation_record(window: u32) -> [u8; 248] {
    let mut bytes = [0; 248];
    bytes[4] = 248;
    bytes[8] = 0x0d;
    bytes[0x3c..0x40].copy_from_slice(&window.to_le_bytes());
    bytes[0x8a] = 1;
    bytes
}
fn send_record(
    window: u32,
    cancel: &Cancellation,
    mut post: impl FnMut(&[u8; 248]) -> i32,
) -> Result<()> {
    cancel.check()?;
    let status = post(&activation_record(window));
    if status != 0 {
        return Err(CuaError::new(
            ErrorCode::InputUnknown,
            format!(
                "Window input preparation returned OSStatus {status} after an attempted activation record. No mouse input was sent; observe before another action."
            ),
        ));
    }
    Ok(())
}
pub(super) fn prepare(pid: i32, window: u32, cancel: &Cancellation) -> Result<()> {
    let api = Api::load()?;
    let mut psn = ProcessSerialNumber::default();
    cancel.check()?;
    if unsafe { (api.process)(pid, &mut psn) } != 0 {
        return Err(CuaError::new(
            ErrorCode::TargetNotFound,
            "The target process could not be resolved for window input preparation.",
        ));
    }
    send_record(window, cancel, |record| unsafe {
        (api.post)(&psn, record.as_ptr())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sends_one_target_activation_record_without_mouse_or_defocus_records() {
        let mut calls = 0;
        send_record(0x12345678, &Cancellation::default(), |record| {
            calls += 1;
            assert_eq!(record[8], 0x0d);
            assert_eq!(record[0x8a], 1);
            assert_eq!(&record[0x3c..0x40], &[0x78, 0x56, 0x34, 0x12]);
            assert_eq!(record.iter().filter(|&&b| b != 0).count(), 7);
            0
        })
        .unwrap();
        assert_eq!(calls, 1);
    }
    #[test]
    fn stop_prevents_post_and_post_errors_are_uncertain_without_retry() {
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            send_record(12, &cancel, |_| panic!("cancelled post"))
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let mut calls = 0;
        assert_eq!(
            send_record(12, &Cancellation::default(), |_| {
                calls += 1;
                -1
            })
            .unwrap_err()
            .code,
            ErrorCode::InputUnknown
        );
        assert_eq!(calls, 1);
    }
}
