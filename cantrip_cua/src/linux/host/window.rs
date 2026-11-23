use super::{Windows, capture, failure, lock, missing, stale};
use crate::{
    backend::Capture,
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Bounds, Point, Target, TargetKind, is_cantrip_application_name},
};
use std::{
    collections::HashSet,
    fs,
    sync::{Arc, Mutex},
};
use x11rb::{
    CURRENT_TIME, NONE,
    connection::Connection,
    errors::ReplyError,
    protocol::{
        ErrorKind, Event,
        composite::{ConnectionExt as _, Redirect},
        xproto::{
            Atom, AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ChangeWindowAttributesAux,
            ConnectionExt, EventMask, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, KeyButMask,
            KeyPressEvent, MOTION_NOTIFY_EVENT, MapState, WindowClass,
        },
    },
    rust_connection::RustConnection,
};

#[derive(Clone, Copy)]
pub(super) struct Atoms {
    clients: Atom,
    pid: Atom,
    name: Atom,
    utf8: Atom,
    active: Atom,
}

impl Atoms {
    pub(super) fn new(connection: &RustConnection) -> Result<Self> {
        let atom = |name: &[u8]| -> Result<Atom> {
            Ok(connection
                .intern_atom(false, name)
                .map_err(failure)?
                .reply()
                .map_err(failure)?
                .atom)
        };
        Ok(Self {
            clients: atom(b"_NET_CLIENT_LIST_STACKING")?,
            pid: atom(b"_NET_WM_PID")?,
            name: atom(b"_NET_WM_NAME")?,
            utf8: atom(b"UTF8_STRING")?,
            active: atom(b"_NET_ACTIVE_WINDOW")?,
        })
    }
}

pub(super) fn list(
    connection: &RustConnection,
    root: u32,
    atoms: &Atoms,
    limit: usize,
) -> Result<Vec<u32>> {
    let list = connection
        .get_property(
            false,
            root,
            atoms.clients,
            AtomEnum::WINDOW,
            0,
            (limit + 1) as u32,
        )
        .map_err(failure)?
        .reply()
        .map_err(failure)?;
    if let Some(clients) = list.value32() {
        let mut windows: Vec<_> = clients.collect();
        windows.reverse();
        return Ok(windows);
    }
    let tree = connection
        .query_tree(root)
        .map_err(failure)?
        .reply()
        .map_err(failure)?;
    Ok(tree.children.into_iter().rev().take(limit + 1).collect())
}

pub(super) fn watch(connection: &RustConnection, window: u32) -> Result<()> {
    connection
        .change_window_attributes(
            window,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        )
        .map_err(failure)?
        .check()
        .map_err(failure)
}

pub(super) fn drain_destroyed(connection: &RustConnection, windows: &mut Windows) -> Result<()> {
    while let Some(event) = connection.poll_for_event().map_err(failure)? {
        if let Event::DestroyNotify(event) = event {
            windows.remove(&event.window);
        }
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Identity {
    class: Option<String>,
    pid: Option<u32>,
    start: Option<u64>,
    protected: bool,
}

pub(super) struct Snapshot {
    pub(super) id: u32,
    pub(super) identity: Identity,
    pub(super) target: Target,
    border: i16,
    visual: u32,
}

#[derive(Clone)]
pub(in crate::linux) struct Pin {
    root: u32,
    atoms: Atoms,
    windows: Arc<Mutex<Windows>>,
    id: u32,
    generation: u64,
    identity: Identity,
}

impl Pin {
    pub(super) fn new(
        root: u32,
        atoms: Atoms,
        windows: Arc<Mutex<Windows>>,
        window: &Snapshot,
    ) -> Self {
        Self {
            root,
            atoms,
            windows,
            id: window.id,
            generation: window.target.generation,
            identity: window.identity.clone(),
        }
    }

    pub(in crate::linux) fn current(&self, connection: &RustConnection) -> Result<Target> {
        let mut windows = lock(&self.windows);
        let observed = Snapshot::observe(connection, self.root, &self.atoms, self.id)?;
        drain_destroyed(connection, &mut windows)?;
        if observed.identity != self.identity
            || !windows.get(&self.id).is_some_and(|(identity, generation)| {
                *identity == self.identity && *generation == self.generation
            })
        {
            return Err(stale());
        }
        Ok(observed.target)
    }
}

#[derive(Default)]
pub(in crate::linux) struct Input {
    position: Point,
    keys: HashSet<u8>,
    buttons: u16,
}

impl Input {
    pub(in crate::linux) fn send(
        &mut self,
        connection: &RustConnection,
        pin: &Pin,
        planned: &Target,
        target: &Target,
        events: &[(u8, u8, Option<Point>)],
    ) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let map = connection
            .get_modifier_mapping()
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        let width = map.keycodes.len() / 8;
        for &(kind, detail, point) in events {
            if let Some(point) = point {
                self.position = Point {
                    x: point.x - planned.bounds.x,
                    y: point.y - planned.bounds.y,
                };
            }
            let modifiers = if width == 0 {
                0
            } else {
                map.keycodes
                    .chunks_exact(width)
                    .enumerate()
                    .fold(0, |bits, (index, keys)| {
                        bits | if keys.iter().any(|key| self.keys.contains(key)) {
                            1 << index
                        } else {
                            0
                        }
                    })
            };
            let mask = match kind {
                KEY_PRESS_EVENT => EventMask::KEY_PRESS,
                KEY_RELEASE_EVENT => EventMask::KEY_RELEASE,
                BUTTON_PRESS_EVENT => EventMask::BUTTON_PRESS,
                BUTTON_RELEASE_EVENT => EventMask::BUTTON_RELEASE,
                MOTION_NOTIFY_EVENT => {
                    EventMask::POINTER_MOTION
                        | if self.buttons == 0 {
                            EventMask::NO_EVENT
                        } else {
                            EventMask::BUTTON_MOTION
                        }
                }
                _ => return Err(CuaError::invalid("Unknown X11 window input event.")),
            };
            // Core pointer, button and key events use the same wire layout.
            let event = KeyPressEvent {
                response_type: kind,
                detail,
                sequence: 0,
                time: CURRENT_TIME,
                root: pin.root,
                event: pin.id,
                child: NONE,
                root_x: (target.bounds.x + self.position.x).round() as i16,
                root_y: (target.bounds.y + self.position.y).round() as i16,
                event_x: self.position.x.round() as i16,
                event_y: self.position.y.round() as i16,
                state: KeyButMask::from(modifiers | self.buttons),
                same_screen: true,
            };
            let button = if (1..=5).contains(&detail) {
                1 << (detail + 7)
            } else {
                0
            };
            match kind {
                KEY_PRESS_EVENT => {
                    self.keys.insert(detail);
                }
                KEY_RELEASE_EVENT => {
                    self.keys.remove(&detail);
                }
                BUTTON_PRESS_EVENT => self.buttons |= button,
                BUTTON_RELEASE_EVENT => self.buttons &= !button,
                _ => {}
            }
            connection
                .send_event(false, pin.id, mask, event)
                .map_err(failure)?
                .check()
                .map_err(window_error)?;
        }
        connection.flush().map_err(failure)
    }
}

impl Snapshot {
    pub(super) fn observe(
        connection: &RustConnection,
        root: u32,
        atoms: &Atoms,
        id: u32,
    ) -> Result<Self> {
        if id == root || id <= 1 {
            return Err(missing());
        }
        let attributes = connection
            .get_window_attributes(id)
            .map_err(failure)?
            .reply()
            .map_err(window_error)?;
        if attributes.class != WindowClass::INPUT_OUTPUT || attributes.override_redirect {
            return Err(missing());
        }
        let geometry = connection
            .get_geometry(id)
            .map_err(failure)?
            .reply()
            .map_err(window_error)?;
        let origin = connection
            .translate_coordinates(id, root, 0, 0)
            .map_err(failure)?
            .reply()
            .map_err(window_error)?;
        if geometry.root != root
            || !origin.same_screen
            || geometry.width == 0
            || geometry.height == 0
        {
            return Err(missing());
        }
        let pid = cardinal(connection, id, atoms.pid, AtomEnum::CARDINAL).filter(|pid| *pid != 0);
        let class = property(
            connection,
            id,
            AtomEnum::WM_CLASS.into(),
            AtomEnum::STRING,
            256,
        )
        .and_then(|value| {
            value
                .split('\0')
                .rfind(|part| !part.is_empty())
                .map(str::to_owned)
        });
        let identity = Identity {
            protected: class.as_deref().is_some_and(is_cantrip_application_name)
                || pid.is_some_and(is_cantrip_process),
            class,
            pid,
            start: pid.and_then(start_time),
        };
        let title = property(connection, id, atoms.name, atoms.utf8, 1024).or_else(|| {
            property(
                connection,
                id,
                AtomEnum::WM_NAME.into(),
                AtomEnum::STRING,
                1024,
            )
        });
        let application = if identity.protected {
            Some("Cantrip".into())
        } else {
            identity.class.clone()
        };
        Ok(Self {
            id,
            identity,
            border: i16::try_from(geometry.border_width).map_err(failure)?,
            visual: attributes.visual,
            target: Target {
                access: None,
                id: format!("x11-window-{id}"),
                generation: 0,
                kind: TargetKind::Window,
                title,
                application,
                process_id: pid,
                bounds: Bounds {
                    x: origin.dst_x.into(),
                    y: origin.dst_y.into(),
                    width: geometry.width.into(),
                    height: geometry.height.into(),
                },
                pixel_width: geometry.width.into(),
                pixel_height: geometry.height.into(),
                scale_factor: 1.0,
                focused: Some(
                    cardinal(connection, root, atoms.active, AtomEnum::WINDOW) == Some(id),
                ),
                minimized: Some(attributes.map_state != MapState::VIEWABLE),
            },
        })
    }
}

fn property(
    connection: &RustConnection,
    window: u32,
    atom: Atom,
    kind: impl Into<Atom>,
    limit: u32,
) -> Option<String> {
    let result = connection
        .get_property(false, window, atom, kind.into(), 0, limit)
        .ok()?
        .reply()
        .ok()?;
    if result.format != 8 || result.value.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&result.value);
    // The byte limit also applies when invalid UTF-8 expands to replacement characters.
    let mut length = text.len().min((limit * 4) as usize);
    while !text.is_char_boundary(length) {
        length -= 1;
    }
    Some(text[..length].to_owned())
}

fn cardinal(connection: &RustConnection, window: u32, atom: Atom, kind: AtomEnum) -> Option<u32> {
    connection
        .get_property(false, window, atom, kind, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()
}

fn start_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_ascii_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

fn is_cantrip_process(pid: u32) -> bool {
    fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .is_some_and(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_cantrip_application_name)
        })
}

fn window_error(error: ReplyError) -> CuaError {
    if matches!(&error, ReplyError::X11Error(error) if error.error_kind == ErrorKind::Window) {
        missing()
    } else {
        failure(error)
    }
}

pub(super) struct Pixmap {
    connection: Arc<RustConnection>,
    id: u32,
    redirected: Option<u32>,
}

impl Pixmap {
    pub(super) fn open(connection: Arc<RustConnection>, window: &Snapshot) -> Result<Self> {
        let unsupported = || {
            CuaError::new(
                ErrorCode::Unsupported,
                "Window capture requires the X11 Composite extension.",
            )
        };
        connection
            .composite_query_version(0, 4)
            .map_err(|_| unsupported())?
            .reply()
            .map_err(|_| unsupported())?;
        let id = connection.generate_id().map_err(failure)?;
        let redirect = match name_pixmap(&connection, window.id, id) {
            Ok(()) => None,
            Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Match => {
                connection
                    .composite_redirect_window(window.id, Redirect::AUTOMATIC)
                    .map_err(failure)?
                    .check()
                    .map_err(window_error)?;
                if let Err(error) = name_pixmap(&connection, window.id, id) {
                    unredirect(&connection, window.id);
                    return Err(window_error(error));
                }
                Some(window.id)
            }
            Err(error) => return Err(window_error(error)),
        };
        Ok(Self {
            connection,
            id,
            redirected: redirect,
        })
    }

    pub(super) fn capture(
        self,
        screen: usize,
        window: Snapshot,
        cancel: &Cancellation,
    ) -> Result<Capture> {
        capture::drawable(
            &self.connection,
            screen,
            self.id,
            (window.border, window.border),
            window.visual,
            window.target,
            cancel,
        )
    }
}

fn name_pixmap(
    connection: &RustConnection,
    window: u32,
    pixmap: u32,
) -> std::result::Result<(), ReplyError> {
    connection
        .composite_name_window_pixmap(window, pixmap)?
        .check()
}

fn unredirect(connection: &RustConnection, window: u32) {
    if let Ok(request) = connection.composite_unredirect_window(window, Redirect::AUTOMATIC) {
        let _ = request.check();
    }
}

impl Drop for Pixmap {
    fn drop(&mut self) {
        if let Ok(request) = self.connection.free_pixmap(self.id) {
            let _ = request.check();
        }
        if let Some(window) = self.redirected {
            unredirect(&self.connection, window);
        }
    }
}
