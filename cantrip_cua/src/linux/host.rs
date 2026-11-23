//! Capture the local user's X11 session with window and display identities.
mod clipboard;
pub(super) mod window;

use super::{capture, failure, gestures, input, lock};
use crate::{
    backend::{Capture, CaptureBackend, CaptureWork, RemoteMonitorInput},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::InputCommand,
    input::InputReceipt,
    input_job::{InputProgress, InputWork},
    target::{Bounds, MAX_SEQUENCE, Point, Target, TargetKind},
};
use cantrip_interaction::input::{InputEvent, Modifier};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use x11rb::{
    NONE,
    connection::Connection,
    protocol::{
        randr::ConnectionExt as _,
        xproto::{ConnectionExt, InputFocus},
    },
    rust_connection::RustConnection,
};

const INVENTORY_LIMIT: usize = 2_000;
type Windows = HashMap<u32, (window::Identity, u64)>;

struct DisplayLayout {
    generation: u64,
    monitors: Vec<(String, Bounds)>,
}

pub(super) struct Host {
    display: String,
    connection: Arc<RustConnection>,
    screen: usize,
    atoms: window::Atoms,
    windows: Arc<Mutex<Windows>>,
    input: Arc<Mutex<input::Host>>,
    participants: HashMap<String, Arc<Mutex<input::Session>>>,
    generation: u64,
    display_layout: Mutex<DisplayLayout>,
    truncated: bool,
}

impl Host {
    pub(super) fn connect() -> Result<Self> {
        let display = std::env::var("DISPLAY").map_err(|_| unavailable())?;
        if !local_display(&display) {
            return Err(unavailable());
        }
        let (connection, screen) = x11rb::connect(Some(&display)).map_err(failure)?;
        let atoms = window::Atoms::new(&connection)?;
        let generation = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(failure)?
            .as_nanos() as u64
            & (MAX_SEQUENCE >> 1))
            .max(1);
        let connection = Arc::new(connection);
        Ok(Self {
            display,
            input: Arc::new(Mutex::new(input::host(connection.clone(), screen))),
            connection,
            screen,
            atoms,
            windows: Arc::default(),
            participants: HashMap::new(),
            generation,
            display_layout: Mutex::new(DisplayLayout {
                generation,
                monitors: Vec::new(),
            }),
            truncated: false,
        })
    }

    fn root(&self) -> u32 {
        self.connection.setup().roots[self.screen].root
    }

    pub(super) fn monitors(&self, cancel: &Cancellation) -> Result<Vec<Target>> {
        let mut layout = lock(&self.display_layout);
        let mut targets = self.read_monitors(layout.generation, cancel)?;
        let monitors = targets
            .iter()
            .map(|target| (target.id.clone(), target.bounds))
            .collect();
        if layout.monitors != monitors {
            layout.generation = layout
                .generation
                .checked_add(1)
                .filter(|generation| *generation <= MAX_SEQUENCE)
                .ok_or_else(|| {
                    CuaError::new(ErrorCode::Capacity, "X11 display generations exhausted.")
                })?;
            layout.monitors = monitors;
        }
        for target in &mut targets {
            target.generation = layout.generation;
        }
        Ok(targets)
    }

    fn read_monitors(&self, generation: u64, cancel: &Cancellation) -> Result<Vec<Target>> {
        cancel.check()?;
        let root = self.root();
        let displays = self
            .connection
            .randr_get_monitors(root, true)
            .ok()
            .and_then(|request| request.reply().ok());
        if let Some(displays) = displays.filter(|response| !response.monitors.is_empty()) {
            let mut monitors: Vec<_> = displays
                .monitors
                .into_iter()
                .filter(|monitor| monitor.width > 0 && monitor.height > 0)
                .collect();
            monitors.sort_by_key(|monitor| !monitor.primary);
            return monitors
                .into_iter()
                .map(|monitor| {
                    let id = monitor.outputs.first().copied().unwrap_or(monitor.name);
                    let name = self
                        .connection
                        .get_atom_name(monitor.name)
                        .ok()
                        .and_then(|request| request.reply().ok())
                        .map(|name| String::from_utf8_lossy(&name.name).into_owned());
                    self.monitor(
                        id,
                        name,
                        (monitor.x, monitor.y),
                        (monitor.width, monitor.height),
                        generation,
                    )
                })
                .collect();
        }
        let geometry = self
            .connection
            .get_geometry(root)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        self.monitor(
            root,
            Some("X11 display".into()),
            (0, 0),
            (geometry.width, geometry.height),
            generation,
        )
        .map(|target| vec![target])
    }

    fn monitor(
        &self,
        id: u32,
        title: Option<String>,
        origin: (i16, i16),
        size: (u16, u16),
        generation: u64,
    ) -> Result<Target> {
        let target = Target {
            access: None,
            id: format!("x11-display-{id}"),
            generation,
            kind: TargetKind::Monitor,
            title,
            application: None,
            process_id: None,
            bounds: Bounds {
                x: origin.0.into(),
                y: origin.1.into(),
                width: size.0.into(),
                height: size.1.into(),
            },
            pixel_width: size.0.into(),
            pixel_height: size.1.into(),
            scale_factor: 1.0,
            focused: None,
            minimized: None,
        };
        target.validate()?;
        Ok(target)
    }

    fn window(&mut self, id: u32, cancel: &Cancellation) -> Result<window::Snapshot> {
        cancel.check()?;
        let mut windows = lock(&self.windows);
        window::drain_destroyed(&self.connection, &mut windows)?;
        let mut window = window::Snapshot::observe(&self.connection, self.root(), &self.atoms, id)?;
        window::drain_destroyed(&self.connection, &mut windows)?;
        let generation = match windows.get(&id) {
            Some((identity, generation)) if *identity == window.identity => *generation,
            _ => {
                window::watch(&self.connection, id)?;
                self.generation = self
                    .generation
                    .checked_add(1)
                    .filter(|generation| *generation < MAX_SEQUENCE)
                    .ok_or_else(|| {
                        CuaError::new(ErrorCode::Capacity, "X11 target generations exhausted.")
                    })?;
                windows.insert(id, (window.identity.clone(), self.generation));
                self.generation
            }
        };
        window.target.generation = generation;
        window.target.validate()?;
        Ok(window)
    }

    fn current_window(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<window::Snapshot> {
        let id = target
            .id
            .strip_prefix("x11-window-")
            .and_then(|id| id.parse().ok())
            .ok_or_else(missing)?;
        let window = self.window(id, cancel)?;
        if window.target.generation != target.generation
            || window.target.process_id != target.process_id
        {
            return Err(stale());
        }
        Ok(window)
    }

    fn participant(
        &mut self,
        session: &str,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<(Target, Arc<Mutex<input::Session>>)> {
        let window = self.current_window(target, cancel)?;
        let participant = if let Some(participant) = self.participants.get(session) {
            lock(participant).refresh(&window.target);
            participant.clone()
        } else {
            let pin = window::Pin::new(self.root(), self.atoms, self.windows.clone(), &window);
            let participant = Arc::new(Mutex::new(input::Session::open_window(
                self.input.clone(),
                &window.target,
                pin,
            )?));
            self.participants
                .insert(session.into(), participant.clone());
            participant
        };
        Ok((window.target, participant))
    }

    fn monitor_participant(
        &mut self,
        session: &str,
        target: &Target,
    ) -> Result<Arc<Mutex<input::Session>>> {
        if let Some(participant) = self.participants.get(session) {
            lock(participant).refresh(target);
            return Ok(participant.clone());
        }
        let participant = Arc::new(Mutex::new(input::Session::open(
            self.input.clone(),
            target,
        )?));
        self.participants
            .insert(session.into(), participant.clone());
        Ok(participant)
    }

    fn monitor_focus(&self, target: &Target) -> Result<u32> {
        let root = self.root();
        let bounds = target.bounds;
        let outside = || {
            CuaError::new(
                ErrorCode::PermissionDenied,
                "Keyboard focus is outside the selected display.",
            )
        };
        let focus = self
            .connection
            .get_input_focus()
            .map_err(failure)?
            .reply()
            .map_err(failure)?
            .focus;
        if focus == u32::from(InputFocus::POINTER_ROOT) || focus == root {
            let pointer = self
                .connection
                .query_pointer(root)
                .map_err(failure)?
                .reply()
                .map_err(failure)?;
            if !pointer.same_screen
                || !bounds.contains_local(Point {
                    x: f64::from(pointer.root_x) - bounds.x,
                    y: f64::from(pointer.root_y) - bounds.y,
                })
            {
                return Err(outside());
            }
            return Ok(if pointer.child == NONE {
                root
            } else {
                pointer.child
            });
        }
        if focus == NONE {
            return Err(outside());
        }
        let geometry = self
            .connection
            .get_geometry(focus)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        let position = self
            .connection
            .translate_coordinates(focus, root, 0, 0)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        let x = f64::from(position.dst_x);
        let y = f64::from(position.dst_y);
        if geometry.root != root
            || !position.same_screen
            || x >= bounds.x + bounds.width
            || y >= bounds.y + bounds.height
            || x + f64::from(geometry.width) <= bounds.x
            || y + f64::from(geometry.height) <= bounds.y
        {
            return Err(outside());
        }
        Ok(focus)
    }

    pub(super) fn window_targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        let mut targets = Vec::new();
        let mut windows =
            window::list(&self.connection, self.root(), &self.atoms, INVENTORY_LIMIT)?;
        self.truncated = windows.len() > INVENTORY_LIMIT;
        windows.truncate(INVENTORY_LIMIT);
        let present: HashSet<_> = windows.iter().copied().collect();
        lock(&self.windows).retain(|window, _| present.contains(window));
        for id in windows {
            cancel.check()?;
            if let Ok(window) = self.window(id, cancel) {
                targets.push(window.target);
            }
        }
        Ok(targets)
    }
}

impl CaptureBackend for Host {
    fn name(&self) -> &'static str {
        "linux-x11"
    }

    fn available(&self) -> bool {
        true
    }

    fn inventory_truncated(&self) -> bool {
        self.truncated
    }

    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        let mut targets = self.monitors(cancel)?;
        targets.extend(self.window_targets(cancel)?);
        Ok(targets)
    }

    fn resolve_target(
        &mut self,
        id: &str,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<Target> {
        let target = if let Some(window) = id
            .strip_prefix("x11-window-")
            .and_then(|id| id.parse().ok())
        {
            self.window(window, cancel)?.target
        } else {
            self.monitors(cancel)?
                .into_iter()
                .find(|target| target.id == id)
                .ok_or_else(missing)?
        };
        if target.generation != generation {
            return Err(stale());
        }
        Ok(target)
    }

    fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
        self.capture_work(target, cancel)?
            .expect("X11 capture work")()
    }

    fn capture_work(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<Option<CaptureWork>> {
        let connection = self.connection.clone();
        let screen = self.screen;
        let work_cancel = cancel.clone();
        let work: CaptureWork = match target.kind {
            TargetKind::Monitor => {
                let target = self.resolve_target(&target.id, target.generation, cancel)?;
                let root = &connection.setup().roots[screen];
                let (drawable, visual) = (root.root, root.root_visual);
                let origin = (target.bounds.x as i16, target.bounds.y as i16);
                Box::new(move || {
                    capture::drawable(
                        &connection,
                        screen,
                        drawable,
                        origin,
                        visual,
                        target,
                        &work_cancel,
                    )
                })
            }
            TargetKind::Window => {
                let window = self.current_window(target, cancel)?;
                let pixmap = window::Pixmap::open(connection, &window)?;
                let mut windows = lock(&self.windows);
                window::drain_destroyed(&self.connection, &mut windows)?;
                if !windows.contains_key(&window.id) {
                    return Err(stale());
                }
                Box::new(move || pixmap.capture(screen, window, &work_cancel))
            }
        };
        Ok(Some(work))
    }

    fn native_input(&self) -> bool {
        true
    }

    fn remote_monitor_input(&self) -> RemoteMonitorInput {
        RemoteMonitorInput::ExclusiveHost
    }

    fn copy_selection_text(
        &mut self,
        session: &str,
        target: &Target,
        position: Point,
        sequence: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        let recipient = match target.kind {
            TargetKind::Window => self.current_window(target, cancel)?.id,
            TargetKind::Monitor => self.monitor_focus(target)?,
        };
        if recipient == self.root() {
            return Ok(None);
        }
        let clipboard = clipboard::Selection::subscribe(&self.display)?;
        self.interaction_input(
            session,
            target,
            position,
            sequence - 1,
            InputEvent::KeyDown {
                key: "C".into(),
                modifiers: vec![Modifier::Control],
                repeat: false,
            },
            cancel,
        )?;
        if let Err(error) = self.interaction_input(
            session,
            target,
            position,
            sequence,
            InputEvent::KeyUp { key: "C".into() },
            cancel,
        ) {
            let _ = self.close_input(session);
            return Err(error);
        }
        let text = clipboard.read(recipient, cancel)?;
        let refreshed = self.resolve_interaction_target(target, cancel)?;
        if target.kind == TargetKind::Monitor && self.monitor_focus(&refreshed)? != recipient {
            return Ok(None);
        }
        Ok(text)
    }

    fn interaction_input(
        &mut self,
        session: &str,
        target: &Target,
        _: Point,
        sequence: u64,
        event: InputEvent,
        cancel: &Cancellation,
    ) -> Result<()> {
        let participant = match target.kind {
            TargetKind::Window => self.participant(session, target, cancel)?.1,
            TargetKind::Monitor => {
                if matches!(event, InputEvent::KeyDown { .. } | InputEvent::Text(_)) {
                    self.monitor_focus(target)?;
                }
                self.monitor_participant(session, target)?
            }
        };
        let result = lock(&participant).submit(sequence, &event, cancel);
        if result.is_err() {
            let _ = self.close_input(session);
        }
        result
    }

    fn close_input(&mut self, session: &str) -> Result<()> {
        if let Some(participant) = self.participants.remove(session) {
            lock(&participant).close()?;
        }
        Ok(())
    }

    fn perform(
        &mut self,
        session: &str,
        target: &Target,
        command: &InputCommand,
        position: Point,
        cancel: &Cancellation,
        progress: &mut dyn FnMut(Point),
    ) -> Result<(Target, InputReceipt)> {
        let (window, participant) = self.participant(session, target, cancel)?;
        let result = gestures::perform(
            &mut lock(&participant),
            window,
            command,
            position,
            cancel,
            progress,
        );
        if result.is_err() {
            let _ = self.close_input(session);
        }
        result
    }

    fn input_work(
        &mut self,
        session: &str,
        target: &Target,
        command: &InputCommand,
        position: Point,
        cancel: &Cancellation,
        _: InputProgress,
    ) -> Result<Option<InputWork>> {
        let (window, participant) = self.participant(session, target, cancel)?;
        let command = command.clone();
        let cancel = cancel.clone();
        Ok(Some(Box::new(move |progress| {
            gestures::perform(
                &mut lock(&participant),
                window,
                &command,
                position,
                &cancel,
                progress,
            )
        })))
    }

    fn input_finished(&mut self, session: &str, succeeded: bool) {
        if !succeeded {
            let _ = self.close_input(session);
        }
    }

    fn click(
        &mut self,
        session: &str,
        target: &Target,
        position: Point,
        cancel: &Cancellation,
    ) -> Result<(Target, InputReceipt)> {
        self.perform(
            session,
            target,
            &InputCommand::PreparedPress {
                point: Some(position),
                hold_ms: 0,
                button: Default::default(),
            },
            position,
            cancel,
            &mut |_| {},
        )
    }
}

fn local_display(display: &str) -> bool {
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    display.strip_prefix(':').is_some_and(|suffix| {
        suffix.split_once('.').map_or_else(
            || digits(suffix),
            |(display, screen)| digits(display) && digits(screen),
        )
    })
}

fn unavailable() -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "A local X11 desktop is unavailable.",
    )
}

fn missing() -> CuaError {
    CuaError::new(
        ErrorCode::TargetNotFound,
        "The X11 target no longer exists.",
    )
}

fn stale() -> CuaError {
    CuaError::new(ErrorCode::StaleTarget, "The X11 target changed.")
}
