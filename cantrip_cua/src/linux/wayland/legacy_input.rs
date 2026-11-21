use super::{drive, inventory::Display, legacy_clipboard::Clipboard, monitor_control::Event};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::MAX_HOST_CLIPBOARD_BYTES,
};
use rustix::fs::{MemfdFlags, memfd_create};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Seek, SeekFrom, Write},
    mem::{offset_of, size_of},
    os::unix::net::UnixDatagram,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, EventQueue, QueueHandle, delegate_noop,
    protocol::{wl_callback, wl_pointer, wl_seat},
};
use wayland_protocols_wlr::{
    data_control::v1::client::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1,
    virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
        zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
    },
};

const LEFT_CONTROL: u16 = 29;
const RIGHT_CONTROL: u16 = 97;
const KEY_V: u16 = 47;

pub(super) struct Setup {
    connection: Connection,
    pointer: ZwlrVirtualPointerManagerV1,
    seat: wl_seat::WlSeat,
    seat_name: Option<String>,
    clipboard: Option<ZwlrDataControlManagerV1>,
}

pub(super) struct Session(Mutex<Devices>);

struct Devices {
    connection: Connection,
    pointer: ZwlrVirtualPointerV1,
    pointer_queue: EventQueue<PointerState>,
    keyboard: UnixDatagram,
    pressed: BTreeSet<u16>,
    seat_name: Option<String>,
    clipboard: Option<Clipboard>,
    paste: Option<SelectionOwner>,
    extent: (u32, u32),
    start: Instant,
}

struct PointerState;

impl Setup {
    pub(super) fn new(
        connection: Connection,
        pointer: ZwlrVirtualPointerManagerV1,
        seat: wl_seat::WlSeat,
        seat_name: Option<String>,
        clipboard: Option<ZwlrDataControlManagerV1>,
    ) -> Self {
        Self {
            connection,
            pointer,
            seat,
            seat_name,
            clipboard,
        }
    }

    pub(super) fn open(&self, display: &Display, cancel: &Cancellation) -> Result<Session> {
        cancel.check()?;
        let keyboard = connect_keyboard(&keyboard_socket())?;
        let queue = self.connection.new_event_queue();
        let pointer = self.pointer.create_virtual_pointer_with_output(
            Some(&self.seat),
            Some(&display.proxy),
            &queue.handle(),
            (),
        );
        let mut devices = Devices {
            connection: self.connection.clone(),
            pointer,
            pointer_queue: queue,
            keyboard,
            pressed: BTreeSet::new(),
            seat_name: self.seat_name.clone(),
            clipboard: None,
            paste: None,
            extent: (extent(display.bounds.width), extent(display.bounds.height)),
            start: Instant::now(),
        };
        let done = Arc::new(AtomicBool::new(false));
        self.connection
            .display()
            .sync(&devices.pointer_queue.handle(), done.clone());
        drive::until(
            &mut devices.pointer_queue,
            &mut PointerState,
            Instant::now() + Duration::from_secs(2),
            cancel,
            |_| done.load(Ordering::Relaxed).then_some(()),
        )?;
        devices.clipboard = self.clipboard.as_ref().and_then(|clipboard| {
            Clipboard::open(&self.connection, clipboard, &self.seat, cancel).ok()
        });
        cancel.check()?;
        Ok(Session(Mutex::new(devices)))
    }
}

impl Session {
    pub(super) fn notify(&self, event: &Event, cancel: &Cancellation) -> Result<()> {
        cancel.check()?;
        let mut devices = self.devices()?;
        match event {
            Event::Key(symbol, down) => devices.key(key_code(*symbol)?, *down),
            Event::Text(text) => devices.paste(text, cancel),
            event => devices.pointer(event),
        }
    }

    pub(super) fn watch_clipboard(&self, cancel: &Cancellation) -> Result<Option<u64>> {
        self.devices()?
            .clipboard
            .as_mut()
            .map(|clipboard| clipboard.generation(cancel))
            .transpose()
    }

    pub(super) fn copied_text(
        &self,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        match self.devices()?.clipboard.as_mut() {
            Some(clipboard) => clipboard.read_after(generation, cancel),
            None => Ok(None),
        }
    }

    fn devices(&self) -> Result<MutexGuard<'_, Devices>> {
        self.0.lock().map_err(|_| input_failed())
    }
}

impl Devices {
    fn pointer(&self, event: &Event) -> Result<()> {
        let time = self.start.elapsed().as_millis() as u32;
        match *event {
            Event::Move(point) => {
                let (width, height) = self.extent;
                self.pointer.motion_absolute(
                    time,
                    coordinate(point.x, width),
                    coordinate(point.y, height),
                    width,
                    height,
                );
            }
            Event::Button(code, down) => self.pointer.button(
                time,
                code as u32,
                if down {
                    wl_pointer::ButtonState::Pressed
                } else {
                    wl_pointer::ButtonState::Released
                },
            ),
            Event::Scroll(dx, dy) => {
                self.pointer.axis_source(wl_pointer::AxisSource::Wheel);
                for (axis, delta) in [
                    (wl_pointer::Axis::HorizontalScroll, dx),
                    (wl_pointer::Axis::VerticalScroll, dy),
                ] {
                    if delta != 0.0 {
                        self.pointer.axis(time, axis, delta);
                    }
                }
            }
            _ => return Err(input_failed()),
        }
        self.pointer.frame();
        self.connection.flush().map_err(|_| input_failed())
    }

    fn key(&mut self, code: u16, down: bool) -> Result<()> {
        let value = if down {
            if self.pressed.insert(code) { 1 } else { 2 }
        } else {
            0
        };
        send_event(&self.keyboard, 1, code, value)?;
        send_event(&self.keyboard, 0, 0, 0)?;
        if !down {
            self.pressed.remove(&code);
        }
        Ok(())
    }

    fn paste(&mut self, text: &str, cancel: &Cancellation) -> Result<()> {
        if text.len() > MAX_HOST_CLIPBOARD_BYTES {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Clipboard text exceeds the supported limit.",
            ));
        }
        let clipboard = self.clipboard.as_mut().ok_or_else(|| {
            CuaError::new(
                ErrorCode::InputFailed,
                "This Wayland session does not expose a clipboard for text input.",
            )
        })?;
        let generation = clipboard.generation(cancel)?;
        let paste = SelectionOwner::open(self.seat_name.as_deref(), text)?;
        if clipboard.read_after(generation, cancel)?.as_deref() != Some(text) {
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "The Wayland clipboard did not accept the text.",
            ));
        }
        cancel.check()?;
        if self.pressed.contains(&KEY_V) {
            return Err(input_failed());
        }
        let added_control = ![LEFT_CONTROL, RIGHT_CONTROL]
            .iter()
            .any(|code| self.pressed.contains(code));
        let result = (|| {
            if added_control {
                self.key(LEFT_CONTROL, true)?;
            }
            self.key(KEY_V, true)?;
            self.key(KEY_V, false)
        })();
        if self.pressed.contains(&KEY_V) {
            let _ = self.key(KEY_V, false);
        }
        let release = if added_control && self.pressed.contains(&LEFT_CONTROL) {
            self.key(LEFT_CONTROL, false)
        } else {
            Ok(())
        };
        result.and(release)?;
        self.paste = Some(paste);
        Ok(())
    }
}

impl Drop for Devices {
    fn drop(&mut self) {
        for code in std::mem::take(&mut self.pressed) {
            let _ = self.key(code, false);
        }
        self.pointer.destroy();
        let _ = self.connection.flush();
    }
}

struct SelectionOwner(Child);

impl SelectionOwner {
    fn open(seat: Option<&str>, text: &str) -> Result<Self> {
        let fd = memfd_create("cantrip-paste", MemfdFlags::CLOEXEC).map_err(|_| input_failed())?;
        let mut input = File::from(fd);
        input
            .write_all(text.as_bytes())
            .map_err(|_| input_failed())?;
        input.seek(SeekFrom::Start(0)).map_err(|_| input_failed())?;
        let mut copy = Command::new("wl-copy");
        copy.args(["--foreground", "--type", "text/plain;charset=utf-8"]);
        if let Some(seat) = seat {
            copy.args(["--seat", seat]);
        }
        copy.stdin(Stdio::from(input))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(Self)
            .map_err(|_| {
                CuaError::new(
                    ErrorCode::InputFailed,
                    "Unable to start the Wayland clipboard helper.",
                )
            })
    }
}

impl Drop for SelectionOwner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn keyboard_socket() -> PathBuf {
    std::env::var_os("YDOTOOL_SOCKET")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_RUNTIME_DIR")
                .filter(|path| !path.is_empty())
                .map_or_else(|| PathBuf::from("/tmp"), PathBuf::from)
                .join(".ydotool_socket")
        })
}

fn connect_keyboard(path: &Path) -> Result<UnixDatagram> {
    let unavailable = |_| {
        CuaError::new(
            ErrorCode::InputFailed,
            "Could not connect to the configured Wayland keyboard daemon.",
        )
    };
    let socket = UnixDatagram::unbound().map_err(unavailable)?;
    socket
        .set_write_timeout(Some(Duration::from_millis(250)))
        .map_err(unavailable)?;
    socket.connect(path).map_err(unavailable)?;
    Ok(socket)
}

fn send_event(socket: &UnixDatagram, kind: u16, code: u16, value: i32) -> Result<()> {
    // ydotoold accepts one native Linux input_event per datagram.
    const KIND: usize = offset_of!(libc::input_event, type_);
    const CODE: usize = offset_of!(libc::input_event, code);
    const VALUE: usize = offset_of!(libc::input_event, value);
    let mut event = [0u8; size_of::<libc::input_event>()];
    event[KIND..KIND + 2].copy_from_slice(&kind.to_ne_bytes());
    event[CODE..CODE + 2].copy_from_slice(&code.to_ne_bytes());
    event[VALUE..VALUE + 4].copy_from_slice(&value.to_ne_bytes());
    if socket.send(&event).map_err(|_| input_failed())? == event.len() {
        Ok(())
    } else {
        Err(input_failed())
    }
}

fn key_code(symbol: i32) -> Result<u16> {
    let code = match symbol {
        0xff1b => 1,
        0xff08 => 14,
        0xff09 => 15,
        0xff0d => 28,
        0xffe3 => LEFT_CONTROL,
        0xffe4 => RIGHT_CONTROL,
        0xffe1 => 42,
        0xffe2 => 54,
        0xffe9 => 56,
        0xffea => 100,
        0xffeb => 125,
        0xffec => 126,
        0xffe5 => 58,
        0x20 => 57,
        0xff50 => 102,
        0xff51 => 105,
        0xff52 => 103,
        0xff53 => 106,
        0xff54 => 108,
        0xff55 => 104,
        0xff56 => 109,
        0xff57 => 107,
        0xff63 => 110,
        0xffff => 111,
        0xffbe..=0xffc7 => 59 + (symbol - 0xffbe) as u16,
        0xffc8..=0xffc9 => 87 + (symbol - 0xffc8) as u16,
        0xffca..=0xffd1 => 183 + (symbol - 0xffca) as u16,
        0x21..=0x7e => ascii_code((symbol as u8).to_ascii_lowercase()).ok_or_else(input_failed)?,
        _ => return Err(input_failed()),
    };
    Ok(code)
}

fn ascii_code(key: u8) -> Option<u16> {
    const ROWS: &[(u16, &[u8], &[u8])] = &[
        (2, b"1234567890-=", b"!@#$%^&*()_+"),
        (16, b"qwertyuiop[]", b"{}"),
        (30, b"asdfghjkl;'`", b":\"~"),
        (43, b"\\zxcvbnm,./", b""),
        (43, b"\\", b"|"),
        (51, b",./", b"<>?"),
    ];
    ROWS.iter().find_map(|(start, base, shifted)| {
        base.iter()
            .position(|&entry| entry == key)
            .or_else(|| {
                shifted
                    .iter()
                    .position(|&entry| entry == key)
                    .map(|index| base.len() - shifted.len() + index)
            })
            .map(|offset| start + offset as u16)
    })
}

fn extent(length: f64) -> u32 {
    (length * 256.0).round().clamp(1.0, u32::MAX as f64) as u32
}

fn coordinate(point: f64, extent: u32) -> u32 {
    (point * 256.0).round().clamp(0.0, f64::from(extent - 1)) as u32
}

fn input_failed() -> CuaError {
    CuaError::new(
        ErrorCode::InputFailed,
        "The native Wayland input devices could not accept the input.",
    )
}

delegate_noop!(PointerState: ignore ZwlrVirtualPointerV1);

impl Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> for PointerState {
    fn event(
        _: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        done: &Arc<AtomicBool>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        done.store(true, Ordering::Relaxed);
    }
}
