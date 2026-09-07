//! Explicit system consumer keys. Never used as a fallback for window input.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{MediaKey, Modifier, held_gesture, modifier_flags, wait_until},
};
use objc2::{
    msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::CGPoint;
use std::{
    ffi::c_void,
    time::{Duration, Instant},
};
type Ref = *const c_void;
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateCopy(event: Ref) -> Ref;
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetTimestamp(event: Ref) -> u64;
    fn CGEventSetTimestamp(event: Ref, timestamp: u64);
    fn CGEventPost(tap: u32, event: Ref);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
}
struct Event(Ref);
impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
fn event(key: MediaKey, down: bool, modifiers: &[Modifier]) -> Result<Event> {
    autoreleasepool(|_| unsafe {
        let class = AnyClass::get(c"NSEvent").ok_or_else(failed)?;
        // NX_SYSDEFINED=14, NX_SUBTYPE_AUX_CONTROL_BUTTONS=8. data1 stores
        // NX_KEYTYPE in the high word and NX_KEYDOWN/UP in the next byte.
        let native: Option<Retained<AnyObject>> = msg_send![class,
            otherEventWithType:14_usize,
            location:CGPoint { x:0.0, y:0.0 },
            modifierFlags:modifier_flags(modifiers) as usize,
            timestamp:0.0_f64,
            windowNumber:0_isize,
            context:std::ptr::null::<AnyObject>(),
            subtype:8_i16,
            data1:key.data(down),
            data2:(-1_isize)
        ];
        let native = native.ok_or_else(failed)?;
        let cg: *const objc2_core_graphics::CGEvent = msg_send![&*native, CGEvent];
        if cg.is_null() {
            return Err(failed());
        }
        let owned = CGEventCreateCopy(cg.cast());
        if owned.is_null() {
            Err(failed())
        } else {
            Ok(Event(owned))
        }
    })
}
fn failed() -> CuaError {
    CuaError::new(
        ErrorCode::InputFailed,
        "Unable to create system media key; no input was posted.",
    )
}
pub(super) fn press(key: MediaKey, modifiers: &[Modifier], cancel: &Cancellation) -> Result<()> {
    // Both halves exist before posting. Stop/panic cleanup always releases.
    let down = event(key, true, modifiers)?;
    let up = event(key, false, modifiers)?;
    let clock = unsafe { CGEventCreate(std::ptr::null()) };
    if clock.is_null() {
        return Err(failed());
    }
    let clock = Event(clock);
    let epoch = unsafe { CGEventGetTimestamp(clock.0) };
    let start = Instant::now();
    let post = |event: &Event| unsafe {
        CGEventSetTimestamp(
            event.0,
            epoch.saturating_add(start.elapsed().as_nanos().min(u64::MAX as u128) as u64),
        );
        CGEventPost(0, event.0);
    };
    held_gesture(
        cancel,
        || post(&down),
        || wait_until(Instant::now() + Duration::from_millis(2), cancel),
        || post(&up),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consumer_event_round_trips_type_payload_and_flags_without_posting() {
        for key in [
            MediaKey::PlayPause,
            MediaKey::NextTrack,
            MediaKey::PreviousTrack,
            MediaKey::FastForward,
            MediaKey::Rewind,
            MediaKey::VolumeUp,
            MediaKey::VolumeDown,
            MediaKey::VolumeMute,
        ] {
            for down in [true, false] {
                let event = event(key, down, &[Modifier::Shift]).unwrap();
                autoreleasepool(|_| unsafe {
                    let native: Retained<AnyObject> = msg_send![AnyClass::get(c"NSEvent").unwrap(), eventWithCGEvent:event.0.cast::<objc2_core_graphics::CGEvent>()];
                    let kind: usize = msg_send![&*native, type];
                    let subtype: i16 = msg_send![&*native, subtype];
                    let data: isize = msg_send![&*native, data1];
                    let flags: usize = msg_send![&*native, modifierFlags];
                    assert_eq!(kind, 14);
                    assert_eq!(subtype, 8);
                    assert_eq!(data, key.data(down));
                    assert_eq!(flags & (1 << 17), 1 << 17);
                });
            }
        }
    }
}
