//! One explicitly selected X server. Never reconnect or discover another DISPLAY.
mod capture;
mod gestures;
mod input;
mod keys;

use crate::{
    backend::{Capture, CaptureBackend, CaptureWork},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::InputCommand,
    input::InputReceipt,
    input_job::{InputProgress, InputWork},
    target::{Bounds, Point, Target, TargetKind},
};
use cantrip_interaction::input::InputEvent;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use x11rb::{
    connection::Connection, protocol::xproto::ConnectionExt, rust_connection::RustConnection,
};

pub(super) fn failure(error: impl std::fmt::Display) -> CuaError {
    // Native errors contain protocol metadata, never pixels or typed text.
    CuaError::new(
        ErrorCode::InputUnknown,
        format!("X11 operation failed: {error}"),
    )
}
pub(super) fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct X11Backend {
    connection: Arc<RustConnection>,
    screen: usize,
    id: String,
    generation: u64,
    input: Arc<Mutex<input::Host>>,
    participants: HashMap<String, Arc<Mutex<input::Session>>>,
}
impl X11Backend {
    pub fn connect(display: &str, desktop_generation: &str) -> Result<Self> {
        // DISPLAY must be an explicit local Unix X server, never inherited or TCP.
        if !display
            .strip_prefix(':')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            || desktop_generation.is_empty()
            || desktop_generation.len() > 128
            || !desktop_generation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(CuaError::invalid(
                "Use an explicit local :display and desktop generation.",
            ));
        }
        let (connection, screen) = x11rb::connect(Some(display)).map_err(failure)?;
        let generation = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(failure)?
            .as_nanos() as u64
            & ((1 << 53) - 1);
        let connection = Arc::new(connection);
        let input = input::host(connection.clone(), screen);
        Ok(Self {
            connection,
            screen,
            id: format!("x11-{display}-{desktop_generation}"),
            generation,
            input: Arc::new(Mutex::new(input)),
            participants: HashMap::new(),
        })
    }
    fn target(&self, cancel: &Cancellation) -> Result<Target> {
        cancel.check()?;
        let root = self.connection.setup().roots[self.screen].root;
        let geometry = self
            .connection
            .get_geometry(root)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        let target = Target {
            access: None,
            id: self.id.clone(),
            generation: self.generation,
            kind: TargetKind::Monitor,
            title: Some("Assigned Linux desktop".into()),
            application: None,
            process_id: None,
            bounds: Bounds {
                x: 0.,
                y: 0.,
                width: geometry.width.into(),
                height: geometry.height.into(),
            },
            pixel_width: geometry.width.into(),
            pixel_height: geometry.height.into(),
            scale_factor: 1.,
            focused: None,
            minimized: None,
        };
        target.validate()?;
        Ok(target)
    }
    fn current(&self, target: &Target, cancel: &Cancellation) -> Result<Target> {
        if target.id != self.id || target.generation != self.generation {
            return Err(CuaError::new(
                ErrorCode::StaleTarget,
                "The assigned desktop session changed.",
            ));
        }
        self.target(cancel)
    }
    fn participant(
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
}
impl CaptureBackend for X11Backend {
    fn name(&self) -> &'static str {
        "linux-x11"
    }
    fn available(&self) -> bool {
        true
    }
    fn native_input(&self) -> bool {
        true
    }
    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        Ok(vec![self.target(cancel)?])
    }
    fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
        let target = self.current(target, cancel)?;
        capture::capture(&self.connection, self.screen, target, cancel)
    }
    fn capture_work(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<Option<CaptureWork>> {
        let target = self.current(target, cancel)?;
        let connection = self.connection.clone();
        let screen = self.screen;
        let cancel = cancel.clone();
        Ok(Some(Box::new(move || {
            capture::capture(&connection, screen, target, &cancel)
        })))
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
        let current = self.current(target, cancel)?;
        let participant = self.participant(session, &current)?;
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
        let target = self.current(target, cancel)?;
        let participant = self.participant(session, &target)?;
        let result = gestures::perform(
            &mut lock(&participant),
            target,
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
    fn input_finished(&mut self, session: &str, succeeded: bool) {
        if !succeeded {
            let _ = self.close_input(session);
        }
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
        let target = self.current(target, cancel)?;
        let participant = self.participant(session, &target)?;
        let command = command.clone();
        let cancel = cancel.clone();
        Ok(Some(Box::new(move |progress| {
            gestures::perform(
                &mut lock(&participant),
                target,
                &command,
                position,
                &cancel,
                progress,
            )
        })))
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
    fn global_click(
        &mut self,
        session: &str,
        target: &Target,
        position: Point,
        cancel: &Cancellation,
    ) -> Result<(Target, InputReceipt)> {
        self.click(session, target, position, cancel)
    }
}

pub fn run(display: &str, generation: &str) -> std::io::Result<()> {
    let backend = X11Backend::connect(display, generation).map_err(std::io::Error::other)?;
    crate::runtime::run(backend, std::io::stdin(), std::io::stdout())
}
