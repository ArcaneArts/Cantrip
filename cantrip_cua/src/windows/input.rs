use super::{
    failure,
    lifetime::{Registry, verify_window},
    lock, physical, stale,
    targets::{Monitor, PixelCoordinates, Window},
};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Point, Target},
};
use cantrip_interaction::{
    host::{Delivery, InputBackend, InputFailure, InputHost, PostFailure, Prepared},
    input::{InputEvent, Modifier, MouseButton, TextInput},
    ownership::{Participant, TargetIdentity},
};
use std::{
    mem::size_of,
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, POINT, WPARAM},
    Graphics::Gdi::{ClientToScreen, ScreenToClient},
    UI::{
        HiDpi::PhysicalToLogicalPointForPerMonitorDPI, Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};

pub(super) type Shared = Arc<Mutex<InputHost<Native>>>;

pub(super) struct Session {
    host: Shared,
    id: TargetIdentity,
    owner: Participant,
    sequence: u64,
}

pub(super) struct Native {
    registry: Arc<Mutex<Registry>>,
}

pub(super) enum Destination {
    Window(Arc<Window>),
    ForegroundWindow(Arc<Window>, Cancellation),
    Monitor(Monitor),
}

impl Destination {
    fn target(&self) -> &Target {
        match self {
            Self::Window(window) | Self::ForegroundWindow(window, _) => &window.target,
            Self::Monitor(monitor) => &monitor.target,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Control {
    Key(u16),
    Button(MouseButton),
}

#[derive(Clone, Copy)]
struct Recipient {
    hwnd: usize,
    thread: u32,
}

#[derive(Clone, Copy)]
pub(super) struct Message {
    recipient: Recipient,
    kind: u32,
    word: WPARAM,
    long: LPARAM,
}

pub(super) enum Packet {
    Directed(Vec<Message>),
    System(physical::Packet),
}

impl Packet {
    fn first_message(&self) -> Option<Message> {
        match self {
            Self::Directed(messages) => messages.first().copied(),
            Self::System(_) => None,
        }
    }
}

impl Native {
    pub(super) fn host(registry: Arc<Mutex<Registry>>) -> Shared {
        Arc::new(Mutex::new(InputHost::new(Self { registry }, 32, 32)))
    }
}

impl Session {
    pub(super) fn open(host: Shared, destination: Destination) -> Result<Self> {
        let id = TargetIdentity {
            id: destination.target().id.clone(),
            generation: destination.target().generation,
        };
        let domain = match destination {
            Destination::Window(_) => id.id.clone(),
            Destination::ForegroundWindow(..) | Destination::Monitor(_) => {
                "windows-desktop".to_owned()
            }
        };
        let owner = lock(&host)
            .open(id.clone(), domain, destination)
            .map_err(|_| CuaError::new(ErrorCode::Capacity, "Windows input capacity reached."))?;
        Ok(Self {
            host,
            id,
            owner,
            sequence: 0,
        })
    }

    pub(super) fn refresh(&mut self, destination: Destination) -> Result<()> {
        let target = destination.target();
        if target.id != self.id.id || target.generation != self.id.generation {
            return Err(stale());
        }
        lock(&self.host)
            .update_destination(self.owner, &self.id, destination)
            .map_err(|_| stale())
    }

    pub(super) fn submit(
        &mut self,
        sequence: u64,
        event: &InputEvent,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        self.sequence = self.sequence.max(sequence);
        lock(&self.host)
            .submit(self.owner, &self.id, sequence, event)
            .map(|_| ())
            .map_err(input_error)
    }

    pub(super) fn send(&mut self, event: InputEvent, cancel: &Cancellation) -> Result<()> {
        let sequence = self.sequence.checked_add(1).ok_or_else(|| {
            CuaError::new(ErrorCode::Capacity, "Windows input sequence exhausted.")
        })?;
        self.submit(sequence, &event, cancel)
    }

    pub(super) fn close(&mut self) -> Result<()> {
        if lock(&self.host).close(self.owner).is_empty() {
            Ok(())
        } else {
            Err(CuaError::new(
                ErrorCode::InputUnknown,
                "Windows input release is uncertain.",
            ))
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn input_error(error: InputFailure<CuaError>) -> CuaError {
    match error {
        InputFailure::Invalid(error) => error.into(),
        InputFailure::Prepare(error)
        | InputFailure::Post {
            failure: PostFailure::NotDispatched(error),
            ..
        } => error,
        InputFailure::Ownership(_) => CuaError::new(
            ErrorCode::OwnershipMismatch,
            "Windows input ownership or sequence conflicts.",
        ),
        InputFailure::Post { .. } => CuaError::new(
            ErrorCode::InputUnknown,
            "Windows input delivery is uncertain. Do not replay.",
        ),
    }
}

impl Native {
    fn prepare_window<'a>(
        &self,
        window: &Window,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Control, &'a Packet)>,
    ) -> Result<Prepared<Control, Packet>> {
        verify_window(&self.registry, window)?;
        let _coordinates = PixelCoordinates::enter();
        let holds: Vec<_> = held.collect();
        let pointer_route = holds.iter().find_map(|(control, release)| match control {
            Control::Button(button) => release.first_message().map(|message| (*button, message)),
            _ => None,
        });
        let held_buttons = holds
            .iter()
            .filter_map(|(control, _)| match control {
                Control::Button(button) => Some(button_flags(*button).2),
                _ => None,
            })
            .fold(0, |flags, button| flags | button);
        let held_key = |key| {
            holds
                .iter()
                .find(|(control, _)| **control == Control::Key(key))
                .and_then(|(_, packet)| packet.first_message())
        };
        let action = |messages| Prepared::Action {
            controls: vec![],
            packet: Packet::Directed(messages),
        };
        let point = |local: Point| -> Result<POINT> {
            let global = window.target.bounds.to_global(local)?;
            Ok(POINT {
                x: global.x.floor() as i32,
                y: global.y.floor() as i32,
            })
        };
        let pointer_recipient = |point| -> Result<Recipient> {
            match pointer_route {
                Some((_, release)) => Ok(release.recipient),
                None => Recipient::pointer(window, point),
            }
        };
        Ok(match event {
            InputEvent::PrepareSurface => action(vec![]),
            InputEvent::Text(TextInput::Commit(text)) => {
                let recipient = Recipient::keyboard(window)?;
                let messages = text
                    .replace("\r\n", "\r")
                    .replace('\n', "\r")
                    .encode_utf16()
                    .map(|unit| Message {
                        recipient,
                        kind: WM_CHAR,
                        word: unit.into(),
                        long: 1,
                    })
                    .collect();
                action(messages)
            }
            InputEvent::KeyDown {
                key,
                modifiers,
                repeat,
            } => {
                let key = virtual_key(key)?;
                let modifier_keys: Vec<_> = modifiers
                    .iter()
                    .map(|modifier| modifier_key(*modifier))
                    .filter(|code| *code != key && held_key(*code).is_none())
                    .collect();
                let alt = key == VK_MENU || modifiers.contains(&Modifier::Alt);
                if *repeat {
                    let release = held_key(key).ok_or_else(|| {
                        CuaError::new(
                            ErrorCode::OwnershipMismatch,
                            "Windows key is no longer held.",
                        )
                    })?;
                    Prepared::Repeat {
                        control: Control::Key(key),
                        packet: Packet::Directed(vec![key_message(
                            release.recipient,
                            key,
                            false,
                            true,
                            alt,
                        )]),
                    }
                } else {
                    let recipient = Recipient::keyboard(window)?;
                    let mut down: Vec<_> = modifier_keys
                        .iter()
                        .map(|code| key_message(recipient, *code, false, false, *code == VK_MENU))
                        .collect();
                    down.push(key_message(recipient, key, false, false, alt));
                    let mut up = vec![key_message(recipient, key, true, false, alt)];
                    up.extend(
                        modifier_keys.iter().rev().map(|code| {
                            key_message(recipient, *code, true, false, *code == VK_MENU)
                        }),
                    );
                    Prepared::Down {
                        control: Control::Key(key),
                        packet: Packet::Directed(down),
                        release: Packet::Directed(up),
                    }
                }
            }
            InputEvent::KeyUp { key } => Prepared::Up {
                control: Control::Key(virtual_key(key)?),
                packet: None,
            },
            InputEvent::PointerMove {
                point: local,
                modifiers,
            } => {
                let point = point(*local)?;
                let recipient = pointer_recipient(point)?;
                let coordinates = recipient.coordinates(point, false)?;
                let flags = held_buttons | mouse_modifiers(modifiers);
                let packet = Packet::Directed(vec![Message {
                    recipient,
                    kind: WM_MOUSEMOVE,
                    word: flags,
                    long: coordinates,
                }]);
                if let Some((button, release)) = pointer_route {
                    Prepared::MoveHeld {
                        control: Control::Button(button),
                        packet,
                        release: Packet::Directed(vec![Message {
                            long: coordinates,
                            ..release
                        }]),
                    }
                } else {
                    Prepared::Action {
                        controls: vec![],
                        packet,
                    }
                }
            }
            InputEvent::PointerDown {
                point: local,
                button,
                modifiers,
            } => {
                let point = point(*local)?;
                let recipient = pointer_recipient(point)?;
                let long = recipient.coordinates(point, false)?;
                let (down, up, flag, xbutton) = button_flags(*button);
                let flags = held_buttons | mouse_modifiers(modifiers);
                Prepared::Down {
                    control: Control::Button(*button),
                    packet: Packet::Directed(vec![Message {
                        recipient,
                        kind: down,
                        word: flags | flag | xbutton,
                        long,
                    }]),
                    release: Packet::Directed(vec![Message {
                        recipient,
                        kind: up,
                        word: flags | xbutton,
                        long,
                    }]),
                }
            }
            InputEvent::PointerUp {
                point: local,
                button,
            } => {
                let control = Control::Button(*button);
                let point = point(*local)?;
                let packet = holds
                    .iter()
                    .find(|(held_control, _)| **held_control == control)
                    .and_then(|(_, release)| release.first_message())
                    .map(|mut message| {
                        message.long = message.recipient.coordinates(point, false)?;
                        let (_, _, flag, xbutton) = button_flags(*button);
                        message.word = (held_buttons & !flag) | xbutton;
                        Ok::<_, CuaError>(Packet::Directed(vec![message]))
                    })
                    .transpose()?;
                Prepared::Up { control, packet }
            }
            InputEvent::Scroll {
                point: local,
                delta_x,
                delta_y,
                modifiers,
            } => {
                let point = point(*local)?;
                let recipient = pointer_recipient(point)?;
                let long = recipient.coordinates(point, true)?;
                let flags = held_buttons | mouse_modifiers(modifiers);
                let messages = [
                    (WM_MOUSEWHEEL, -i64::from(*delta_y)),
                    (WM_MOUSEHWHEEL, i64::from(*delta_x)),
                ]
                .into_iter()
                .filter(|(_, delta)| *delta != 0)
                .map(|(kind, delta)| {
                    let delta = delta.clamp(i16::MIN.into(), i16::MAX.into()) as i16;
                    Message {
                        recipient,
                        kind,
                        word: flags | (usize::from(delta as u16) << 16),
                        long,
                    }
                })
                .collect();
                action(messages)
            }
            _ => {
                return Err(failure(
                    "This Windows input operation is unavailable for a scoped window.",
                ));
            }
        })
    }

    fn post_window(
        &self,
        target: &Window,
        messages: &[Message],
    ) -> std::result::Result<Delivery, PostFailure<CuaError>> {
        verify_window(&self.registry, target).map_err(PostFailure::NotDispatched)?;
        for (position, message) in messages.iter().enumerate() {
            let result = message.recipient.verify(target).and_then(|()| {
                if unsafe {
                    PostMessageW(
                        message.recipient.hwnd as HWND,
                        message.kind,
                        message.word,
                        message.long,
                    )
                } == 0
                {
                    return Err(CuaError::new(
                        ErrorCode::InputFailed,
                        "Windows declined window-directed input.",
                    ));
                }
                Ok(())
            });
            if let Err(error) = result {
                return Err(if position == 0 {
                    PostFailure::NotDispatched(error)
                } else {
                    PostFailure::Uncertain(error)
                });
            }
        }
        Ok(Delivery::DispatchedUnverified)
    }
}

impl InputBackend for Native {
    type Target = Destination;
    type Control = Control;
    type Packet = Packet;
    type Error = CuaError;

    fn prepare<'a>(
        &mut self,
        destination: &Destination,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Control, &'a Packet)>,
    ) -> Result<Prepared<Control, Packet>> {
        match destination {
            Destination::Window(window) => self.prepare_window(window, event, held),
            Destination::ForegroundWindow(window, _) => {
                let holds: Vec<_> = held.collect();
                if matches!(event, InputEvent::PointerMove { .. })
                    && !holds
                        .iter()
                        .any(|(control, _)| matches!(control, Control::Button(_)))
                {
                    return self.prepare_window(window, event, holds.into_iter());
                }
                physical::prepare(&window.target.bounds, event, holds.into_iter())
            }
            Destination::Monitor(monitor) => physical::prepare(&monitor.target.bounds, event, held),
        }
    }

    fn post(
        &mut self,
        destination: &Destination,
        packet: &Packet,
    ) -> std::result::Result<Delivery, PostFailure<CuaError>> {
        match (destination, packet) {
            (
                Destination::Window(window) | Destination::ForegroundWindow(window, _),
                Packet::Directed(messages),
            ) => self.post_window(window, messages),
            (Destination::ForegroundWindow(window, cancel), Packet::System(packet)) => {
                physical::post_window(&self.registry, window, packet, cancel)
            }
            (Destination::Monitor(monitor), Packet::System(packet)) => {
                physical::post_monitor(monitor, packet)
            }
            _ => Err(PostFailure::NotDispatched(stale())),
        }
    }
}

impl Recipient {
    fn for_window(window: &Window, hwnd: HWND) -> Result<Self> {
        let thread = window.recipient_thread(hwnd).ok_or_else(stale)?;
        Ok(Self {
            hwnd: hwnd as usize,
            thread,
        })
    }

    fn verify(self, window: &Window) -> Result<()> {
        if Self::for_window(window, self.hwnd as HWND)?.thread != self.thread {
            return Err(stale());
        }
        Ok(())
    }

    fn keyboard(window: &Window) -> Result<Self> {
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(window.identity.thread, &mut info) } != 0
            && let Ok(recipient) = Self::for_window(window, info.hwndFocus)
        {
            return Ok(recipient);
        }
        Self::for_window(window, window.identity.hwnd as HWND)
    }

    fn pointer(window: &Window, point: POINT) -> Result<Self> {
        let mut hwnd = window.identity.hwnd as HWND;
        for _ in 0..32 {
            let mut local = point;
            if unsafe { ScreenToClient(hwnd, &mut local) } == 0 {
                return Err(stale());
            }
            let child = unsafe { RealChildWindowFromPoint(hwnd, local) };
            if child == hwnd || child.is_null() || Self::for_window(window, child).is_err() {
                break;
            }
            hwnd = child;
        }
        Self::for_window(window, hwnd)
    }

    fn coordinates(self, mut point: POINT, screen: bool) -> Result<LPARAM> {
        let hwnd = self.hwnd as HWND;
        let mut origin = POINT::default();
        if !screen && unsafe { ClientToScreen(hwnd, &mut origin) } == 0 {
            return Err(stale());
        }
        if unsafe { PhysicalToLogicalPointForPerMonitorDPI(hwnd, &mut point) } == 0
            || (!screen
                && unsafe { PhysicalToLogicalPointForPerMonitorDPI(hwnd, &mut origin) } == 0)
        {
            return Err(stale());
        }
        pack_point(point.x - origin.x, point.y - origin.y)
    }
}

fn pack_point(x: i32, y: i32) -> Result<LPARAM> {
    let x = i16::try_from(x)
        .map_err(|_| CuaError::invalid("Windows input point is outside the native range."))?;
    let y = i16::try_from(y)
        .map_err(|_| CuaError::invalid("Windows input point is outside the native range."))?;
    Ok((u32::from(x as u16) | (u32::from(y as u16) << 16)) as LPARAM)
}

fn key_message(recipient: Recipient, key: u16, release: bool, repeat: bool, alt: bool) -> Message {
    let mapped = unsafe {
        MapVirtualKeyExW(
            key.into(),
            MAPVK_VK_TO_VSC_EX,
            GetKeyboardLayout(recipient.thread),
        )
    };
    let long = 1
        | ((mapped & 0xff) << 16)
        | (u32::from(mapped & 0xff00 == 0xe000) << 24)
        | (u32::from(alt && key != VK_MENU) << 29)
        | (u32::from(release || repeat) << 30)
        | (u32::from(release) << 31);
    let kind = match (alt, release) {
        (true, false) => WM_SYSKEYDOWN,
        (true, true) => WM_SYSKEYUP,
        (false, false) => WM_KEYDOWN,
        (false, true) => WM_KEYUP,
    };
    Message {
        recipient,
        kind,
        word: key.into(),
        long: long as LPARAM,
    }
}

pub(super) fn modifier_key(modifier: Modifier) -> u16 {
    match modifier {
        Modifier::Shift => VK_SHIFT,
        Modifier::Control => VK_CONTROL,
        Modifier::Alt => VK_MENU,
        Modifier::Meta => VK_LWIN,
    }
}

fn mouse_modifiers(modifiers: &[Modifier]) -> usize {
    use windows_sys::Win32::System::SystemServices::{MK_CONTROL, MK_SHIFT};
    modifiers.iter().fold(0, |flags, modifier| {
        flags
            | match modifier {
                Modifier::Shift => MK_SHIFT as usize,
                Modifier::Control => MK_CONTROL as usize,
                _ => 0,
            }
    })
}

fn button_flags(button: MouseButton) -> (u32, u32, usize, usize) {
    use windows_sys::Win32::System::SystemServices::{
        MK_LBUTTON, MK_MBUTTON, MK_RBUTTON, MK_XBUTTON1, MK_XBUTTON2,
    };
    let (down, up, flag, button) = match button {
        MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON, 0),
        MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON, 0),
        MouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON, 0),
        MouseButton::Back => (WM_XBUTTONDOWN, WM_XBUTTONUP, MK_XBUTTON1, XBUTTON1),
        MouseButton::Forward => (WM_XBUTTONDOWN, WM_XBUTTONUP, MK_XBUTTON2, XBUTTON2),
    };
    (down, up, flag as usize, (button as usize) << 16)
}

pub(super) fn virtual_key(key: &str) -> Result<u16> {
    let code = match key.as_bytes() {
        [code @ (b'A'..=b'Z' | b'0'..=b'9')] => u16::from(*code),
        [code @ b'a'..=b'z'] => u16::from(code.to_ascii_uppercase()),
        _ => match key {
            "Shift" => VK_SHIFT,
            "Control" => VK_CONTROL,
            "Alt" => VK_MENU,
            "Meta" => VK_LWIN,
            "Enter" => VK_RETURN,
            "Escape" => VK_ESCAPE,
            "Backspace" => VK_BACK,
            "Tab" => VK_TAB,
            "Space" | " " => VK_SPACE,
            "Delete" => VK_DELETE,
            "Insert" => VK_INSERT,
            "ArrowUp" => VK_UP,
            "ArrowDown" => VK_DOWN,
            "ArrowLeft" => VK_LEFT,
            "ArrowRight" => VK_RIGHT,
            "Home" => VK_HOME,
            "End" => VK_END,
            "PageUp" => VK_PRIOR,
            "PageDown" => VK_NEXT,
            "CapsLock" => VK_CAPITAL,
            "NumLock" => VK_NUMLOCK,
            "ScrollLock" => VK_SCROLL,
            "PrintScreen" => VK_SNAPSHOT,
            "Pause" => VK_PAUSE,
            "ContextMenu" => VK_APPS,
            "Minus" | "-" | "_" => VK_OEM_MINUS,
            "Equal" | "=" | "+" => VK_OEM_PLUS,
            "BracketLeft" | "[" | "{" => VK_OEM_4,
            "BracketRight" | "]" | "}" => VK_OEM_6,
            "Backslash" | "\\" | "|" => VK_OEM_5,
            "Semicolon" | ";" | ":" => VK_OEM_1,
            "Quote" | "'" | "\"" => VK_OEM_7,
            "Comma" | "," | "<" => VK_OEM_COMMA,
            "Period" | "." | ">" => VK_OEM_PERIOD,
            "Slash" | "/" | "?" => VK_OEM_2,
            "Backquote" | "`" | "~" => VK_OEM_3,
            key => match key
                .strip_prefix('F')
                .and_then(|key| key.parse::<u16>().ok())
            {
                Some(number @ 1..=24) => VK_F1 + number - 1,
                _ => return Err(failure("Unsupported Windows key name.")),
            },
        },
    };
    Ok(code)
}
