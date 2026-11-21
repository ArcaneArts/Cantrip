use super::drive;
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::MAX_HOST_CLIPBOARD_BYTES,
};
use rustix::pipe::{PipeFlags, pipe_with};
use std::{
    collections::HashMap,
    fs::File,
    io::{ErrorKind, Read},
    os::fd::AsFd,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    backend::ObjectId,
    event_created_child,
    protocol::{wl_callback, wl_seat},
};
use wayland_protocols_wlr::data_control::v1::client::{
    zwlr_data_control_device_v1 as device, zwlr_data_control_manager_v1 as manager,
    zwlr_data_control_offer_v1 as offer,
};

const TIMEOUT: Duration = Duration::from_millis(900);
const TEXT_TYPES: [&str; 3] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain"];

#[derive(Default)]
struct State {
    selection: Option<offer::ZwlrDataControlOfferV1>,
    formats: HashMap<ObjectId, String>,
    generation: u64,
    finished: bool,
}

pub(super) struct Clipboard {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    device: device::ZwlrDataControlDeviceV1,
}

impl Clipboard {
    pub(super) fn open(
        connection: &Connection,
        manager: &manager::ZwlrDataControlManagerV1,
        seat: &wl_seat::WlSeat,
        cancel: &Cancellation,
    ) -> Result<Self> {
        let queue = connection.new_event_queue();
        let device = manager.get_data_device(seat, &queue.handle(), ());
        let mut clipboard = Self {
            connection: connection.clone(),
            queue,
            state: State::default(),
            device,
        };
        clipboard.generation(cancel)?;
        Ok(clipboard)
    }

    pub(super) fn generation(&mut self, cancel: &Cancellation) -> Result<u64> {
        let done = Arc::new(AtomicBool::new(false));
        self.connection
            .display()
            .sync(&self.queue.handle(), done.clone());
        drive::until(
            &mut self.queue,
            &mut self.state,
            Instant::now() + TIMEOUT,
            cancel,
            |state| {
                if state.finished {
                    Some(Err(failed()))
                } else {
                    done.load(Ordering::Relaxed).then_some(Ok(state.generation))
                }
            },
        )?
    }

    pub(super) fn read_after(
        &mut self,
        previous: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        let deadline = Instant::now() + TIMEOUT;
        let selection = drive::until(
            &mut self.queue,
            &mut self.state,
            deadline,
            cancel,
            |state| {
                if state.finished {
                    return Some(None);
                }
                if state.generation <= previous {
                    return None;
                }
                let selection = state.selection.clone()?;
                Some(
                    state
                        .formats
                        .get(&selection.id())
                        .cloned()
                        .map(|format| (selection, format, state.generation)),
                )
            },
        );
        let (selection, format, generation) = match selection {
            Ok(Some(selection)) => selection,
            Ok(None) => return Ok(None),
            Err(error) if error.code == ErrorCode::CaptureImageTimeout => return Ok(None),
            Err(error) => return Err(error),
        };

        let (reader, writer) = pipe_with(PipeFlags::CLOEXEC).map_err(|_| failed())?;
        let flags = rustix::fs::fcntl_getfl(&reader).map_err(|_| failed())?;
        rustix::fs::fcntl_setfl(&reader, flags | rustix::fs::OFlags::NONBLOCK)
            .map_err(|_| failed())?;
        selection.receive(format, writer.as_fd());
        drop(writer);
        self.connection.flush().map_err(|_| failed())?;
        let mut reader = File::from(reader);
        let mut output = Vec::new();
        let mut chunk = [0; 8192];
        loop {
            cancel.check()?;
            if Instant::now() >= deadline {
                return Ok(None);
            }
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) if output.len() + count <= MAX_HOST_CLIPBOARD_BYTES => {
                    output.extend_from_slice(&chunk[..count]);
                }
                Ok(_) => {
                    return Err(CuaError::new(
                        ErrorCode::Capacity,
                        "Clipboard text exceeds the supported limit.",
                    ));
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    cancel.wait_cancelled(Duration::from_millis(5));
                }
                Err(_) => return Err(failed()),
            }
        }
        if self.generation(cancel)? != generation {
            return Ok(None);
        }
        Ok(String::from_utf8(output).ok())
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        if let Some(offer) = self.state.selection.take() {
            offer.destroy();
        }
        if !self.state.finished {
            self.device.destroy();
        }
        let _ = self.connection.flush();
    }
}

impl Dispatch<device::ZwlrDataControlDeviceV1, ()> for State {
    fn event(
        state: &mut Self,
        device: &device::ZwlrDataControlDeviceV1,
        event: device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            device::Event::Selection { id } => {
                if let Some(previous) = state.selection.take() {
                    state.formats.remove(&previous.id());
                    previous.destroy();
                }
                state.selection = id;
                state.generation = state.generation.saturating_add(1);
            }
            device::Event::PrimarySelection { id: Some(offer) } => {
                state.formats.remove(&offer.id());
                offer.destroy();
            }
            device::Event::Finished => {
                state.finished = true;
                device.destroy();
            }
            _ => {}
        }
    }

    event_created_child!(State, device::ZwlrDataControlDeviceV1, [
        device::EVT_DATA_OFFER_OPCODE => (offer::ZwlrDataControlOfferV1, ())
    ]);
}

impl Dispatch<offer::ZwlrDataControlOfferV1, ()> for State {
    fn event(
        state: &mut Self,
        offer: &offer::ZwlrDataControlOfferV1,
        event: offer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let offer::Event::Offer { mime_type } = event
            && let Some(rank) = TEXT_TYPES.iter().position(|kind| *kind == mime_type)
            && state.formats.get(&offer.id()).is_none_or(|old| {
                TEXT_TYPES
                    .iter()
                    .position(|kind| *kind == old)
                    .is_none_or(|old| rank < old)
            })
        {
            state.formats.insert(offer.id(), mime_type);
        }
    }
}

impl Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> for State {
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

fn failed() -> CuaError {
    CuaError::new(
        ErrorCode::InputFailed,
        "The Wayland clipboard selection is unavailable.",
    )
}
