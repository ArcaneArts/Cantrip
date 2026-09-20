//! One worker/native round trip for overlapping keys and timed pointer holds.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{key_code, wait_for_offset},
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
    #[serde(default, deserialize_with = "crate::gesture::deserialize_keys")]
    pub key_down: Vec<String>,
    #[serde(default, deserialize_with = "crate::gesture::deserialize_keys")]
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
            "Invalid input timeline: use 1-131072 ordered frames at nonnegative safe-integer millisecond timestamps, supported keys, and balanced down/up events (maximum 16 held keys and one pointer).",
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
            || frame.at_ms > 9_007_199_254_740_991
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
pub use cantrip_interaction::schedule::{Frame, Transition, with_pointer_travel};

pub fn dispatch<I>(
    frames: I,
    count: usize,
    cancel: &Cancellation,
    post: impl FnMut(Transition),
    prepare: impl FnMut(Transition) -> Result<()>,
    wait: impl FnMut(Duration) -> Result<Duration>,
) -> Result<()>
where
    I: IntoIterator,
    I::Item: std::borrow::Borrow<Frame>,
{
    cantrip_interaction::schedule::dispatch(frames, count, || cancel.check(), post, prepare, wait)
        .map_err(|failure| if failure.input_began {
            CuaError::new(ErrorCode::InputUnknown, "Timeline stopped after input began; all held keys/buttons were released. Do not replay it automatically.")
        } else { failure.source })
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
        wait_for_offset(start, at, cancel)?;
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
            Ok,
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
            Ok,
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
            Ok,
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
            Ok,
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
            Ok,
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
        for at_ms in [150_000u64, 7_200_001, 86_400_000, 9_007_199_254_740_991] {
            assert!(
                validate(&parse(
                    serde_json::json!([{"atMs":0,"keyDown":["C"]},{"atMs":at_ms,"keyUp":["C"]}])
                ))
                .is_ok()
            );
        }
        for value in [
            serde_json::json!([{"atMs":0,"keyDown":["C"]}]),
            serde_json::json!([{"atMs":0,"keyUp":["C"]}]),
            serde_json::json!([{"atMs":0,"keyDown":["C","C"]}]),
            serde_json::json!([{"atMs":9007199254740992u64}]),
        ] {
            assert!(validate(&parse(value)).is_err());
        }
    }
}
