//! CUA macro adapter. Native resources and dispatch belong to the shared host's
//! concrete backend; CUA keeps validation, cancellation and wire receipts here.
use super::input_backend::{Control, Destination, NativeInput, Packet};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{InputCommand, MouseButton, drag_points, key_code, text_units, wait_until},
    input::InputReceipt,
    target::{Point, Target},
};
use cantrip_interaction::{
    host::{InputBackend, InputFailure, InputHost, Prepared},
    input::InputEvent,
    ownership::{Participant, TargetIdentity},
    schedule::{Frame, Transition, dispatch_fallible, with_pointer_travel},
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

struct Pair {
    prepared: Option<Prepared<Control, Packet>>,
    control: Control,
    point: Option<Point>,
}
impl Pair {
    fn new(prepared: Prepared<Control, Packet>) -> Self {
        let Prepared::Down {
            control, packet, ..
        } = &prepared
        else {
            unreachable!("compiled Down")
        };
        Self {
            control: control.clone(),
            point: packet.point,
            prepared: Some(prepared),
        }
    }
}
fn failure(error: InputFailure<CuaError>) -> CuaError {
    use cantrip_interaction::host::PostFailure;
    match error {
        InputFailure::Prepare(error) => error,
        InputFailure::Invalid(error) => CuaError::invalid(error.to_string()),
        InputFailure::Ownership(error) => CuaError::invalid(format!(
            "Input ownership rejected the operation: {error:?}. No input was posted."
        )),
        InputFailure::Post {
            failure: PostFailure::NotDispatched(error),
            cleanup,
        } if cleanup.is_empty() => error,
        InputFailure::Post { .. } => unknown(),
    }
}
fn unknown() -> CuaError {
    CuaError::new(
        ErrorCode::InputUnknown,
        "Input stopped after dispatch may have begun; participant-scoped release cleanup was attempted. Do not replay automatically.",
    )
}
struct Session {
    host: InputHost<NativeInput>,
    owner: Participant,
    identity: TargetIdentity,
    sequence: u64,
}
impl Session {
    fn new(backend: NativeInput, destination: Destination) -> Self {
        let identity = TargetIdentity {
            id: destination.target.id.clone(),
            generation: destination.target.generation,
        };
        let domain = format!("process:{:?}", destination.target.process_id);
        let mut host = InputHost::new(backend, 1, 17);
        let owner = host
            .open(identity.clone(), domain, destination)
            .expect("new input host capacity");
        Self {
            host,
            owner,
            identity,
            sequence: 0,
        }
    }
    fn prepared(&mut self, packet: Prepared<Control, Packet>) -> Result<()> {
        self.sequence += 1;
        self.host
            .submit_prepared(self.owner, &self.identity, self.sequence, packet)
            .map(|_| ())
            .map_err(failure)
    }
    fn event(&mut self, event: InputEvent) -> Result<()> {
        self.sequence += 1;
        self.host
            .submit(self.owner, &self.identity, self.sequence, &event)
            .map(|_| ())
            .map_err(failure)
    }
    fn close(&mut self) -> Result<()> {
        if self.host.close(self.owner).is_empty() {
            Ok(())
        } else {
            Err(unknown())
        }
    }
}
fn run(
    session: &mut Session,
    frames: impl IntoIterator<Item = Frame>,
    pairs: &mut [Pair],
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point, bool),
    final_position: &mut Point,
    notify_release: bool,
) -> Result<()> {
    let started = Instant::now();
    let mut began = false;
    dispatch_fallible(
        frames,
        pairs.len(),
        || cancel.check(),
        |transition| {
            let (i, down) = match transition {
                Transition::Down(i) => (i, true),
                Transition::Up(i) => (i, false),
                Transition::Move(point) => {
                    *final_position = point;
                    progress(point, false);
                    return Ok(());
                }
            };
            let pair = &mut pairs[i];
            let packet = if down {
                pair.prepared.take().expect("single scheduled Down")
            } else {
                Prepared::Up {
                    control: pair.control.clone(),
                    packet: None,
                }
            };
            session.prepared(packet)?;
            began = true;
            if let Some(point) = pair.point {
                *final_position = point;
                if down || notify_release {
                    progress(point, true);
                }
            }
            Ok(())
        },
        |_| Ok(()),
        |at| {
            wait_until(started + at, cancel)?;
            Ok(started.elapsed())
        },
    )
    .map_err(|error| if began { unknown() } else { error.source })
}
pub(super) fn perform(
    participant: &str,
    target: &Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point, bool),
) -> Result<(Target, InputReceipt)> {
    command.validate()?;
    // Focus reports updated geometry. It is never an implicit input fallback.
    if matches!(command, InputCommand::Focus {}) {
        let mut current = target.clone();
        current.bounds = super::accessibility::request_focus(target, cancel)?;
        return Ok((
            current,
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
    let destination = Destination {
        target: target.clone(),
        participant: participant.to_owned(),
        position,
    };
    let mut backend = NativeInput::new(cancel.clone());
    let mut final_position = position;
    let mut pairs = vec![];
    let mut frames = vec![];
    match command {
        InputCommand::PreparedPress {
            hold_ms, button, ..
        } => {
            pairs.push(Pair::new(backend.prepare(
                &destination,
                &InputEvent::PointerDown {
                    point: position,
                    button: *button,
                    modifiers: vec![],
                },
                std::iter::empty(),
            )?));
            frames.push(Frame {
                at: Duration::ZERO,
                events: vec![Transition::Down(0)],
            });
            frames.push(Frame {
                at: Duration::from_millis(*hold_ms),
                events: vec![Transition::Up(0)],
            });
        }
        InputCommand::Timeline { frames: input } => {
            let mut keys = HashMap::new();
            let mut pointer = None;
            for frame in input {
                cancel.check()?;
                let mut events = vec![];
                for key in &frame.key_up {
                    events.push(Transition::Up(keys.remove(key).expect("validated key up")));
                }
                if frame.pointer_up {
                    events.push(Transition::Up(
                        pointer.take().expect("validated pointer up"),
                    ));
                }
                for key in &frame.key_down {
                    let i = pairs.len();
                    pairs.push(Pair::new(backend.prepare(
                        &destination,
                        &InputEvent::KeyDown {
                            key: key.clone(),
                            modifiers: frame.key_modifiers.clone(),
                            repeat: false,
                        },
                        std::iter::empty(),
                    )?));
                    keys.insert(key.clone(), i);
                    events.push(Transition::Down(i));
                }
                if let Some(point) = frame.pointer_down {
                    let i = pairs.len();
                    pairs.push(Pair::new(backend.prepare(
                        &destination,
                        &InputEvent::PointerDown {
                            point,
                            button: frame.pointer_button.unwrap_or_default(),
                            modifiers: frame.pointer_modifiers.clone(),
                        },
                        std::iter::empty(),
                    )?));
                    pointer = Some(i);
                    events.push(Transition::Down(i));
                }
                frames.push(Frame {
                    at: Duration::from_millis(frame.at_ms),
                    events,
                });
            }
        }
        InputCommand::Text { text } => {
            for unit in text_units(text) {
                cancel.check()?;
                let (key, text) = match unit.as_slice() {
                    [10] | [13] => (36, vec![]),
                    [9] => (48, vec![]),
                    _ => (0, unit),
                };
                pairs.push(Pair::new(backend.key_pair(
                    &destination,
                    key,
                    &text,
                    &[],
                )?));
            }
        }
        InputCommand::Key { key, modifiers } => {
            pairs.push(Pair::new(backend.key_pair(
                &destination,
                key_code(key).expect("validated key"),
                &[],
                modifiers,
            )?));
        }
        InputCommand::Drag { start, end, .. } => {
            target.bounds.to_global(*end)?;
            pairs.push(Pair::new(backend.prepare(
                &destination,
                &InputEvent::PointerDown {
                    point: *start,
                    button: MouseButton::Left,
                    modifiers: vec![],
                },
                std::iter::empty(),
            )?));
        }
        _ => {}
    }
    let mut session = Session::new(backend, destination);
    let result: Result<()> = (|| {
        match command {
            InputCommand::PreparedPress { .. } | InputCommand::Timeline { .. } => {
                let points: Vec<_> = pairs.iter().map(|p| p.point).collect();
                run(
                    &mut session,
                    with_pointer_travel(frames, &points, position),
                    &mut pairs,
                    cancel,
                    progress,
                    &mut final_position,
                    matches!(command, InputCommand::Timeline { .. }),
                )?;
            }
            InputCommand::Text { .. } | InputCommand::Key { .. } => {
                let mut began = false;
                for pair in &mut pairs {
                    let result = (|| {
                        session.prepared(pair.prepared.take().unwrap())?;
                        began = true;
                        wait_until(Instant::now() + Duration::from_millis(2), cancel)?;
                        session.prepared(Prepared::Up {
                            control: pair.control.clone(),
                            packet: None,
                        })
                    })();
                    result.map_err(|error| if began { unknown() } else { error })?;
                }
            }
            InputCommand::Drag {
                start,
                end,
                duration_ms,
            } => {
                session.prepared(pairs[0].prepared.take().unwrap())?;
                progress(*start, true);
                let began = Instant::now();
                for (at, point) in drag_points(*start, *end, *duration_ms) {
                    wait_until(began + at, cancel).map_err(|_| unknown())?;
                    session
                        .event(InputEvent::PointerMove {
                            point,
                            modifiers: vec![],
                        })
                        .map_err(|_| unknown())?;
                    final_position = point;
                    progress(point, true);
                }
                session.event(InputEvent::PointerUp {
                    point: final_position,
                    button: MouseButton::Left,
                })?;
            }
            InputCommand::Scroll {
                delta_x, delta_y, ..
            } => session.event(InputEvent::Scroll {
                point: position,
                delta_x: *delta_x,
                delta_y: *delta_y,
                modifiers: vec![],
            })?,
            InputCommand::WindowInput {} => session.event(InputEvent::PrepareSurface)?,
            InputCommand::Media { key, modifiers } => session.event(InputEvent::Media {
                key: *key,
                modifiers: modifiers.clone(),
            })?,
            InputCommand::Focus {} => unreachable!(),
        }
        Ok(())
    })();
    let cleanup = session.close();
    result?;
    cleanup?;
    let has_position = !matches!(
        command,
        InputCommand::Media { .. } | InputCommand::WindowInput {}
    );
    Ok((
        target.clone(),
        InputReceipt {
            control: None,
            method: command.method(),
            activation: command.prepares_window()
                || matches!(command, InputCommand::WindowInput {}),
            outcome: "dispatched",
            position: has_position.then_some(final_position),
            global_position: if has_position {
                Some(target.bounds.to_global(final_position)?)
            } else {
                None
            },
            effects: None,
            window_delivery: has_position.then_some("unverified"),
        },
    ))
}
