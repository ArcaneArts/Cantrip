use super::{monitor_control::Event, portal::bounded};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::Bounds,
};
use async_channel::{Receiver, Sender};
use futures_lite::{StreamExt, future};
use reis::{
    ei,
    event::{Connection, Device, DeviceCapability as Capability, EiEvent, Region},
};
use std::{os::unix::net::UnixStream, thread, time::Duration};
use zbus::zvariant::OwnedFd;

const READY_TIMEOUT: Duration = Duration::from_secs(3);
const INPUT_TIMEOUT: Duration = Duration::from_secs(2);
const TEXT_FRAME_BYTES: usize = 254;

pub(super) struct SelectedOutput {
    pub(super) bounds: Bounds,
    pub(super) mapping_id: Option<String>,
}

struct Dispatch {
    event: Event,
    cancel: Cancellation,
    reply: Sender<Result<()>>,
}

pub(super) struct EmulatedInput {
    commands: Sender<Dispatch>,
    stop: Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl EmulatedInput {
    pub(super) async fn start(
        fd: OwnedFd,
        output: SelectedOutput,
        cancel: &Cancellation,
    ) -> Result<Self> {
        let (commands, pending) = async_channel::bounded(1);
        let (ready, initialized) = async_channel::bounded(1);
        let (stop, stopped) = async_channel::bounded::<()>(1);
        let thread = thread::Builder::new()
            .name("cantrip-wayland-emulated-input".into())
            .spawn(move || {
                let _ = async_io::block_on(future::or(
                    async {
                        let _ = stopped.recv().await;
                        Ok(())
                    },
                    run(fd, output, &pending, ready),
                ));
            })
            .map_err(|_| unavailable())?;
        let endpoint = Self {
            commands,
            stop,
            thread: Some(thread),
        };
        bounded(
            async { initialized.recv().await.map_err(|_| unavailable()) },
            READY_TIMEOUT,
            cancel,
        )
        .await?;
        Ok(endpoint)
    }

    pub(super) fn is_closed(&self) -> bool {
        self.commands.is_closed()
    }

    pub(super) fn send(&self, event: &Event, cancel: &Cancellation) -> Result<()> {
        async_io::block_on(bounded(
            async {
                let (reply, result) = async_channel::bounded(1);
                self.commands
                    .try_send(Dispatch {
                        event: event.clone(),
                        cancel: cancel.clone(),
                        reply,
                    })
                    .map_err(|_| disconnected())?;
                result.recv().await.map_err(|_| disconnected())?
            },
            INPUT_TIMEOUT,
            cancel,
        ))
    }
}

impl Drop for EmulatedInput {
    fn drop(&mut self) {
        self.stop.close();
        self.commands.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Incoming {
    Event(Option<std::result::Result<EiEvent, reis::Error>>),
    Input(Option<Dispatch>),
}

async fn run(
    fd: OwnedFd,
    output: SelectedOutput,
    pending: &Receiver<Dispatch>,
    ready: Sender<()>,
) -> Result<()> {
    let socket = UnixStream::from(std::os::fd::OwnedFd::from(fd));
    let context = ei::Context::new(socket).map_err(|_| unavailable())?;
    let (connection, mut events) = context
        .handshake_async_io("Cantrip", ei::handshake::ContextType::Sender)
        .await
        .map_err(|_| unavailable())?;
    let mut devices = Vec::new();
    let mut active: Option<Devices> = None;
    loop {
        match future::or(async { Incoming::Event(events.next().await) }, async {
            Incoming::Input(pending.recv().await.ok())
        })
        .await
        {
            Incoming::Event(Some(Ok(event))) => {
                match event {
                    EiEvent::SeatAdded(added) => added.seat.bind_capabilities(
                        Capability::Text
                            | Capability::PointerAbsolute
                            | Capability::Button
                            | Capability::Scroll,
                    ),
                    EiEvent::DeviceResumed(resumed) => {
                        if !devices.contains(&resumed.device) {
                            devices.push(resumed.device);
                        }
                    }
                    EiEvent::DevicePaused(paused) => {
                        devices.retain(|device| *device != paused.device);
                    }
                    EiEvent::DeviceRemoved(removed) => {
                        devices.retain(|device| *device != removed.device);
                    }
                    EiEvent::Disconnected(_) => return Err(disconnected()),
                    _ => {}
                }
                connection.flush().map_err(|_| disconnected())?;
                if let Some(selected) = &active {
                    if !devices.contains(&selected.text) || !devices.contains(&selected.pointer) {
                        return Err(disconnected());
                    }
                } else if let Some(selected) = Devices::select(&devices, &output) {
                    selected
                        .pointer
                        .device()
                        .start_emulating(connection.serial(), 1);
                    if selected.text != selected.pointer {
                        selected
                            .text
                            .device()
                            .start_emulating(connection.serial(), 2);
                    }
                    connection.flush().map_err(|_| disconnected())?;
                    active = Some(selected);
                    ready.try_send(()).map_err(|_| disconnected())?;
                }
            }
            Incoming::Event(_) => return Err(disconnected()),
            Incoming::Input(Some(command)) => {
                let result = active
                    .as_ref()
                    .ok_or_else(unavailable)
                    .and_then(|selected| {
                        selected.post(&connection, &output, command.event, &command.cancel)
                    });
                let delivered = result.is_ok();
                let _ = command.reply.try_send(result);
                if !delivered {
                    return Err(disconnected());
                }
            }
            Incoming::Input(None) => return Ok(()),
        }
    }
}

struct Devices {
    text: Device,
    pointer: Device,
}

impl Devices {
    fn select(devices: &[Device], output: &SelectedOutput) -> Option<Self> {
        let pointer = devices.iter().find(|device| {
            device.has_capability(Capability::PointerAbsolute)
                && device.has_capability(Capability::Button)
                && device.has_capability(Capability::Scroll)
                && device
                    .regions()
                    .iter()
                    .any(|region| matches_region(region, output))
        })?;
        let text = devices.iter().find(|device| {
            device.seat() == pointer.seat() && device.has_capability(Capability::Text)
        })?;
        Some(Self {
            text: text.clone(),
            pointer: pointer.clone(),
        })
    }

    fn post(
        &self,
        connection: &Connection,
        output: &SelectedOutput,
        event: Event,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        match event {
            Event::Text(text) => return self.commit(connection, &text, cancel),
            Event::Key(key, down) => return self.key(connection, key as u32, down),
            Event::Move(point) => {
                let x = pointer_coordinate(point.x, output.bounds.x, output.bounds.width)?;
                let y = pointer_coordinate(point.y, output.bounds.y, output.bounds.height)?;
                self.pointer
                    .interface::<ei::PointerAbsolute>()
                    .ok_or_else(disconnected)?
                    .motion_absolute(x, y);
            }
            Event::Button(code, down) => {
                let state = if down {
                    ei::button::ButtonState::Press
                } else {
                    ei::button::ButtonState::Released
                };
                self.pointer
                    .interface::<ei::Button>()
                    .ok_or_else(disconnected)?
                    .button(code as u32, state);
            }
            Event::Scroll(x, y) => {
                if x == 0.0 && y == 0.0 {
                    return Ok(());
                }
                let scroll = self
                    .pointer
                    .interface::<ei::Scroll>()
                    .ok_or_else(disconnected)?;
                scroll.scroll(x as f32, y as f32);
                frame(connection, &self.pointer)?;
                scroll.scroll_stop(u32::from(x != 0.0), u32::from(y != 0.0), 0);
            }
        }
        frame(connection, &self.pointer)
    }

    fn key(&self, connection: &Connection, symbol: u32, down: bool) -> Result<()> {
        let state = if down {
            ei::keyboard::KeyState::Press
        } else {
            ei::keyboard::KeyState::Released
        };
        self.text
            .interface::<ei::Text>()
            .ok_or_else(disconnected)?
            .keysym(symbol, state);
        frame(connection, &self.text)
    }

    fn commit(&self, connection: &Connection, text: &str, cancel: &Cancellation) -> Result<()> {
        let text = text.replace("\r\n", "\n");
        let mut remaining = text.as_str();
        let device = self.text.interface::<ei::Text>().ok_or_else(disconnected)?;
        while !remaining.is_empty() {
            cancel.check()?;
            match remaining.as_bytes()[0] {
                b'\r' | b'\n' | b'\t' => {
                    let symbol = if remaining.starts_with('\t') {
                        0xff09
                    } else {
                        0xff0d
                    };
                    self.key(connection, symbol, true)?;
                    self.key(connection, symbol, false)?;
                    remaining = &remaining[1..];
                }
                0 => remaining = &remaining[1..],
                _ => {
                    let mut end = remaining
                        .find(['\r', '\n', '\t', '\0'])
                        .unwrap_or(remaining.len())
                        .min(TEXT_FRAME_BYTES);
                    while !remaining.is_char_boundary(end) {
                        end -= 1;
                    }
                    device.utf8(&remaining[..end]);
                    frame(connection, &self.text)?;
                    remaining = &remaining[end..];
                }
            }
        }
        Ok(())
    }
}

fn matches_region(region: &Region, output: &SelectedOutput) -> bool {
    let bounds = output.bounds;
    output
        .mapping_id
        .as_ref()
        .is_none_or(|id| region.mapping_id.as_ref() == Some(id))
        && f64::from(region.x) == bounds.x
        && f64::from(region.y) == bounds.y
        && f64::from(region.width) == bounds.width
        && f64::from(region.height) == bounds.height
}

fn pointer_coordinate(local: f64, origin: f64, size: f64) -> Result<f32> {
    if !(0.0..size).contains(&local) {
        return Err(CuaError::new(
            ErrorCode::InputFailed,
            "The pointer is outside the shared output.",
        ));
    }
    let mut absolute = (origin + local) as f32;
    if f64::from(absolute) >= origin + size {
        absolute = absolute.next_down();
    }
    Ok(absolute)
}

fn frame(connection: &Connection, device: &Device) -> Result<()> {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    let micros = now.tv_sec as u64 * 1_000_000 + now.tv_nsec as u64 / 1_000;
    device.device().frame(connection.serial(), micros);
    connection.flush().map_err(|_| disconnected())
}

fn unavailable() -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "The Wayland portal has no matching emulated input devices.",
    )
}

fn disconnected() -> CuaError {
    CuaError::new(
        ErrorCode::InputFailed,
        "The Wayland emulated input session ended.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_rounding_keeps_the_event_on_the_shared_output() {
        assert_eq!(pointer_coordinate(16.5, 1280.0, 640.0).unwrap(), 1296.5);
        assert!(pointer_coordinate(639.999_999, 1280.0, 640.0).unwrap() < 1920.0);
        assert!(pointer_coordinate(640.0, 1280.0, 640.0).is_err());
        assert!(pointer_coordinate(-0.5, 1280.0, 640.0).is_err());
    }
}
