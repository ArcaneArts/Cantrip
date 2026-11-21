use super::failure;
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::MAX_HOST_CLIPBOARD_BYTES,
};
use std::time::{Duration, Instant};
use x11rb::{
    NONE,
    connection::Connection,
    protocol::{
        Event,
        res::ConnectionExt as _,
        xfixes::{ConnectionExt as _, SelectionEvent, SelectionEventMask},
        xproto::{
            Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, GetPropertyReply,
            Property, Timestamp, Window, WindowClass,
        },
    },
    rust_connection::RustConnection,
};

const COPY_TIMEOUT: Duration = Duration::from_millis(900);

pub(super) struct Selection {
    connection: RustConnection,
    requestor: Window,
    clipboard: Atom,
    property: Atom,
    utf8: Atom,
    incr: Atom,
}

impl Selection {
    pub(super) fn subscribe(display: &str) -> Result<Self> {
        let (connection, screen) = x11rb::connect(Some(display)).map_err(failure)?;
        let root = connection.setup().roots[screen].root;
        let atom = |name: &[u8]| -> Result<Atom> {
            Ok(connection
                .intern_atom(false, name)
                .map_err(failure)?
                .reply()
                .map_err(failure)?
                .atom)
        };
        let clipboard = atom(b"CLIPBOARD")?;
        let property = atom(b"CANTRIP_HOST_SELECTION")?;
        let utf8 = atom(b"UTF8_STRING")?;
        let incr = atom(b"INCR")?;
        let requestor = connection.generate_id().map_err(failure)?;
        connection
            .create_window(
                0,
                requestor,
                root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .map_err(failure)?
            .check()
            .map_err(failure)?;
        connection
            .xfixes_query_version(2, 0)
            .map_err(failure)?
            .reply()
            .map_err(|_| unavailable())?;
        connection
            .xfixes_select_selection_input(
                requestor,
                clipboard,
                SelectionEventMask::SET_SELECTION_OWNER
                    | SelectionEventMask::SELECTION_WINDOW_DESTROY
                    | SelectionEventMask::SELECTION_CLIENT_CLOSE,
            )
            .map_err(failure)?
            .check()
            .map_err(failure)?;
        // Changes already queued before posting Ctrl+C cannot provide the reply.
        while connection.poll_for_event().map_err(failure)?.is_some() {}
        Ok(Self {
            connection,
            requestor,
            clipboard,
            property,
            utf8,
            incr,
        })
    }

    pub(super) fn read(&self, window: Window, cancel: &Cancellation) -> Result<Option<String>> {
        let deadline = Instant::now() + COPY_TIMEOUT;
        while let Some(event) = self.next_event(deadline, cancel)? {
            let Event::XfixesSelectionNotify(change) = event else {
                continue;
            };
            if change.subtype != SelectionEvent::SET_SELECTION_OWNER
                || change.owner == NONE
                || !self.same_client(window, change.owner)?
                || self.owner()? != change.owner
            {
                continue;
            }
            let Some((target, first)) =
                self.convert(change.selection_timestamp, deadline, cancel)?
            else {
                return Ok(None);
            };
            let Some(bytes) = self.receive(target, first, deadline, cancel)? else {
                return Ok(None);
            };
            if self.owner()? != change.owner {
                return Ok(None);
            }
            while let Some(event) = self.connection.poll_for_event().map_err(failure)? {
                if matches!(event, Event::XfixesSelectionNotify(_)) {
                    return Ok(None);
                }
                cancel.check()?;
            }
            return if target == Atom::from(AtomEnum::STRING) {
                Ok(Some(bytes.into_iter().map(char::from).collect()))
            } else {
                Ok(String::from_utf8(bytes).ok())
            };
        }
        Ok(None)
    }

    fn same_client(&self, window: Window, owner: Window) -> Result<bool> {
        if owner == window {
            return Ok(true);
        }
        // Clipboard owners are often hidden windows. Use X server resource
        // identities to correlate them with the selected application connection.
        let clients = self
            .connection
            .res_query_clients()
            .map_err(failure)?
            .reply()
            .map_err(|_| unavailable())?;
        Ok(clients.clients.iter().any(|client| {
            let mask = !client.resource_mask;
            window & mask == client.resource_base && owner & mask == client.resource_base
        }))
    }

    fn owner(&self) -> Result<Window> {
        Ok(self
            .connection
            .get_selection_owner(self.clipboard)
            .map_err(failure)?
            .reply()
            .map_err(failure)?
            .owner)
    }

    fn next_event(&self, deadline: Instant, cancel: &Cancellation) -> Result<Option<Event>> {
        loop {
            cancel.check()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            if let Some(event) = self.connection.poll_for_event().map_err(failure)? {
                return Ok(Some(event));
            }
            cancel.wait_cancelled(remaining.min(Duration::from_millis(5)));
        }
    }

    fn convert(
        &self,
        timestamp: Timestamp,
        deadline: Instant,
        cancel: &Cancellation,
    ) -> Result<Option<(Atom, GetPropertyReply)>> {
        for target in [self.utf8, Atom::from(AtomEnum::STRING)] {
            self.connection
                .convert_selection(
                    self.requestor,
                    self.clipboard,
                    target,
                    self.property,
                    timestamp,
                )
                .map_err(failure)?
                .check()
                .map_err(failure)?;
            loop {
                match self.next_event(deadline, cancel)? {
                    Some(Event::SelectionNotify(reply))
                        if reply.requestor == self.requestor
                            && reply.selection == self.clipboard
                            && reply.target == target
                            && reply.time == timestamp =>
                    {
                        if reply.property == self.property {
                            return Ok(Some((target, self.take_property()?)));
                        }
                        if reply.property == NONE {
                            break;
                        }
                    }
                    Some(Event::XfixesSelectionNotify(_)) | None => return Ok(None),
                    _ => {}
                }
            }
        }
        Ok(None)
    }

    fn take_property(&self) -> Result<GetPropertyReply> {
        let reply = self
            .connection
            .get_property(
                true,
                self.requestor,
                self.property,
                AtomEnum::ANY,
                0,
                (MAX_HOST_CLIPBOARD_BYTES / 4) as u32,
            )
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        if reply.bytes_after > 0 {
            return Err(too_large());
        }
        Ok(reply)
    }

    fn receive(
        &self,
        target: Atom,
        first: GetPropertyReply,
        deadline: Instant,
        cancel: &Cancellation,
    ) -> Result<Option<Vec<u8>>> {
        let valid = |property: &GetPropertyReply| property.type_ == target && property.format == 8;
        if first.type_ != self.incr {
            return Ok(valid(&first).then_some(first.value));
        }
        let Some(minimum) = first.value32().and_then(|mut units| units.next()) else {
            return Ok(None);
        };
        if minimum as usize > MAX_HOST_CLIPBOARD_BYTES {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        while let Some(event) = self.next_event(deadline, cancel)? {
            match event {
                Event::PropertyNotify(change)
                    if change.window == self.requestor
                        && change.atom == self.property
                        && change.state == Property::NEW_VALUE =>
                {
                    let chunk = self.take_property()?;
                    if !valid(&chunk) {
                        return Ok(None);
                    }
                    if chunk.value.is_empty() {
                        return Ok(Some(bytes));
                    }
                    if bytes.len() + chunk.value.len() > MAX_HOST_CLIPBOARD_BYTES {
                        return Err(too_large());
                    }
                    bytes.extend(chunk.value);
                }
                Event::XfixesSelectionNotify(_) => return Ok(None),
                _ => {}
            }
        }
        Ok(None)
    }
}

fn too_large() -> CuaError {
    CuaError::new(
        ErrorCode::Capacity,
        "Clipboard text exceeds the supported limit.",
    )
}

fn unavailable() -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "X11 clipboard ownership is unavailable.",
    )
}
