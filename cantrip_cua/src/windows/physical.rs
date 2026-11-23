use super::{
    failure,
    input::{Control, Packet as InputPacket, modifier_key, virtual_key},
    lifetime::{Shared, verify_window},
    stale,
    targets::{Monitor, PixelCoordinates, Window},
};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Bounds, Point},
};
use cantrip_interaction::{
    host::{Delivery, PostFailure, Prepared},
    input::{InputEvent, Modifier, MouseButton, TextInput},
};
use std::{
    mem::size_of,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::{HMONITOR, MONITOR_DEFAULTTONULL, MonitorFromWindow},
    System::Threading::AttachThreadInput,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Event {
    Key(u16, bool),
    Unicode(u16, bool),
    Mouse(u32, u32),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dispatch {
    Held,
    Release,
    Action,
}

pub(super) struct Packet {
    point: Option<Point>,
    events: Vec<Event>,
    dispatch: Dispatch,
    may_activate: bool,
}

pub(super) fn prepare<'a>(
    bounds: &Bounds,
    event: &InputEvent,
    held: impl Iterator<Item = (&'a Control, &'a InputPacket)>,
) -> Result<Prepared<Control, InputPacket>> {
    let holds: Vec<_> = held.collect();
    let modifiers = |modifiers: &[Modifier], key: Option<u16>| -> Vec<u16> {
        modifiers
            .iter()
            .map(|modifier| modifier_key(*modifier))
            .filter(|&code| {
                Some(code) != key
                    && !holds
                        .iter()
                        .any(|(control, _)| **control == Control::Key(code))
                    && !pressed(code)
            })
            .collect()
    };
    let point = |point: Point| -> Result<Option<Point>> {
        bounds.to_global(point)?;
        Ok(Some(point))
    };
    let packet = |point, events, dispatch| {
        InputPacket::System(Packet {
            point,
            events,
            dispatch,
            may_activate: holds.is_empty(),
        })
    };
    let action = |point, events| Prepared::Action {
        controls: vec![],
        packet: packet(point, events, Dispatch::Action),
    };
    Ok(match event {
        InputEvent::PrepareSurface => action(None, vec![]),
        InputEvent::PointerMove { point: local, .. } => action(point(*local)?, vec![]),
        InputEvent::PointerDown {
            point: local,
            button: logical_button,
            modifiers: requested,
        } => {
            let button = button(*logical_button);
            ensure_releasable(button.key)?;
            let keys = modifiers(requested, None);
            let mut down: Vec<_> = keys.iter().map(|&key| Event::Key(key, false)).collect();
            down.push(button.down);
            let mut up = vec![button.up];
            up.extend(keys.iter().rev().map(|&key| Event::Key(key, true)));
            Prepared::Down {
                control: Control::Button(*logical_button),
                packet: packet(point(*local)?, down, Dispatch::Held),
                release: packet(None, up, Dispatch::Release),
            }
        }
        InputEvent::PointerUp {
            point: local,
            button,
        } => {
            let control = Control::Button(*button);
            let point = point(*local)?;
            let pending = holds.iter().find_map(|(owned, release)| match release {
                InputPacket::System(release) if **owned == control => {
                    Some(packet(point, release.events.clone(), Dispatch::Release))
                }
                _ => None,
            });
            Prepared::Up {
                control,
                packet: pending,
            }
        }
        InputEvent::Scroll {
            point: local,
            delta_x,
            delta_y,
            modifiers: requested,
        } => {
            let keys = modifiers(requested, None);
            let mut events: Vec<_> = keys.iter().map(|&key| Event::Key(key, false)).collect();
            events.extend(
                [
                    (MOUSEEVENTF_WHEEL, delta_y.saturating_neg()),
                    (MOUSEEVENTF_HWHEEL, *delta_x),
                ]
                .into_iter()
                .filter(|(_, delta)| *delta != 0)
                .map(|(flag, delta)| Event::Mouse(flag, delta as u32)),
            );
            events.extend(keys.iter().rev().map(|&key| Event::Key(key, true)));
            action(point(*local)?, events)
        }
        InputEvent::KeyDown {
            key,
            modifiers: requested,
            repeat,
        } => {
            let key = virtual_key(key)?;
            let control = Control::Key(key);
            if *repeat {
                Prepared::Repeat {
                    control,
                    packet: packet(None, vec![Event::Key(key, false)], Dispatch::Held),
                }
            } else {
                ensure_releasable(key)?;
                let keys = modifiers(requested, Some(key));
                let mut down: Vec<_> = keys.iter().map(|&key| Event::Key(key, false)).collect();
                down.push(Event::Key(key, false));
                let mut up = vec![Event::Key(key, true)];
                up.extend(keys.iter().rev().map(|&key| Event::Key(key, true)));
                Prepared::Down {
                    control,
                    packet: packet(None, down, Dispatch::Held),
                    release: packet(None, up, Dispatch::Release),
                }
            }
        }
        InputEvent::KeyUp { key } => Prepared::Up {
            control: Control::Key(virtual_key(key)?),
            packet: None,
        },
        InputEvent::Text(TextInput::Commit(text)) => action(
            None,
            text.replace("\r\n", "\r")
                .replace('\n', "\r")
                .encode_utf16()
                .flat_map(|unit| [Event::Unicode(unit, false), Event::Unicode(unit, true)])
                .collect(),
        ),
        _ => {
            return Err(failure(
                "This Windows desktop input operation is unavailable.",
            ));
        }
    })
}

pub(super) fn post_monitor(
    monitor: &Monitor,
    packet: &Packet,
) -> std::result::Result<Delivery, PostFailure<CuaError>> {
    let _coordinates = PixelCoordinates::enter();
    if packet.point.is_none() && !packet.events.is_empty() && packet.dispatch != Dispatch::Release {
        monitor.verify().map_err(PostFailure::NotDispatched)?;
        monitor_focus(monitor).map_err(PostFailure::NotDispatched)?;
    }
    let motion = packet
        .point
        .map(|point| {
            monitor.verify()?;
            absolute_motion(monitor.target.bounds.to_global(point)?)
        })
        .transpose();
    dispatch_input(packet, motion)
}

pub(super) fn post_window(
    registry: &Shared,
    window: &Window,
    packet: &Packet,
    cancel: &Cancellation,
) -> std::result::Result<Delivery, PostFailure<CuaError>> {
    let _coordinates = PixelCoordinates::enter();
    if packet.dispatch == Dispatch::Release {
        // Release recorded holds after focus loss without reactivating the
        // window or moving the pointer into another application.
        let motion = packet
            .point
            .map(|point| {
                verify_window(registry, window)?;
                let info = focused_window_info(window)?;
                window_motion(window, point, &info)
            })
            .transpose();
        return dispatch_input(packet, motion);
    }
    if packet.point.is_none() && packet.events.is_empty() {
        return Ok(Delivery::DispatchedUnverified);
    }

    let post = || {
        cancel.check()?;
        verify_window(registry, window)?;
        let info = match focused_window_info(window) {
            Ok(info) => info,
            Err(_) if packet.may_activate => {
                let info = focus_window(window, cancel)?;
                verify_window(registry, window)?;
                info
            }
            Err(error) => return Err(error),
        };
        let motion = packet
            .point
            .map(|point| window_motion(window, point, &info))
            .transpose()?;
        cancel.check()?;
        if !window_is_focused(window) {
            return Err(window_focus_denied());
        }
        Ok(motion)
    };
    let motion = post().map_err(PostFailure::NotDispatched)?;
    dispatch_input(packet, Ok(motion))
}

fn dispatch_input(
    packet: &Packet,
    motion: Result<Option<INPUT>>,
) -> std::result::Result<Delivery, PostFailure<CuaError>> {
    let mut inputs = Vec::with_capacity(packet.events.len() + usize::from(packet.point.is_some()));
    if packet.dispatch == Dispatch::Release {
        inputs.extend(motion.ok().flatten());
    } else {
        inputs.extend(motion.map_err(PostFailure::NotDispatched)?);
    }
    let motion_count = inputs.len();
    inputs.extend(packet.events.iter().map(|event| event.native()));
    let sent = send(&inputs);
    if sent == inputs.len() {
        return Ok(Delivery::DispatchedUnverified);
    }
    if sent == 0 {
        return Err(PostFailure::NotDispatched(CuaError::new(
            ErrorCode::InputFailed,
            "Windows declined desktop input.",
        )));
    }

    // InputHost owns cleanup for held inputs. One-shot batches may also leave a
    // modifier or a Unicode packet down. Release only the accepted prefix.
    let accepted = sent.saturating_sub(motion_count).min(packet.events.len());
    match packet.dispatch {
        Dispatch::Held => {}
        Dispatch::Release => {
            send(&inputs[sent..]);
        }
        Dispatch::Action => {
            let releases: Vec<_> = pending_releases(&packet.events[..accepted])
                .into_iter()
                .rev()
                .map(Event::native)
                .collect();
            send(&releases);
        }
    }
    Err(PostFailure::Uncertain(CuaError::new(
        ErrorCode::InputUnknown,
        "Windows accepted only part of the desktop input.",
    )))
}

pub(super) fn window_is_focused(window: &Window) -> bool {
    let hwnd = window.identity.hwnd as HWND;
    unsafe { GetForegroundWindow() == hwnd && IsIconic(hwnd) == 0 }
}

fn focus_window(window: &Window, cancel: &Cancellation) -> Result<GUITHREADINFO> {
    let hwnd = window.identity.hwnd as HWND;
    if unsafe { IsIconic(hwnd) } != 0 && unsafe { ShowWindowAsync(hwnd, SW_RESTORE) } == 0 {
        return Err(window_focus_denied());
    }
    if !window_is_focused(window)
        && unsafe { SetForegroundWindow(hwnd) } == 0
        && !window_is_focused(window)
    {
        let foreground = unsafe { GetForegroundWindow() };
        let thread = unsafe { GetWindowThreadProcessId(foreground, std::ptr::null_mut()) };
        let joined = (thread != 0 && thread != window.identity.thread)
            .then(|| InputThreads::join(thread, window.identity.thread))
            .transpose()?;
        if unsafe { GetForegroundWindow() } == foreground {
            cancel.check()?;
            window.verify_identity()?;
            unsafe {
                SetForegroundWindow(hwnd);
                BringWindowToTop(hwnd);
            }
        }
        drop(joined);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        cancel.check()?;
        if let Ok(info) = focused_window_info(window) {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            return Err(window_focus_denied());
        }
        cancel.wait_cancelled(Duration::from_millis(15));
    }
}

struct InputThreads {
    foreground: u32,
    target: u32,
}

impl InputThreads {
    fn join(foreground: u32, target: u32) -> Result<Self> {
        if unsafe { AttachThreadInput(foreground, target, 1) } == 0 {
            return Err(window_focus_denied());
        }
        Ok(Self { foreground, target })
    }
}

impl Drop for InputThreads {
    fn drop(&mut self) {
        unsafe { AttachThreadInput(self.foreground, self.target, 0) };
    }
}

fn focused_window_info(window: &Window) -> Result<GUITHREADINFO> {
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(0, &mut info) } == 0
        || info.hwndActive != window.identity.hwnd as HWND
        || (!info.hwndFocus.is_null() && window.recipient_thread(info.hwndFocus).is_none())
        || !window_is_focused(window)
    {
        return Err(window_focus_denied());
    }
    Ok(info)
}

fn window_motion(window: &Window, local: Point, focused: &GUITHREADINFO) -> Result<INPUT> {
    let mut info = WINDOWINFO {
        cbSize: size_of::<WINDOWINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetWindowInfo(window.identity.hwnd as HWND, &mut info) } == 0 {
        return Err(stale());
    }
    let rect = info.rcClient;
    let bounds = &window.target.bounds;
    if bounds.width != f64::from(rect.right - rect.left)
        || bounds.height != f64::from(rect.bottom - rect.top)
    {
        return Err(stale());
    }
    let current = Bounds {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        ..*bounds
    };
    let global = current.to_global(local)?;
    let point = POINT {
        x: global.x.floor() as i32,
        y: global.y.floor() as i32,
    };
    if window
        .recipient_thread(unsafe { WindowFromPoint(point) })
        .is_none()
        || (!focused.hwndCapture.is_null()
            && window.recipient_thread(focused.hwndCapture).is_none())
    {
        return Err(CuaError::new(
            ErrorCode::PermissionDenied,
            "The pointer point is covered by another Windows application.",
        ));
    }
    absolute_motion(global)
}

fn window_focus_denied() -> CuaError {
    CuaError::new(
        ErrorCode::PermissionDenied,
        "Windows did not grant foreground input to the selected window.",
    )
}

pub(super) fn monitor_focus(monitor: &Monitor) -> Result<usize> {
    let _coordinates = PixelCoordinates::enter();
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() || unsafe { IsIconic(foreground) } != 0 {
        return Err(outside());
    }
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let mut recipient = foreground;
    if unsafe { GetGUIThreadInfo(0, &mut info) } != 0
        && !info.hwndFocus.is_null()
        && (info.hwndFocus == foreground || unsafe { IsChild(foreground, info.hwndFocus) } != 0)
    {
        recipient = info.hwndFocus;
    }
    if unsafe { MonitorFromWindow(recipient, MONITOR_DEFAULTTONULL) } != monitor.handle as HMONITOR
        || unsafe { GetForegroundWindow() } != foreground
    {
        return Err(outside());
    }
    Ok(foreground as usize)
}

fn absolute_motion(global: Point) -> Result<INPUT> {
    let x = normalized(
        global.x.floor() as i32,
        unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) },
        unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) },
    )?;
    let y = normalized(
        global.y.floor() as i32,
        unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) },
        unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) },
    )?;
    Ok(mouse(
        x,
        y,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        0,
    ))
}

fn normalized(pixel: i32, origin: i32, span: i32) -> Result<i32> {
    let offset = i64::from(pixel) - i64::from(origin);
    if !(1..=65536).contains(&span) || !(0..i64::from(span)).contains(&offset) {
        return Err(stale());
    }
    // Choose the first normalized coordinate that maps to the requested pixel.
    let span = i64::from(span);
    Ok(((offset * 65536 + span - 1) / span) as i32)
}

fn outside() -> CuaError {
    CuaError::new(
        ErrorCode::PermissionDenied,
        "Keyboard focus is outside the selected Windows display.",
    )
}

fn pressed(key: u16) -> bool {
    unsafe { GetAsyncKeyState(i32::from(key)) < 0 }
}

fn ensure_releasable(key: u16) -> Result<()> {
    if pressed(key) {
        return Err(CuaError::new(
            ErrorCode::OwnershipMismatch,
            "That Windows key or button is already held.",
        ));
    }
    Ok(())
}

struct Button {
    key: u16,
    down: Event,
    up: Event,
}

fn button(mut button: MouseButton) -> Button {
    if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
        button = match button {
            MouseButton::Left => MouseButton::Right,
            MouseButton::Right => MouseButton::Left,
            other => other,
        };
    }
    let (key, down, up, data) = match button {
        MouseButton::Left => (VK_LBUTTON, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
        MouseButton::Right => (VK_RBUTTON, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
        MouseButton::Middle => (VK_MBUTTON, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
        MouseButton::Back => (
            VK_XBUTTON1,
            MOUSEEVENTF_XDOWN,
            MOUSEEVENTF_XUP,
            u32::from(XBUTTON1),
        ),
        MouseButton::Forward => (
            VK_XBUTTON2,
            MOUSEEVENTF_XDOWN,
            MOUSEEVENTF_XUP,
            u32::from(XBUTTON2),
        ),
    };
    Button {
        key,
        down: Event::Mouse(down, data),
        up: Event::Mouse(up, data),
    }
}

fn pending_releases(events: &[Event]) -> Vec<Event> {
    let mut releases = Vec::new();
    for event in events {
        match *event {
            Event::Key(key, false) => releases.push(Event::Key(key, true)),
            Event::Unicode(unit, false) => releases.push(Event::Unicode(unit, true)),
            Event::Key(_, true) | Event::Unicode(_, true) => {
                if let Some(index) = releases.iter().rposition(|release| release == event) {
                    releases.remove(index);
                }
            }
            Event::Mouse(..) => {}
        }
    }
    releases
}

impl Event {
    fn native(self) -> INPUT {
        match self {
            Self::Mouse(flags, data) => mouse(0, 0, flags, data),
            Self::Key(code, release) => {
                let mapped = unsafe { MapVirtualKeyW(u32::from(code), MAPVK_VK_TO_VSC_EX) };
                let flags = if mapped & 0xff00 == 0xe000 {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    0
                };
                keyboard(code, (mapped & 0xff) as u16, flags, release)
            }
            Self::Unicode(unit, release) => keyboard(0, unit, KEYEVENTF_UNICODE, release),
        }
    }
}

fn mouse(x: i32, y: i32, flags: u32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn keyboard(code: u16, scan: u16, flags: u32, release: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                wScan: scan,
                dwFlags: flags | if release { KEYEVENTF_KEYUP } else { 0 },
                ..Default::default()
            },
        },
    }
}

fn send(inputs: &[INPUT]) -> usize {
    if inputs.is_empty() {
        return 0;
    }
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        ) as usize
    }
}
