//! Bounded input descriptions and timing; native authority stays in the service.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::Point,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum InputCommand {
    Focus {},
    #[serde(rename = "window-input")]
    WindowInput {},
    #[serde(rename = "prepared-press")]
    PreparedPress {
        #[serde(default)]
        point: Option<Point>,
        #[serde(rename = "holdMs")]
        hold_ms: u64,
        #[serde(default)]
        button: MouseButton,
    },
    Timeline {
        frames: Vec<crate::timeline::InputFrame>,
    },
    Text {
        text: String,
    },
    Media {
        key: MediaKey,
        #[serde(default)]
        modifiers: Vec<Modifier>,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Vec<Modifier>,
    },
    Drag {
        start: Point,
        end: Point,
        #[serde(rename = "durationMs", default = "default_duration")]
        duration_ms: u64,
    },
    Scroll {
        #[serde(rename = "deltaX", default)]
        delta_x: i32,
        #[serde(rename = "deltaY")]
        delta_y: i32,
        #[serde(default)]
        point: Option<Point>,
    },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Meta,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Back,
    Forward,
}
impl MouseButton {
    pub fn number(self) -> u32 {
        match self {
            Self::Left => 0,
            Self::Right => 1,
            Self::Middle => 2,
            Self::Back => 3,
            Self::Forward => 4,
        }
    }
    pub fn event_types(self) -> (u32, u32) {
        match self {
            Self::Left => (1, 2),
            Self::Right => (3, 4),
            _ => (25, 26),
        }
    }
}
/// IOKit hidsystem/ev_keymap.h consumer-key codes, not ANSI key positions.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum MediaKey {
    PlayPause,
    NextTrack,
    PreviousTrack,
    FastForward,
    Rewind,
    VolumeUp,
    VolumeDown,
    VolumeMute,
}
impl MediaKey {
    pub fn code(self) -> u16 {
        match self {
            Self::VolumeUp => 0,
            Self::VolumeDown => 1,
            Self::VolumeMute => 7,
            Self::PlayPause => 16,
            Self::NextTrack => 17,
            Self::PreviousTrack => 18,
            Self::FastForward => 19,
            Self::Rewind => 20,
        }
    }
    pub fn data(self, down: bool) -> isize {
        ((self.code() as isize) << 16) | ((if down { 0xA } else { 0xB }) << 8)
    }
}
pub fn valid_modifiers(modifiers: &[Modifier]) -> bool {
    modifiers.len() <= 4
        && modifiers
            .iter()
            .enumerate()
            .all(|(i, m)| !modifiers[..i].contains(m))
}
fn default_duration() -> u64 {
    200
}
impl InputCommand {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Focus {} => "focus",
            Self::WindowInput {} => "window-input",
            Self::PreparedPress { .. } => "background-prepared-press",
            Self::Timeline { .. } => "background-timeline",
            Self::Text { .. } => "background-text",
            Self::Key { .. } => "background-key",
            Self::Media { .. } => "system-media",
            Self::Drag { .. } => "background-drag",
            Self::Scroll { .. } => "background-scroll",
        }
    }
    /// Requested target-only AppKit preparation, not proof of foreground change.
    pub fn prepares_window(&self) -> bool {
        match self {
            Self::PreparedPress { .. } | Self::Drag { .. } => true,
            Self::Timeline { frames } => frames
                .iter()
                .any(|f| f.pointer_down.is_some() && f.pointer_modifiers.is_empty()),
            _ => false,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let point = |p: Point| p.x.is_finite() && p.y.is_finite() && p.x >= 0.0 && p.y >= 0.0;
        let valid = match self {
            Self::Focus {} | Self::WindowInput {} => true,
            Self::PreparedPress {
                point: p, hold_ms, ..
            } => p.is_none_or(point) && *hold_ms <= 7_200_000,
            Self::Timeline { frames } => return crate::timeline::validate(frames),
            Self::Text { text } => {
                !text.is_empty()
                    && text.len() <= 8192
                    && !text
                        .chars()
                        .any(|c| c.is_ascii_control() && !matches!(c, '\n' | '\r' | '\t'))
            }
            Self::Key { key, modifiers } => key_code(key).is_some() && valid_modifiers(modifiers),
            Self::Media { modifiers, .. } => valid_modifiers(modifiers),
            Self::Drag {
                start,
                end,
                duration_ms,
            } => point(*start) && point(*end) && (50..=2000).contains(duration_ms),
            Self::Scroll {
                delta_x,
                delta_y,
                point: p,
            } => {
                (-10000..=10000).contains(delta_x)
                    && (-10000..=10000).contains(delta_y)
                    && p.is_none_or(point)
            }
        };
        if valid {
            Ok(())
        } else {
            Err(CuaError::invalid(
                "Invalid or oversized native input macro.",
            ))
        }
    }
}
/// Physical ANSI key positions for shortcuts. Unicode text does not use this map.
pub fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "F1" => 122,
        "F2" => 120,
        "F3" => 99,
        "F4" => 118,
        "F5" => 96,
        "F6" => 97,
        "F7" => 98,
        "F8" => 100,
        "F9" => 101,
        "F10" => 109,
        "F11" => 103,
        "F12" => 111,
        "F13" => 105,
        "F14" => 107,
        "F15" => 113,
        "F16" => 106,
        "F17" => 64,
        "F18" => 79,
        "F19" => 80,
        "F20" => 90,
        "Minus" => 27,
        "Equal" => 24,
        "BracketLeft" => 33,
        "BracketRight" => 30,
        "Backslash" => 42,
        "Semicolon" => 41,
        "Quote" => 39,
        "Comma" => 43,
        "Period" => 47,
        "Slash" => 44,
        "Backquote" => 50,
        "Enter" => 36,
        "Tab" => 48,
        "Escape" => 53,
        "Backspace" => 51,
        "Delete" => 117,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        "Home" => 115,
        "End" => 119,
        "PageUp" => 116,
        "PageDown" => 121,
        "Space" => 49,
        "A" => 0,
        "S" => 1,
        "D" => 2,
        "F" => 3,
        "H" => 4,
        "G" => 5,
        "Z" => 6,
        "X" => 7,
        "C" => 8,
        "V" => 9,
        "B" => 11,
        "Q" => 12,
        "W" => 13,
        "E" => 14,
        "R" => 15,
        "Y" => 16,
        "T" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "9" => 25,
        "7" => 26,
        "8" => 28,
        "0" => 29,
        "O" => 31,
        "U" => 32,
        "I" => 34,
        "P" => 35,
        "L" => 37,
        "J" => 38,
        "K" => 40,
        "N" => 45,
        "M" => 46,
        _ => return None,
    })
}
pub fn modifier_flags(modifiers: &[Modifier]) -> u64 {
    modifiers.iter().fold(0, |flags, m| {
        flags
            | match m {
                Modifier::Shift => 1 << 17,
                Modifier::Control => 1 << 18,
                Modifier::Alt => 1 << 19,
                Modifier::Meta => 1 << 20,
            }
    })
}
/// No split surrogate pairs. Newline/tab remain explicit key events in native code.
pub fn text_units(text: &str) -> Vec<Vec<u16>> {
    text.replace("\r\n", "\n")
        .chars()
        .map(|c| c.encode_utf16(&mut [0; 2]).to_vec())
        .collect()
}
pub fn drag_points(start: Point, end: Point, duration_ms: u64) -> Vec<(Duration, Point)> {
    let frames = (duration_ms * 60).div_ceil(1000);
    (1..=frames)
        .map(|i| {
            let t = i as f64 / frames as f64;
            (
                Duration::from_secs_f64(duration_ms as f64 / 1000.0 * t),
                Point {
                    x: start.x + (end.x - start.x) * t,
                    y: start.y + (end.y - start.y) * t,
                },
            )
        })
        .collect()
}
/// Down/up remain one bounded operation. Always release, even on Stop or panic.
/// Once down was posted, cancellation has an unknown outcome, never retryable.
pub fn held_gesture(
    cancel: &Cancellation,
    down: impl FnOnce(),
    body: impl FnOnce() -> Result<()>,
    up: impl FnOnce(),
) -> Result<()> {
    cancel.check()?;
    struct Release<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for Release<F> {
        fn drop(&mut self) {
            if let Some(up) = self.0.take() {
                up();
            }
        }
    }
    let release = Release(Some(up));
    down();
    let result = body();
    drop(release);
    result.map_err(|_| CuaError::new(ErrorCode::InputUnknown,"Input stopped after dispatch began; release cleanup was sent. Do not replay automatically."))
}
pub fn wait_until(deadline: Instant, cancel: &Cancellation) -> Result<()> {
    loop {
        cancel.check()?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        cancel.wait_cancelled(remaining);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_press_is_a_single_bounded_unmodified_action() {
        for hold_ms in [0, 150, 1000, 2000, 7_200_000] {
            let command = InputCommand::PreparedPress {
                point: Some(Point { x: 12., y: 34. }),
                hold_ms,
                button: MouseButton::Left,
            };
            command.validate().unwrap();
            assert_eq!(command.method(), "background-prepared-press");
        }
        for hold_ms in [7_200_001, u64::MAX] {
            assert!(
                InputCommand::PreparedPress {
                    point: Some(Point { x: 0., y: 0. }),
                    hold_ms,
                    button: MouseButton::Left,
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            serde_json::from_value::<InputCommand>(serde_json::json!({
                "kind":"prepared-press", "point":{"x":0,"y":0}, "holdMs":1000,
                "modifiers":["Meta"]
            }))
            .is_err()
        );
    }
    #[test]
    fn unicode_and_keys() {
        assert_eq!(text_units("a🦀"), vec![vec![97], vec![0xd83e, 0xdd80]]);
        assert_eq!(key_code("Enter"), Some(36));
        assert_eq!(
            modifier_flags(&[Modifier::Meta, Modifier::Shift]),
            (1 << 20) | (1 << 17)
        );
    }
    #[test]
    fn timed_drag_reaches_endpoint() {
        let p = drag_points(Point { x: 0., y: 100. }, Point { x: 120., y: 40. }, 200);
        assert_eq!(p.len(), 12);
        assert_eq!(p.last().unwrap().0, Duration::from_millis(200));
        assert_eq!(p.last().unwrap().1, Point { x: 120., y: 40. });
    }
    #[test]
    fn stop_releases_once_and_no_down_after_pre_cancel() {
        use std::cell::Cell;
        let cancel = Cancellation::default();
        let down = Cell::new(0);
        let up = Cell::new(0);
        let result = held_gesture(
            &cancel,
            || {
                down.set(down.get() + 1);
                cancel.cancel();
            },
            || cancel.check(),
            || up.set(up.get() + 1),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::InputUnknown);
        assert_eq!((down.get(), up.get()), (1, 1));
        assert_eq!(
            held_gesture(&cancel, || down.set(2), || Ok(()), || up.set(2))
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!((down.get(), up.get()), (1, 1));
    }
    #[test]
    fn release_on_body_error() {
        use std::cell::RefCell;
        let events = RefCell::new(vec![]);
        let c = Cancellation::default();
        let result = held_gesture(
            &c,
            || events.borrow_mut().push("down"),
            || Err(CuaError::invalid("stop")),
            || events.borrow_mut().push("up"),
        );
        assert_eq!(*events.borrow(), ["down", "up"]);
        assert_eq!(result.unwrap_err().code, ErrorCode::InputUnknown);
    }
}

#[cfg(test)]
mod preparation_tests {
    use super::*;
    #[test]
    fn only_drag_and_unmodified_pointer_actions_request_preparation() {
        for (value, expected) in [
            (
                serde_json::json!({"kind":"prepared-press","holdMs":150}),
                true,
            ),
            (
                serde_json::json!({"kind":"drag","start":{"x":1,"y":2},"end":{"x":3,"y":4}}),
                true,
            ),
            (
                serde_json::json!({"kind":"timeline","frames":[{"atMs":0,"keyDown":["C"]},{"atMs":50,"keyUp":["C"]}]}),
                false,
            ),
            (
                serde_json::json!({"kind":"timeline","frames":[{"atMs":0,"pointerDown":{"x":1,"y":2}},{"atMs":50,"pointerUp":true}]}),
                true,
            ),
            (
                serde_json::json!({"kind":"timeline","frames":[{"atMs":0,"pointerDown":{"x":1,"y":2},"pointerModifiers":["Meta"]},{"atMs":50,"pointerUp":true}]}),
                false,
            ),
        ] {
            let command: InputCommand = serde_json::from_value(value).unwrap();
            command.validate().unwrap();
            assert_eq!(command.prepares_window(), expected);
        }
    }
}
