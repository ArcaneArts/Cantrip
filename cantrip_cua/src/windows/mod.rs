//! Native desktop inventory and capture for the worker's interactive Windows session.
mod capture;
mod clipboard;
mod input;
mod lifetime;
mod physical;
mod targets;

use crate::{
    backend::{Capture, CaptureBackend, CaptureWork, RemoteMonitorInput, UnavailableBackend},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::InputCommand,
    input::InputReceipt,
    input_job::{InputProgress, InputWork},
    target::{Point, Target, TargetKind},
};
use cantrip_interaction::input::{InputEvent, Modifier};
use lifetime::Hook;
use std::{
    collections::{HashMap, HashSet},
    mem::size_of,
    sync::{Arc, Mutex, MutexGuard},
};
use targets::{Monitor, Window};
use windows_sys::Win32::{
    System::StationsAndDesktops::{
        GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
    },
    UI::WindowsAndMessaging::WSF_VISIBLE,
};

struct Host {
    participants: HashMap<String, Arc<Mutex<input::Session>>>,
    physical_owner: Option<String>,
    input: input::Shared,
    observations: Hook,
    truncated: bool,
}

impl Host {
    fn open() -> Result<Self> {
        let station = unsafe { GetProcessWindowStation() };
        let mut flags = USEROBJECTFLAGS::default();
        let mut size = 0;
        if station.is_null()
            || unsafe {
                GetUserObjectInformationW(
                    station,
                    UOI_FLAGS,
                    (&mut flags as *mut USEROBJECTFLAGS).cast(),
                    size_of::<USEROBJECTFLAGS>() as u32,
                    &mut size,
                )
            } == 0
            || flags.dwFlags & WSF_VISIBLE as u32 == 0
            || targets::monitors()?.is_empty()
        {
            return Err(failure(
                "A local interactive Windows desktop is unavailable.",
            ));
        }
        let observations = Hook::start()?;
        let input = input::Native::host(observations.registered.clone());
        Ok(Self {
            observations,
            input,
            participants: HashMap::new(),
            physical_owner: None,
            truncated: false,
        })
    }

    fn monitors(&mut self) -> Result<Vec<Monitor>> {
        let mut monitors = targets::monitors()?;
        lock(&self.observations.registered).bind_monitors(&mut monitors)?;
        Ok(monitors)
    }

    fn window(&mut self, handle: usize, cancel: &Cancellation) -> Result<Window> {
        cancel.check()?;
        let mut window = Window::observe(handle)?;
        lock(&self.observations.registered).bind_window(&mut window)?;
        Ok(window)
    }

    fn select_window(
        &mut self,
        id: &str,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<Window> {
        let id_number = id
            .strip_prefix("windows-window-")
            .and_then(|id| id.parse().ok())
            .ok_or_else(missing)?;
        let handle = lock(&self.observations.registered)
            .window_handle(id_number)
            .ok_or_else(stale)?;
        let window = self.window(handle, cancel)?;
        if window.target.generation != generation {
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
        let window = Arc::new(self.select_window(&target.id, target.generation, cancel)?);
        let target = window.target.clone();
        let participant = self.input_participant(session, input::Destination::Window(window))?;
        Ok((target, participant))
    }

    fn input_participant(
        &mut self,
        session: &str,
        destination: input::Destination,
    ) -> Result<Arc<Mutex<input::Session>>> {
        let participant = if let Some(participant) = self.participants.get(session) {
            lock(participant).refresh(destination)?;
            participant.clone()
        } else {
            let participant = Arc::new(Mutex::new(input::Session::open(
                self.input.clone(),
                destination,
            )?));
            self.participants
                .insert(session.to_owned(), participant.clone());
            participant
        };
        Ok(participant)
    }

    fn select_monitor(&mut self, id: &str, generation: u64) -> Result<Monitor> {
        let monitor = self
            .monitors()?
            .into_iter()
            .find(|monitor| monitor.target.id == id)
            .ok_or_else(missing)?;
        if monitor.target.generation != generation {
            return Err(stale());
        }
        Ok(monitor)
    }

    fn open_physical(
        &mut self,
        participant: &str,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<()> {
        if self.physical_owner.is_some() {
            return Err(CuaError::new(
                ErrorCode::OwnershipMismatch,
                "Another viewer controls the Windows desktop.",
            ));
        }
        let destination = self.physical_destination(target, cancel)?;
        self.input_participant(participant, destination)?;
        self.physical_owner = Some(participant.to_owned());
        Ok(())
    }

    fn physical_destination(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<input::Destination> {
        cancel.check()?;
        Ok(match target.kind {
            TargetKind::Window => input::Destination::ForegroundWindow(
                Arc::new(self.select_window(&target.id, target.generation, cancel)?),
                cancel.clone(),
            ),
            TargetKind::Monitor => {
                input::Destination::Monitor(self.select_monitor(&target.id, target.generation)?)
            }
        })
    }
}

impl CaptureBackend for Host {
    fn name(&self) -> &'static str {
        "windows-win32"
    }

    fn available(&self) -> bool {
        true
    }

    fn is_cantrip_application(&self, target: &Target) -> Result<bool> {
        if target.kind != TargetKind::Window {
            return Ok(false);
        }
        let id = target
            .id
            .strip_prefix("windows-window-")
            .and_then(|id| id.parse().ok())
            .ok_or_else(missing)?;
        lock(&self.observations.registered)
            .protection(id, target.generation)
            .ok_or_else(stale)
    }

    fn inventory_truncated(&self) -> bool {
        self.truncated
    }

    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        cancel.check()?;
        let mut targets: Vec<_> = self
            .monitors()?
            .into_iter()
            .map(|monitor| monitor.target)
            .collect();
        let mut handles = targets::window_handles()?;
        self.truncated = handles.len() > targets::INVENTORY_LIMIT;
        handles.truncate(targets::INVENTORY_LIMIT);
        let present: HashSet<_> = handles.iter().copied().collect();
        lock(&self.observations.registered).retain_windows(&present);
        for handle in handles {
            cancel.check()?;
            if let Ok(window) = self.window(handle, cancel) {
                targets.push(window.target);
            }
        }
        Ok(targets)
    }

    fn resolve_target(
        &mut self,
        id: &str,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<Target> {
        cancel.check()?;
        if id.starts_with("windows-window-") {
            Ok(self.select_window(id, generation, cancel)?.target)
        } else {
            Ok(self.select_monitor(id, generation)?.target)
        }
    }

    fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
        self.capture_work(target, cancel)?
            .expect("Windows capture work")()
    }

    fn capture_work(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<Option<CaptureWork>> {
        cancel.check()?;
        let cancel = cancel.clone();
        let work: CaptureWork = match target.kind {
            TargetKind::Window => {
                let window = self.select_window(&target.id, target.generation, &cancel)?;
                let registry = self.observations.registered.clone();
                Box::new(move || {
                    lifetime::verify_window(&registry, &window)?;
                    let capture = capture::window(&window, &cancel)?;
                    lifetime::verify_window(&registry, &window)?;
                    Ok(capture)
                })
            }
            TargetKind::Monitor => {
                let monitor = self.select_monitor(&target.id, target.generation)?;
                Box::new(move || capture::monitor(monitor, &cancel))
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

    fn open_remote_monitor(
        &mut self,
        _: &crate::interaction::Binding,
        participant: &str,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<()> {
        self.open_physical(participant, target, cancel)
    }

    fn open_remote_window(
        &mut self,
        participant: &str,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<()> {
        self.open_physical(participant, target, cancel)
    }

    fn copy_selection_text(
        &mut self,
        session: &str,
        target: &Target,
        position: Point,
        sequence: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        let window = if target.kind == TargetKind::Monitor {
            let monitor = self.select_monitor(&target.id, target.generation)?;
            let foreground = physical::monitor_focus(&monitor)?;
            match self.window(foreground, cancel) {
                Ok(window) => window,
                Err(error) if error.code == ErrorCode::TargetNotFound => return Ok(None),
                Err(error) => return Err(error),
            }
        } else {
            self.select_window(&target.id, target.generation, cancel)?
        };
        let original = clipboard::sequence();
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
        self.interaction_input(
            session,
            target,
            position,
            sequence,
            InputEvent::KeyUp { key: "C".into() },
            cancel,
        )?;
        let text = clipboard::read_focused(&window, original, cancel)?;
        lifetime::verify_window(&self.observations.registered, &window)?;
        if target.kind == TargetKind::Monitor {
            let monitor = self.select_monitor(&target.id, target.generation)?;
            Ok(text.filter(|_| {
                physical::monitor_focus(&monitor).is_ok_and(|focus| focus == window.identity.hwnd)
            }))
        } else {
            Ok(text.filter(|_| physical::window_is_focused(&window)))
        }
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
        let result = (|| {
            if self.physical_owner.as_deref() != Some(session) {
                return Err(stale());
            }
            let destination = self.physical_destination(target, cancel)?;
            let participant = self.input_participant(session, destination)?;
            lock(&participant).submit(sequence, &event, cancel)
        })();
        if result.is_err() {
            let _ = self.close_input(session);
        }
        result
    }

    fn close_input(&mut self, session: &str) -> Result<()> {
        if self.physical_owner.as_deref() == Some(session) {
            self.physical_owner = None;
        }
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
        let (target, participant) = self.participant(session, target, cancel)?;
        let result = perform(
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

    fn input_work(
        &mut self,
        session: &str,
        target: &Target,
        command: &InputCommand,
        position: Point,
        cancel: &Cancellation,
        _: InputProgress,
    ) -> Result<Option<InputWork>> {
        let (target, participant) = self.participant(session, target, cancel)?;
        let command = command.clone();
        let cancel = cancel.clone();
        Ok(Some(Box::new(move |progress| {
            perform(
                &mut lock(&participant),
                target,
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

fn perform(
    participant: &mut input::Session,
    target: Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point),
) -> Result<(Target, InputReceipt)> {
    let result = crate::surface_gestures::perform(
        |event| participant.send(event, cancel),
        target,
        command,
        position,
        cancel,
        progress,
    );
    if result.is_err() {
        let _ = participant.close();
    }
    result
}

pub fn run() -> std::io::Result<()> {
    match Host::open() {
        Ok(backend) => crate::runtime::run(backend, std::io::stdin(), std::io::stdout()),
        Err(_) => crate::runtime::run(UnavailableBackend, std::io::stdin(), std::io::stdout()),
    }
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn missing() -> CuaError {
    CuaError::new(
        ErrorCode::TargetNotFound,
        "The Windows desktop target no longer exists.",
    )
}

fn stale() -> CuaError {
    CuaError::new(
        ErrorCode::StaleTarget,
        "The Windows desktop target changed.",
    )
}

fn failure(reason: &'static str) -> CuaError {
    CuaError::new(ErrorCode::Unsupported, reason)
}
