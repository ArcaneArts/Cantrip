//! Experimental window-directed macros. Activation requires explicit focus/preparation.
//! Window input never globally posts; explicit consumer keys use the media module. No clipboard,
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
struct PreparedPair {
    down: Event,
    up: Event,
    pointer: Option<(Point, Event)>,
    prepare_window: bool,
}
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
    fn set_modifiers(&self, modifiers: &[crate::gesture::Modifier]) {
        // Event-local flags only: never press/release a hardware modifier or
        // change the flags of interleaved keyboard events in the timeline.
        unsafe { CGEventSetFlags(self.0, modifier_flags(modifiers)) };
    }
    fn mouse(source: Ref, kind: u32, point: Point) -> Result<Self> {
        Self::mouse_button(source, kind, point, crate::gesture::MouseButton::Left)
    }
    fn mouse_button(
        source: Ref,
        kind: u32,
        point: Point,
        button: crate::gesture::MouseButton,
    ) -> Result<Self> {
        Self::owned(unsafe {
            CGEventCreateMouseEvent(
                source,
                kind,
                NativePoint {
                    x: point.x,
                    y: point.y,
                },
                button.number(),
            )
        })
    }
}
pub(super) fn perform(
    session: &str,
    target: &Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point, bool),
) -> Result<(Target, InputReceipt)> {
    command.validate()?;
    if let InputCommand::Media { key, modifiers } = command {
        super::media::press(*key, modifiers, cancel)?;
        return Ok((
            target.clone(),
            InputReceipt {
                control: None,
                method: "system-media",
                activation: false,
                outcome: "dispatched",
                position: None,
                global_position: None,
                effects: None,
                window_delivery: None,
            },
        ));
    }
    if matches!(command, InputCommand::Focus {}) {
        let mut current = target.clone();
        current.bounds = super::accessibility::request_focus(target, cancel)?;
        return Ok((
            current.clone(),
            InputReceipt {
                control: None,
                method: "focus",
                activation: true,
                outcome: "dispatched",
                position: None,
                global_position: None,
                effects: None,
                window_delivery: None,
            },
        ));
    }
    let (pid, window) = super::click::process_destination(target)?;
    if matches!(command, InputCommand::WindowInput {}) {
        super::window_input::prepare(pid, window, cancel)?;
        return Ok((
            target.clone(),
            InputReceipt {
                control: None,
                method: "window-input",
                activation: true,
                outcome: "dispatched",
                position: None,
                global_position: None,
                effects: None,
                window_delivery: None,
            },
        ));
    }
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
        delivery.post(pid, event.0);
        super::input_telemetry::posted(session, target, event.0);
    };
    let mut final_position = position;
    match command {
        InputCommand::Focus {} | InputCommand::WindowInput {} | InputCommand::Media { .. } => {
            unreachable!("focus handled without allocating mouse input")
        }
        InputCommand::PreparedPress {
            hold_ms, button, ..
        } => {
            let point = position;
            // Allocate and address the complete pair before the activation request.
            let tracking = Event::mouse(source.0, 5, global)?;
            let (down_type, up_type) = button.event_types();
            let down = Event::mouse_button(source.0, down_type, global, *button)?;
            let up = Event::mouse_button(source.0, up_type, global, *button)?;
            for event in [&tracking, &down, &up] {
                prepare(event, point, true);
            }
            super::window_input::prepare_then(pid, window, cancel, || {
                held_gesture(
                    cancel,
                    || {
                        post(&tracking);
                        post(&down);
                    },
                    || {
                        final_position = point;
                        progress(point, true);
                        wait_until(Instant::now() + Duration::from_millis(*hold_ms), cancel)
                    },
                    || post(&up),
                )
            })?;
        }
        InputCommand::Timeline { frames } => {
            use crate::timeline::{Frame, Transition};
            use std::collections::HashMap;
            let mut pairs: Vec<PreparedPair> = vec![];
            let mut keys = HashMap::new();
            let mut pointer = None;
            let mut schedule = Vec::with_capacity(frames.len());
            for frame in frames {
                cancel.check()?;
                let mut events = Vec::new();
                for key in &frame.key_up {
                    events.push(Transition::Up(keys.remove(key).expect("validated key up")));
                }
                if frame.pointer_up {
                    events.push(Transition::Up(
                        pointer.take().expect("validated pointer up"),
                    ));
                }
                for key in &frame.key_down {
                    let code = key_code(key).expect("validated key");
                    let down =
                        Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, code, true) })?;
                    let up =
                        Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, code, false) })?;
                    prepare(&down, position, false);
                    prepare(&up, position, false);
                    down.set_modifiers(&frame.key_modifiers);
                    up.set_modifiers(&frame.key_modifiers);
                    let i = pairs.len();
                    pairs.push(PreparedPair {
                        down,
                        up,
                        pointer: None,
                        prepare_window: false,
                    });
                    keys.insert(key.clone(), i);
                    events.push(Transition::Down(i));
                }
                if let Some(point) = frame.pointer_down {
                    let global = target.bounds.to_global(point)?;
                    let tracking = Event::mouse(source.0, 5, global)?;
                    let button = frame.pointer_button.unwrap_or_default();
                    let (down_type, up_type) = button.event_types();
                    let down = Event::mouse_button(source.0, down_type, global, button)?;
                    let up = Event::mouse_button(source.0, up_type, global, button)?;
                    prepare(&tracking, point, true);
                    prepare(&down, point, true);
                    prepare(&up, point, true);
                    for event in [&tracking, &down, &up] {
                        event.set_modifiers(&frame.pointer_modifiers);
                    }
                    let i = pairs.len();
                    pairs.push(PreparedPair {
                        down,
                        up,
                        pointer: Some((point, tracking)),
                        prepare_window: frame.pointer_modifiers.is_empty(),
                    });
                    pointer = Some(i);
                    events.push(Transition::Down(i));
                }
                schedule.push(Frame {
                    at: Duration::from_millis(frame.at_ms),
                    events,
                });
            }
            let pointer_points: Vec<_> = pairs
                .iter()
                .map(|p| p.pointer.as_ref().map(|(point, _)| *point))
                .collect();
            let schedule =
                crate::timeline::with_pointer_travel(schedule, &pointer_points, position);
            crate::timeline::run(
                schedule,
                pairs.len(),
                cancel,
                |transition| {
                    let (i, is_down) = match transition {
                        Transition::Down(i) => (i, true),
                        Transition::Up(i) => (i, false),
                        Transition::Move(point) => {
                            final_position = point;
                            progress(final_position, false);
                            return;
                        }
                    };
                    let PreparedPair {
                        down, up, pointer, ..
                    } = &pairs[i];
                    if let Some((point, tracking)) = pointer {
                        if is_down {
                            post(tracking);
                        }
                        post(if is_down { down } else { up });
                        final_position = *point;
                        progress(*point, true);
                    } else {
                        post(if is_down { down } else { up });
                    }
                },
                |transition| {
                    if let Transition::Down(i) = transition
                        && pairs[i].prepare_window
                    {
                        // Stop during preparation must prevent Down, while
                        // still reporting the attempted activation as uncertain.
                        super::window_input::prepare_then(pid, window, cancel, || cancel.check())?;
                    }
                    Ok(())
                },
            )?;
        }
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
            super::window_input::prepare_then(pid, window, cancel, || {
                held_gesture(
                    cancel,
                    || {
                        post(&tracking);
                        post(&down);
                    },
                    || {
                        progress(*start, true);
                        let started = Instant::now();
                        for (i, (at, point, event)) in moves.iter().enumerate() {
                            wait_until(started + *at, cancel)?;
                            post(event);
                            last.set(i + 1);
                            final_position = *point;
                            progress(*point, true);
                        }
                        Ok(())
                    },
                    || post(&releases[last.get()]),
                )
            })?;
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
            crate::effects::live::input(
                session,
                target,
                crate::effects::telemetry::InputEvent {
                    kind: crate::effects::telemetry::EventKind::Scroll,
                    code: 0,
                    modifiers: 0,
                    position: Some(position),
                    delta: [*delta_x as f32, *delta_y as f32],
                },
            );
        }
    }
    Ok((
        target.clone(),
        InputReceipt {
            control: None,
            method: command.method(),
            activation: command.prepares_window(),
            outcome: "dispatched",
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

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventGetFlags(event: Ref) -> u64;
    }
    #[test]
    fn native_buttons_survive_window_routing_without_posting() {
        use crate::gesture::MouseButton::*;
        unsafe extern "C" {
            fn CGEventGetType(event: Ref) -> u32;
            fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        }
        let source = Event::owned(unsafe { CGEventSourceCreate(-1) }).unwrap();
        let delivery = super::super::skylight::Delivery::load().unwrap();
        for (button, expected_number, types) in [
            (Left, 0, (1, 2)),
            (Right, 1, (3, 4)),
            (Middle, 2, (25, 26)),
            (Back, 3, (25, 26)),
            (Forward, 4, (25, 26)),
        ] {
            assert_eq!(button.event_types(), types);
            for kind in [types.0, types.1] {
                let point = Point { x: 10.0, y: 20.0 };
                let event = Event::mouse_button(source.0, kind, point, button).unwrap();
                unsafe {
                    delivery.prepare(event.0, 77, 123, point, 42, 1);
                }
                event.set_modifiers(&[crate::gesture::Modifier::Meta]);
                unsafe {
                    assert_eq!(CGEventGetType(event.0), kind);
                    assert_eq!(CGEventGetIntegerValueField(event.0, 3), expected_number);
                    assert_eq!(CGEventGetIntegerValueField(event.0, 51), 123);
                    assert_eq!(CGEventGetFlags(event.0), 1 << 20);
                }
            }
        }
    }
    #[test]
    fn pointer_modifier_flags_do_not_leak_into_keyboard_events() {
        // Construct and inspect event buffers only. Nothing is posted, no app
        // is launched, and no capture, focus or shared input state is touched.
        let source = Event::owned(unsafe { CGEventSourceCreate(-1) }).unwrap();
        let key = Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, 8, true) }).unwrap();
        let original_key_flags = unsafe { CGEventGetFlags(key.0) };
        let point = Point { x: 10.0, y: 20.0 };
        for kind in [5, 1, 2] {
            let event = Event::mouse(source.0, kind, point).unwrap();
            event.set_modifiers(&[crate::gesture::Modifier::Meta]);
            assert_eq!(unsafe { CGEventGetFlags(event.0) }, 1 << 20);
            event.set_modifiers(&[]);
            assert_eq!(unsafe { CGEventGetFlags(event.0) }, 0);
        }
        assert_eq!(unsafe { CGEventGetFlags(key.0) }, original_key_flags);
    }
}
