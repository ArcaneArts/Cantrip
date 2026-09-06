//! Experimental window-directed macros. No global post, activation, clipboard,
//! hardware pointer warp or modifier-state suppression. Void SPI cannot certify
//! which responder consumed an event; every completed macro remains unverified.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{
        InputCommand, drag_points, held_gesture, key_code, modifier_flags, text_units, wait_until,
    },
    input::InputReceipt,
    target::{Point, Target},
};
use std::{
    cell::Cell,
    ffi::c_void,
    time::{Duration, Instant},
};
type Ref = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state: i32) -> Ref;
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetTimestamp(event: Ref) -> u64;
    fn CGEventSetTimestamp(event: Ref, timestamp: u64);
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, text: *const u16);
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: NativePoint, button: u32) -> Ref;
    fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, wheels: u32, ...) -> Ref;
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventSetLocation(event: Ref, point: NativePoint);
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
impl Event {
    fn owned(value: Ref) -> Result<Self> {
        if value.is_null() {
            Err(CuaError::new(
                ErrorCode::InputFailed,
                "Native event allocation failed; no input was posted.",
            ))
        } else {
            Ok(Self(value))
        }
    }
    fn mouse(source: Ref, kind: u32, point: Point) -> Result<Self> {
        Self::owned(unsafe {
            CGEventCreateMouseEvent(
                source,
                kind,
                NativePoint {
                    x: point.x,
                    y: point.y,
                },
                0,
            )
        })
    }
}
pub(super) fn perform(
    target: &Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point),
) -> Result<(Target, InputReceipt)> {
    command.validate()?;
    let (pid, window) = super::click::process_destination(target)?;
    let delivery = super::skylight::Delivery::load()?;
    let global = target.bounds.to_global(position)?;
    if let InputCommand::Drag { end, .. } = command {
        target.bounds.to_global(*end)?;
    }
    cancel.check()?;
    // Private source state isolates generated flags from the human keyboard.
    let source = Event::owned(unsafe { CGEventSourceCreate(-1) })?;
    let group = super::skylight::next_group();
    let prepare = |event: &Event, point: Point, mouse: bool| unsafe {
        CGEventSetFlags(event.0, 0);
        if mouse {
            delivery.prepare(event.0, pid, window, point, group, 1);
        } else {
            delivery.prepare_routed(event.0, pid, window, point, group);
        }
    };
    // Events are preallocated for cleanup, but their times must describe actual
    // dispatch. Anchor monotonic elapsed time to a Quartz-created timestamp.
    let clock_event = Event::owned(unsafe { CGEventCreate(source.0) })?;
    let epoch = unsafe { CGEventGetTimestamp(clock_event.0) };
    let clock = Instant::now();
    let post = |event: &Event| unsafe {
        CGEventSetTimestamp(
            event.0,
            epoch.saturating_add(clock.elapsed().as_nanos().min(u64::MAX as u128) as u64),
        );
        delivery.post(pid, event.0)
    };
    let mut final_position = position;
    match command {
        InputCommand::Text { .. } | InputCommand::Key { .. } => {
            let units: Vec<(u16, Vec<u16>, u64)> = match command {
                InputCommand::Text { text } => text_units(text)
                    .into_iter()
                    .map(|unit| match unit.as_slice() {
                        [10] | [13] => (36, vec![], 0),
                        [9] => (48, vec![], 0),
                        _ => (0, unit, 0),
                    })
                    .collect(),
                InputCommand::Key { key, modifiers } => {
                    vec![(key_code(key).unwrap(), vec![], modifier_flags(modifiers))]
                }
                _ => unreachable!(),
            };
            // Allocate both halves before sending anything, including all text
            // pairs. Allocation failure therefore cannot strand a pressed key.
            let mut pairs = Vec::with_capacity(units.len());
            for (key, text, flags) in units {
                cancel.check()?;
                let down =
                    Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, key, true) })?;
                let up = Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, key, false) })?;
                for event in [&down, &up] {
                    prepare(event, position, false);
                    unsafe {
                        CGEventSetFlags(event.0, flags);
                        if !text.is_empty() {
                            CGEventKeyboardSetUnicodeString(event.0, text.len(), text.as_ptr());
                        }
                    }
                }
                pairs.push((down, up));
            }
            let mut began = false;
            for (down, up) in pairs {
                let result = held_gesture(
                    cancel,
                    || post(&down),
                    || wait_until(Instant::now() + Duration::from_millis(2), cancel),
                    || post(&up),
                );
                if let Err(error) = result {
                    return Err(if began { unknown() } else { error });
                }
                began = true;
            }
        }
        InputCommand::Drag {
            start,
            end,
            duration_ms,
        } => {
            let tracking = Event::mouse(source.0, 5, global)?;
            prepare(&tracking, *start, true);
            let down = Event::mouse(source.0, 1, global)?;
            prepare(&down, *start, true);
            // Allocate one release for every possible last dispatched point.
            // Cancellation releases THERE, without jumping to the final target.
            let mut moves = Vec::new();
            let mut releases = vec![Event::mouse(source.0, 2, global)?];
            prepare(&releases[0], *start, true);
            for (at, point) in drag_points(*start, *end, *duration_ms) {
                let global = target.bounds.to_global(point)?;
                let movement = Event::mouse(source.0, 6, global)?; // leftMouseDragged
                let up = Event::mouse(source.0, 2, global)?;
                prepare(&movement, point, true);
                prepare(&up, point, true);
                moves.push((at, point, movement));
                releases.push(up);
            }
            let last = Cell::new(0);
            cancel.check()?;
            post(&tracking);
            wait_until(Instant::now() + Duration::from_millis(12), cancel)
                .map_err(|_| drag_unknown())?;
            held_gesture(
                cancel,
                || post(&down),
                || {
                    progress(*start);
                    let started = Instant::now();
                    for (i, (at, point, event)) in moves.iter().enumerate() {
                        wait_until(started + *at, cancel)?;
                        post(event);
                        last.set(i + 1);
                        final_position = *point;
                        progress(*point);
                    }
                    Ok(())
                },
                || post(&releases[last.get()]),
            )
            .map_err(|_| drag_unknown())?;
        }
        InputCommand::Scroll {
            delta_x, delta_y, ..
        } => {
            // API-positive scroll is up/left; public CUA-positive is down/right.
            let event = Event::owned(unsafe {
                CGEventCreateScrollWheelEvent(source.0, 0, 2, -*delta_y, -*delta_x)
            })?;
            unsafe {
                CGEventSetLocation(
                    event.0,
                    NativePoint {
                        x: global.x,
                        y: global.y,
                    },
                );
            }
            prepare(&event, position, false);
            cancel.check()?;
            post(&event);
        }
    }
    Ok((
        target.clone(),
        InputReceipt {
            control: None,
            method: command.method(),
            activation: false,
            outcome: "unknown",
            position: Some(final_position),
            global_position: Some(target.bounds.to_global(final_position)?),
            effects: None,
            window_delivery: Some("unverified"),
        },
    ))
}
fn unknown() -> CuaError {
    CuaError::new(
        ErrorCode::InputUnknown,
        "Text input stopped after dispatch began; key-up cleanup was sent. Do not replay the text automatically.",
    )
}

fn drag_unknown() -> CuaError {
    CuaError::new(
        ErrorCode::InputUnknown,
        "Drag stopped after tracking began; button-up cleanup was sent if down was posted. Do not replay automatically.",
    )
}
