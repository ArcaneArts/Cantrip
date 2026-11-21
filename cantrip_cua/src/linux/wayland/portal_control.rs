use super::{
    portal::Portal,
    portal_desktop::{DesktopSession, Event},
    stale,
};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::Binding,
    target::{Bounds, Target},
};
use cantrip_interaction::{
    host::{Delivery, InputBackend, InputFailure, InputHost, PostFailure, Prepared},
    input::{InputEvent, Modifier, MouseButton, TextInput},
    ownership::{Participant, TargetIdentity},
};
use std::{
    sync::{Arc, mpsc},
    thread,
};

pub(super) struct Control {
    portal: Portal,
    pending: Option<Pending>,
    active: Option<Active>,
}

struct Pending {
    binding: Binding,
    target: Target,
    layout: Vec<Bounds>,
    cancel: Cancellation,
    result: mpsc::Receiver<Result<DesktopSession>>,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

struct Active {
    native_id: String,
    target: Target,
    identity: TargetIdentity,
    host: InputHost<Native>,
    participant: Participant,
    session: Arc<DesktopSession>,
}

impl Control {
    pub(super) fn new(portal: Portal) -> Self {
        Self {
            portal,
            pending: None,
            active: None,
        }
    }

    pub(super) fn open(
        &mut self,
        binding: &Binding,
        participant: &str,
        target: &Target,
        layout: Vec<Bounds>,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        if self.active.is_some() {
            return Err(busy());
        }
        if let Some(pending) = &self.pending
            && pending.cancel.is_cancelled()
        {
            if matches!(pending.result.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                return Err(busy());
            }
            self.pending.take();
        }
        if let Some(pending) = &self.pending {
            if &pending.binding != binding {
                return Err(busy());
            }
            if !same_target(&pending.target, target) || pending.layout != layout {
                pending.cancel.cancel();
                return Err(stale());
            }
            let result = match pending.result.try_recv() {
                Ok(result) => result,
                Err(mpsc::TryRecvError::Empty) => return Err(waiting()),
                Err(mpsc::TryRecvError::Disconnected) => Err(input_failed()),
            };
            self.pending.take();
            let session = Arc::new(result?);
            let identity = TargetIdentity {
                id: target.id.clone(),
                generation: target.generation,
            };
            let mut host = InputHost::new(Native(session.clone()), 1, 32);
            let owner = host
                .open(identity.clone(), target.id.clone(), cancel.clone())
                .map_err(|_| input_failed())?;
            self.active = Some(Active {
                native_id: participant.to_owned(),
                target: target.clone(),
                identity,
                host,
                participant: owner,
                session,
            });
            return Ok(());
        }

        let portal = self.portal.clone();
        let bounds = target.bounds;
        let (sender, result) = mpsc::channel();
        let attempt_cancel = Cancellation::default();
        let work_cancel = attempt_cancel.clone();
        let output_layout = layout.clone();
        thread::Builder::new()
            .name("cantrip-wayland-control".into())
            .spawn(move || {
                let _ = sender.send(DesktopSession::start(
                    portal,
                    bounds,
                    &output_layout,
                    &work_cancel,
                ));
            })
            .map_err(|_| input_failed())?;
        self.pending = Some(Pending {
            binding: binding.clone(),
            target: target.clone(),
            layout,
            cancel: attempt_cancel,
            result,
        });
        Err(waiting())
    }

    pub(super) fn cancel_open(&mut self, binding: &Binding) {
        if let Some(pending) = self
            .pending
            .as_ref()
            .filter(|pending| &pending.binding == binding)
        {
            pending.cancel.cancel();
        }
    }

    pub(super) fn submit(
        &mut self,
        session: &str,
        target: &Target,
        sequence: u64,
        event: &InputEvent,
        cancel: &Cancellation,
    ) -> Result<()> {
        let result = self
            .current(session, target)?
            .submit(sequence, event, cancel);
        if result.is_err() {
            self.close(session);
        }
        result
    }

    pub(super) fn copy(
        &mut self,
        session: &str,
        target: &Target,
        sequence: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        let portal = self.current(session, target)?.session.clone();
        let Some(signals) = portal.watch_clipboard(cancel)? else {
            return Ok(None);
        };
        self.submit(
            session,
            target,
            sequence - 1,
            &InputEvent::KeyDown {
                key: "C".into(),
                modifiers: vec![Modifier::Control],
                repeat: false,
            },
            cancel,
        )?;
        self.submit(
            session,
            target,
            sequence,
            &InputEvent::KeyUp { key: "C".into() },
            cancel,
        )?;
        portal.copied_text(signals, cancel)
    }

    pub(super) fn close(&mut self, session: &str) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.native_id == session)
        {
            self.active.take();
            true
        } else {
            false
        }
    }

    fn current(&mut self, session: &str, target: &Target) -> Result<&mut Active> {
        self.active
            .as_mut()
            .filter(|active| active.native_id == session && same_target(&active.target, target))
            .ok_or_else(stale)
    }
}

impl Active {
    fn submit(&mut self, sequence: u64, event: &InputEvent, cancel: &Cancellation) -> Result<()> {
        self.host
            .update_destination(self.participant, &self.identity, cancel.clone())
            .map_err(|_| stale())?;
        self.host
            .submit(self.participant, &self.identity, sequence, event)
            .map(|_| ())
            .map_err(|error| match error {
                InputFailure::Prepare(error)
                | InputFailure::Post {
                    failure: PostFailure::NotDispatched(error),
                    ..
                } => error,
                InputFailure::Invalid(error) => error.into(),
                InputFailure::Ownership(_) => busy(),
                _ => CuaError::new(
                    ErrorCode::InputUnknown,
                    "Wayland input delivery is uncertain.",
                ),
            })
    }
}

struct Native(Arc<DesktopSession>);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Held {
    Key(i32),
    Button(i32),
}

struct Packet {
    events: Vec<Event>,
    cleanup: bool,
}

impl InputBackend for Native {
    type Target = Cancellation;
    type Control = Held;
    type Packet = Packet;
    type Error = CuaError;

    fn prepare<'a>(
        &mut self,
        _: &Cancellation,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Held, &'a Packet)>,
    ) -> Result<Prepared<Held, Packet>> {
        let held: Vec<_> = held.collect();
        let packet = |events| Packet {
            events,
            cleanup: false,
        };
        let action = |events| Prepared::Action {
            controls: vec![],
            packet: packet(events),
        };
        let keys = |mods: &[Modifier], key: Option<i32>| {
            mods.iter()
                .map(|modifier| super::super::keys::modifier(*modifier) as i32)
                .filter(|code| {
                    Some(*code) != key
                        && !held
                            .iter()
                            .any(|(control, _)| **control == Held::Key(*code))
                })
                .collect::<Vec<_>>()
        };
        let press = |control, mut events: Vec<Event>, modifiers: Vec<i32>, down, up| {
            events.extend(modifiers.iter().map(|&key| Event::Key(key, true)));
            events.push(down);
            let mut release = vec![up];
            release.extend(
                modifiers
                    .into_iter()
                    .rev()
                    .map(|key| Event::Key(key, false)),
            );
            Prepared::Down {
                control,
                packet: packet(events),
                release: Packet {
                    events: release,
                    cleanup: true,
                },
            }
        };
        Ok(match event {
            InputEvent::PointerMove { point, .. } => action(vec![Event::Move(*point)]),
            InputEvent::PointerDown {
                point,
                button,
                modifiers,
            } => {
                let code = button_code(*button);
                press(
                    Held::Button(code),
                    vec![Event::Move(*point)],
                    keys(modifiers, None),
                    Event::Button(code, true),
                    Event::Button(code, false),
                )
            }
            InputEvent::PointerUp { point, button } => {
                let control = Held::Button(button_code(*button));
                let release =
                    held.iter()
                        .find(|(item, _)| **item == control)
                        .map(|(_, release)| {
                            let mut events = vec![Event::Move(*point)];
                            events.extend(&release.events);
                            Packet {
                                events,
                                cleanup: true,
                            }
                        });
                Prepared::Up {
                    control,
                    packet: release,
                }
            }
            InputEvent::Scroll {
                point,
                delta_x,
                delta_y,
                modifiers,
            } => {
                let modifiers = keys(modifiers, None);
                let mut events = vec![Event::Move(*point)];
                events.extend(modifiers.iter().map(|&key| Event::Key(key, true)));
                events.push(Event::Scroll(f64::from(*delta_x), f64::from(*delta_y)));
                events.extend(
                    modifiers
                        .into_iter()
                        .rev()
                        .map(|key| Event::Key(key, false)),
                );
                action(events)
            }
            InputEvent::KeyDown {
                key,
                modifiers,
                repeat,
            } => {
                let code = key_code(key)?;
                if *repeat {
                    Prepared::Repeat {
                        control: Held::Key(code),
                        packet: packet(vec![Event::Key(code, true)]),
                    }
                } else {
                    press(
                        Held::Key(code),
                        vec![],
                        keys(modifiers, Some(code)),
                        Event::Key(code, true),
                        Event::Key(code, false),
                    )
                }
            }
            InputEvent::KeyUp { key } => Prepared::Up {
                control: Held::Key(key_code(key)?),
                packet: None,
            },
            InputEvent::Text(TextInput::Commit(text)) => action(
                text.replace("\r\n", "\n")
                    .chars()
                    .flat_map(|character| {
                        let code = match character {
                            '\n' | '\r' => 0xff0d,
                            '\t' => 0xff09,
                            short if short as u32 <= 0xff => short as i32,
                            unicode => 0x0100_0000 | unicode as i32,
                        };
                        [Event::Key(code, true), Event::Key(code, false)]
                    })
                    .collect(),
            ),
            InputEvent::PrepareSurface => action(vec![]),
            _ => {
                return Err(CuaError::new(
                    ErrorCode::Unsupported,
                    "This input operation is unavailable on the Wayland display.",
                ));
            }
        })
    }

    fn post(
        &mut self,
        cancel: &Cancellation,
        packet: &Packet,
    ) -> std::result::Result<Delivery, PostFailure<CuaError>> {
        let cleanup = Cancellation::default();
        let cancel = if packet.cleanup { &cleanup } else { cancel };
        cancel.check().map_err(PostFailure::NotDispatched)?;
        for event in &packet.events {
            self.0
                .notify(*event, cancel)
                .map_err(PostFailure::Uncertain)?;
        }
        Ok(Delivery::DispatchedUnverified)
    }
}

fn same_target(left: &Target, right: &Target) -> bool {
    left.id == right.id && left.generation == right.generation && left.bounds == right.bounds
}

fn button_code(button: MouseButton) -> i32 {
    match button {
        MouseButton::Left => 0x110,
        MouseButton::Right => 0x111,
        MouseButton::Middle => 0x112,
        MouseButton::Back => 0x113,
        MouseButton::Forward => 0x114,
    }
}

fn key_code(key: &str) -> Result<i32> {
    super::super::keys::symbol(key)
        .map(|code| {
            if code > 0xff && key.chars().count() == 1 {
                (0x0100_0000 | code) as i32
            } else {
                code as i32
            }
        })
        .ok_or_else(|| CuaError::new(ErrorCode::Unsupported, "Unsupported Wayland key name."))
}

fn busy() -> CuaError {
    CuaError::new(
        ErrorCode::OwnershipMismatch,
        "Another viewer controls the Wayland display.",
    )
}

fn waiting() -> CuaError {
    CuaError::new(
        ErrorCode::InputPending,
        "Waiting for approval in the Wayland desktop.",
    )
}

fn input_failed() -> CuaError {
    CuaError::new(
        ErrorCode::InputFailed,
        "Could not open Wayland desktop control.",
    )
}
