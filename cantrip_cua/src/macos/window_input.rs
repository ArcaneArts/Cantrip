//! Target-only AppKit input preparation. This sends activation and key-window records,
//! without a WindowServer front-process request or a raise operation.
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
// Native make-key record layout used by yabai and trycua's SkyLight bridge.
// These records address the target window only; no defocus record, foreground
// request, HID post, or primer click is sent to the human's application.
fn key_window_record(window: u32, kind: u8) -> [u8; 248] {
    let mut record = [0; 248];
    record[4] = 248;
    record[8] = kind;
    record[0x3a] = 0x10;
    record[0x3c..0x40].copy_from_slice(&window.to_le_bytes());
    record[0x20..0x30].fill(0xff);
    record
}

/// Read WindowServer's foreground PID, independent of cached AppKit activation.
pub(super) fn foreground_pid() -> Option<u32> {
    type Front = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
    type Pid = unsafe extern "C" fn(*const ProcessSerialNumber, *mut i32) -> i32;
    static READERS: OnceLock<Option<(Front, Pid)>> = OnceLock::new();
    let (front, pid) = READERS
        .get_or_init(|| unsafe {
            let handle = dlopen(
                c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
                2,
            );
            if handle.is_null() {
                return None;
            }
            let front = dlsym(handle, c"_SLPSGetFrontProcess".as_ptr());
            let pid = dlsym((-2_isize) as *mut c_void, c"GetProcessPID".as_ptr());
            if front.is_null() || pid.is_null() {
                return None;
            }
            Some((
                std::mem::transmute::<*mut c_void, Front>(front),
                std::mem::transmute::<*mut c_void, Pid>(pid),
            ))
        })
        .as_ref()?;
    let mut psn = ProcessSerialNumber::default();
    let mut value = 0;
    if unsafe { front(&mut psn) } != 0 || unsafe { pid(&psn, &mut value) } != 0 {
        return None;
    }
    u32::try_from(value).ok().filter(|pid| *pid > 0)
}

fn send_record(
    window: u32,
    cancel: &Cancellation,
    mut post: impl FnMut(&[u8; 248]) -> i32,
) -> Result<()> {
    cancel.check()?;
    for record in [
        activation_record(window),
        key_window_record(window, 1),
        key_window_record(window, 2),
    ] {
        let status = post(&record);
        if status != 0 {
            return Err(CuaError::new(
                ErrorCode::InputUnknown,
                format!(
                    "Window input preparation returned OSStatus {status} during target-window preparation. The requested pointer gesture was not posted; preparation may have changed app state. Observe before another action."
                ),
            ));
        }
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
/// Queue preparation and one preallocated input operation within the same native
/// request. A successful post is not proof that AppKit accepted the activation.
/// Any subsequent failure is uncertain, including Stop before mouse-down.
pub(super) fn prepare_then(
    pid: i32,
    window: u32,
    cancel: &Cancellation,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    after_preparation(|| prepare(pid, window, cancel), action)
}
fn after_preparation(
    prepare: impl FnOnce() -> Result<()>,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    prepare()?;
    action().map_err(|_| CuaError::new(
        ErrorCode::InputUnknown,
        "Prepared pointer action stopped after activation was attempted. Button-up cleanup was sent if down began. Observe; do not replay automatically.",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_precedes_action_and_failure_never_replays() {
        use std::cell::RefCell;
        let calls = RefCell::new(vec![]);
        after_preparation(
            || {
                calls.borrow_mut().push("prepare");
                Ok(())
            },
            || {
                calls.borrow_mut().push("press");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), ["prepare", "press"]);
        let err = after_preparation(
            || Err(CuaError::new(ErrorCode::Unsupported, "unavailable")),
            || panic!("must not click after preparation fails"),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unsupported);
        let err = after_preparation(
            || Ok(()),
            || {
                Err(CuaError::new(
                    ErrorCode::Cancelled,
                    "Stop after preparation",
                ))
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InputUnknown);
    }
    #[test]
    fn sends_target_activation_then_balanced_key_window_records() {
        let mut calls = 0;
        send_record(0x12345678, &Cancellation::default(), |record| {
            calls += 1;
            assert_eq!(record[8], [0x0d, 1, 2][calls - 1]);
            assert_eq!(&record[0x3c..0x40], &[0x78, 0x56, 0x34, 0x12]);
            if calls == 1 {
                assert_eq!(record[0x8a], 1);
            } else {
                assert_eq!(record[0x8a], 0);
                assert_eq!(record[0x3a], 0x10);
                assert!(record[0x20..0x30].iter().all(|&b| b == 0xff));
            }
            0
        })
        .unwrap();
        assert_eq!(calls, 3);
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
