//! Observe already-posted generated events. No permission checks, input or hardware queries.
use crate::{
    effects::{
        live,
        telemetry::{EventKind, InputEvent},
    },
    target::{Point, Target},
};
use std::ffi::c_void;
type Event = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventGetType(event: Event) -> u32;
    fn CGEventGetFlags(event: Event) -> u64;
    fn CGEventGetIntegerValueField(event: Event, field: u32) -> i64;
    fn CGEventGetLocation(event: Event) -> NativePoint;
}
pub(super) unsafe fn posted(session: &str, target: &Target, event: Event) {
    if let Some(input) = unsafe { decode(target, event) } {
        live::input(session, target, input);
    }
}
unsafe fn decode(target: &Target, event: Event) -> Option<InputEvent> {
    unsafe {
        let kind = CGEventGetType(event);
        let modifiers = ((CGEventGetFlags(event) >> 17) & 15) as u32;
        let mouse = matches!(kind,1..=7|25..=27);
        let position = mouse.then(|| {
            let global = CGEventGetLocation(event);
            Point {
                x: global.x - target.bounds.x,
                y: global.y - target.bounds.y,
            }
        });
        let action = match kind {
            1 | 3 | 25 => Some((
                EventKind::Press,
                CGEventGetIntegerValueField(event, 3) as u32,
            )),
            2 | 4 | 26 => Some((
                EventKind::Release,
                CGEventGetIntegerValueField(event, 3) as u32,
            )),
            10 => Some((
                EventKind::KeyDown,
                CGEventGetIntegerValueField(event, 9) as u32,
            )),
            11 => Some((
                EventKind::KeyUp,
                CGEventGetIntegerValueField(event, 9) as u32,
            )),
            _ => None,
        };
        action.map(|(kind, code)| InputEvent {
            kind,
            code,
            modifiers,
            position,
            delta: [0.0; 2],
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateMouseEvent(
            source: Event,
            kind: u32,
            point: NativePoint,
            button: u32,
        ) -> Event;
        fn CGEventCreateKeyboardEvent(source: Event, key: u16, down: bool) -> Event;
        fn CGEventSetFlags(event: Event, flags: u64);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Event);
    }
    fn target() -> Target {
        Target {
            id: "window".into(),
            generation: 1,
            kind: crate::target::TargetKind::Window,
            title: None,
            application: None,
            process_id: Some(42),
            bounds: crate::target::Bounds {
                x: -800.,
                y: 500.,
                width: 800.,
                height: 600.,
            },
            pixel_width: 1600,
            pixel_height: 1200,
            scale_factor: 2.,
            focused: None,
            minimized: None,
        }
    }
    #[test]
    fn allocated_mouse_events_decode_without_posting_any_input() {
        for (button, down, up) in [(0, 1, 2), (1, 3, 4), (2, 25, 26), (3, 25, 26), (4, 25, 26)] {
            for (kind, expected) in [(down, EventKind::Press), (up, EventKind::Release)] {
                unsafe {
                    let event = CGEventCreateMouseEvent(
                        std::ptr::null(),
                        kind,
                        NativePoint { x: -600., y: 800. },
                        button,
                    );
                    assert!(!event.is_null());
                    CGEventSetFlags(event, (1 << 17) | (1 << 20));
                    let input = decode(&target(), event).unwrap();
                    CFRelease(event);
                    assert_eq!(input.kind, expected);
                    assert_eq!(input.code, button);
                    assert_eq!(input.modifiers, 9);
                    assert_eq!(input.position, Some(Point { x: 200., y: 300. }));
                }
            }
        }
    }
    #[test]
    fn allocated_keyboard_events_do_not_invent_mouse_positions() {
        for (down, expected) in [(true, EventKind::KeyDown), (false, EventKind::KeyUp)] {
            unsafe {
                let event = CGEventCreateKeyboardEvent(std::ptr::null(), 8, down);
                assert!(!event.is_null());
                CGEventSetFlags(event, (1 << 18) | (1 << 19));
                let input = decode(&target(), event).unwrap();
                CFRelease(event);
                assert_eq!(input.kind, expected);
                assert_eq!(input.code, 8);
                assert_eq!(input.modifiers, 6);
                assert!(input.position.is_none());
            }
        }
    }
}
