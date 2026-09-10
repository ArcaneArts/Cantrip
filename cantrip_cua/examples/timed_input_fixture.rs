//! Test-only stdio host: the production scheduler runs real time against fake events.
//! Never built into the shipped helper, never opens applications or posts OS input.
use cantrip_cua::{
    backend::{Capture, CaptureBackend, FakeBackend},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::InputCommand,
    input::InputReceipt,
    runtime::run,
    target::{Point, Target},
    timeline::{self, Frame, InputFrame, Transition},
};
use std::time::Duration;

fn play(
    frames: &[InputFrame],
    cancel: &Cancellation,
    mut post: impl FnMut(Transition, Option<Point>),
) -> Result<()> {
    timeline::validate(frames)?;
    if frames
        .iter()
        .any(|f| !f.key_down.is_empty() || !f.key_up.is_empty())
    {
        return Err(CuaError::new(
            ErrorCode::Unsupported,
            "Fixture supports pointer timelines only.",
        ));
    }
    let mut points = Vec::new();
    let mut held = None;
    let scheduled: Vec<_> = frames
        .iter()
        .map(|f| {
            let mut events = Vec::new();
            if f.pointer_up {
                events.push(Transition::Up(
                    held.take().expect("validated pointer release"),
                ));
            }
            if let Some(point) = f.pointer_down {
                let index = points.len();
                points.push(point);
                held = Some(index);
                events.push(Transition::Down(index));
            }
            Frame {
                at: Duration::from_millis(f.at_ms),
                events,
            }
        })
        .collect();
    timeline::run(
        scheduled,
        points.len(),
        cancel,
        |event| {
            let point = match event {
                Transition::Down(i) | Transition::Up(i) => Some(points[i]),
                Transition::Move(point) => Some(point),
            };
            post(event, point);
        },
        |_| Ok(()),
    )
}

struct TimedInputFixture;
impl CaptureBackend for TimedInputFixture {
    fn name(&self) -> &'static str {
        "fake-timed-input"
    }
    fn available(&self) -> bool {
        true
    }
    fn native_input(&self) -> bool {
        true
    }
    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        FakeBackend.targets(cancel)
    }
    fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
        FakeBackend.capture(target, cancel)
    }
    fn perform(
        &mut self,
        _session: &str,
        target: &Target,
        command: &InputCommand,
        mut position: Point,
        cancel: &Cancellation,
        progress: &mut dyn FnMut(Point),
    ) -> Result<(Target, InputReceipt)> {
        let InputCommand::Timeline { frames } = command else {
            return Err(CuaError::new(
                ErrorCode::Unsupported,
                "Fixture supports timelines only.",
            ));
        };
        play(frames, cancel, |event, point| {
            if let Transition::Down(_) = event {
                position = point.expect("pointer transition");
                progress(position);
            }
        })?;
        Ok((
            target.clone(),
            InputReceipt {
                control: None,
                method: "background-timeline",
                activation: frames
                    .iter()
                    .any(|f| f.pointer_down.is_some() && f.pointer_modifiers.is_empty()),
                outcome: "dispatched",
                position: Some(position),
                global_position: Some(target.bounds.to_global(position)?),
                effects: None,
                window_delivery: Some("unverified"),
            },
        ))
    }
}

fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--backend", "fake"] {
        eprintln!("Test fixture requires --backend fake.");
        std::process::exit(2);
    }
    if run(TimedInputFixture, std::io::stdin(), std::io::stdout()).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frames() -> Vec<InputFrame> {
        serde_json::from_value(serde_json::json!([
            {"atMs":0,"pointerDown":{"x":20,"y":30}},
            {"atMs":25,"pointerUp":true}
        ]))
        .unwrap()
    }
    #[test]
    fn real_scheduler_waits_and_posts_exact_balanced_events() {
        let start = std::time::Instant::now();
        let mut events = Vec::new();
        play(&frames(), &Cancellation::default(), |event, point| {
            events.push((event, point))
        })
        .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(25));
        assert_eq!(
            events.iter().map(|(event, _)| *event).collect::<Vec<_>>(),
            [Transition::Down(0), Transition::Up(0)]
        );
        assert!(
            events
                .iter()
                .all(|(_, point)| *point == Some(Point { x: 20.0, y: 30.0 }))
        );
    }
    #[test]
    fn cancellation_releases_held_input_without_waiting_for_the_end() {
        let cancel = Cancellation::default();
        let mut frames = frames();
        frames[1].at_ms = 150000;
        let mut events = Vec::new();
        let start = std::time::Instant::now();
        let error = play(&frames, &cancel, |event, _| {
            events.push(event);
            if matches!(event, Transition::Down(_)) {
                cancel.cancel();
            }
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnknown);
        assert_eq!(events, [Transition::Down(0), Transition::Up(0)]);
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn invalid_or_unsupported_input_posts_nothing() {
        let mut unbalanced = frames();
        unbalanced.pop();
        assert!(
            play(&unbalanced, &Cancellation::default(), |_, _| panic!(
                "unexpected post"
            ))
            .is_err()
        );
        let keyboard: Vec<InputFrame> = serde_json::from_value(serde_json::json!([
            {"atMs":0,"keyDown":["C"]},{"atMs":25,"keyUp":["C"]}
        ]))
        .unwrap();
        assert!(
            play(&keyboard, &Cancellation::default(), |_, _| panic!(
                "unexpected post"
            ))
            .is_err()
        );
    }
}
