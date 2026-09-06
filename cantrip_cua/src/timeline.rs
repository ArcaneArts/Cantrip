//! One worker/native round trip for overlapping keys and timed pointer holds.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{key_code, wait_until},
    target::Point,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputFrame {
    pub at_ms: u64,
    #[serde(default)]
    pub key_down: Vec<String>,
    #[serde(default)]
    pub key_up: Vec<String>,
    #[serde(default)]
    pub pointer_down: Option<Point>,
    #[serde(default)]
    pub pointer_up: bool,
}
pub fn validate(frames: &[InputFrame]) -> Result<()> {
    let invalid = || {
        CuaError::invalid(
            "Invalid input timeline: use 1-256 ordered frames within 10000 ms, supported keys, and balanced down/up events (maximum 16 held keys and one pointer).",
        )
    };
    if frames.is_empty() || frames.len() > 256 {
        return Err(invalid());
    }
    let mut held = BTreeSet::new();
    let mut pointer = false;
    let mut at = 0;
    for frame in frames {
        if frame.at_ms < at
            || frame.at_ms > 10000
            || frame.key_down.len() > 16
            || frame.key_up.len() > 16
        {
            return Err(invalid());
        }
        at = frame.at_ms;
        for key in &frame.key_up {
            if !held.remove(key) {
                return Err(invalid());
            }
        }
        for key in &frame.key_down {
            if key_code(key).is_none() || !held.insert(key.clone()) {
                return Err(invalid());
            }
        }
        if held.len() > 16 {
            return Err(invalid());
        }
        if frame.pointer_up {
            if !pointer {
                return Err(invalid());
            }
            pointer = false;
        }
        if let Some(p) = frame.pointer_down {
            if pointer || !p.x.is_finite() || !p.y.is_finite() || p.x < 0.0 || p.y < 0.0 {
                return Err(invalid());
            }
            pointer = true;
        }
    }
    if !held.is_empty() || pointer {
        return Err(invalid());
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Down(usize),
    Up(usize),
}
pub struct Frame {
    pub at: Duration,
    pub events: Vec<Transition>,
}
/// Every Down owns a prepared matching Up. Use the same executor with fake
/// events in unit tests; production posts native events through the callback.
pub fn dispatch(
    frames: &[Frame],
    count: usize,
    cancel: &Cancellation,
    post: impl FnMut(Transition),
    mut wait: impl FnMut(Duration) -> Result<()>,
) -> Result<()> {
    struct Held<F: FnMut(Transition)> {
        keys: Vec<bool>,
        post: F,
    }
    impl<F: FnMut(Transition)> Drop for Held<F> {
        fn drop(&mut self) {
            for i in (0..self.keys.len()).rev() {
                if self.keys[i] {
                    self.keys[i] = false;
                    (self.post)(Transition::Up(i));
                }
            }
        }
    }
    let mut held = Held {
        keys: vec![false; count],
        post,
    };
    let mut began = false;
    let mut result = Ok(());
    for frame in frames {
        result = wait(frame.at).and_then(|_| cancel.check());
        if result.is_err() {
            break;
        }
        // No waits, RPCs, authority lookups or snapshots inside a frame.
        for &event in &frame.events {
            if let Err(error) = cancel.check() {
                result = Err(error);
                break;
            }
            match event {
                Transition::Down(i) => held.keys[i] = true,
                Transition::Up(i) => held.keys[i] = false,
            }
            began = true;
            (held.post)(event);
        }
        if result.is_err() {
            break;
        }
    }
    drop(held);
    result.map_err(|error| {
        if began {
            CuaError::new(ErrorCode::InputUnknown, "Timeline stopped after input began; all held keys/buttons were released. Do not replay it automatically.")
        } else {
            error
        }
    })
}
pub fn run(
    frames: &[Frame],
    count: usize,
    cancel: &Cancellation,
    post: impl FnMut(Transition),
) -> Result<()> {
    let start = Instant::now();
    dispatch(frames, count, cancel, post, |at| {
        wait_until(start + at, cancel)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn chord_downs_precede_all_ups_and_one_wait_per_frame() {
        let frames = [
            Frame {
                at: Duration::ZERO,
                events: vec![
                    Transition::Down(0),
                    Transition::Down(1),
                    Transition::Down(2),
                ],
            },
            Frame {
                at: Duration::from_millis(500),
                events: vec![Transition::Up(0), Transition::Up(1), Transition::Up(2)],
            },
        ];
        let events = RefCell::new(vec![]);
        let waits = RefCell::new(vec![]);
        dispatch(
            &frames,
            3,
            &Cancellation::default(),
            |e| events.borrow_mut().push(e),
            |at| {
                waits.borrow_mut().push(at);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *events.borrow(),
            [
                Transition::Down(0),
                Transition::Down(1),
                Transition::Down(2),
                Transition::Up(0),
                Transition::Up(1),
                Transition::Up(2)
            ]
        );
        assert_eq!(
            *waits.borrow(),
            [Duration::ZERO, Duration::from_millis(500)]
        );
    }
    #[test]
    fn stop_between_chord_keys_releases_only_dispatched_downs() {
        let c = Cancellation::default();
        let events = RefCell::new(vec![]);
        let result = dispatch(
            &[Frame {
                at: Duration::ZERO,
                events: vec![Transition::Down(0), Transition::Down(1)],
            }],
            2,
            &c,
            |e| {
                events.borrow_mut().push(e);
                c.cancel();
            },
            |_| Ok(()),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::InputUnknown);
        assert_eq!(*events.borrow(), [Transition::Down(0), Transition::Up(0)]);
    }
    #[test]
    fn validates_balanced_overlapping_notes() {
        let parse = |v| serde_json::from_value::<Vec<InputFrame>>(v).unwrap();
        assert!(validate(&parse(serde_json::json!([{"atMs":0,"keyDown":["C","B","M"]},{"atMs":500,"keyUp":["C","B","M"]}]))).is_ok());
        for value in [
            serde_json::json!([{"atMs":0,"keyDown":["C"]}]),
            serde_json::json!([{"atMs":0,"keyUp":["C"]}]),
            serde_json::json!([{"atMs":0,"keyDown":["C","C"]}]),
            serde_json::json!([{"atMs":10001}]),
        ] {
            assert!(validate(&parse(value)).is_err());
        }
    }
}
