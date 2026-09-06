//! A single left-button pair. Quartz reports dispatch, not application success.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    input::InputReceipt,
    target::{Point, Target, TargetKind},
};
use std::{ffi::c_void, ptr};
type Event = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateMouseEvent(
        source: Event,
        kind: u32,
        position: NativePoint,
        button: u32,
    ) -> Event;
    fn CGEventSetIntegerValueField(event: Event, field: u32, value: i64);
    fn CGEventSetFlags(event: Event, flags: u64);
    fn CGEventPost(location: u32, event: Event);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Event);
}
struct MouseEvent(Event);
impl Drop for MouseEvent {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
impl MouseEvent {
    fn create(kind: u32, position: Point) -> Result<Self> {
        let event = unsafe {
            CGEventCreateMouseEvent(
                ptr::null(),
                kind,
                NativePoint {
                    x: position.x,
                    y: position.y,
                },
                0,
            )
        };
        if event.is_null() {
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "Could not create mouse event; no click was posted.",
            ));
        }
        unsafe {
            CGEventSetIntegerValueField(event, 1, 1); // kCGMouseEventClickState
            CGEventSetFlags(event, 0); // Explicit ordinary click, no inherited modifiers.
        }
        Ok(Self(event))
    }
}
pub(super) fn click(
    target: &Target,
    position: Point,
    cancel: &Cancellation,
) -> Result<(Target, InputReceipt)> {
    target.bounds.to_global(position)?;
    cancel.check()?;
    let mut current = target.clone();
    let activation = target.kind == TargetKind::Window;
    if activation {
        current.bounds = super::accessibility::activate_for_click(target, position, cancel)?;
    }
    let global = current.bounds.to_global(position)?;
    let down = MouseEvent::create(1, global)?; // kCGEventLeftMouseDown
    let up = MouseEvent::create(2, global)?; // kCGEventLeftMouseUp
    crate::input::dispatch_single_click(
        cancel,
        || unsafe { CGEventPost(0, down.0) },
        || unsafe { CGEventPost(0, up.0) },
    )?;
    Ok((
        current,
        InputReceipt {
            method: "coordinate",
            activation,
            outcome: "dispatched",
            position: Some(position),
            global_position: Some(global),
            effects: None,
        },
    ))
}
