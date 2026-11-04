use super::input::Session;
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{InputCommand, MouseButton, drag_points, wait_for_offset},
    input::InputReceipt,
    target::{Point, Target},
};
use cantrip_interaction::input::{InputEvent, TextInput};
use std::time::{Duration, Instant};

pub(super) fn perform(
    session: &mut Session,
    target: Target,
    command: &InputCommand,
    mut position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point),
) -> Result<(Target, InputReceipt)> {
    command.validate()?;
    let mut began = false;
    let result = (|| {
        let mut send = |event| {
            cancel.check()?;
            began = true;
            session.send(event, cancel)
        };
        let start = Instant::now();
        match command {
            InputCommand::PreparedPress {
                point,
                hold_ms,
                button,
            } => {
                position = point.unwrap_or(position);
                send(InputEvent::PointerDown {
                    point: position,
                    button: *button,
                    modifiers: vec![],
                })?;
                progress(position);
                wait_for_offset(start, Duration::from_millis(*hold_ms), cancel)?;
                send(InputEvent::PointerUp {
                    point: position,
                    button: *button,
                })?;
            }
            InputCommand::Key { key, modifiers } => {
                send(InputEvent::KeyDown {
                    key: key.clone(),
                    modifiers: modifiers.clone(),
                    repeat: false,
                })?;
                send(InputEvent::KeyUp { key: key.clone() })?;
            }
            InputCommand::Text { text } => {
                for ch in text.replace("\r\n", "\n").chars() {
                    send(InputEvent::Text(TextInput::Commit(ch.to_string())))?;
                }
            }
            InputCommand::Scroll {
                delta_x,
                delta_y,
                point,
            } => {
                position = point.unwrap_or(position);
                send(InputEvent::Scroll {
                    point: position,
                    delta_x: *delta_x,
                    delta_y: *delta_y,
                    modifiers: vec![],
                })?;
            }
            InputCommand::Drag {
                start: from,
                end,
                duration_ms,
            } => {
                target.bounds.to_global(*end)?;
                position = *from;
                send(InputEvent::PointerDown {
                    point: position,
                    button: MouseButton::Left,
                    modifiers: vec![],
                })?;
                for (at, point) in drag_points(*from, *end, *duration_ms) {
                    wait_for_offset(start, at, cancel)?;
                    send(InputEvent::PointerMove {
                        point,
                        modifiers: vec![],
                    })?;
                    position = point;
                    progress(position);
                }
                send(InputEvent::PointerUp {
                    point: position,
                    button: MouseButton::Left,
                })?;
            }
            InputCommand::Timeline { frames } => {
                let mut pointer_button = MouseButton::Left;
                for frame in frames {
                    wait_for_offset(start, Duration::from_millis(frame.at_ms), cancel)?;
                    for key in &frame.key_up {
                        send(InputEvent::KeyUp { key: key.clone() })?;
                    }
                    if frame.pointer_up {
                        send(InputEvent::PointerUp {
                            point: position,
                            button: pointer_button,
                        })?;
                    }
                    for key in &frame.key_down {
                        send(InputEvent::KeyDown {
                            key: key.clone(),
                            modifiers: frame.key_modifiers.clone(),
                            repeat: false,
                        })?;
                    }
                    if let Some(point) = frame.pointer_down {
                        pointer_button = frame.pointer_button.unwrap_or_default();
                        position = point;
                        send(InputEvent::PointerDown {
                            point,
                            button: pointer_button,
                            modifiers: frame.pointer_modifiers.clone(),
                        })?;
                        progress(position);
                    }
                }
            }
            InputCommand::Focus {} | InputCommand::WindowInput {} => {
                return Err(CuaError::new(
                    ErrorCode::Unsupported,
                    "Window focus/preparation is unavailable for an X11 display; click the intended application.",
                ));
            }
            InputCommand::Media { .. } => {
                return Err(CuaError::new(
                    ErrorCode::Unsupported,
                    "System media is not available on this workspace backend.",
                ));
            }
        }
        cancel.check()
    })();
    if let Err(error) = result {
        let _ = session.close();
        return Err(if began {
            CuaError::new(
                ErrorCode::InputUnknown,
                "X11 input stopped after dispatch began; release cleanup was attempted. Do not replay.",
            )
        } else {
            error
        });
    }
    Ok((
        target,
        InputReceipt {
            control: None,
            method: command.method(),
            activation: true,
            outcome: "dispatched",
            position: Some(position),
            global_position: None,
            effects: None,
            window_delivery: None,
        },
    ))
}
