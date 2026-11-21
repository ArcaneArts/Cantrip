//! Ordered input owned by one remote viewer and one exact native window.
use crate::desktop_inventory::{Capture, GuestControl, InputAuthority};
use anyhow::{Result, ensure};
use cantrip_interaction::{
    geometry::Point,
    input::{InputEvent, Modifier, MouseButton, TextInput},
};
use cantrip_wire::{JsString, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc, watch},
    task::JoinSet,
};
use uuid::Uuid;

const LIMIT: usize = 64;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const TEXT_CHUNK: usize = 8192;

pub(super) struct Viewer {
    pub epoch: String,
    pub sequence: u64,
    pub sprite: Option<Value>,
    pub position: Option<(f64, f64)>,
    queue: Arc<Queue>,
    stop: watch::Sender<bool>,
    pub closed: watch::Receiver<bool>,
}

pub(super) struct Update {
    pub attachment: JsString,
    pub epoch: String,
    pub sprite: Option<Value>,
    pub message: Option<String>,
    pub clipboard: Option<JsString>,
}

pub(super) struct Authority {
    pub allowed: InputAuthority,
    pub control: Option<Arc<GuestControl>>,
}

pub(super) struct Command {
    pub value: Value,
    pub pixels: (u32, u32),
    pub logical: (f64, f64),
    pub bytes: usize,
}

#[derive(Default)]
struct Queue {
    wake: Notify,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    commands: VecDeque<Command>,
    bytes: usize,
}

impl Viewer {
    pub(super) fn start(
        tasks: &mut JoinSet<()>,
        updates: mpsc::Sender<Update>,
        capture: Arc<Capture>,
        worker: JsString,
        attachment: JsString,
        authority: Authority,
        previous: Option<watch::Receiver<bool>>,
    ) -> Self {
        let epoch = Uuid::new_v4().to_string();
        let active_epoch = epoch.clone();
        let (stop, mut stopped) = watch::channel(false);
        let (finished, closed) = watch::channel(false);
        let live = stopped.clone();
        let Authority { allowed, control } = authority;
        let allowed: InputAuthority = Arc::new(move || !*live.borrow() && allowed());
        let queue = Arc::new(Queue::default());
        let commands = queue.clone();
        tasks.spawn(async move {
            let mut participant = capture.participant(
                &worker,
                &attachment,
                &active_epoch,
                allowed.clone(),
                control.as_deref(),
            );
            drop(capture);
            // A replacement of this viewer waits for its prior held input to
            // be released, even if several transitions arrive in succession.
            if let Some(mut previous) = previous {
                let _ = previous.wait_for(|closed| *closed).await;
            }
            let run = async {
                if !allowed() {
                    return Ok(());
                }
                if let Some(control) = &control {
                    control
                        .take(allowed.clone())
                        .await
                        .map_err(|error| error.to_string())?;
                }
                let sprite = participant.open().await.map_err(|_| {
                    "Desktop input could not attach. Reconnect to try again.".to_owned()
                })?;
                updates
                    .send(Update {
                        attachment: attachment.clone(),
                        epoch: active_epoch.clone(),
                        sprite: Some(sprite),
                        message: None,
                        clipboard: None,
                    })
                    .await
                    .map_err(|_| "Input stopped.".to_owned())?;
                let mut state = State::default();
                loop {
                    let command = commands.next().await;
                    let copy = command.value["operation"] == "copy";
                    let text = if copy && control.is_none() {
                        if !allowed() {
                            return Ok(());
                        }
                        state.native_sequence += 2;
                        participant
                            .copy_window_text(state.native_sequence)
                            .await
                            .map_err(|_| FAILED.to_owned())?
                    } else {
                        let events = if copy {
                            vec![
                                InputEvent::KeyDown {
                                    key: "C".into(),
                                    modifiers: vec![Modifier::Control],
                                    repeat: false,
                                },
                                InputEvent::KeyUp { key: "C".into() },
                            ]
                        } else {
                            state.translate(&command).map_err(|_| FAILED.to_owned())?
                        };
                        for event in events {
                            if !allowed() {
                                return Ok(());
                            }
                            event.validate().map_err(|_| FAILED.to_owned())?;
                            state.native_sequence += 1;
                            participant
                                .input(state.native_sequence, &event)
                                .await
                                .map_err(|_| FAILED.to_owned())?;
                        }
                        if copy {
                            tokio::time::sleep(Duration::from_millis(60)).await;
                            Some(
                                participant
                                    .clipboard()
                                    .await
                                    .map_err(|_| FAILED.to_owned())?,
                            )
                        } else {
                            None
                        }
                    };
                    if let Some(text) = text {
                        if !allowed() {
                            return Ok(());
                        }
                        updates
                            .send(Update {
                                attachment: attachment.clone(),
                                epoch: active_epoch.clone(),
                                sprite: None,
                                message: None,
                                clipboard: Some(text),
                            })
                            .await
                            .map_err(|_| "Input stopped.".to_owned())?;
                    }
                }
            };
            let watch_route = async {
                while allowed() {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
            };
            let result = tokio::select! {
                biased;
                _ = stopped.changed() => None,
                _ = watch_route => Some(Ok(())),
                result = run => Some(result),
            };
            participant.close().await;
            drop(control);
            finished.send_replace(true);
            if let Some(result) = result {
                let _ = updates
                    .send(Update {
                        attachment,
                        epoch: active_epoch,
                        sprite: None,
                        message: result.err(),
                        clipboard: None,
                    })
                    .await;
            }
        });
        Self {
            epoch,
            sequence: 0,
            sprite: None,
            position: None,
            queue,
            stop,
            closed,
        }
    }

    pub(super) fn enqueue(&self, command: Command) -> bool {
        self.queue.push(command)
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

pub(super) const FAILED: &str =
    "Input stopped; delivery may be uncertain. Reconnect without replaying the last action.";

impl Command {
    fn hover(&self) -> bool {
        self.value["type"] == "pointer"
            && self.value["event"] == "move"
            && self.value["buttons"] == 0
    }
}

impl Queue {
    fn push(&self, command: Command) -> bool {
        let mut pending = self.pending.lock().unwrap();
        if command.hover()
            && pending.commands.back().is_some_and(|last| {
                last.hover() && last.value["modifiers"] == command.value["modifiers"]
            })
        {
            pending.bytes -= pending.commands.pop_back().unwrap().bytes;
        }
        if pending.bytes + command.bytes > MAX_BYTES || pending.commands.len() >= LIMIT {
            return false;
        }
        pending.bytes += command.bytes;
        pending.commands.push_back(command);
        self.wake.notify_one();
        true
    }

    async fn next(&self) -> Command {
        loop {
            let ready = self.wake.notified();
            if let Some(command) = {
                let mut pending = self.pending.lock().unwrap();
                let command = pending.commands.pop_front();
                if let Some(command) = &command {
                    pending.bytes -= command.bytes;
                }
                command
            } {
                return command;
            }
            ready.await;
        }
    }
}

#[derive(Default)]
struct State {
    native_sequence: u64,
    held: HashMap<String, HashSet<String>>,
    wheel: (f64, f64, u64),
}

impl State {
    fn translate(&mut self, command: &Command) -> Result<Vec<InputEvent>> {
        let message = &command.value;
        let event = match message["type"].as_str() {
            Some("pointer") => self.pointer(command)?,
            Some("key") => self.key(message),
            Some("clipboard") => {
                let text = message["text"]
                    .as_js_string()
                    .expect("validated text")
                    .lossy();
                let mut remaining = text.as_ref();
                let mut events = Vec::new();
                while !remaining.is_empty() {
                    let mut end = remaining.len().min(TEXT_CHUNK);
                    while !remaining.is_char_boundary(end) {
                        end -= 1;
                    }
                    let (chunk, tail) = remaining.split_at(end);
                    events.push(InputEvent::Text(TextInput::Commit(chunk.to_owned())));
                    remaining = tail;
                }
                return Ok(events);
            }
            _ => unreachable!("validated desktop input command"),
        };
        Ok(event.into_iter().collect())
    }

    fn pointer(&mut self, command: &Command) -> Result<Option<InputEvent>> {
        let message = &command.value;
        let number = |field| message[field].as_f64().expect("validated pointer input");
        let point = Point {
            x: number("x") / f64::from(command.pixels.0) * command.logical.0,
            y: number("y") / f64::from(command.pixels.1) * command.logical.1,
        };
        let bits = message["modifiers"].as_u64().expect("validated modifiers");
        let modifiers = modifiers(bits);
        let event = match message["event"].as_str() {
            Some("move") => InputEvent::PointerMove { point, modifiers },
            Some("wheel") => {
                if self.wheel.2 != bits {
                    self.wheel = (0.0, 0.0, bits);
                }
                self.wheel.0 += number("deltaX");
                self.wheel.1 += number("deltaY");
                let delta = |value: &mut f64| {
                    let whole = value.trunc();
                    ensure!(
                        (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&whole),
                        "Desktop scroll exceeds the native range."
                    );
                    *value -= whole;
                    Ok(whole as i32)
                };
                let delta_x = delta(&mut self.wheel.0)?;
                let delta_y = delta(&mut self.wheel.1)?;
                if delta_x == 0 && delta_y == 0 {
                    return Ok(None);
                }
                InputEvent::Scroll {
                    point,
                    delta_x,
                    delta_y,
                    modifiers,
                }
            }
            direction => {
                let button = match message["button"].as_str() {
                    Some("left") => MouseButton::Left,
                    Some("middle") => MouseButton::Middle,
                    Some("right") => MouseButton::Right,
                    Some("back") => MouseButton::Back,
                    Some("forward") => MouseButton::Forward,
                    _ => return Ok(None),
                };
                if direction == Some("down") {
                    InputEvent::PointerDown {
                        point,
                        button,
                        modifiers,
                    }
                } else {
                    InputEvent::PointerUp { point, button }
                }
            }
        };
        Ok(Some(event))
    }

    fn key(&mut self, message: &Value) -> Option<InputEvent> {
        let code = message["code"]
            .as_js_string()
            .expect("validated code")
            .lossy();
        let key = message["key"]
            .as_js_string()
            .expect("validated key")
            .lossy();
        let physical = if code.is_empty() {
            key.as_ref()
        } else {
            code.as_ref()
        };
        let key = match code.as_bytes() {
            [b'K', b'e', b'y', b'A'..=b'Z'] => &code[3..],
            [b'D', b'i', b'g', b'i', b't', b'0'..=b'9'] => &code[5..],
            _ => match code.as_ref() {
                "MetaLeft" | "MetaRight" => "Meta",
                "ControlLeft" | "ControlRight" => "Control",
                "AltLeft" | "AltRight" => "Alt",
                "ShiftLeft" | "ShiftRight" => "Shift",
                "Space" => "Space",
                _ => &key,
            },
        };
        if message["event"] == "down" {
            let held = self.held.entry(key.to_owned()).or_default();
            let repeat = held.contains(physical);
            let deliver = held.is_empty() || repeat;
            held.insert(physical.to_owned());
            return deliver.then(|| InputEvent::KeyDown {
                key: key.to_owned(),
                modifiers: modifiers(message["modifiers"].as_u64().unwrap()),
                repeat,
            });
        }
        let held = self.held.get_mut(key)?;
        if !held.remove(physical) || !held.is_empty() {
            return None;
        }
        self.held.remove(key);
        Some(InputEvent::KeyUp {
            key: key.to_owned(),
        })
    }
}

fn modifiers(bits: u64) -> Vec<Modifier> {
    [
        Modifier::Alt,
        Modifier::Control,
        Modifier::Meta,
        Modifier::Shift,
    ]
    .into_iter()
    .enumerate()
    .filter_map(|(bit, modifier)| (bits & (1 << bit) != 0).then_some(modifier))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cantrip_wire::value::json;

    fn command(value: Value) -> Command {
        Command {
            value,
            pixels: (320, 200),
            logical: (160.0, 100.0),
            bytes: 100,
        }
    }

    fn pointer(event: &str, x: u32, delta_y: f64, modifiers: u64) -> Command {
        command(json!({
            "type":"pointer","event":event,"x":x,"y":40,"deltaX":0,"deltaY":delta_y,
            "modifiers":modifiers,"button":"left","buttons":0
        }))
    }

    #[tokio::test]
    async fn adjacent_hover_coalesces_but_clicks_and_modifier_changes_keep_order() {
        let queue = Queue::default();
        assert!(queue.push(pointer("move", 4, 0.0, 0)));
        assert!(queue.push(pointer("move", 8, 0.0, 0)));
        assert!(queue.push(pointer("down", 7, 0.0, 0)));
        assert!(queue.push(pointer("move", 11, 0.0, 0)));
        assert!(queue.push(pointer("move", 12, 0.0, 8)));
        assert_eq!(queue.next().await.value["x"], 8);
        assert_eq!(queue.next().await.value["event"], "down");
        assert_eq!(queue.next().await.value["x"], 11);
        assert_eq!(queue.next().await.value["x"], 12);
    }

    #[test]
    fn keeps_fractional_scroll_and_maps_frame_pixels_to_window_points() {
        let mut state = State::default();
        assert!(
            state
                .translate(&pointer("wheel", 80, 0.6, 0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            state.translate(&pointer("wheel", 80, 0.6, 0)).unwrap(),
            [InputEvent::Scroll {
                point: Point { x: 40.0, y: 20.0 },
                delta_x: 0,
                delta_y: 1,
                modifiers: vec![],
            }],
        );
        assert!(
            state
                .translate(&pointer("wheel", 80, 0.9, 8))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn shares_native_modifier_holds_and_splits_utf8_paste() {
        let mut state = State::default();
        let key = |code: &str, event: &str| {
            command(json!({
                "type":"key","event":event,"code":code,"key":"Shift","modifiers":8
            }))
        };
        let left = key("ShiftLeft", "down");
        let right = key("ShiftRight", "down");
        let down = |repeat| InputEvent::KeyDown {
            key: "Shift".to_owned(),
            modifiers: vec![Modifier::Shift],
            repeat,
        };
        assert_eq!(state.translate(&left).unwrap(), [down(false)]);
        assert_eq!(state.translate(&left).unwrap(), [down(true)]);
        assert!(state.translate(&right).unwrap().is_empty());
        assert!(state.translate(&key("ShiftLeft", "up")).unwrap().is_empty());
        assert_eq!(
            state.translate(&key("ShiftRight", "up")).unwrap(),
            [InputEvent::KeyUp {
                key: "Shift".to_owned()
            }],
        );

        let prefix = "a".repeat(TEXT_CHUNK - 1);
        let paste = command(
            json!({"type":"clipboard","operation":"paste-text","text":format!("{prefix}🧪")}),
        );
        assert_eq!(
            state.translate(&paste).unwrap(),
            [
                InputEvent::Text(TextInput::Commit(prefix)),
                InputEvent::Text(TextInput::Commit("🧪".to_owned())),
            ],
        );
    }
}
