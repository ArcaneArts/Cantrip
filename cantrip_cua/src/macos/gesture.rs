//! CUA macro adapter. Native resources and dispatch belong to the shared host's
//! concrete backend; CUA keeps validation, cancellation and wire receipts here.
use super::{
    input_backend::{Control, Packet},
    input_session::{NativeInputSession, unknown},
};
use crate::{
    cancellation::Cancellation,
    error::Result,
    gesture::{
        InputCommand, MouseButton, drag_points, key_code, text_units, wait_for_offset, wait_until,
    },
    input::InputReceipt,
    target::{Point, Target},
};
use cantrip_interaction::{
    host::Prepared,
    input::InputEvent,
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
fn run(
    session: &mut NativeInputSession,
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
            wait_for_offset(started, at, cancel)?;
            Ok(started.elapsed())
        },
    )
    .map_err(|error| if began { unknown() } else { error.source })
}
pub(super) fn perform(
    session: &mut NativeInputSession,
    target: &Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point, bool),
) -> Result<(Target, InputReceipt)> {
    struct Scope<'a> {
        session: &'a mut NativeInputSession,
        armed: bool,
    }
    impl Drop for Scope<'_> {
        fn drop(&mut self) {
            if self.armed {
                let _ = self.session.close();
            }
        }
    }
    let mut scope = Scope {
        session,
        armed: true,
    };
    let result = perform_inner(scope.session, target, command, position, cancel, progress);
    if result.is_err() {
        let cleanup = scope.session.close();
        scope.armed = false;
        if cleanup.is_err() {
            return Err(unknown());
        }
    } else {
        scope.armed = false;
    }
    result
}
fn perform_inner(
    session: &mut NativeInputSession,
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
        session.refresh(target.clone(), position, cancel)?;
        current.bounds = session.action(&[], cancel, || {
            super::accessibility::request_focus(target, cancel)
        })?;
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
    session.begin_macro(target.clone(), position, cancel)?;
    let mut final_position = position;
    let mut pairs = vec![];
    let mut frames = vec![];
    match command {
        InputCommand::PreparedPress {
            hold_ms, button, ..
        } => {
            pairs.push(Pair::new(session.prepare(&InputEvent::PointerDown {
                point: position,
                button: *button,
                modifiers: vec![],
            })?));
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
                    pairs.push(Pair::new(session.prepare(&InputEvent::KeyDown {
                        key: key.clone(),
                        modifiers: frame.key_modifiers.clone(),
                        repeat: false,
                    })?));
                    keys.insert(key.clone(), i);
                    events.push(Transition::Down(i));
                }
                if let Some(point) = frame.pointer_down {
                    let i = pairs.len();
                    pairs.push(Pair::new(session.prepare(&InputEvent::PointerDown {
                        point,
                        button: frame.pointer_button.unwrap_or_default(),
                        modifiers: frame.pointer_modifiers.clone(),
                    })?));
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
                pairs.push(Pair::new(session.key_pair(key, &text, &[])?));
            }
        }
        InputCommand::Key { key, modifiers } => {
            pairs.push(Pair::new(session.key_pair(
                key_code(key).expect("validated key"),
                &[],
                modifiers,
            )?));
        }
        InputCommand::Drag { start, end, .. } => {
            target.bounds.to_global(*end)?;
            pairs.push(Pair::new(session.prepare(&InputEvent::PointerDown {
                point: *start,
                button: MouseButton::Left,
                modifiers: vec![],
            })?));
        }
        _ => {}
    }
    let result: Result<()> = (|| {
        match command {
            InputCommand::PreparedPress { .. } | InputCommand::Timeline { .. } => {
                let points: Vec<_> = pairs.iter().map(|p| p.point).collect();
                run(
                    session,
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
                    wait_for_offset(began, at, cancel).map_err(|_| unknown())?;
                    session
                        .send(
                            InputEvent::PointerMove {
                                point,
                                modifiers: vec![],
                            },
                            cancel,
                        )
                        .map_err(|_| unknown())?;
                    final_position = point;
                    progress(point, true);
                }
                session.send(
                    InputEvent::PointerUp {
                        point: final_position,
                        button: MouseButton::Left,
                    },
                    cancel,
                )?;
            }
            InputCommand::Scroll {
                delta_x, delta_y, ..
            } => session
                .send(
                    InputEvent::Scroll {
                        point: position,
                        delta_x: *delta_x,
                        delta_y: *delta_y,
                        modifiers: vec![],
                    },
                    cancel,
                )
                .map(|_| ())?,
            InputCommand::WindowInput {} => session
                .send(InputEvent::PrepareSurface, cancel)
                .map(|_| ())?,
            InputCommand::Media { key, modifiers } => session
                .send(
                    InputEvent::Media {
                        key: *key,
                        modifiers: modifiers.clone(),
                    },
                    cancel,
                )
                .map(|_| ())?,
            InputCommand::Focus {} => unreachable!(),
        }
        Ok(())
    })();
    result?;
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
