use super::{failure, keys, lock};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Point, Target},
};
use cantrip_interaction::{
    host::{Delivery, InputBackend, InputFailure, InputHost, PostFailure, Prepared},
    input::{InputEvent, TextInput},
    ownership::{Participant, TargetIdentity},
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{
            BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt, KEY_PRESS_EVENT,
            KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
        },
        xtest::ConnectionExt as _,
    },
    rust_connection::RustConnection,
};

#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
pub(super) enum Control {
    Key(u8),
    Button(u8),
}
pub(super) enum Packet {
    Events(Vec<(u8, u8, Option<Point>)>),
    Text(String),
}
#[derive(Clone)]
pub(super) struct Destination {
    pub target: Target,
    pub cancel: Cancellation,
    pub owner: u64,
}

pub(super) struct Native {
    connection: Arc<RustConnection>,
    root: u32,
    held: BTreeMap<(u8, u8), u64>,
    keyboard: keys::Keyboard,
}
pub(super) type Host = InputHost<Native>;
impl Native {
    pub(super) fn new(connection: Arc<RustConnection>, screen: usize) -> Self {
        Self {
            root: connection.setup().roots[screen].root,
            keyboard: keys::Keyboard::new(connection.clone()),
            connection,
            held: BTreeMap::new(),
        }
    }
    fn release(&mut self, owner: u64) {
        let held: Vec<_> = self
            .held
            .iter()
            .filter(|(_, o)| **o == owner)
            .map(|(k, _)| *k)
            .collect();
        for (kind, code) in held {
            let up = if kind == KEY_PRESS_EVENT {
                KEY_RELEASE_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            };
            let _ = self.events(&[(up, code, None)], owner);
        }
    }
    fn code(&self, symbol: u32) -> Result<u8> {
        let setup = self.connection.setup();
        let map = self
            .connection
            .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        map.keysyms
            .chunks(map.keysyms_per_keycode as usize)
            .position(|keys| keys.contains(&symbol))
            .map(|index| setup.min_keycode + index as u8)
            .ok_or_else(|| {
                CuaError::new(
                    ErrorCode::Unsupported,
                    "Key is unavailable in the assigned X11 keyboard map.",
                )
            })
    }
    fn modifiers(&self, modifiers: &[crate::gesture::Modifier]) -> Result<Vec<u8>> {
        modifiers
            .iter()
            .map(|m| self.code(keys::modifier(*m)))
            .collect()
    }
    fn pair(
        control: Control,
        mut before: Vec<(u8, u8, Option<Point>)>,
        down: (u8, u8, Option<Point>),
        up: (u8, u8, Option<Point>),
        modifiers: Vec<u8>,
    ) -> Prepared<Control, Packet> {
        before.extend(modifiers.iter().map(|k| (KEY_PRESS_EVENT, *k, None)));
        before.push(down);
        let mut release = vec![up];
        release.extend(
            modifiers
                .into_iter()
                .rev()
                .map(|k| (KEY_RELEASE_EVENT, k, None)),
        );
        Prepared::Down {
            control,
            packet: Packet::Events(before),
            release: Packet::Events(release),
        }
    }
    fn events(&mut self, events: &[(u8, u8, Option<Point>)], owner: u64) -> Result<()> {
        for (kind, detail, point) in events {
            let p = point.unwrap_or_default();
            let cookie = self
                .connection
                .xtest_fake_input(
                    *kind,
                    *detail,
                    0,
                    self.root,
                    p.x.round() as i16,
                    p.y.round() as i16,
                    0,
                )
                .map_err(failure)?;
            // Track the attempted down before waiting for confirmation. An
            // uncertain post must still retain a release for cancellation.
            match *kind {
                KEY_PRESS_EVENT | BUTTON_PRESS_EVENT => {
                    self.held.insert((*kind, *detail), owner);
                }
                KEY_RELEASE_EVENT => {
                    self.held.remove(&(KEY_PRESS_EVENT, *detail));
                }
                BUTTON_RELEASE_EVENT => {
                    self.held.remove(&(BUTTON_PRESS_EVENT, *detail));
                }
                _ => {}
            }
            cookie.check().map_err(failure)?;
        }
        self.connection.flush().map_err(failure)
    }
    fn text(&mut self, text: &str, cancel: &Cancellation, owner: u64) -> Result<()> {
        for ch in text.replace("\r\n", "\n").chars() {
            cancel.check()?;
            let symbol = match ch {
                '\n' | '\r' => 0xff0d,
                '\t' => 0xff09,
                c if c as u32 <= 0xff => c as u32,
                c => 0x01000000 | c as u32,
            };
            let (code, shift) = self.keyboard.resolve(symbol)?;
            let mut events = vec![];
            let shift_code = self.code(keys::modifier(crate::gesture::Modifier::Shift))?;
            if shift {
                events.push((KEY_PRESS_EVENT, shift_code, None));
            }
            events.extend([
                (KEY_PRESS_EVENT, code, None),
                (KEY_RELEASE_EVENT, code, None),
            ]);
            if shift {
                events.push((KEY_RELEASE_EVENT, shift_code, None));
            }
            self.events(&events, owner)?;
        }
        Ok(())
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        let owners: Vec<_> = self.held.values().copied().collect();
        for owner in owners {
            self.release(owner);
        }
    }
}
impl InputBackend for Native {
    type Target = Destination;
    type Control = Control;
    type Packet = Packet;
    type Error = CuaError;
    fn closed(&mut self, destination: &Destination) {
        self.release(destination.owner);
    }
    fn prepare<'a>(
        &mut self,
        destination: &Destination,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Control, &'a Packet)>,
    ) -> Result<Prepared<Control, Packet>> {
        let target = &destination.target;
        let point = |p: Point| -> Result<Point> { Ok(target.bounds.to_global(p)?) };
        let action = |events| Prepared::Action {
            controls: vec![],
            packet: Packet::Events(events),
        };
        Ok(match event {
            InputEvent::PointerMove {
                point: p,
                modifiers,
            } => {
                if !modifiers.is_empty() {
                    return Err(CuaError::new(
                        ErrorCode::Unsupported,
                        "Move modifiers must be held explicitly.",
                    ));
                }
                action(vec![(MOTION_NOTIFY_EVENT, 0, Some(point(*p)?))])
            }
            InputEvent::PointerDown {
                point: p,
                button,
                modifiers,
            } => {
                let p = point(*p)?;
                let code = keys::button(*button);
                Self::pair(
                    Control::Button(code),
                    vec![(MOTION_NOTIFY_EVENT, 0, Some(p))],
                    (BUTTON_PRESS_EVENT, code, None),
                    (BUTTON_RELEASE_EVENT, code, None),
                    self.modifiers(modifiers)?,
                )
            }
            InputEvent::PointerUp { point: p, button } => {
                let control = Control::Button(keys::button(*button));
                let mut events = vec![(MOTION_NOTIFY_EVENT, 0, Some(point(*p)?))];
                for (held_control, packet) in held {
                    if held_control == &control
                        && let Packet::Events(release) = packet
                    {
                        events.extend(release.iter().copied());
                    }
                }
                Prepared::Up {
                    control,
                    packet: Some(Packet::Events(events)),
                }
            }
            InputEvent::KeyDown {
                key,
                modifiers,
                repeat,
            } => {
                let symbol = keys::symbol(key).ok_or_else(|| {
                    CuaError::new(ErrorCode::Unsupported, "Unsupported X11 key name.")
                })?;
                let code = self.code(symbol)?;
                if *repeat {
                    Prepared::Repeat {
                        control: Control::Key(code),
                        packet: Packet::Events(vec![(KEY_PRESS_EVENT, code, None)]),
                    }
                } else {
                    Self::pair(
                        Control::Key(code),
                        vec![],
                        (KEY_PRESS_EVENT, code, None),
                        (KEY_RELEASE_EVENT, code, None),
                        self.modifiers(modifiers)?,
                    )
                }
            }
            InputEvent::KeyUp { key } => Prepared::Up {
                control: Control::Key(self.code(keys::symbol(key).ok_or_else(|| {
                    CuaError::new(ErrorCode::Unsupported, "Unsupported X11 key name.")
                })?)?),
                packet: None,
            },
            InputEvent::Scroll {
                point: p,
                delta_x,
                delta_y,
                modifiers,
            } => {
                let mut events = vec![(MOTION_NOTIFY_EVENT, 0, Some(point(*p)?))];
                let modifiers = self.modifiers(modifiers)?;
                events.extend(modifiers.iter().map(|k| (KEY_PRESS_EVENT, *k, None)));
                for (delta, negative, positive) in [(*delta_y, 4, 5), (*delta_x, 6, 7)] {
                    for _ in 0..delta.unsigned_abs().div_ceil(40).min(250) {
                        let button = if delta < 0 { negative } else { positive };
                        events.extend([
                            (BUTTON_PRESS_EVENT, button, None),
                            (BUTTON_RELEASE_EVENT, button, None),
                        ]);
                    }
                }
                events.extend(
                    modifiers
                        .into_iter()
                        .rev()
                        .map(|k| (KEY_RELEASE_EVENT, k, None)),
                );
                action(events)
            }
            InputEvent::Text(TextInput::Commit(text)) => Prepared::Action {
                controls: vec![],
                packet: Packet::Text(text.clone()),
            },
            InputEvent::PrepareSurface => action(vec![]),
            _ => {
                return Err(CuaError::new(
                    ErrorCode::Unsupported,
                    "This X11 input operation is not implemented.",
                ));
            }
        })
    }
    fn post(
        &mut self,
        destination: &Destination,
        packet: &Packet,
    ) -> std::result::Result<Delivery, PostFailure<CuaError>> {
        // XTEST changes this display's physical state. Another participant
        // cannot move/type while the first still owns a physical hold.
        if self.held.values().any(|owner| *owner != destination.owner) {
            return Err(PostFailure::NotDispatched(CuaError::new(
                ErrorCode::OwnershipMismatch,
                "Another participant owns held input on this display.",
            )));
        }
        let result = match packet {
            Packet::Events(events) => self.events(events, destination.owner),
            Packet::Text(text) => self.text(text, &destination.cancel, destination.owner),
        };
        if result.is_err() {
            self.release(destination.owner);
        }
        result
            .map(|_| Delivery::DispatchedUnverified)
            .map_err(PostFailure::Uncertain)
    }
}

pub(super) fn host(connection: Arc<RustConnection>, screen: usize) -> Host {
    InputHost::new(Native::new(connection, screen), 32, 32)
}
pub(super) struct Session {
    host: Arc<Mutex<Host>>,
    owner: Participant,
    identity: TargetIdentity,
    sequence: u64,
    destination: Destination,
}
fn map(error: InputFailure<CuaError>) -> CuaError {
    match error {
        InputFailure::Prepare(e) => e,
        InputFailure::Invalid(e) => e.into(),
        InputFailure::Ownership(_) => CuaError::new(
            ErrorCode::OwnershipMismatch,
            "X11 input ownership or sequence conflicts.",
        ),
        InputFailure::Post {
            failure: PostFailure::NotDispatched(error),
            ..
        } => error,
        InputFailure::Post { .. } => CuaError::new(
            ErrorCode::InputUnknown,
            "X11 input delivery is uncertain; do not replay.",
        ),
    }
}
impl Session {
    pub(super) fn open(host: Arc<Mutex<Host>>, target: &Target) -> Result<Self> {
        let identity = TargetIdentity {
            id: target.id.clone(),
            generation: target.generation,
        };
        static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
        let destination = Destination {
            target: target.clone(),
            cancel: Cancellation::default(),
            owner: NEXT_OWNER.fetch_add(1, Ordering::Relaxed),
        };
        let owner = lock(&host)
            .open(identity.clone(), target.id.clone(), destination.clone())
            .map_err(|_| CuaError::new(ErrorCode::Capacity, "X11 input capacity reached."))?;
        Ok(Self {
            host,
            owner,
            identity,
            sequence: 0,
            destination,
        })
    }
    pub(super) fn refresh(&mut self, target: &Target) {
        self.destination.target = target.clone();
    }
    pub(super) fn submit(
        &mut self,
        sequence: u64,
        event: &InputEvent,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        self.sequence = self.sequence.max(sequence);
        self.destination.cancel = cancel.clone();
        lock(&self.host)
            .update_destination(self.owner, &self.identity, self.destination.clone())
            .map_err(|_| CuaError::new(ErrorCode::StaleTarget, "X11 participant is closed."))?;
        lock(&self.host)
            .submit(self.owner, &self.identity, sequence, event)
            .map(|_| ())
            .map_err(map)
    }
    pub(super) fn send(&mut self, event: InputEvent, cancel: &Cancellation) -> Result<()> {
        self.submit(
            self.sequence.checked_add(1).ok_or_else(|| {
                CuaError::new(ErrorCode::Capacity, "X11 input sequence exhausted.")
            })?,
            &event,
            cancel,
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if lock(&self.host).close(self.owner).is_empty() {
            Ok(())
        } else {
            Err(CuaError::new(
                ErrorCode::InputUnknown,
                "X11 input release is uncertain.",
            ))
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
