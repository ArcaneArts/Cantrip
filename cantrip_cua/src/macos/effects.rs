//! Best-effort before/after observations, never a permission/readiness gate.
//! Native identities stay here; only change summaries leave the helper.
use super::accessibility::FocusSample;
use crate::{
    error::Result,
    input::{InputEffects, InputReceipt, observed_change},
    target::{Point, Target},
};
use std::{
    ffi::c_void,
    ptr,
    time::{SystemTime, UNIX_EPOCH},
};
type Ref = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetLocation(event: Ref) -> NativePoint;
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
    static kCGWindowNumber: Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFNumberGetValue(number: Ref, kind: isize, value: *mut c_void) -> u8;
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
fn pointer() -> Option<Point> {
    let raw = unsafe { CGEventCreate(ptr::null()) };
    if raw.is_null() {
        return None;
    }
    let event = Owned(raw);
    let point = unsafe { CGEventGetLocation(event.0) };
    (point.x.is_finite() && point.y.is_finite()).then_some(Point {
        x: point.x,
        y: point.y,
    })
}
fn window_order() -> Option<Vec<u32>> {
    // Public front-to-back inventory. Read only numeric IDs; window titles
    // and other dictionary fields are never accessed or returned.
    let raw = unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) };
    if raw.is_null() {
        return None;
    }
    let array = Owned(raw);
    let count = unsafe { CFArrayGetCount(array.0) };
    if !(0..=1024).contains(&count) {
        return None;
    }
    (0..count)
        .map(|i| {
            let dictionary = unsafe { CFArrayGetValueAtIndex(array.0, i) };
            let number = unsafe { CFDictionaryGetValue(dictionary, kCGWindowNumber) };
            if number.is_null() {
                return None;
            }
            let mut id = 0_i64;
            if unsafe { CFNumberGetValue(number, 4, (&mut id as *mut i64).cast()) } == 0 {
                return None;
            }
            u32::try_from(id).ok()
        })
        .collect()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
struct Snapshot {
    at_ms: u64,
    pointer: Option<Point>,
    order: Option<Vec<u32>>,
    focus: FocusSample,
}
impl Snapshot {
    fn capture() -> Self {
        Self {
            at_ms: now_ms(),
            pointer: pointer(),
            order: window_order(),
            focus: FocusSample::capture(),
        }
    }
    fn compare(self, after: Self) -> InputEffects {
        let (foreground_application, foreground_window) = self.focus.compare(&after.focus);
        InputEffects {
            sampling: "before-after-dispatch",
            before_at_ms: self.at_ms,
            after_at_ms: after.at_ms,
            pointer: observed_change(self.pointer.as_ref(), after.pointer.as_ref()),
            window_order: observed_change(self.order.as_ref(), after.order.as_ref()),
            foreground_application,
            foreground_window,
        }
    }
}
/// A missing sample is reported as unknown and never prevents the input attempt.
/// Sampling is immediate and not atomic; asynchronous app/human changes can follow.
pub(super) fn observe(
    action: impl FnOnce() -> Result<(Target, InputReceipt)>,
) -> Result<(Target, InputReceipt)> {
    let before = Snapshot::capture();
    let mut result = action()?;
    result.1.effects = Some(before.compare(Snapshot::capture()));
    Ok(result)
}
