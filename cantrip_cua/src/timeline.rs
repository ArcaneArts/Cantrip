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
    /// Modifiers belong to this pointer-down and its matching up, not keyboard keys.
    #[serde(default)]
    pub pointer_modifiers: Vec<crate::gesture::Modifier>,
    #[serde(default)]
    pub pointer_button: Option<crate::gesture::MouseButton>,
    /// Event-local flags retained for matching key ups, including Stop cleanup.
    #[serde(default)]
    pub key_modifiers: Vec<crate::gesture::Modifier>,
}
pub fn validate(frames: &[InputFrame]) -> Result<()> {
    let invalid = || {
        CuaError::invalid(
            "Invalid input timeline: use 1-131072 ordered frames within 7200000 ms, supported keys, and balanced down/up events (maximum 16 held keys and one pointer).",
        )
    };
    if frames.is_empty() || frames.len() > 131072 {
        return Err(invalid());
    }
    let mut held = BTreeSet::new();
    let mut pointer = false;
    let mut at = 0;
    for frame in frames {
        if frame.at_ms < at
            || frame.at_ms > 7_200_000
            || frame.key_down.len() > 16
            || frame.key_up.len() > 16
            || (frame.pointer_button.is_some() && frame.pointer_down.is_none())
            || (!frame.key_modifiers.is_empty() && frame.key_down.is_empty())
            || !crate::gesture::valid_modifiers(&frame.key_modifiers)
            || frame.pointer_modifiers.len() > 4
            || (!frame.pointer_modifiers.is_empty() && frame.pointer_down.is_none())
            || frame
                .pointer_modifiers
                .iter()
                .enumerate()
                .any(|(i, m)| frame.pointer_modifiers[..i].contains(m))
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
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transition {
    Down(usize),
    Up(usize),
    /// Custom-cursor presentation only; never a native input event.
    Move(Point),
}
#[derive(Clone, Debug)]
pub struct Frame {
    pub at: Duration,
    pub events: Vec<Transition>,
}
/// Merge lazy visual samples into the original timeline. Only button-up gaps
/// can contain travel; actual events keep their original times and order.
pub fn with_pointer_travel(
    frames: Vec<Frame>,
    pointer_points: &[Option<Point>],
    start: Point,
) -> impl Iterator<Item = Frame> + use<> {
    let clicks: Vec<Point> = frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter_map(|e| {
            if let Transition::Down(i) = e {
                pointer_points[*i]
            } else {
                None
            }
        })
        .collect();
    let mut spans = Vec::with_capacity(clicks.len());
    let mut cursor = start;
    let mut previous = None;
    let mut released_at = Duration::ZERO;
    let mut click = 0;
    for frame in &frames {
        for &event in &frame.events {
            match event {
                Transition::Up(i) if pointer_points[i].is_some() => released_at = frame.at,
                Transition::Down(i) => {
                    if let Some(end) = pointer_points[i] {
                        if let Some(span) = crate::cursor_motion::TimedSpline::new(
                            previous,
                            cursor,
                            end,
                            clicks.get(click + 1).copied(),
                            released_at,
                            frame.at,
                        ) {
                            spans.push(span);
                        }
                        previous = Some(cursor);
                        cursor = end;
                        click += 1;
                    }
                }
                _ => {}
            }
        }
    }
    let mut inputs = frames.into_iter().peekable();
    let mut visual = spans.into_iter().flatten().peekable();
    std::iter::from_fn(move || {
        if let Some(&(at, point)) = visual.peek()
            && inputs.peek().is_none_or(|input| at <= input.at)
        {
            visual.next();
            return Some(Frame {
                at,
                events: vec![Transition::Move(point)],
            });
        }
        inputs.next()
    })
}
/// Every Down owns a prepared matching Up. Use the same executor with fake
/// events in unit tests; production posts native events through the callback.
pub fn dispatch<I>(
    frames: I,
    count: usize,
    cancel: &Cancellation,
    post: impl FnMut(Transition),
    mut prepare: impl FnMut(Transition) -> Result<()>,
    mut wait: impl FnMut(Duration) -> Result<Duration>,
) -> Result<()>
where
    I: IntoIterator,
    I::Item: std::borrow::Borrow<Frame>,
{
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
        let frame = std::borrow::Borrow::<Frame>::borrow(&frame);
        let elapsed = match wait(frame.at).and_then(|elapsed| cancel.check().map(|_| elapsed)) {
            Ok(elapsed) => elapsed,
            Err(error) => {
                result = Err(error);
                break;
            }
        };
        // Obsolete cosmetic samples must not amplify a slow renderer's backlog.
        // Keep every native Down/Up and on-time travel sample, including Stop.
        let late_visual = elapsed.saturating_sub(frame.at) > Duration::from_millis(16);
        // No waits, RPCs, authority lookups or snapshots inside a frame.
        for &event in &frame.events {
            if late_visual && matches!(event, Transition::Move(_)) {
                continue;
            }
            if let Err(error) = cancel.check() {
                result = Err(error);
                break;
            }
            // Preparation can fail before Down. Arm its cleanup only after
            // successful preparation, then post without an intervening wait.
            if let Err(error) = prepare(event) {
                result = Err(error);
                break;
            }
            match event {
                Transition::Down(i) => {
                    held.keys[i] = true;
                    began = true;
                }
                Transition::Up(i) => {
                    held.keys[i] = false;
                    began = true;
                }
                Transition::Move(_) => {}
            }
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
pub fn run<I>(
    frames: I,
    count: usize,
    cancel: &Cancellation,
    post: impl FnMut(Transition),
    prepare: impl FnMut(Transition) -> Result<()>,
) -> Result<()>
where
    I: IntoIterator,
    I::Item: std::borrow::Borrow<Frame>,
{
    let start = Instant::now();
    dispatch(frames, count, cancel, post, prepare, |at| {
        wait_until(start + at, cancel)?;
        Ok(start.elapsed())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn extended_buttons_and_keyboard_flags_validate_before_dispatch() {
        for button in ["left", "right", "middle", "back", "forward"] {
            let frames: Vec<InputFrame> = serde_json::from_value(serde_json::json!([
                {"atMs":0,"pointerDown":{"x":1,"y":2},"pointerButton":button,"keyDown":["F12"],"keyModifiers":["Meta","Shift"]},
                {"atMs":100,"pointerUp":true,"keyUp":["F12"]}
            ])).unwrap();
            validate(&frames).unwrap();
        }
        for value in [
            serde_json::json!([{"atMs":0,"pointerButton":"back"}]),
            serde_json::json!([{"atMs":0,"keyModifiers":["Meta"]}]),
            serde_json::json!([{"atMs":0,"keyDown":["A"],"keyModifiers":["Meta","Meta"]},{"atMs":1,"keyUp":["A"]}]),
        ] {
            let frames: Vec<InputFrame> = serde_json::from_value(value).unwrap();
            assert!(validate(&frames).is_err());
        }
    }
    #[test]
    fn piano_travel_fits_release_gaps_without_retiming_input_or_dragging() {
        let p = Point {
            x: 1244.0,
            y: 530.0,
        };
        let q = Point {
            x: 1221.0,
            y: 420.0,
        };
        let frames = vec![
            Frame {
                at: Duration::ZERO,
                events: vec![Transition::Down(0)],
            },
            Frame {
                at: Duration::from_millis(105),
                events: vec![Transition::Up(0)],
            },
            Frame {
                at: Duration::from_millis(150),
                events: vec![Transition::Down(2)],
            },
            Frame {
                at: Duration::from_millis(220),
                events: vec![Transition::Down(1)],
            },
            Frame {
                at: Duration::from_millis(325),
                events: vec![Transition::Up(1), Transition::Up(2)],
            },
        ];
        let expected: Vec<_> = frames
            .iter()
            .flat_map(|f| f.events.iter().map(move |e| (f.at, *e)))
            .collect();
        let schedule: Vec<_> =
            with_pointer_travel(frames, &[Some(p), Some(q), None], Point { x: 0.0, y: 0.0 })
                .collect();
        let points: Vec<_> = schedule
            .iter()
            .flat_map(|f| f.events.iter())
            .filter_map(|e| {
                if let Transition::Move(p) = e {
                    Some(*p)
                } else {
                    None
                }
            })
            .collect();
        assert!(!points.is_empty());
        assert_eq!(points.last(), Some(&q));
        let inputs: Vec<_> = schedule
            .iter()
            .flat_map(|f| {
                f.events
                    .iter()
                    .filter(|e| !matches!(e, Transition::Move(_)))
                    .map(move |e| (f.at, *e))
            })
            .collect();
        assert_eq!(inputs, expected);
        let mut last = Duration::ZERO;
        for frame in &schedule {
            assert!(frame.at >= last);
            last = frame.at;
            for e in &frame.events {
                if matches!(e, Transition::Move(_)) {
                    assert!(frame.at > Duration::from_millis(105));
                    assert!(frame.at <= Duration::from_millis(220));
                }
            }
        }
        let flat: Vec<_> = schedule
            .iter()
            .flat_map(|f| f.events.iter().copied())
            .collect();
        let down = flat.iter().position(|e| *e == Transition::Down(1)).unwrap();
        assert!(matches!(flat[down - 1], Transition::Move(_)));
    }
    #[test]
    fn no_gap_or_keyboard_only_timeline_adds_no_travel() {
        let point = Point { x: 100.0, y: 200.0 };
        let frames = vec![Frame {
            at: Duration::ZERO,
            events: vec![
                Transition::Down(0),
                Transition::Up(0),
                Transition::Down(1),
                Transition::Up(1),
            ],
        }];
        let schedule: Vec<_> = with_pointer_travel(
            frames,
            &[Some(point), Some(Point { x: 300.0, y: 200.0 })],
            point,
        )
        .collect();
        assert!(
            schedule
                .iter()
                .flat_map(|f| &f.events)
                .all(|e| !matches!(e, Transition::Move(_)))
        );
        let frames = vec![Frame {
            at: Duration::from_millis(100),
            events: vec![Transition::Down(0)],
        }];
        let frames: Vec<_> = with_pointer_travel(frames, &[None], point).collect();
        assert_eq!(frames.len(), 1);
    }
    #[test]
    fn lazy_planned_travel_cancels_and_releases_only_actual_held_input() {
        let cancel = Cancellation::default();
        let end = Point { x: 500.0, y: 200.0 };
        let schedule = with_pointer_travel(
            vec![
                Frame {
                    at: Duration::ZERO,
                    events: vec![Transition::Down(0)],
                },
                Frame {
                    at: Duration::from_secs(7200),
                    events: vec![Transition::Up(0), Transition::Down(1), Transition::Up(1)],
                },
            ],
            &[None, Some(end)],
            Point::default(),
        );
        let posted = RefCell::new(vec![]);
        let error = dispatch(
            schedule,
            2,
            &cancel,
            |e| {
                posted.borrow_mut().push(e);
                if matches!(e, Transition::Move(_)) {
                    cancel.cancel();
                }
            },
            |_| Ok(()),
            |at| Ok(at),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnknown);
        let posted = posted.into_inner();
        assert_eq!(posted.len(), 3);
        assert_eq!(posted[0], Transition::Down(0));
        assert!(matches!(posted[1], Transition::Move(_)));
        assert_eq!(posted[2], Transition::Up(0));
    }
    #[test]
    fn executor_reaches_each_planned_click_without_retiming_native_events() {
        let start = Point { x: 10., y: 10. };
        let end = Point { x: 200., y: 300. };
        let frames = vec![
            Frame {
                at: Duration::from_millis(500),
                events: vec![Transition::Down(0)],
            },
            Frame {
                at: Duration::from_millis(600),
                events: vec![Transition::Up(0)],
            },
            Frame {
                at: Duration::from_millis(1600),
                events: vec![Transition::Down(1)],
            },
            Frame {
                at: Duration::from_millis(1700),
                events: vec![Transition::Up(1)],
            },
        ];
        let expected: Vec<_> = frames
            .iter()
            .flat_map(|f| f.events.iter().map(move |e| (f.at, *e)))
            .collect();
        let now = std::cell::Cell::new(Duration::ZERO);
        let cursor = std::cell::Cell::new(Point::default());
        let native = RefCell::new(vec![]);
        dispatch(
            with_pointer_travel(frames, &[Some(start), Some(end)], Point::default()),
            2,
            &Cancellation::default(),
            |e| {
                if let Transition::Move(p) = e {
                    cursor.set(p);
                } else {
                    if let Transition::Down(i) = e {
                        assert_eq!(cursor.get(), [start, end][i]);
                    }
                    native.borrow_mut().push((now.get(), e));
                }
            },
            |_| Ok(()),
            |at| {
                now.set(at);
                Ok(at)
            },
        )
        .unwrap();
        assert_eq!(native.into_inner(), expected);
    }
    #[test]
    fn cancelled_visual_travel_is_not_reported_as_input_and_has_no_release() {
        let cancel = Cancellation::default();
        let events = RefCell::new(vec![]);
        let result = dispatch(
            &[Frame {
                at: Duration::ZERO,
                events: vec![
                    Transition::Move(Point { x: 0.0, y: 0.0 }),
                    Transition::Down(0),
                ],
            }],
            1,
            &cancel,
            |e| {
                events.borrow_mut().push(e);
                cancel.cancel();
            },
            |_| Ok(()),
            |at| Ok(at),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(
            *events.borrow(),
            vec![Transition::Move(Point { x: 0.0, y: 0.0 })]
        );
    }
    #[test]
    fn slow_presentation_skips_overdue_travel_but_keeps_all_native_input() {
        let events = RefCell::new(vec![]);
        let frames = [
            Frame {
                at: Duration::ZERO,
                events: vec![Transition::Move(Point { x: 0.0, y: 0.0 })],
            },
            Frame {
                at: Duration::from_millis(10),
                events: vec![
                    Transition::Move(Point { x: 1.0, y: 0.0 }),
                    Transition::Down(0),
                ],
            },
            Frame {
                at: Duration::from_millis(20),
                events: vec![Transition::Up(0)],
            },
            Frame {
                at: Duration::from_millis(100),
                events: vec![
                    Transition::Move(Point { x: 2.0, y: 0.0 }),
                    Transition::Down(1),
                    Transition::Up(1),
                ],
            },
        ];
        dispatch(
            &frames,
            2,
            &Cancellation::default(),
            |e| events.borrow_mut().push(e),
            |_| Ok(()),
            |at| Ok(at.max(Duration::from_millis(50))),
        )
        .unwrap();
        assert_eq!(
            *events.borrow(),
            vec![
                Transition::Down(0),
                Transition::Up(0),
                Transition::Move(Point { x: 2.0, y: 0.0 }),
                Transition::Down(1),
                Transition::Up(1)
            ]
        );
    }
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
            |_| Ok(()),
            |at| {
                waits.borrow_mut().push(at);
                Ok(at)
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
            |at| Ok(at),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::InputUnknown);
        assert_eq!(*events.borrow(), [Transition::Down(0), Transition::Up(0)]);
    }
    #[test]
    fn preparation_failure_releases_prior_keys_but_not_an_unposted_pointer() {
        let calls = RefCell::new(vec![]);
        let frames = [Frame {
            at: Duration::ZERO,
            events: vec![
                Transition::Down(0),
                Transition::Down(1),
                Transition::Down(2),
            ],
        }];
        let error = dispatch(
            &frames,
            3,
            &Cancellation::default(),
            |e| calls.borrow_mut().push(format!("post {e:?}")),
            |e| {
                calls.borrow_mut().push(format!("prepare {e:?}"));
                if e == Transition::Down(1) {
                    return Err(CuaError::new(
                        ErrorCode::Unsupported,
                        "preparation unavailable",
                    ));
                }
                Ok(())
            },
            |at| Ok(at),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnknown);
        assert_eq!(
            *calls.borrow(),
            [
                "prepare Down(0)",
                "post Down(0)",
                "prepare Down(1)",
                "post Up(0)",
            ]
        );
    }
    #[test]
    fn preparation_runs_at_each_scheduled_down_without_extra_waits() {
        let calls = RefCell::new(vec![]);
        let frames = [Frame {
            at: Duration::from_millis(500),
            events: vec![
                Transition::Down(0),
                Transition::Up(0),
                Transition::Down(1),
                Transition::Up(1),
            ],
        }];
        dispatch(
            &frames,
            2,
            &Cancellation::default(),
            |e| calls.borrow_mut().push(format!("post {e:?}")),
            |e| {
                if matches!(e, Transition::Down(_)) {
                    calls.borrow_mut().push(format!("prepare {e:?}"));
                }
                Ok(())
            },
            |at| {
                calls.borrow_mut().push(format!("wait {}", at.as_millis()));
                Ok(at)
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            [
                "wait 500",
                "prepare Down(0)",
                "post Down(0)",
                "post Up(0)",
                "prepare Down(1)",
                "post Down(1)",
                "post Up(1)"
            ]
        );
        let error = dispatch(
            &frames,
            2,
            &Cancellation::default(),
            |_| panic!("no input or cleanup before first down"),
            |_| Err(CuaError::new(ErrorCode::Unsupported, "unavailable")),
            |at| Ok(at),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);
    }
    #[test]
    fn pointer_modifiers_require_a_down_and_are_unique() {
        let parse = |v| serde_json::from_value::<Vec<InputFrame>>(v).unwrap();
        let frames = parse(serde_json::json!([
            {"atMs":0,"pointerDown":{"x":10,"y":20},"pointerModifiers":["Meta"],"keyDown":["C"]},
            {"atMs":150,"pointerUp":true,"keyUp":["C"]}
        ]));
        assert!(validate(&frames).is_ok());
        assert!(frames[1].pointer_modifiers.is_empty());
        for value in [
            serde_json::json!([{"atMs":0,"pointerModifiers":["Meta"]}]),
            serde_json::json!([{"atMs":0,"pointerDown":{"x":10,"y":20},"pointerModifiers":["Meta","Meta"]},{"atMs":1,"pointerUp":true}]),
            serde_json::json!([{"atMs":0,"pointerDown":{"x":10,"y":20}},{"atMs":1,"pointerUp":true,"pointerModifiers":["Meta"]}]),
        ] {
            assert!(validate(&parse(value)).is_err());
        }
        assert!(
            serde_json::from_value::<Vec<InputFrame>>(serde_json::json!([
                {"atMs":0,"pointerDown":{"x":10,"y":20},"pointerModifiers":["Bogus"]}
            ]))
            .is_err()
        );
    }
    #[test]
    fn validates_balanced_overlapping_notes() {
        let parse = |v| serde_json::from_value::<Vec<InputFrame>>(v).unwrap();
        assert!(validate(&parse(serde_json::json!([{"atMs":0,"keyDown":["C","B","M"]},{"atMs":500,"keyUp":["C","B","M"]}]))).is_ok());
        for value in [
            serde_json::json!([{"atMs":0,"keyDown":["C"]}]),
            serde_json::json!([{"atMs":0,"keyUp":["C"]}]),
            serde_json::json!([{"atMs":0,"keyDown":["C","C"]}]),
            serde_json::json!([{"atMs":7200001}]),
        ] {
            assert!(validate(&parse(value)).is_err());
        }
    }
}
