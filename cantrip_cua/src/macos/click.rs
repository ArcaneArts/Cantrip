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
    fn CGEventSourceCreate(state: i32) -> Event;
    fn CGEventCreateMouseEvent(
        source: Event,
        kind: u32,
        position: NativePoint,
        button: u32,
    ) -> Event;
    fn CGEventSetIntegerValueField(event: Event, field: u32, value: i64);
    fn CGEventSetFlags(event: Event, flags: u64);
    fn CGEventPost(location: u32, event: Event);
    fn CGEventPostToPid(pid: i32, event: Event);
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
        Self::with_source(kind, position, ptr::null())
    }
    fn with_source(kind: u32, position: Point, source: Event) -> Result<Self> {
        let event = unsafe {
            CGEventCreateMouseEvent(
                source,
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
            control: None,
            method: "coordinate",
            activation,
            outcome: "dispatched",
            position: Some(position),
            global_position: Some(global),
            effects: None,
            window_delivery: None,
        },
    ))
}

/// Explicit process-directed attempt, not verified per-window delivery. Public
/// Quartz fields 91/92 describe the intended window but do not guarantee routing.
/// No global post, application activation or system cursor restoration occurs.
pub(super) fn process_click(
    target: &Target,
    position: Point,
    cancel: &Cancellation,
) -> Result<(Target, InputReceipt)> {
    let (pid, window_id) = process_destination(target)?;
    let global = target.bounds.to_global(position)?;
    cancel.check()?;
    let down = MouseEvent::create(1, global)?;
    let up = MouseEvent::create(2, global)?;
    for event in [&down, &up] {
        unsafe {
            CGEventSetIntegerValueField(event.0, 40, i64::from(pid)); // kCGEventTargetUnixProcessID
            CGEventSetIntegerValueField(event.0, 91, i64::from(window_id)); // kCGMouseEventWindowUnderMousePointer
            CGEventSetIntegerValueField(event.0, 92, i64::from(window_id)); // kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent
        }
    }
    crate::input::dispatch_single_click(
        cancel,
        || unsafe { CGEventPostToPid(pid, down.0) },
        || unsafe { CGEventPostToPid(pid, up.0) },
    )?;
    Ok((
        target.clone(),
        InputReceipt {
            control: None,
            method: "process-coordinate",
            activation: false,
            // The void API provides no acknowledgement of window delivery.
            outcome: "unknown",
            position: Some(position),
            global_position: Some(global),
            effects: None,
            window_delivery: Some("unverified"),
        },
    ))
}

/// One explicit experimental mouse gesture. No public/global second posting.
pub(super) fn background_click(
    target: &Target,
    position: Point,
    cancel: &Cancellation,
) -> Result<(Target, InputReceipt)> {
    use std::{
        sync::atomic::{AtomicI64, Ordering},
        time::Duration,
    };
    let (pid, window) = process_destination(target)?;
    let global = target.bounds.to_global(position)?;
    let delivery = super::skylight::Delivery::load()?;
    let source = unsafe { CGEventSourceCreate(1) }; // kCGEventSourceStateHIDSystemState
    if source.is_null() {
        return Err(CuaError::new(
            ErrorCode::InputFailed,
            "Could not create background event source; no input was posted.",
        ));
    }
    let source = MouseEvent(source); // CF-owned source; same release semantics.
    let movement = MouseEvent::with_source(5, global, source.0)?;
    let down = MouseEvent::with_source(1, global, source.0)?;
    let up = MouseEvent::with_source(2, global, source.0)?;
    static GROUP: AtomicI64 = AtomicI64::new(1);
    let group = GROUP.fetch_add(1, Ordering::Relaxed);
    for (event, state) in [(&movement, 0), (&down, 1), (&up, 1)] {
        unsafe {
            delivery.prepare(event.0, pid, window, position, group, state);
        }
    }
    cancel.check()?;
    unsafe {
        delivery.post(pid, movement.0);
    }
    // Give the target's event loop a tracking update before the button pair.
    std::thread::sleep(Duration::from_millis(12));
    if cancel.is_cancelled() {
        return Err(CuaError::new(
            ErrorCode::InputUnknown,
            "Stopped after a background tracking event; no button pair was sent. Do not replay the gesture automatically.",
        ));
    }
    crate::input::dispatch_single_click(
        cancel,
        || {
            unsafe {
                delivery.post(pid, down.0);
            }
            std::thread::sleep(Duration::from_millis(28));
        },
        || unsafe {
            delivery.post(pid, up.0);
        },
    ).map_err(|_| CuaError::new(
        ErrorCode::InputUnknown,
        "Stopped after background tracking began; mouse-up cleanup was preserved if down was posted. Do not replay the gesture automatically.",
    ))?;
    Ok((
        target.clone(),
        InputReceipt {
            control: None,
            method: "background-coordinate",
            activation: false,
            outcome: "unknown",
            position: Some(position),
            global_position: Some(global),
            effects: None,
            window_delivery: Some("unverified"),
        },
    ))
}

fn process_destination(target: &Target) -> Result<(i32, u32)> {
    let unsupported = || {
        CuaError::new(
            ErrorCode::Unsupported,
            "Process input requires an attached application window with a native process identity; no input was posted.",
        )
    };
    if target.kind != TargetKind::Window {
        return Err(unsupported());
    }
    let pid = target
        .process_id
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(unsupported)?;
    let window_id = target
        .id
        .strip_prefix("macos-window-")
        .and_then(|id| id.parse::<u32>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(unsupported)?;
    Ok((pid, window_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{CaptureBackend, FakeBackend};
    #[test]
    fn process_destination_preserves_native_window_and_pid_without_posting() {
        let mut targets = FakeBackend.targets(&Cancellation::default()).unwrap();
        let mut window = targets.pop().unwrap();
        window.id = "macos-window-1234".into();
        window.process_id = Some(4567);
        assert_eq!(process_destination(&window).unwrap(), (4567, 1234));
        window.process_id = Some(0);
        assert!(process_destination(&window).is_err());
        window.process_id = Some(u32::MAX);
        assert!(process_destination(&window).is_err());
        window.process_id = Some(4567);
        window.id = "macos-display-1234".into();
        assert!(process_destination(&window).is_err());
        window.id = "macos-window-1234".into();
        window.kind = TargetKind::Monitor;
        assert!(process_destination(&window).is_err());
    }
}
